require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const SessionManager = require('./whatsapp/sessions');
const createRoutes = require('./api/routes');

const app = express();
const PORT = process.env.PORT || 3000;
const SPRING_BOOT_URL = process.env.SPRING_BOOT_URL || 'http://localhost:8080/api';

console.log('=================================================');
console.log('   WhatsApp Web.js Service Starting...         ');
console.log('=================================================');
console.log(`Port: ${PORT}`);
console.log(`Spring Boot Webhook URL: ${SPRING_BOOT_URL}`);
console.log('=================================================\n');

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// API Key authentication middleware
app.use((req, res, next) => {
    // Skip health check
    if (req.path === '/api/health') {
        return next();
    }

    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized - Invalid API Key' });
    }
    next();
});

// Initialize session manager
const sessionManager = new SessionManager(SPRING_BOOT_URL);

// Routes
app.use('/api', createRoutes(sessionManager));

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'WhatsApp Web.js API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /api/health',
            init: 'POST /api/init',
            qr: 'GET /api/qr/:userId',
            sendMessage: 'POST /api/send-message',
            sendBulk: 'POST /api/send-bulk',
            sendMedia: 'POST /api/send-media',
            status: 'GET /api/status/:userId',
            disconnect: 'POST /api/disconnect'
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.path,
        method: req.method
    });
});

// Error handling
app.use((error, req, res, next) => {
    console.error('Error:', error);
    res.status(500).json({
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log('\n✅ WhatsApp Service is running!');
    console.log(`📡 Listening on http://localhost:${PORT}`);
    console.log(`🔗 Spring Boot: ${SPRING_BOOT_URL}`);
    console.log('\nReady to accept requests!\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n\n⚠️  Shutting down gracefully...');

    const sessions = sessionManager.getAllSessions();
    console.log(`Disconnecting ${sessions.length} active sessions...`);

    for (const userId of sessions) {
        try {
            await sessionManager.destroySession(userId);
            console.log(`✓ Disconnected user ${userId}`);
        } catch (error) {
            console.error(`✗ Error disconnecting user ${userId}:`, error.message);
        }
    }

    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    process.kill(process.pid, 'SIGINT');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
