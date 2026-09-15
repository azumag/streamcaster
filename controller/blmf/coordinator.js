const DEFAULT_SCENES = {
    mainVenue: 'VRC_VENUE',
    mainEntry: 'ENTRY_FULLSCREEN',
    subEntry: 'ENTRY',
    subStandby: 'STANDBY'
};
const REQUIRED = ['mainConnected', 'subConnected', 'assetReady', 'vrcdnActive', 'ndiHealthy'];

class BlmfCoordinator {
    constructor({ mainObs, subObs, readinessProvider, preparer = null, entries = [], scenes = {},
        mediaInput = 'entry_player', takeDelayMs = 0, now = Date.now, healthMaxAgeMs = 5000,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
        this.mainObs = mainObs;
        this.subObs = subObs;
        this.readinessProvider = readinessProvider || (async () => ({}));
        this.preparer = preparer;
        this.entries = entries.map((entry) => ({ ...entry }));
        this.scenes = { ...DEFAULT_SCENES, ...scenes };
        this.mediaInput = mediaInput;
        this.takeDelayMs = takeDelayMs;
        this.sleep = sleep;
        this.now = now;
        this.healthMaxAgeMs = healthMaxAgeMs;
        this.phase = 'IDLE';
        this.programView = 'VENUE';
        this.subView = 'STANDBY';
        this.selectedIndex = -1;
        this.currentIndex = -1;
        this.readiness = null;
        this.generation = 0;
        this.commands = Promise.resolve();
        // Per-OBS ordering lets PANIC follow an already-issued mutation without waiting
        // for TAKE's read/settling delay, and without one OBS failure blocking the other.
        this.mutations = { main: Promise.resolve(), sub: Promise.resolve() };
    }

    execute(command, { authorize = () => true, isFresh = () => true } = {}) {
        if (command === 'PANIC') {
            const generation = ++this.generation;
            this.phase = 'RETURNING';
            this.selectedIndex = -1;
            this.readiness = null;
            const result = this.panic(generation);
            this.commands = result.then(() => undefined, () => undefined);
            return result;
        }
        const generation = this.generation;
        const result = this.commands.then(async () => {
            try {
                this.check(generation);
                if (!authorize()) {
                    return this.failure('director_required');
                }
                if (!isFresh()) {
                    return this.failure('stale_command');
                }
                switch (command) {
                case 'NEXT': return await this.prepareNext(generation);
                case 'TAKE': return await this.take(generation);
                case 'VENUE': return await this.venue(generation);
                case 'ENTRY': return await this.entry(generation);
                case 'STANDBY': return await this.standby(generation);
                default: return this.failure('unknown_command');
                }
            } catch (_error) {
                if (generation !== this.generation) {
                    return this.failure('cancelled_by_panic');
                }
                this.phase = 'DEGRADED';
                return this.failure('command_failed');
            }
        });
        this.commands = result.then(() => undefined, () => undefined);
        return result;
    }

    check(generation) {
        if (generation !== this.generation) {
            throw new Error('cancelled_by_panic');
        }
    }

    mutate(role, operation, generation, safe = false) {
        const result = this.mutations[role].then(() => {
            if (!safe) {
                this.check(generation);
            }
            return operation();
        });
        this.mutations[role] = result.then(() => undefined, () => undefined);
        return result;
    }

    async readReadiness(entry, generation) {
        const value = await this.readinessProvider(entry);
        this.check(generation);
        // Expose a fixed allowlist, not a provider's arbitrary error/settings payload.
        this.readiness = Object.fromEntries(REQUIRED.map((key) => [key, !!(value && value[key] === true)]));
        this.readiness.checkedAt = this.now();
        this.readiness.validUntil = value && Number.isFinite(value.validUntil)
            ? value.validUntil : this.readiness.checkedAt + this.healthMaxAgeMs;
        this.readiness.entryId = entry ? entry.id : null;
        return this.readiness;
    }

    isReady(readiness) {
        return readiness && REQUIRED.every((key) => readiness[key]) &&
            this.now() >= readiness.checkedAt && this.now() <= readiness.validUntil;
    }

    async prepareNext(generation) {
        if (this.entries.length) {
            // Repeated NEXT while READY is idempotent; it must not silently skip entries.
            const index = this.selectedIndex >= 0 ? this.selectedIndex : this.currentIndex + 1;
            if (index >= this.entries.length) {
                return this.failure('queue_exhausted');
            }
            this.selectedIndex = index;
            this.phase = 'PREPARING';
            const readiness = await this.readReadiness(this.entries[index], generation);
            const ready = this.isReady(readiness);
            this.phase = ready ? 'READY' : 'IDLE';
            return ready ? this.success() : this.failure('not_ready');
        }
        if (!this.preparer || typeof this.preparer.prepareNext !== 'function') {
            return this.failure('preparer_unavailable');
        }
        this.phase = 'PREPARING';
        const result = await this.preparer.prepareNext();
        this.check(generation);
        this.phase = result && result.ready ? 'READY' : 'IDLE';
        return { ok: !!(result && result.ready), state: this.phase, preparation: result };
    }

    async take(generation) {
        if (this.snapshot().state !== 'READY') {
            return this.failure('not_ready');
        }
        const selected = this.entries[this.selectedIndex];
        const readiness = await this.readReadiness(selected, generation);
        if (!this.isReady(readiness)) {
            this.phase = 'IDLE';
            return this.failure('not_ready');
        }
        let restart = true;
        if (selected) {
            const inspection = await this.subObs.inspectEntry(selected);
            this.check(generation);
            const currentScene = await this.subObs.getProgramScene();
            this.check(generation);
            // Re-selecting an active scene does not activate its source again. Require
            // STANDBY first instead of restarting an entry that may already be on air.
            if (!inspection.configured || !inspection.inactive || currentScene === selected.sceneName) {
                this.phase = 'IDLE';
                return this.failure('entry_not_inactive');
            }
            restart = !inspection.restartOnActivate;
        }
        // OBS inspection may outlive the evidence checked at the start of TAKE.
        const subReadiness = await this.readReadiness(selected, generation);
        if (!this.isReady(subReadiness)) {
            this.phase = 'IDLE';
            return this.failure('not_ready');
        }
        this.phase = 'TAKING';
        await this.mutate('sub', () => this.subObs.setProgramScene(selected ? selected.sceneName : this.scenes.subEntry), generation);
        this.check(generation);
        this.subView = 'ENTRY';
        if (selected && !await this.confirmProgram(this.subObs, selected.sceneName, generation)) {
            this.phase = 'DEGRADED';
            return this.failure('program_not_confirmed');
        }
        if (restart) {
            await this.mutate('sub', () => this.subObs.restartMedia(selected ? selected.mediaInput : this.mediaInput), generation);
            this.check(generation);
        }
        if (selected) {
            const playing = await this.waitForPlaying(selected.mediaInput, generation);
            if (!playing) {
                this.phase = 'DEGRADED';
                return this.failure('media_not_playing');
            }
        }
        this.currentIndex = this.selectedIndex;
        if (this.takeDelayMs > 0) {
            await this.sleep(this.takeDelayMs);
            this.check(generation);
        }
        // Conditions may have changed while the source was activating or during delay.
        const finalReadiness = await this.readReadiness(selected, generation);
        if (!this.isReady(finalReadiness)) {
            this.phase = 'DEGRADED';
            return this.failure('not_ready');
        }
        if (selected) {
            if (!await this.confirmProgram(this.subObs, selected.sceneName, generation)) {
                this.phase = 'DEGRADED';
                return this.failure('program_not_confirmed');
            }
            const media = await this.subObs.getMediaStatus(selected.mediaInput);
            this.check(generation);
            if (media.mediaState !== 'OBS_MEDIA_STATE_PLAYING') {
                this.phase = 'DEGRADED';
                return this.failure('media_not_playing');
            }
        }
        if (!this.isReady(finalReadiness)) {
            this.phase = 'DEGRADED';
            return this.failure('not_ready');
        }
        await this.mutate('main', () => this.mainObs.setProgramScene(this.scenes.mainEntry), generation);
        this.check(generation);
        if (selected && !await this.confirmProgram(this.mainObs, this.scenes.mainEntry, generation)) {
            this.phase = 'DEGRADED';
            return this.failure('program_not_confirmed');
        }
        this.programView = 'ENTRY';
        this.phase = 'ON_AIR';
        this.selectedIndex = -1;
        return this.success();
    }

    async confirmProgram(obs, sceneName, generation) {
        const observed = await obs.getProgramScene();
        this.check(generation);
        return observed === sceneName;
    }

    async waitForPlaying(inputName, generation) {
        const attempts = 10;
        const intervalMs = 100;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const status = await this.subObs.getMediaStatus(inputName);
            this.check(generation);
            if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING') {
                return true;
            }
            if (attempt < attempts - 1) {
                await this.sleep(intervalMs);
                this.check(generation);
            }
        }
        return false;
    }

    async venue(generation) {
        await this.mutate('main', () => this.mainObs.setProgramScene(this.scenes.mainVenue), generation);
        this.check(generation);
        this.programView = 'VENUE';
        return this.success();
    }

    async entry(generation) {
        const readiness = await this.readReadiness(this.entries[this.currentIndex], generation);
        if (readiness.ndiHealthy !== true) {
            return this.failure('ndi_not_ready');
        }
        await this.mutate('main', () => this.mainObs.setProgramScene(this.scenes.mainEntry), generation);
        this.check(generation);
        this.programView = 'ENTRY';
        return this.success();
    }

    async standby(generation) {
        await this.mutate('sub', () => this.subObs.setProgramScene(this.scenes.subStandby), generation);
        this.check(generation);
        this.subView = 'STANDBY';
        this.phase = 'IDLE';
        this.readiness = null;
        return this.success();
    }

    async panic(generation) {
        const [main, sub] = await Promise.allSettled([
            this.mutate('main', () => this.mainObs.setProgramScene(this.scenes.mainVenue), generation, true),
            this.mutate('sub', () => this.subObs.setProgramScene(this.scenes.subStandby), generation, true)
        ]);
        const panicResults = { main: { ok: main.status === 'fulfilled' }, sub: { ok: sub.status === 'fulfilled' } };
        const ok = panicResults.main.ok && panicResults.sub.ok;
        if (generation === this.generation) {
            this.programView = panicResults.main.ok ? 'VENUE' : this.programView;
            this.subView = panicResults.sub.ok ? 'STANDBY' : this.subView;
            this.phase = ok ? 'IDLE' : 'DEGRADED';
        }
        return { ok, ...this.snapshot(), panicResults };
    }

    success(extra = {}) {
        return { ok: true, ...this.snapshot(), ...extra };
    }

    failure(reason, extra = {}) {
        return { ok: false, ...this.snapshot(), reason, ...extra };
    }

    snapshot() {
        const readiness = this.readiness ? { ...this.readiness,
            stale: this.now() > this.readiness.validUntil || this.now() < this.readiness.checkedAt } : null;
        const selected = this.entries[this.selectedIndex];
        const ready = readiness && !readiness.stale && REQUIRED.every((key) => readiness[key]) &&
            (!selected || readiness.entryId === selected.id);
        return {
            state: this.phase === 'READY' && this.entries.length && !ready ? 'IDLE' : this.phase,
            programView: this.programView,
            subView: this.subView,
            currentEntry: this.entries[this.currentIndex] ? { ...this.entries[this.currentIndex] } : null,
            currentEntryIndex: this.currentIndex + 1,
            selectedEntry: this.entries[this.selectedIndex] ? { ...this.entries[this.selectedIndex] } : null,
            readiness
        };
    }
}

module.exports = BlmfCoordinator;
