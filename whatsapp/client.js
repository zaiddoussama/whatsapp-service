const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class WhatsAppClient {
    constructor(userId, springBootWebhookUrl) {
        this.userId = userId;
        this.webhookUrl = springBootWebhookUrl;
        this.client = null;
        this.qrCode = null;
        this.isReady = false;
        this.initializationError = null;
    }

    async initialize() {
        console.log(`Initializing WhatsApp client for user ${this.userId}...`);

        // Create client with persistent session
        this.client = new Client({
            authStrategy: new LocalAuth({
                clientId: `user-${this.userId}`,
                dataPath: './storage/sessions'
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            },
            webVersionCache: {
                type: 'none'
            }
        });

        // QR Code event - send to Spring Boot so user can scan
        this.client.on('qr', async (qr) => {
            console.log(`QR Code generated for user ${this.userId}`);
            this.qrCode = qr;

            // Generate QR code image as base64
            const qrImage = await qrcode.toDataURL(qr);

            // Notify Spring Boot that QR is ready
            await this.sendWebhook('/whatsapp/qr-ready', {
                userId: this.userId,
                qrCode: qr,
                qrImage: qrImage
            });
        });

        // Ready event - WhatsApp is connected
        this.client.on('ready', async () => {
            console.log(`WhatsApp ready for user ${this.userId}`);
            this.isReady = true;

            const info = this.client.info;
            await this.sendWebhook('/whatsapp/connected', {
                userId: this.userId,
                phoneNumber: info.wid.user,
                platform: info.platform
            });
        });

        // Incoming message event - forward to Spring Boot
        this.client.on('message', async (message) => {
            console.log(`Message received from ${message.from}`);

            const messageData = {
                userId: this.userId,
                messageId: message.id.id,
                from: message.from,
                to: message.to,
                body: message.body,
                type: message.type, // text, image, document, etc.
                timestamp: message.timestamp,
                hasMedia: message.hasMedia,
                isForwarded: message.isForwarded,
                fromMe: message.fromMe
            };

            // If message has media, download it
            if (message.hasMedia) {
                try {
                    const media = await message.downloadMedia();
                    messageData.media = {
                        mimetype: media.mimetype,
                        data: media.data, // base64
                        filename: media.filename
                    };
                } catch (error) {
                    console.error('Error downloading media:', error);
                }
            }

            // Send to Spring Boot for AI processing
            await this.sendWebhook('/whatsapp/message-received', messageData);
        });

        // Disconnected event
        this.client.on('disconnected', async (reason) => {
            console.log(`WhatsApp disconnected for user ${this.userId}: ${reason}`);
            this.isReady = false;

            await this.sendWebhook('/whatsapp/disconnected', {
                userId: this.userId,
                reason: reason
            });
        });

        // Authentication failure
        this.client.on('auth_failure', async (error) => {
            console.error(`Auth failure for user ${this.userId}:`, error);
            this.initializationError = error.message;

            await this.sendWebhook('/whatsapp/auth-failed', {
                userId: this.userId,
                error: error.message
            });
        });

        // Initialize the client with timeout
        console.log(`Starting browser initialization for user ${this.userId}...`);

        // Don't await - let it initialize in background so we can return quickly
        // The QR code will be sent via webhook when ready
        this.client.initialize().catch((error) => {
            console.error(`Client initialization error for user ${this.userId}:`, error);
            this.initializationError = error.message;
        });

        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Browser initialization started for user ${this.userId}`);
    }

    async sendMessage(to, message) {
        if (!this.isReady) {
            throw new Error('WhatsApp client is not ready');
        }

        try {
            // Format phone number (must include country code)
            const chatId = to.includes('@c.us') ? to : `${to}@c.us`;

            // sendSeen: false fixes "markedUnread" error in newer WhatsApp Web versions
            const sentMessage = await this.client.sendMessage(chatId, message, {
                sendSeen: false
            });

            return {
                success: true,
                messageId: sentMessage.id.id,
                timestamp: sentMessage.timestamp
            };
        } catch (error) {
            console.error('Error sending message:', error);
            throw error;
        }
    }

    async sendMediaMessage(to, mediaUrl, caption) {
        if (!this.isReady) {
            throw new Error('WhatsApp client is not ready');
        }

        try {
            const chatId = to.includes('@c.us') ? to : `${to}@c.us`;

            // Download media from URL
            const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
            const base64 = Buffer.from(response.data).toString('base64');

            const media = new MessageMedia(
                response.headers['content-type'],
                base64,
                'media-file'
            );

            const sentMessage = await this.client.sendMessage(chatId, media, {
                caption: caption,
                sendSeen: false
            });

            return {
                success: true,
                messageId: sentMessage.id.id,
                timestamp: sentMessage.timestamp
            };
        } catch (error) {
            console.error('Error sending media:', error);
            throw error;
        }
    }

    async getContactInfo(phoneNumber) {
        try {
            const chatId = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
            const contact = await this.client.getContactById(chatId);

            return {
                phone: contact.id.user,
                name: contact.name || contact.pushname,
                isMyContact: contact.isMyContact,
                isBlocked: contact.isBlocked
            };
        } catch (error) {
            console.error('Error getting contact info:', error);
            return null;
        }
    }

    async markAsRead(messageId) {
        // Note: sendSeen is currently broken in newer WhatsApp Web versions
        // Skipping this functionality until whatsapp-web.js fixes it
        try {
            console.log(`markAsRead called for ${messageId} - skipped due to WhatsApp Web API changes`);
            // const message = await this.client.getMessageById(messageId);
            // if (message) {
            //     const chat = await message.getChat();
            //     await chat.sendSeen();
            // }
        } catch (error) {
            console.error('Error marking as read:', error);
        }
    }

    async disconnect(clearSession = false) {
        this.isReady = false;
        this.qrCode = null;
        this.initializationError = null;

        if (this.client) {
            try {
                // If clearing session, try to logout first (this clears WhatsApp's session)
                if (clearSession) {
                    try {
                        await this.client.logout();
                        console.log(`Logged out WhatsApp session for user ${this.userId}`);
                    } catch (logoutError) {
                        console.error(`Error during logout for user ${this.userId}:`, logoutError.message);
                        // Continue - we'll still destroy and clear files
                    }
                }
                await this.client.destroy();
            } catch (error) {
                console.error(`Error destroying client for user ${this.userId}:`, error.message);
                // Continue anyway - we want to clean up the session
            }
            this.client = null;
        }

        // If clearing session, delete the session files from disk
        if (clearSession) {
            await this.clearSessionFiles();
        }
    }

    /**
     * Delete session files from disk to force a fresh QR code on next init.
     */
    async clearSessionFiles() {
        const sessionPath = path.join('./storage/sessions', `session-user-${this.userId}`);

        try {
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
                console.log(`Cleared session files for user ${this.userId} at ${sessionPath}`);
            }
        } catch (error) {
            console.error(`Error clearing session files for user ${this.userId}:`, error.message);
            // Don't throw - this shouldn't block the flow
        }
    }

    /**
     * Get the session directory path for this user.
     */
    getSessionPath() {
        return path.join('./storage/sessions', `session-user-${this.userId}`);
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
            console.error(`Error sending webhook to ${endpoint}:`, error.message);
            // Don't throw - webhook failures shouldn't break WhatsApp
        }
    }
}

module.exports = WhatsAppClient;
