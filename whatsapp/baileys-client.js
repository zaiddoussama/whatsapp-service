const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let baileysModulePromise;
let pinoModulePromise;

async function loadBaileys() {
    if (!baileysModulePromise) {
        baileysModulePromise = import('baileys');
    }
    return baileysModulePromise;
}

async function loadPino() {
    if (!pinoModulePromise) {
        pinoModulePromise = import('pino');
    }
    return pinoModulePromise;
}

class BaileysClient {
    constructor(userId, springBootWebhookUrl) {
        this.userId = userId;
        this.webhookUrl = springBootWebhookUrl;
        this.sock = null;
        this.qrCode = null;
        this.isReady = false;
        this.isAuthenticated = false;
        this.initializationError = null;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.intentionalDisconnect = false;
        this.authSaveHandler = null;
        this.baileys = null;
        this.heartbeatInterval = null;
    }

    async initialize() {
        console.log(`Initializing Baileys client for user ${this.userId}...`);
        this.initializationError = null;
        this.intentionalDisconnect = false;

        const baileys = await loadBaileys();
        const pinoModule = await loadPino();
        const makeWASocket = baileys.default || baileys.makeWASocket;
        const { state, saveCreds } = await baileys.useMultiFileAuthState(this.getSessionPath());
        const { version } = await baileys.fetchLatestBaileysVersion();
        const pino = pinoModule.default || pinoModule;

        this.baileys = baileys;
        this.authSaveHandler = saveCreds;

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            emitOwnEvents: false,
            logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' }),
            browser: ['Watscale', 'Chrome', '1.0.0']
        });

        this.registerEventHandlers(saveCreds);
    }

    registerEventHandlers(saveCreds) {
        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`Baileys QR generated for user ${this.userId}`);
                this.qrCode = qr;
                this.isReady = false;
                this.isAuthenticated = false;

                const qrImage = await qrcode.toDataURL(qr);
                await this.sendWebhook('/whatsapp/qr-ready', {
                    userId: this.userId,
                    qrCode: qr,
                    qrImage
                });
            }

            if (connection === 'open') {
                console.log(`Baileys READY for user ${this.userId}`);
                this.isReady = true;
                this.isAuthenticated = true;
                this.qrCode = null;
                this.reconnectAttempts = 0;

                const phoneNumber = this.getOwnPhoneNumber();
                await this.sendWebhook('/whatsapp/connected', {
                    userId: this.userId,
                    phoneNumber,
                    platform: 'baileys'
                });

                this.startHeartbeat();
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || `Disconnected (${statusCode || 'unknown'})`;

                this.isReady = false;
                this.isAuthenticated = false;
                this.stopHeartbeat();

                if (this.intentionalDisconnect) {
                    console.log(`Baileys intentionally disconnected for user ${this.userId}`);
                    return;
                }

                console.warn(`Baileys disconnected for user ${this.userId}: ${reason}`);
                await this.sendWebhook('/whatsapp/disconnected', {
                    userId: this.userId,
                    reason
                });

                if (statusCode === this.baileys.DisconnectReason.loggedOut) {
                    this.initializationError = 'WhatsApp session logged out. Please scan a new QR code.';
                    await this.sendWebhook('/whatsapp/auth-failed', {
                        userId: this.userId,
                        reason: this.initializationError,
                        error: this.initializationError
                    });
                    return;
                }

                this.scheduleReconnect(5000);
            }
        });

        this.sock.ev.on('messages.upsert', async ({ type, messages }) => {
            if (type !== 'notify') return;
            for (const message of messages) {
                await this.handleIncomingMessage(message);
            }
        });
    }

    async handleIncomingMessage(message) {
        if (!message?.message || message.key?.fromMe) return;

        try {
            const content = this.baileys.extractMessageContent(message.message);
            const messageType = this.baileys.getContentType(content);
            const body = this.extractText(content, messageType);
            const remoteJid = message.key.remoteJid;
            const from = this.resolveSender(message);
            const timestamp = Number(message.messageTimestamp || Math.floor(Date.now() / 1000));
            const hasMedia = this.isMediaType(messageType);

            const messageData = {
                userId: this.userId,
                messageId: message.key.id,
                from,
                chatId: remoteJid,
                to: this.sock.user?.id,
                body,
                type: this.mapMessageType(messageType),
                timestamp,
                hasMedia,
                isForwarded: Boolean(content?.[messageType]?.contextInfo?.isForwarded),
                fromMe: false
            };

            if (hasMedia) {
                try {
                    const buffer = await this.baileys.downloadMediaMessage(
                        message,
                        'buffer',
                        {}
                    );
                    const mediaContent = content?.[messageType] || {};
                    messageData.media = {
                        mimetype: mediaContent.mimetype,
                        data: buffer.toString('base64'),
                        filename: mediaContent.fileName
                    };
                } catch (error) {
                    console.error('Baileys media download failed:', error.message);
                }
            }

            await this.sendWebhook('/whatsapp/message-received', messageData);
        } catch (error) {
            console.error(`Error handling Baileys incoming message for user ${this.userId}:`, error);
        }
    }

    async sendMessage(to, message) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp client is not ready');
        }

        const chatId = await this.formatChatId(to);
        if (chatId && chatId.success === false) return chatId;
        const sentMessage = await this.sock.sendMessage(chatId, { text: message });

        return {
            success: true,
            messageId: sentMessage?.key?.id,
            timestamp: Math.floor(Date.now() / 1000)
        };
    }

    async sendMediaMessage(to, mediaUrl, caption) {
        if (!this.isReady || !this.sock) {
            throw new Error('WhatsApp client is not ready');
        }

        const chatId = await this.formatChatId(to);
        if (chatId && chatId.success === false) return chatId;
        const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
        const mimetype = response.headers['content-type'] || 'application/octet-stream';
        const buffer = Buffer.from(response.data);

        const sentMessage = await this.sock.sendMessage(chatId, {
            document: buffer,
            mimetype,
            fileName: 'media-file',
            caption
        });

        return {
            success: true,
            messageId: sentMessage?.key?.id,
            timestamp: Math.floor(Date.now() / 1000)
        };
    }

    async getContactInfo(phoneNumber) {
        if (!this.sock) return null;
        try {
            const jid = await this.formatChatId(phoneNumber);
            const [result] = await this.sock.onWhatsApp(jid);
            if (!result?.exists) return null;
            return {
                phone: result.jid?.split('@')[0],
                name: result.name || result.notify,
                isMyContact: false,
                isBlocked: false
            };
        } catch (error) {
            console.error('Baileys getContactInfo failed:', error.message);
            return null;
        }
    }

    async sendTyping(chatId) {
        if (!this.isReady || !this.sock || !chatId) return;
        try {
            await this.sock.sendPresenceUpdate('composing', this.normalizeIncomingJid(chatId));
        } catch (_) { /* typing is cosmetic */ }
    }

    markAsRead() {
        // Not needed for the current backend contract.
    }

    scheduleReconnect(delayMs) {
        if (this.isReconnecting) {
            console.log(`Baileys user ${this.userId}: reconnect already scheduled, skipping`);
            return;
        }

        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error(`Baileys user ${this.userId}: max reconnect attempts exceeded`);
            this.sendWebhook('/whatsapp/reconnect-failed', {
                userId: this.userId,
                attempts: this.reconnectAttempts - 1,
                reason: 'Max reconnect attempts exceeded'
            });
            return;
        }

        const backoffDelay = delayMs || Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
        this.isReconnecting = true;

        setTimeout(async () => {
            try {
                console.log(`Baileys user ${this.userId}: reconnect attempt ${this.reconnectAttempts}`);
                await this.closeSocket();
                await this.initialize();
            } catch (error) {
                console.error(`Baileys reconnect failed for user ${this.userId}:`, error.message);
            } finally {
                this.isReconnecting = false;
            }
        }, backoffDelay);
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.sock?.ws || this.sock.ws.readyState > 1) {
                console.warn(`Baileys user ${this.userId}: socket heartbeat detected closed websocket`);
                this.isReady = false;
                this.scheduleReconnect(2000);
            }
        }, 30000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    async disconnect(clearSession = false) {
        console.log(`Disconnecting Baileys client for user ${this.userId} (clearSession=${clearSession})...`);
        this.intentionalDisconnect = true;
        this.isReady = false;
        this.isAuthenticated = false;
        this.qrCode = null;
        this.initializationError = null;
        this.stopHeartbeat();

        if (clearSession && this.sock) {
            try {
                await this.withTimeout(this.sock.logout(), 10000, 'Baileys logout timed out');
            } catch (error) {
                console.error(`Baileys logout error for user ${this.userId}:`, error.message);
            }
        }

        await this.closeSocket();

        if (clearSession) {
            await this.clearSessionFiles();
        }

        console.log(`Disconnected Baileys client for user ${this.userId}`);
    }

    async closeSocket() {
        if (!this.sock) return;
        try {
            this.sock.ev.removeAllListeners('connection.update');
            this.sock.ev.removeAllListeners('messages.upsert');
            this.sock.ev.removeAllListeners('creds.update');
            this.sock.end?.(undefined);
            this.sock.ws?.close?.();
        } catch (error) {
            console.error(`Baileys socket close error for user ${this.userId}:`, error.message);
        } finally {
            this.sock = null;
        }
    }

    async clearSessionFiles() {
        const sessionPath = this.getSessionPath();
        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`Cleared Baileys session files for user ${this.userId} at ${sessionPath}`);
            }
        } catch (error) {
            console.error(`Error clearing Baileys session files for user ${this.userId}:`, error.message);
        }
    }

    getSessionPath() {
        return path.join('./storage/sessions', `baileys-user-${this.userId}`);
    }

    async formatChatId(to) {
        if (to.includes('@lid') || to.includes('@s.whatsapp.net') || to.includes('@g.us')) {
            return to;
        }

        if (to.includes('@c.us')) {
            return to.replace('@c.us', '@s.whatsapp.net');
        }

        const cleanNumber = to.startsWith('+') ? to.substring(1) : to.replace(/\D/g, '');
        if (!cleanNumber) {
            throw new Error('Invalid phone number');
        }

        try {
            const results = await this.sock.onWhatsApp(cleanNumber);
            const match = results?.find(result => result.exists);
            if (match?.jid) return match.jid;
            return {
                success: false,
                error: 'Number is not registered on WhatsApp',
                phoneNumber: to
            };
        } catch (error) {
            console.warn(`Baileys onWhatsApp lookup failed for ${cleanNumber}, falling back:`, error.message);
        }

        return `${cleanNumber}@s.whatsapp.net`;
    }

    resolveSender(message) {
        const participant = message.key.participant;
        const remoteJid = message.key.remoteJid;
        return this.normalizeIncomingJid(participant || remoteJid);
    }

    normalizeIncomingJid(jid) {
        if (!jid) return jid;
        if (jid.endsWith('@s.whatsapp.net')) return jid.replace('@s.whatsapp.net', '@c.us');
        return jid;
    }

    getOwnPhoneNumber() {
        const jid = this.sock?.user?.id;
        if (!jid) return undefined;
        try {
            return this.baileys.jidDecode(jid)?.user || jid.split('@')[0];
        } catch (_) {
            return jid.split('@')[0];
        }
    }

    extractText(content, messageType) {
        if (!content || !messageType) return '';
        const node = content[messageType] || {};
        switch (messageType) {
            case 'conversation':
                return content.conversation || '';
            case 'extendedTextMessage':
                return node.text || '';
            case 'imageMessage':
            case 'videoMessage':
            case 'documentMessage':
            case 'audioMessage':
                return node.caption || '';
            case 'buttonsResponseMessage':
                return node.selectedDisplayText || node.selectedButtonId || '';
            case 'listResponseMessage':
                return node.title || node.singleSelectReply?.selectedRowId || '';
            default:
                return node.text || node.caption || '';
        }
    }

    mapMessageType(messageType) {
        switch (messageType) {
            case 'conversation':
            case 'extendedTextMessage':
                return 'chat';
            case 'imageMessage':
                return 'image';
            case 'videoMessage':
                return 'video';
            case 'documentMessage':
                return 'document';
            case 'audioMessage':
                return 'audio';
            case 'stickerMessage':
                return 'sticker';
            case 'locationMessage':
                return 'location';
            case 'contactMessage':
            case 'contactsArrayMessage':
                return 'contact';
            default:
                return messageType || 'unknown';
        }
    }

    isMediaType(messageType) {
        return ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(messageType);
    }

    async withTimeout(promise, timeoutMs, message) {
        let timeout;
        try {
            return await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
                })
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    async sendWebhook(endpoint, data) {
        try {
            await axios.post(`${this.webhookUrl}${endpoint}`, data, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': process.env.WEBHOOK_API_KEY
                },
                timeout: 10000
            });
        } catch (error) {
            console.error(`Error sending Baileys webhook to ${endpoint}:`, error.message);
        }
    }
}

module.exports = BaileysClient;
