const ALLOWED_COMMANDS = new Set(['NEXT', 'TAKE', 'ENTRY', 'VENUE', 'STANDBY', 'PANIC']);

class ControlPlane {
    constructor({ lease, ledger, coordinator, logger = console }) {
        this.lease = lease;
        this.ledger = ledger;
        this.coordinator = coordinator;
        this.logger = logger;
    }

    claim(operator, bridgeId) {
        if (!this.validBridgeId(bridgeId)) {
            return { ok: false, reason: 'bridge_id_required' };
        }
        return this.lease.claim(operator.id, bridgeId);
    }

    heartbeat(operator, bridgeId) {
        if (!this.validBridgeId(bridgeId)) {
            return { ok: false, reason: 'bridge_id_required' };
        }
        return this.lease.heartbeat(operator.id, bridgeId);
    }

    release(operator, bridgeId) {
        if (!this.validBridgeId(bridgeId)) {
            return { ok: false, reason: 'bridge_id_required' };
        }
        return this.lease.release(operator.id, bridgeId);
    }

    async command(operator, payload) {
        if (!payload || (!ALLOWED_COMMANDS.has(payload.command) &&
            !(payload.command === 'ENTRY_SCENE' && this.coordinator.pocEntrySceneEnabled === true))) {
            return { ok: false, reason: 'invalid_command' };
        }

        const replay = this.ledger.accept({
            operatorId: operator.id,
            bridgeId: payload.bridgeId,
            sessionId: payload.sessionId,
            commandId: payload.commandId,
            sequence: payload.sequence,
            sentAt: payload.sentAt
        });
        if (!replay.ok) {
            this.warn(operator, payload, replay.reason);
            return replay;
        }

        if (payload.command === 'PANIC') {
            if (operator.canPanic === false) {
                this.warn(operator, payload, 'panic_not_allowed');
                return { ok: false, reason: 'panic_not_allowed' };
            }
        } else if (!this.lease.isDirector(operator.id, payload.bridgeId)) {
            this.warn(operator, payload, 'director_required');
            return { ok: false, reason: 'director_required', director: this.lease.snapshot() };
        }

        const result = payload.command === 'PANIC'
            ? await this.coordinator.execute(payload.command)
            : await this.coordinator.execute(payload.command, {
                entryId: payload.entryId,
                authorize: () => this.lease.isDirector(operator.id, payload.bridgeId),
                isFresh: () => this.ledger.isFresh(payload.sentAt)
            });
        this.logger.info({
            event: 'blmf_command',
            operatorId: operator.id,
            bridgeId: payload.bridgeId,
            command: payload.command,
            commandId: payload.commandId,
            ok: result.ok,
            state: result.state,
            reason: result.reason
        });
        return result;
    }

    state(operator, bridgeId) {
        return {
            ok: true,
            operatorId: operator.id,
            isDirector: this.validBridgeId(bridgeId) && this.lease.isDirector(operator.id, bridgeId),
            director: this.lease.snapshot(),
            ...this.coordinator.snapshot()
        };
    }

    validBridgeId(bridgeId) {
        return typeof bridgeId === 'string' && bridgeId.trim().length > 0;
    }

    warn(operator, payload, reason) {
        if (this.logger && typeof this.logger.warning === 'function') {
            this.logger.warning({
                event: 'blmf_command_rejected',
                operatorId: operator.id,
                bridgeId: payload && payload.bridgeId,
                command: payload && payload.command,
                reason
            });
        }
    }
}

module.exports = ControlPlane;
