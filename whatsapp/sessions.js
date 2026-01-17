const WhatsAppClient = require('./client');

class SessionManager {
    constructor(springBootUrl) {
        this.sessions = new Map(); // userId -> WhatsAppClient
        this.springBootUrl = springBootUrl;
    }

    async createSession(userId) {
        if (this.sessions.has(userId)) {
            throw new Error(`Session already exists for user ${userId}`);
        }

        const client = new WhatsAppClient(userId, this.springBootUrl);
        this.sessions.set(userId, client);

        await client.initialize();

        return client;
    }

    getSession(userId) {
        return this.sessions.get(userId);
    }

    async destroySession(userId) {
        const client = this.sessions.get(userId);
        if (client) {
            await client.disconnect();
            this.sessions.delete(userId);
        }
    }

    getAllSessions() {
        return Array.from(this.sessions.keys());
    }

    hasSession(userId) {
        return this.sessions.has(userId);
    }

    getSessionStatus(userId) {
        const client = this.sessions.get(userId);
        if (!client) {
            return { exists: false, connected: false };
        }
        return { exists: true, connected: client.isReady };
    }
}

module.exports = SessionManager;
