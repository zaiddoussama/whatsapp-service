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
        this.isAuthenticated = false; // Track authentication state to prevent duplicate events
        this.initializationError = null;
        this.isReconnecting = false;   // Guard against concurrent reconnect attempts
        this.reconnectAttempts = 0;    // Tracks consecutive reconnect attempts for exponential backoff
        this.maxReconnectAttempts = 10; // Stop trying after this many consecutive failures
        this.heartbeatInterval = null;       // Periodic health check timer
        this.proactiveReconnectTimer = null; // Proactive reconnect to prevent ~1hr degradation
        this.recentSendFailures = [];  // Timestamps of recent send failures for storm detection
        this.provider = 'wwebjs';
        this.createdAt = new Date().toISOString();
        this.lastReadyAt = null;
        this.lastQrAt = null;
        this.lastDisconnectedAt = null;
        this.lastError = null;
        this.lastInboundAt = null;
        this.lastOutboundAt = null;
        this.connectionState = 'new';
    }

    async initialize() {
        console.log(`Initializing WhatsApp client for user ${this.userId}...`);
        this.initializationError = null;
        this.lastError = null;
        this.connectionState = 'initializing';

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
                    '--disable-gpu',
                    // Prevent Chrome from throttling/killing background tabs over time.
                    // Without these, the WhatsApp Web JS context degrades after ~1 hour.
                    '--disable-background-timer-throttling',
                    '--disable-renderer-backgrounding',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-hang-monitor',
                    '--disable-breakpad',
                    '--disable-crash-reporter',
                    '--disable-crashpad',
                    // Reduce per-instance memory footprint on constrained VPS
                    '--js-flags=--max-old-space-size=512',
                    '--disable-extensions',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--disable-translate',
                    '--metrics-recording-only',
                    '--no-default-browser-check',
                    '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider'
                ],
                timeout: 60000,
                protocolTimeout: 60000
            },
            webVersionCache: {
                type: 'none'
            }
        });

        // QR Code event - send to Spring Boot so user can scan
        this.client.on('qr', async (qr) => {
            console.log(`QR Code generated for user ${this.userId}`);
            this.qrCode = qr;
            this.isReady = false; // Reset ready state when new QR is generated
            this.isAuthenticated = false; // Reset authenticated state for new QR
            this.lastQrAt = new Date().toISOString();
            this.connectionState = 'waiting_scan';

            // Generate QR code image as base64
            const qrImage = await qrcode.toDataURL(qr);

            // Notify Spring Boot that QR is ready
            await this.sendWebhook('/whatsapp/qr-ready', {
                userId: this.userId,
                qrCode: qr,
                qrImage: qrImage
            });
        });

        // Authenticated event - QR code scanned successfully, session being established
        this.client.on('authenticated', async () => {
            // Prevent duplicate authenticated events
            if (this.isAuthenticated) {
                console.log(`User ${this.userId} already authenticated, skipping duplicate event`);
                return;
            }

            this.isAuthenticated = true;
            this.qrCode = null; // Clear QR code since it's been scanned
            console.log(`WhatsApp AUTHENTICATED for user ${this.userId} - QR scan successful`);

            // Notify Spring Boot that authentication succeeded (QR was scanned)
            await this.sendWebhook('/whatsapp/authenticated', {
                userId: this.userId,
                status: 'authenticated'
            });

            // Fallback: If 'ready' event doesn't fire within 30 seconds, check manually
            setTimeout(async () => {
                if (!this.isReady && this.client && this.client.info) {
                    console.log(`User ${this.userId}: Ready event didn't fire, but client has info - forcing ready state`);
                    this.isReady = true;
                    this.qrCode = null;

                    const info = this.client.info;
                    await this.sendWebhook('/whatsapp/connected', {
                        userId: this.userId,
                        phoneNumber: info?.wid?.user,
                        platform: info?.platform
                    });
                } else if (!this.isReady) {
                    console.log(`User ${this.userId}: Still not ready after 30s, client state: hasClient=${!!this.client}, hasInfo=${!!(this.client?.info)}`);
                }
            }, 30000);
        });

        // Loading screen event - WhatsApp is loading after authentication
        this.client.on('loading_screen', (percent, message) => {
            console.log(`WhatsApp loading for user ${this.userId}: ${percent}% - ${message}`);
        });

        // Ready event - WhatsApp is fully connected and ready to send/receive messages
        this.client.on('ready', async () => {
            console.log(`WhatsApp READY for user ${this.userId}`);

            // Prevent duplicate ready events
            if (this.isReady) {
                console.log(`User ${this.userId} already marked as ready, skipping duplicate event`);
                return;
            }

            this.isReady = true;
            this.qrCode = null;
            this.reconnectAttempts = 0; // Reset on successful connection
            this.recentSendFailures = []; // Clear failure history on fresh connection
            this.lastReadyAt = new Date().toISOString();
            this.lastError = null;
            this.connectionState = 'connected';

            const info = this.client.info;
            console.log(`User ${this.userId} connected with phone: ${info?.wid?.user}, platform: ${info?.platform}`);

            await this.sendWebhook('/whatsapp/connected', {
                userId: this.userId,
                phoneNumber: info?.wid?.user,
                platform: info?.platform
            });

            // Start heartbeat to catch silent crashes + proactive 45-min reconnect
            // to prevent the ~1 hour Chromium context degradation in production.
            this.startHeartbeat();
        });

        // Incoming message event - forward to Spring Boot
        this.client.on('message', async (message) => {
            console.log(`Message received from ${message.from}`);
            this.lastInboundAt = new Date().toISOString();

            // Send typing indicator — best effort, never block message processing
            try {
                const chat = await message.getChat();
                await chat.sendStateTyping();
            } catch (_) { /* ignore — typing is cosmetic */ }

            // Resolve the actual phone number for LID contacts
            // WhatsApp uses LID (Linked Device ID) format for unregistered contacts
            // e.g. 242958397890794@lid instead of 212619805732@c.us
            let resolvedFrom = message.from;
            const isLidContact = message.from.endsWith('@lid');

            if (isLidContact) {
                try {
                    const contact = await message.getContact();
                    if (contact.number) {
                        resolvedFrom = contact.number + '@c.us';
                        console.log(`LID resolved via contact.number: ${message.from} → ${resolvedFrom}`);
                    } else if (contact.id && contact.id._serialized && contact.id._serialized.endsWith('@c.us')) {
                        resolvedFrom = contact.id._serialized;
                        console.log(`LID resolved via contact.id: ${message.from} → ${resolvedFrom}`);
                    } else {
                        console.log(`Could not resolve LID ${message.from} to phone number, will use LID for routing`);
                    }
                } catch (err) {
                    console.error(`Error resolving LID contact ${message.from}:`, err.message);
                }
            }

            const messageData = {
                userId: this.userId,
                messageId: message.id.id,
                from: resolvedFrom,       // resolved phone or original LID
                chatId: message.from,     // always the original WhatsApp chat ID for replies
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
            this.isAuthenticated = false;
            this.lastDisconnectedAt = new Date().toISOString();
            this.lastError = reason;
            this.connectionState = 'degraded';

            await this.sendWebhook('/whatsapp/disconnected', {
                userId: this.userId,
                reason: reason
            });

            // Auto-reconnect after a short delay, preserving the saved session so the
            // user does NOT have to scan the QR code again (unless the session was
            // explicitly invalidated, in which case a new QR will be generated).
            this.scheduleReconnect(5000);
        });

        // Authentication failure
        this.client.on('auth_failure', async (error) => {
            console.error(`Auth failure for user ${this.userId}:`, error);
            this.initializationError = error.message;
            this.lastError = error.message;
            this.connectionState = 'failed';

            await this.sendWebhook('/whatsapp/auth-failed', {
                userId: this.userId,
                error: error.message
            });
        });

        // Initialize the client with timeout
        console.log(`Starting browser initialization for user ${this.userId}...`);

        // Don't await - let it initialize in background so we can return quickly
        // The QR code will be sent via webhook when ready
        this.client.initialize().catch(async (error) => {
            console.error(`Client initialization error for user ${this.userId}:`, error);
            this.initializationError = error.message;
            this.lastError = error.message;
            this.connectionState = 'failed';
            this.isReady = false;
            this.isAuthenticated = false;
            this.qrCode = null;
            await this.sendWebhook('/whatsapp/auth-failed', {
                userId: this.userId,
                reason: error.message,
                error: error.message
            });
        });

        // Give it a moment to start
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log(`Browser initialization started for user ${this.userId}`);
    }

    async sendMessage(to, message) {
        // Allow sending if ready, OR if authenticated and client has info (ready event sometimes doesn't fire)
        if (!this.isReady) {
            // Check if we're authenticated and client is actually connected
            if (this.isAuthenticated && this.client && this.client.info) {
                console.log(`User ${this.userId}: Not ready but authenticated with info - forcing ready state for sendMessage`);
                this.isReady = true;
            } else {
                throw new Error('WhatsApp client is not ready');
            }
        }

        try {
            // Format phone number - support both @c.us and @lid chat IDs
            let chatId;
            if (to.includes('@c.us') || to.includes('@lid')) {
                chatId = to;
            } else {
                // Strip '+' prefix - whatsapp-web.js expects numbers without it
                const cleanNumber = to.startsWith('+') ? to.substring(1) : to;

                // Validate that the number exists on WhatsApp before sending.
                // getNumberId returns null for numbers not registered on WhatsApp,
                // which prevents the "Cannot read properties of undefined (reading 'getChat')" crash.
                try {
                    const numberId = await this.client.getNumberId(cleanNumber);
                    if (numberId) {
                        chatId = numberId._serialized; // use the exact id WhatsApp knows about
                    } else {
                        console.warn(`User ${this.userId}: Number ${cleanNumber} is not on WhatsApp`);
                        return {
                            success: false,
                            error: 'Number is not registered on WhatsApp',
                            phoneNumber: to
                        };
                    }
                } catch (lookupErr) {
                    if (this.isBrowserCrashError(lookupErr)) {
                        // Browser/page has crashed — mark as not ready and reconnect
                        console.error(`User ${this.userId}: Browser crash detected in getNumberId, triggering reconnect:`, lookupErr.message);
                        this.isReady = false;
                        this.connectionState = 'degraded';
                        this.lastError = lookupErr.message;
                        this.scheduleReconnect(3000);
                        throw new Error('WhatsApp service is temporarily unavailable, reconnecting...');
                    }
                    // Other transient error — fall back to direct chatId
                    console.warn(`User ${this.userId}: getNumberId lookup failed, falling back to direct chatId:`, lookupErr.message);
                    chatId = `${cleanNumber}@c.us`;
                }
            }

            // sendSeen: false fixes "markedUnread" error in newer WhatsApp Web versions
            const sentMessage = await this.client.sendMessage(chatId, message, {
                sendSeen: false
            });
            this.lastOutboundAt = new Date().toISOString();

            return {
                success: true,
                messageId: sentMessage.id.id,
                timestamp: sentMessage.timestamp
            };
        } catch (error) {
            console.error('Error sending message:', error);
            this.lastError = error.message;
            this.recordSendFailure();
            if (this.isBrowserCrashError(error)) {
                // The Puppeteer execution context is gone — mark not-ready and reconnect
                this.isReady = false;
                this.connectionState = 'degraded';
                this.scheduleReconnect(3000);
            }
            throw error;
        }
    }

    async sendMediaMessage(to, mediaUrl, caption) {
        // Allow sending if ready, OR if authenticated and client has info
        if (!this.isReady) {
            if (this.isAuthenticated && this.client && this.client.info) {
                console.log(`User ${this.userId}: Not ready but authenticated with info - forcing ready state for sendMediaMessage`);
                this.isReady = true;
            } else {
                throw new Error('WhatsApp client is not ready');
            }
        }

        try {
            // Support both @c.us and @lid chat IDs
            let chatId;
            if (to.includes('@c.us') || to.includes('@lid')) {
                chatId = to;
            } else {
                const cleanNumber = to.startsWith('+') ? to.substring(1) : to;
                try {
                    const numberId = await this.client.getNumberId(cleanNumber);
                    if (numberId) {
                        chatId = numberId._serialized;
                    } else {
                        console.warn(`User ${this.userId}: Number ${cleanNumber} is not on WhatsApp`);
                        return { success: false, error: 'Number is not registered on WhatsApp', phoneNumber: to };
                    }
                } catch (lookupErr) {
                    console.warn(`User ${this.userId}: getNumberId lookup failed, falling back:`, lookupErr.message);
                    chatId = `${cleanNumber}@c.us`;
                }
            }

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
            this.lastOutboundAt = new Date().toISOString();

            return {
                success: true,
                messageId: sentMessage.id.id,
                timestamp: sentMessage.timestamp
            };
        } catch (error) {
            console.error('Error sending media:', error);
            this.lastError = error.message;
            this.recordSendFailure();
            if (this.isBrowserCrashError(error)) {
                this.isReady = false;
                this.connectionState = 'degraded';
                this.scheduleReconnect(3000);
            }
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

    async sendTyping(chatId) {
        if (!this.isReady || !this.client) return;
        try {
            const chat = await this.client.getChatById(chatId);
            await chat.sendStateTyping();
        } catch (_) { /* ignore */ }
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

    /**
     * Schedule a session-preserving reconnect attempt with exponential backoff.
     * Guards against concurrent reconnects with isReconnecting flag.
     * Backoff: 5s → 10s → 20s → 40s → 60s (capped).
     * After maxReconnectAttempts, stops trying and notifies the backend.
     */
    scheduleReconnect(delayMs) {
        if (this.isReconnecting) {
            console.log(`User ${this.userId}: reconnect already scheduled, skipping`);
            return;
        }

        this.reconnectAttempts++;

        // Check if max attempts exceeded
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error(`User ${this.userId}: max reconnect attempts (${this.maxReconnectAttempts}) exceeded, giving up`);
            this.stopHeartbeat();
            // Notify backend that reconnection has permanently failed
            this.sendWebhook('/whatsapp/reconnect-failed', {
                userId: this.userId,
                attempts: this.reconnectAttempts - 1,
                reason: 'Max reconnect attempts exceeded'
            });
            this.lastError = 'Max reconnect attempts exceeded';
            this.connectionState = 'failed';
            return;
        }

        // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
        const backoffDelay = delayMs || Math.min(5000 * Math.pow(2, this.reconnectAttempts - 1), 60000);

        this.isReconnecting = true;
        this.connectionState = 'reconnecting';
        // Stop heartbeat timers before reconnecting — they'll restart after ready fires
        this.stopHeartbeat();
        console.log(`User ${this.userId}: scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${backoffDelay}ms...`);
        setTimeout(async () => {
            try {
                console.log(`User ${this.userId}: attempting auto-reconnect (attempt ${this.reconnectAttempts})...`);
                // Destroy the broken browser instance without clearing saved session files
                if (this.client) {
                    try { await this.client.destroy(); } catch (_) { /* ignore */ }
                    this.client = null;
                }
                this.isReady = false;
                this.isAuthenticated = false;
                this.qrCode = null;
                this.connectionState = 'initializing';
                // Re-initialize — LocalAuth will restore the saved session automatically
                await this.initialize();
                console.log(`User ${this.userId}: auto-reconnect initialization triggered`);
            } catch (err) {
                console.error(`User ${this.userId}: auto-reconnect failed:`, err.message);
            } finally {
                this.isReconnecting = false;
            }
        }, backoffDelay);
    }

    /**
     * Start a 2-minute health check + a proactive 45-minute reconnect.
     * The proactive reconnect prevents the ~1-hour Chromium context degradation
     * seen in production: Chrome's background throttling slowly kills the WhatsApp
     * Web JS context, so we proactively reconnect before it degrades.
     */
    startHeartbeat() {
        this.stopHeartbeat(); // clear any stale timers first

        // Check getState() every 30 seconds — catches silent crashes quickly
        this.heartbeatInterval = setInterval(() => this.checkHealth(), 30 * 1000);

        // Proactively reconnect every 45 minutes — prevents the ~1hr degradation cycle
        this.proactiveReconnectTimer = setTimeout(() => {
            if (!this.isReconnecting) {
                console.log(`User ${this.userId}: proactive scheduled reconnect to prevent Chromium degradation`);
                this.reconnectAttempts = 0; // Reset — this is a proactive reconnect, not a failure
                this.scheduleReconnect(1000);
            }
        }, 45 * 60 * 1000);

        console.log(`User ${this.userId}: heartbeat started (health check every 30s, proactive reconnect in 45m)`);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.proactiveReconnectTimer) {
            clearTimeout(this.proactiveReconnectTimer);
            this.proactiveReconnectTimer = null;
        }
    }

    /**
     * Called by the heartbeat interval. Checks WhatsApp state and triggers
     * reconnect if the connection has silently degraded.
     */
    async checkHealth() {
        if (!this.isReady || this.isReconnecting || !this.client) return;
        try {
            const state = await this.client.getState();
            if (state !== 'CONNECTED') {
                console.warn(`User ${this.userId}: heartbeat detected bad state: ${state}, triggering reconnect`);
                this.isReady = false;
                this.scheduleReconnect(2000);
            }
        } catch (err) {
            if (this.isBrowserCrashError(err)) {
                console.warn(`User ${this.userId}: heartbeat detected browser crash, triggering reconnect:`, err.message);
                this.isReady = false;
                this.scheduleReconnect(2000);
            }
            // Non-crash errors (transient) are ignored — next heartbeat will retry
        }
    }

    /**
     * Returns true when the error is caused by a crashed Puppeteer/WWebJS
     * execution context rather than a bad phone number.
     */
    isBrowserCrashError(err) {
        const msg = err && err.message ? err.message : '';
        return (
            msg.includes('WidFactory') ||
            msg.includes('Execution context was destroyed') ||
            msg.includes('Session closed') ||
            msg.includes('Target closed') ||
            msg.includes('Protocol error') ||
            msg.includes('Cannot read properties of undefined')
        );
    }

    /**
     * Records a send failure timestamp for failure storm detection.
     * If 5+ failures occur within 10 minutes, forces a reconnect.
     */
    recordSendFailure() {
        const now = Date.now();
        this.recentSendFailures.push(now);
        // Keep only failures from the last 10 minutes
        const tenMinutesAgo = now - 10 * 60 * 1000;
        this.recentSendFailures = this.recentSendFailures.filter(ts => ts > tenMinutesAgo);
        this.checkFailureStorm();
    }

    /**
     * Detects "failure storms" — when 5+ send attempts fail within 10 minutes
     * even though the socket reports CONNECTED. This catches the case where
     * Baileys reports connected but the actual WA session is degraded.
     */
    checkFailureStorm() {
        if (this.recentSendFailures.length >= 5 && !this.isReconnecting) {
            console.warn(`User ${this.userId}: FAILURE STORM detected (${this.recentSendFailures.length} failures in 10min), forcing reconnect`);
            this.recentSendFailures = []; // Clear to prevent repeated triggers
            this.isReady = false;
            this.connectionState = 'degraded';
            this.lastError = 'Multiple send failures detected. Recovering session.';
            this.scheduleReconnect(2000);
        }
    }

    async disconnect(clearSession = false) {
        console.log(`Disconnecting WhatsApp client for user ${this.userId} (clearSession=${clearSession})...`);
        this.isReady = false;
        this.qrCode = null;
        this.initializationError = null;
        this.connectionState = 'disconnected';
        this.lastDisconnectedAt = new Date().toISOString();
        this.stopHeartbeat();

        if (this.client) {
            try {
                // If clearing session, try to logout first (this clears WhatsApp's session)
                if (clearSession && this.client.pupPage && this.client.pupBrowser) {
                    try {
                        await this.withTimeout(this.client.logout(), 10000, 'logout timed out');
                        console.log(`Logged out WhatsApp session for user ${this.userId}`);
                    } catch (logoutError) {
                        console.error(`Error during logout for user ${this.userId}:`, logoutError.message);
                        // Continue - we'll still destroy and clear files
                    }
                }

                // Gracefully destroy the client (closes browser properly)
                try {
                    await this.withTimeout(this.client.destroy(), 15000, 'browser destroy timed out');
                    console.log(`Browser closed for user ${this.userId}`);
                } catch (destroyError) {
                    console.error(`Error destroying client for user ${this.userId}:`, destroyError.message);

                    // Force kill the browser if destroy fails
                    try {
                        if (this.client.pupBrowser) {
                            await this.withTimeout(this.client.pupBrowser.close(), 5000, 'browser close timed out');
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

    getStatusMetadata() {
        const info = this.client?.info;
        const sessionAgeSeconds = Math.max(0, Math.floor((Date.now() - new Date(this.createdAt).getTime()) / 1000));
        const degradedReason = ['degraded', 'failed'].includes(this.connectionState) ? this.lastError : null;
        return {
            provider: this.provider,
            connectionState: this.connectionState,
            sessionAgeSeconds,
            createdAt: this.createdAt,
            lastReadyAt: this.lastReadyAt,
            lastQrAt: this.lastQrAt,
            lastDisconnectedAt: this.lastDisconnectedAt,
            lastError: this.lastError,
            lastInboundAt: this.lastInboundAt,
            lastOutboundAt: this.lastOutboundAt,
            reconnectCount: this.reconnectAttempts,
            reconnectAttempts: this.reconnectAttempts,
            degradedReason,
            isReconnecting: this.isReconnecting,
            phoneNumber: info?.wid?.user,
            platform: info?.platform || 'wwebjs'
        };
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
