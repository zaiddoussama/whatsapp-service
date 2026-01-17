const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');

class WhatsAppClient {
    constructor(userId, springBootWebhookUrl) {
        this.userId = userId;
        this.webhookUrl = springBootWebhookUrl;
        this.client = null;
        this.qrCode = null;
        this.isReady = false;
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

            await this.sendWebhook('/whatsapp/auth-failed', {
                userId: this.userId,
                error: error.message
            });
        });

        // Initialize the client
        await this.client.initialize();
    }

    async sendMessage(to, message) {
        if (!this.isReady) {
            throw new Error('WhatsApp client is not ready');
        }

        try {
            // Format phone number (must include country code)
            const chatId = to.includes('@c.us') ? to : `${to}@c.us`;

            const sentMessage = await this.client.sendMessage(chatId, message);

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
                caption: caption
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
        try {
            const message = await this.client.getMessageById(messageId);
            if (message) {
                const chat = await message.getChat();
                await chat.sendSeen();
            }
        } catch (error) {
            console.error('Error marking as read:', error);
        }
    }

    async disconnect() {
        if (this.client) {
            await this.client.destroy();
            this.isReady = false;
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
            console.error(`Error sending webhook to ${endpoint}:`, error.message);
            // Don't throw - webhook failures shouldn't break WhatsApp
        }
    }
}

module.exports = WhatsAppClient;
