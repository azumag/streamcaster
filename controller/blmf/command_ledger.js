class CommandLedger {
    constructor({ maxAgeMs = 10000, now = Date.now } = {}) {
        this.maxAgeMs = maxAgeMs;
        this.now = now;
        this.commandIds = new Set();
        this.lastSequences = new Map();
    }

    accept(envelope) {
        if (!this.isValidEnvelope(envelope)) {
            return { ok: false, reason: 'invalid_envelope' };
        }

        if (!this.isFresh(envelope.sentAt)) {
            return { ok: false, reason: 'stale_command' };
        }

        if (this.commandIds.has(envelope.commandId)) {
            return { ok: false, reason: 'duplicate_command' };
        }

        const sequenceKey = [envelope.operatorId, envelope.bridgeId, envelope.sessionId].join(':');
        const lastSequence = this.lastSequences.get(sequenceKey);
        if (lastSequence !== undefined && envelope.sequence <= lastSequence) {
            return { ok: false, reason: 'out_of_order' };
        }

        this.commandIds.add(envelope.commandId);
        this.lastSequences.set(sequenceKey, envelope.sequence);
        return { ok: true };
    }

    isFresh(sentAt) {
        return Number.isFinite(sentAt) && Math.abs(this.now() - sentAt) <= this.maxAgeMs;
    }

    isValidEnvelope(envelope) {
        return !!envelope &&
            typeof envelope.operatorId === 'string' && envelope.operatorId.length > 0 &&
            typeof envelope.bridgeId === 'string' && envelope.bridgeId.length > 0 &&
            typeof envelope.sessionId === 'string' && envelope.sessionId.length > 0 &&
            typeof envelope.commandId === 'string' && envelope.commandId.length > 0 &&
            Number.isInteger(envelope.sequence) && envelope.sequence >= 0 &&
            Number.isFinite(envelope.sentAt);
    }
}

module.exports = CommandLedger;
