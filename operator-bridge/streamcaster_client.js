const crypto = require('crypto');

class StreamCasterClient {
    constructor({
        baseUrl,
        token,
        bridgeId,
        sessionId = crypto.randomUUID(),
        fetchImpl = global.fetch,
        now = Date.now,
        idFactory = crypto.randomUUID
    }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token;
        this.bridgeId = bridgeId;
        this.sessionId = sessionId;
        this.fetch = fetchImpl;
        this.now = now;
        this.idFactory = idFactory;
        this.sequence = 0;
    }

    claimDirector() {
        return this.post('/api/blmf/director/claim', { bridgeId: this.bridgeId });
    }

    heartbeatDirector() {
        return this.post('/api/blmf/director/heartbeat', { bridgeId: this.bridgeId });
    }

    releaseDirector() {
        return this.post('/api/blmf/director/release', { bridgeId: this.bridgeId });
    }

    sendCommand(command) {
        this.sequence += 1;
        return this.post('/api/blmf/commands', {
            command,
            bridgeId: this.bridgeId,
            sessionId: this.sessionId,
            commandId: this.idFactory(),
            sequence: this.sequence,
            sentAt: this.now()
        });
    }

    getState() {
        return this.request(`/api/blmf/state?bridgeId=${encodeURIComponent(this.bridgeId)}`, {
            method: 'GET'
        });
    }

    post(path, body) {
        return this.request(path, {
            method: 'POST',
            body: JSON.stringify(body)
        });
    }

    async request(path, options) {
        const headers = {
            Authorization: `Bearer ${this.token}`
        };
        if (options.body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        try {
            const response = await this.fetch(`${this.baseUrl}${path}`, {
                ...options,
                headers
            });
            const data = await response.json();
            if (response.ok) {
                return data;
            }
            return { ...data, ok: false, status: response.status };
        } catch (error) {
            return {
                ok: false,
                reason: 'network_error',
                error: error.message
            };
        }
    }
}

module.exports = StreamCasterClient;
