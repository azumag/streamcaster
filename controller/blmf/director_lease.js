class DirectorLease {
    constructor({ ttlMs = 15000, now = Date.now } = {}) {
        this.ttlMs = ttlMs;
        this.now = now;
        this.holder = null;
    }

    claim(operatorId, bridgeId) {
        this.expireIfNeeded();
        if (this.holder && !this.matches(operatorId, bridgeId)) {
            return { ok: false, reason: 'director_busy', director: this.snapshot() };
        }
        this.holder = {
            operatorId,
            bridgeId,
            expiresAt: this.now() + this.ttlMs
        };
        return { ok: true, director: this.snapshot() };
    }

    heartbeat(operatorId, bridgeId) {
        this.expireIfNeeded();
        if (!this.holder || !this.matches(operatorId, bridgeId)) {
            return { ok: false, reason: 'not_director', director: this.snapshot() };
        }
        this.holder.expiresAt = this.now() + this.ttlMs;
        return { ok: true, director: this.snapshot() };
    }

    release(operatorId, bridgeId) {
        this.expireIfNeeded();
        if (!this.holder || !this.matches(operatorId, bridgeId)) {
            return { ok: false, reason: 'not_director', director: this.snapshot() };
        }
        this.holder = null;
        return { ok: true, director: null };
    }

    isDirector(operatorId, bridgeId) {
        this.expireIfNeeded();
        return !!this.holder && this.matches(operatorId, bridgeId);
    }

    snapshot() {
        this.expireIfNeeded();
        return this.holder ? { ...this.holder } : null;
    }

    matches(operatorId, bridgeId) {
        return this.holder.operatorId === operatorId && this.holder.bridgeId === bridgeId;
    }

    expireIfNeeded() {
        if (this.holder && this.now() >= this.holder.expiresAt) {
            this.holder = null;
        }
    }
}

module.exports = DirectorLease;
