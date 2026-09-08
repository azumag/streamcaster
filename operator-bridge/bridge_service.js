const COMMAND_ADDRESS = '/avatar/parameters/BLMF_Command';
const FEEDBACK = {
    ready: '/avatar/parameters/BLMF_Ready',
    onAir: '/avatar/parameters/BLMF_OnAir',
    error: '/avatar/parameters/BLMF_Error',
    isDirector: '/avatar/parameters/BLMF_IsDirector',
    currentEntryIndex: '/avatar/parameters/BLMF_CurrentEntryIndex'
};

class BridgeService {
    constructor({
        oscPort,
        client,
        decoder,
        pollIntervalMs = 1000,
        heartbeatIntervalMs = 5000,
        logger = console,
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval
    }) {
        this.oscPort = oscPort;
        this.client = client;
        this.decoder = decoder;
        this.pollIntervalMs = pollIntervalMs;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.logger = logger;
        this.setIntervalFn = setIntervalFn;
        this.clearIntervalFn = clearIntervalFn;
        this.pollTimer = null;
        this.heartbeatTimer = null;
        this.isDirector = false;
        this.lastFeedback = new Map();
    }

    async start() {
        this.oscPort.on('message', (message) => {
            this.handleOscMessage(message).catch((error) => this.logWarning('osc_command_failed', error.message));
        });

        const ready = new Promise((resolve, reject) => {
            let opened = false;
            this.oscPort.on('ready', async () => {
                opened = true;
                await this.pollState();
                this.startTimers();
                resolve();
            });
            this.oscPort.on('error', (error) => {
                if (!opened) {
                    reject(error);
                    return;
                }
                this.logWarning('osc_port_error', error.message);
            });
        });
        this.oscPort.open();
        return ready;
    }

    startTimers() {
        this.pollTimer = this.setIntervalFn(() => {
            this.pollState().catch((error) => this.logWarning('state_poll_failed', error.message));
        }, this.pollIntervalMs);
        this.heartbeatTimer = this.setIntervalFn(() => {
            this.heartbeat().catch((error) => this.logWarning('director_heartbeat_failed', error.message));
        }, this.heartbeatIntervalMs);
    }

    stop() {
        if (this.pollTimer) {
            this.clearIntervalFn(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.heartbeatTimer) {
            this.clearIntervalFn(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.oscPort.close();
    }

    async handleOscMessage(message) {
        if (!message || message.address !== COMMAND_ADDRESS) {
            return null;
        }
        const command = this.decoder.accept(this.extractValue(message));
        if (!command) {
            return null;
        }

        let result;
        if (command === 'CLAIM_DIRECTOR') {
            result = await this.client.claimDirector();
            if (result.ok) {
                this.isDirector = true;
            }
        } else if (command === 'RELEASE_DIRECTOR') {
            result = await this.client.releaseDirector();
            if (result.ok) {
                this.isDirector = false;
            }
        } else {
            result = await this.client.sendCommand(command);
        }

        if (!result.ok) {
            this.logWarning('operator_command_rejected', result.reason || 'unknown');
        }
        return result;
    }

    async pollState() {
        const state = await this.client.getState();
        if (!state.ok) {
            this.logWarning('state_poll_failed', state.reason || 'unknown');
            this.sendFeedback(FEEDBACK.error, true);
            return state;
        }

        this.isDirector = state.isDirector === true;
        this.sendFeedback(FEEDBACK.ready, state.state === 'READY');
        this.sendFeedback(FEEDBACK.onAir, state.state === 'ON_AIR');
        this.sendFeedback(FEEDBACK.error, state.state === 'DEGRADED' || state.error === true);
        this.sendFeedback(FEEDBACK.isDirector, this.isDirector);
        this.sendFeedback(FEEDBACK.currentEntryIndex,
            Number.isInteger(state.currentEntryIndex) ? state.currentEntryIndex : 0);
        return state;
    }

    async heartbeat() {
        if (!this.isDirector) {
            return { ok: true, skipped: true };
        }
        const result = await this.client.heartbeatDirector();
        if (!result.ok) {
            this.logWarning('director_heartbeat_failed', result.reason || 'unknown');
            if (result.reason === 'not_director') {
                this.isDirector = false;
                this.sendFeedback(FEEDBACK.isDirector, false);
            }
        }
        return result;
    }

    sendFeedback(address, value) {
        if (this.lastFeedback.get(address) === value) {
            return;
        }
        this.lastFeedback.set(address, value);
        this.oscPort.send({ address, args: [value] });
    }

    extractValue(message) {
        const value = Array.isArray(message.args) ? message.args[0] : undefined;
        if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
            return value.value;
        }
        return value;
    }

    logWarning(event, reason) {
        if (this.logger && typeof this.logger.warning === 'function') {
            this.logger.warning({ event, reason });
        } else if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn({ event, reason });
        }
    }
}

module.exports = BridgeService;
module.exports.COMMAND_ADDRESS = COMMAND_ADDRESS;
module.exports.FEEDBACK = FEEDBACK;
