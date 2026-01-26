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

        // Clean up stale Chrome lock files before starting
        await this.cleanupLockFiles();

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
                type: 'remote',
                remotePath: 'https://raw.githubusercontent.com/AhmadMBaker/AhmadMBaker.github.io/refs/heads/main/wa-version.json'
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
        console.log(`Disconnecting WhatsApp client for user ${this.userId} (clearSession=${clearSession})...`);
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

                // Gracefully destroy the client (closes browser properly)
                try {
                    await this.client.destroy();
                    console.log(`Browser closed for user ${this.userId}`);
                } catch (destroyError) {
                    console.error(`Error destroying client for user ${this.userId}:`, destroyError.message);

                    // Force kill the browser if destroy fails
                    try {
                        if (this.client.pupBrowser) {
                            await this.client.pupBrowser.close();
                            console.log(`Force closed browser for user ${this.userId}`);
                        }
                    } catch (forceCloseError) {
                        // Ignore
                    }
                }
            } catch (error) {
                console.error(`Error during disconnect for user ${this.userId}:`, error.message);
            }
            this.client = null;
        }

        // If clearing session, delete the session files from disk
        if (clearSession) {
            await this.clearSessionFiles();
        }

        console.log(`Disconnected WhatsApp client for user ${this.userId}`);
    }

    /**
     * Clean up stale Chrome lock files that prevent browser from starting.
     * This happens when the container crashes or doesn't shut down cleanly.
     * Chrome stores the hostname in these files, so when Docker container ID changes,
     * Chrome thinks "another computer" is using the profile.
     */
    async cleanupLockFiles() {
        const sessionPath = this.getSessionPath();
        console.log(`Cleaning lock files in: ${sessionPath}`);

        if (!fs.existsSync(sessionPath)) {
            console.log(`Session path does not exist yet: ${sessionPath}`);
            return;
        }

        // Recursively find and delete all lock files
        const cleanDirectory = (dir) => {
            let cleaned = 0;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);

                    // Check if it's a lock file by name
                    const isLockFile = [
                        'SingletonLock', 'SingletonSocket', 'SingletonCookie',
                        'lockfile', 'LOCK', '.lock'
                    ].some(lock => entry.name === lock || entry.name.endsWith('.lock'));

                    if (isLockFile) {
                        try {
                            if (entry.isDirectory()) {
                                fs.rmSync(fullPath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(fullPath);
                            }
                            console.log(`  Removed lock: ${fullPath}`);
                            cleaned++;
                        } catch (e) {
                            console.log(`  Failed to remove: ${fullPath} - ${e.message}`);
                        }
                    } else if (entry.isDirectory()) {
                        // Recurse into subdirectories
                        cleaned += cleanDirectory(fullPath);
                    }
                }
            } catch (error) {
                // Directory might not be readable
            }
            return cleaned;
        };

        const totalCleaned = cleanDirectory(sessionPath);
        console.log(`Lock file cleanup complete: ${totalCleaned} file(s) removed`);
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
