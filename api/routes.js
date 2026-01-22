const express = require('express');
const router = express.Router();

module.exports = (sessionManager) => {
    // Initialize WhatsApp for a user
    router.post('/init', async (req, res) => {
        try {
            const { userId, force, clearSession } = req.body;

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

            // Determine if we should clear session files (force implies clearSession)
            const shouldClearSession = clearSession || force;

            // If session exists and force=true, destroy it first
            if (sessionManager.hasSession(userId)) {
                if (force) {
                    console.log(`Force reinitializing session for user ${userId} (clearSession=${shouldClearSession})`);
                    try {
                        await sessionManager.destroySession(userId, shouldClearSession);
                    } catch (err) {
                        console.error(`Error destroying old session: ${err.message}`);
                        // Force remove from map if destroy fails
                        sessionManager.sessions.delete(userId);
                    }
                } else {
                    return res.status(400).json({
                        error: 'Session already exists for this user',
                        userId: userId,
                        hint: 'Use force=true to reinitialize'
                    });
                }
            } else if (shouldClearSession) {
                // No in-memory session but user wants to clear - clear any leftover files
                console.log(`Clearing leftover session files for user ${userId}`);
                await sessionManager.destroySession(userId, true);
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

    // Reconnect WhatsApp - clears old session and generates new QR code
    // This is the user-friendly endpoint for "Generate New QR Code"
    router.post('/reconnect', async (req, res) => {
        try {
            const { userId } = req.body;

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

            console.log(`Reconnecting WhatsApp for user ${userId} - clearing old session and generating new QR`);

            // Destroy existing session and clear all session files
            try {
                await sessionManager.destroySession(userId, true);
            } catch (err) {
                console.error(`Error destroying session during reconnect: ${err.message}`);
                sessionManager.sessions.delete(userId);
            }

            // Create fresh session
            await sessionManager.createSession(userId);

            res.json({
                success: true,
                message: 'WhatsApp reconnection started. A new QR code will be generated.',
                userId: userId,
                nextStep: 'Poll /api/qr/{userId} or wait for qr-ready webhook'
            });
        } catch (error) {
            console.error('Error in /reconnect:', error);
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
            const client = sessionManager.getSession(userId);
            const status = sessionManager.getSessionStatus(userId);

            let statusStr = 'no_session';
            let action = null;
            let actionHint = null;

            if (status.exists) {
                if (status.connected) {
                    statusStr = 'connected';
                } else if (client && client.initializationError) {
                    statusStr = 'error';
                    action = 'reconnect';
                    actionHint = 'Call POST /api/reconnect with {userId} to generate a new QR code';
                } else if (client && client.qrCode) {
                    statusStr = 'waiting_scan';
                    action = 'scan_qr';
                    actionHint = 'Scan the QR code with WhatsApp on your phone';
                } else {
                    statusStr = 'initializing';
                    action = 'wait_or_reconnect';
                    actionHint = 'Wait for QR code, or call POST /api/reconnect to force a new session';
                }
            } else {
                action = 'init';
                actionHint = 'Call POST /api/init with {userId} to start a new session';
            }

            const response = {
                userId: userId,
                sessionExists: status.exists,
                connected: status.connected,
                status: statusStr,
                action: action,
                actionHint: actionHint
            };

            // Add error info if there was an initialization error
            if (client && client.initializationError) {
                response.error = client.initializationError;
            }

            // Add phone info if connected
            if (client && client.isReady && client.client && client.client.info) {
                response.phoneNumber = client.client.info.wid.user;
                response.platform = client.client.info.platform;
            }

            // Add QR code if available and not connected
            if (client && client.qrCode && !client.isReady) {
                response.qrCode = client.qrCode;
            }

            res.json(response);
        } catch (error) {
            console.error('Error in /status:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Disconnect WhatsApp
    router.post('/disconnect', async (req, res) => {
        try {
            const { userId, clearSession } = req.body;

            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }

            await sessionManager.destroySession(userId, clearSession || false);

            res.json({
                success: true,
                message: clearSession
                    ? 'WhatsApp disconnected and session cleared. You will need to scan QR code again.'
                    : 'WhatsApp disconnected successfully. Session preserved for quick reconnect.'
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
