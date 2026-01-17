const express = require('express');
const router = express.Router();

module.exports = (sessionManager) => {
    // Initialize WhatsApp for a user
    router.post('/init', async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

            if (sessionManager.hasSession(userId)) {
                return res.status(400).json({
                    error: 'Session already exists for this user',
                    userId: userId
                });
            }

            await sessionManager.createSession(userId);

            res.json({
                success: true,
                message: 'WhatsApp initialization started. Check for QR code webhook.',
                userId: userId
            });
        } catch (error) {
            console.error('Error in /init:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get QR code for scanning
    router.get('/qr/:userId', async (req, res) => {
        try {
            const userId = parseInt(req.params.userId);
            const client = sessionManager.getSession(userId);

            if (!client) {
                return res.status(404).json({ error: 'Session not found' });
            }

            if (client.isReady) {
                return res.json({
                    success: true,
                    status: 'connected',
                    message: 'WhatsApp is already connected'
                });
            }

            if (!client.qrCode) {
                return res.json({
                    success: false,
                    status: 'initializing',
                    message: 'QR code not yet generated'
                });
            }

            res.json({
                success: true,
                status: 'waiting_scan',
                qrCode: client.qrCode
            });
        } catch (error) {
            console.error('Error in /qr:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Send text message
    router.post('/send-message', async (req, res) => {
        try {
            const { userId, to, message } = req.body;

            if (!userId || !to || !message) {
                return res.status(400).json({
                    error: 'userId, to, and message are required'
                });
            }

            const client = sessionManager.getSession(userId);

            if (!client || !client.isReady) {
                return res.status(400).json({
                    error: 'WhatsApp is not connected for this user'
                });
            }

            const result = await client.sendMessage(to, message);

            res.json({
                success: true,
                ...result
            });
        } catch (error) {
            console.error('Error in /send-message:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Send bulk messages
    router.post('/send-bulk', async (req, res) => {
        try {
            const { userId, messages } = req.body;
            // messages = [{to: "phone", message: "text"}, ...]

            if (!userId || !messages || !Array.isArray(messages)) {
                return res.status(400).json({
                    error: 'userId and messages array are required'
                });
            }

            const client = sessionManager.getSession(userId);

            if (!client || !client.isReady) {
                return res.status(400).json({
                    error: 'WhatsApp is not connected'
                });
            }

            const results = [];

            for (const msg of messages) {
                try {
                    const result = await client.sendMessage(msg.to, msg.message);
                    results.push({
                        to: msg.to,
                        success: true,
                        ...result
                    });

                    // Delay between messages to avoid spam detection
                    const delay = Math.random() * 5000 + 3000; // 3-8 seconds
                    await new Promise(resolve => setTimeout(resolve, delay));
                } catch (error) {
                    results.push({
                        to: msg.to,
                        success: false,
                        error: error.message
                    });
                }
            }

            res.json({
                success: true,
                results: results,
                sent: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            });
        } catch (error) {
            console.error('Error in /send-bulk:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Send media message
    router.post('/send-media', async (req, res) => {
        try {
            const { userId, to, mediaUrl, caption } = req.body;

            if (!userId || !to || !mediaUrl) {
                return res.status(400).json({
                    error: 'userId, to, and mediaUrl are required'
                });
            }

            const client = sessionManager.getSession(userId);

            if (!client || !client.isReady) {
                return res.status(400).json({
                    error: 'WhatsApp is not connected'
                });
            }

            const result = await client.sendMediaMessage(to, mediaUrl, caption);

            res.json({
                success: true,
                ...result
            });
        } catch (error) {
            console.error('Error in /send-media:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get contact info
    router.get('/contact/:userId/:phoneNumber', async (req, res) => {
        try {
            const userId = parseInt(req.params.userId);
            const { phoneNumber } = req.params;

            const client = sessionManager.getSession(userId);

            if (!client || !client.isReady) {
                return res.status(400).json({
                    error: 'WhatsApp is not connected'
                });
            }

            const contactInfo = await client.getContactInfo(phoneNumber);

            if (!contactInfo) {
                return res.status(404).json({ error: 'Contact not found' });
            }

            res.json({
                success: true,
                contact: contactInfo
            });
        } catch (error) {
            console.error('Error in /contact:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get session status
    router.get('/status/:userId', async (req, res) => {
        try {
            const userId = parseInt(req.params.userId);
            const status = sessionManager.getSessionStatus(userId);

            res.json({
                userId: userId,
                sessionExists: status.exists,
                connected: status.connected,
                status: !status.exists ? 'no_session' : (status.connected ? 'connected' : 'initializing')
            });
        } catch (error) {
            console.error('Error in /status:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Disconnect WhatsApp
    router.post('/disconnect', async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

            await sessionManager.destroySession(userId);

            res.json({
                success: true,
                message: 'WhatsApp disconnected successfully'
            });
        } catch (error) {
            console.error('Error in /disconnect:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Health check
    router.get('/health', (req, res) => {
        const activeSessions = sessionManager.getAllSessions();

        res.json({
            status: 'ok',
            service: 'whatsapp-web.js',
            activeSessions: activeSessions.length,
            sessions: activeSessions
        });
    });

    return router;
};
