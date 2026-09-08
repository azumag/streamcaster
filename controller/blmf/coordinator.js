const DEFAULT_SCENES = {
    mainVenue: 'VRC_VENUE',
    mainEntry: 'ENTRY_FULLSCREEN',
    subEntry: 'ENTRY',
    subStandby: 'STANDBY'
};

class BlmfCoordinator {
    constructor({
        mainObs,
        subObs,
        readinessProvider,
        preparer = null,
        scenes = {},
        mediaInput = 'entry_player',
        takeDelayMs = 0,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    }) {
        this.mainObs = mainObs;
        this.subObs = subObs;
        this.readinessProvider = readinessProvider || (async () => ({}));
        this.preparer = preparer;
        this.scenes = { ...DEFAULT_SCENES, ...scenes };
        this.mediaInput = mediaInput;
        this.takeDelayMs = takeDelayMs;
        this.sleep = sleep;
        this.phase = 'IDLE';
        this.programView = 'VENUE';
        this.subView = 'STANDBY';
    }

    async execute(command) {
        try {
            switch (command) {
            case 'NEXT':
                return this.prepareNext();
            case 'TAKE':
                return this.take();
            case 'VENUE':
                return this.venue();
            case 'ENTRY':
                return this.entry();
            case 'STANDBY':
                return this.standby();
            case 'PANIC':
                return this.panic();
            default:
                return this.failure('unknown_command');
            }
        } catch (error) {
            this.phase = 'DEGRADED';
            return this.failure('command_failed', { error: error.message });
        }
    }

    async prepareNext() {
        if (!this.preparer || typeof this.preparer.prepareNext !== 'function') {
            return this.failure('preparer_unavailable');
        }
        this.phase = 'PREPARING';
        const result = await this.preparer.prepareNext();
        this.phase = result && result.ready ? 'READY' : 'IDLE';
        return { ok: !!(result && result.ready), state: this.phase, preparation: result };
    }

    async take() {
        const readiness = await this.readinessProvider();
        const required = ['mainConnected', 'subConnected', 'assetReady', 'vrcdnActive', 'ndiHealthy'];
        if (!required.every((key) => readiness[key] === true)) {
            return this.failure('not_ready', { readiness });
        }

        this.phase = 'TAKING';
        await this.subObs.setProgramScene(this.scenes.subEntry);
        this.subView = 'ENTRY';
        await this.subObs.restartMedia(this.mediaInput);
        if (this.takeDelayMs > 0) {
            await this.sleep(this.takeDelayMs);
        }
        await this.mainObs.setProgramScene(this.scenes.mainEntry);
        this.programView = 'ENTRY';
        this.phase = 'ON_AIR';
        return this.success();
    }

    async venue() {
        await this.mainObs.setProgramScene(this.scenes.mainVenue);
        this.programView = 'VENUE';
        return this.success();
    }

    async entry() {
        const readiness = await this.readinessProvider();
        if (readiness.ndiHealthy !== true) {
            return this.failure('ndi_not_ready', { readiness });
        }
        await this.mainObs.setProgramScene(this.scenes.mainEntry);
        this.programView = 'ENTRY';
        return this.success();
    }

    async standby() {
        await this.subObs.setProgramScene(this.scenes.subStandby);
        this.subView = 'STANDBY';
        this.phase = 'IDLE';
        return this.success();
    }

    async panic() {
        const [main, sub] = await Promise.allSettled([
            this.mainObs.setProgramScene(this.scenes.mainVenue),
            this.subObs.setProgramScene(this.scenes.subStandby)
        ]);
        const panicResults = {
            main: this.settledResult(main),
            sub: this.settledResult(sub)
        };
        this.programView = panicResults.main.ok ? 'VENUE' : this.programView;
        this.subView = panicResults.sub.ok ? 'STANDBY' : this.subView;
        const ok = panicResults.main.ok && panicResults.sub.ok;
        this.phase = ok ? 'IDLE' : 'DEGRADED';
        return { ok, state: this.phase, panicResults };
    }

    settledResult(result) {
        if (result.status === 'fulfilled') {
            return { ok: true };
        }
        return { ok: false, error: result.reason && result.reason.message ? result.reason.message : String(result.reason) };
    }

    success(extra = {}) {
        return { ok: true, state: this.phase, ...extra };
    }

    failure(reason, extra = {}) {
        return { ok: false, state: this.phase, reason, ...extra };
    }

    snapshot() {
        return {
            state: this.phase,
            programView: this.programView,
            subView: this.subView
        };
    }
}

module.exports = BlmfCoordinator;
