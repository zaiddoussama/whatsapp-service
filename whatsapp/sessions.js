const WhatsAppClient = require('./client');
const fs = require('fs');
const path = require('path');

class SessionManager {
    constructor(springBootUrl) {
        this.sessions = new Map(); // userId -> WhatsAppClient
        this.springBootUrl = springBootUrl;
        this.sessionsPath = './storage/sessions';
    }

    /**
     * Restore all sessions from disk on startup.
     * This scans the sessions directory and reinitializes clients for existing sessions.
     */
    async restoreSessions() {
        console.log('Checking for existing sessions to restore...');

        try {
            // Ensure the sessions directory exists
            if (!fs.existsSync(this.sessionsPath)) {
                fs.mkdirSync(this.sessionsPath, { recursive: true });
                console.log('No existing sessions found (directory created)');
                return;
            }

            // List session directories (format: session-user-{userId})
            const entries = fs.readdirSync(this.sessionsPath, { withFileTypes: true });
            const sessionDirs = entries
                .filter(entry => entry.isDirectory() && entry.name.startsWith('session-user-'))
                .map(entry => {
                    const match = entry.name.match(/session-user-(\d+)/);
                    return match ? parseInt(match[1]) : null;
                })
                .filter(userId => userId !== null);

            if (sessionDirs.length === 0) {
                console.log('No existing sessions found');
                return;
            }

            console.log(`Found ${sessionDirs.length} session(s) to restore: ${sessionDirs.join(', ')}`);

            // Restore each session
            for (const userId of sessionDirs) {
                try {
                    console.log(`Restoring session for user ${userId}...`);
                    await this.createSession(userId);
                    console.log(`✓ Session restored for user ${userId}`);
                } catch (error) {
                    console.error(`✗ Failed to restore session for user ${userId}:`, error.message);
                }
            }

            console.log('Session restoration complete');
        } catch (error) {
            console.error('Error restoring sessions:', error);
        }
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

    async destroySession(userId, clearSession = false) {
        const client = this.sessions.get(userId);
        if (client) {
            await client.disconnect(clearSession);
            this.sessions.delete(userId);
        } else if (clearSession) {
            // Even if no in-memory session, try to clear files on disk
            const tempClient = new WhatsAppClient(userId, this.springBootUrl);
            await tempClient.clearSessionFiles();
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
