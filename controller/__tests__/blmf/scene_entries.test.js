const BlmfCoordinator = require('../../blmf/coordinator');

const entries = [
    { id: 'one', sceneName: 'ENTRY_001', mediaInput: 'ENTRY_001_MEDIA' },
    { id: 'two', sceneName: 'ENTRY_002', mediaInput: 'ENTRY_002_MEDIA' }
];
const healthy = { mainConnected: true, subConnected: true, assetReady: true, vrcdnActive: true, ndiHealthy: true };
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes; reject = no;
    });
    return { promise, resolve, reject };
}
function setup(options = {}) {
    let subScene = 'STANDBY';
    let mainScene = 'VRC_VENUE';
    const mainObs = {
        setProgramScene: jest.fn(async (scene) => {
            mainScene = scene;
        }),
        getProgramScene: jest.fn(async () => mainScene)
    };
    const subObs = {
        setProgramScene: jest.fn(async (scene) => {
            subScene = scene;
        }),
        getProgramScene: jest.fn(async () => subScene),
        inspectEntry: jest.fn().mockResolvedValue({ configured: true, restartOnActivate: true, inactive: true }),
        restartMedia: jest.fn().mockResolvedValue(),
        getMediaStatus: jest.fn().mockResolvedValue({ mediaState: 'OBS_MEDIA_STATE_PLAYING' })
    };
    const readinessProvider = jest.fn().mockResolvedValue(healthy);
    const coordinator = new BlmfCoordinator({ mainObs, subObs, entries, readinessProvider, ...options });
    return { mainObs, subObs, coordinator, readinessProvider };
}

describe('scene-based entry control', () => {
    test.each([
        ['inspectEntry', 'expired'], ['getProgramScene', 'expired'],
        ['inspectEntry', 'unhealthy'], ['getProgramScene', 'unhealthy']
    ])('rechecks evidence after slow %s and rejects %s refresh before either OBS changes', async (method, evidence) => {
        let time = 10000;
        const { coordinator, readinessProvider, subObs, mainObs } = setup({ now: () => time });
        readinessProvider.mockImplementation(async () => ({ ...healthy,
            assetReady: evidence !== 'unhealthy' || time === 10000,
            validUntil: evidence === 'expired' ? 11000 : time + 1000
        }));
        subObs[method].mockImplementationOnce(async () => {
            time = 12000;
            return method === 'inspectEntry'
                ? { configured: true, inactive: true, restartOnActivate: true } : 'STANDBY';
        });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({
            ok: false, reason: 'not_ready', currentEntry: null, subView: 'STANDBY'
        });
        expect(readinessProvider).toHaveBeenLastCalledWith(entries[0]);
        expect(readinessProvider).toHaveBeenCalledTimes(3);
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('fresh successful evidence after slow inspection permits one scene activation', async () => {
        let time = 10000;
        const { coordinator, readinessProvider, subObs } = setup({ now: () => time });
        readinessProvider.mockImplementation(async () => ({ ...healthy, validUntil: time + 1000 }));
        subObs.inspectEntry.mockImplementationOnce(async () => {
            time = 12000;
            return { configured: true, inactive: true, restartOnActivate: true };
        });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ ok: true, state: 'ON_AIR' });
        expect(subObs.setProgramScene).toHaveBeenCalledTimes(1);
        expect(subObs.restartMedia).not.toHaveBeenCalled();
    });

    test('PANIC bypasses the new pre-Sub readiness refresh and cancels the old TAKE', async () => {
        const pending = deferred();
        const entered = deferred();
        const { coordinator, readinessProvider, subObs, mainObs } = setup();
        await coordinator.execute('NEXT');
        readinessProvider.mockResolvedValueOnce(healthy).mockImplementationOnce(() => {
            entered.resolve();
            return pending.promise;
        });
        const take = coordinator.execute('TAKE');
        await entered.promise;
        expect((await coordinator.execute('PANIC')).ok).toBe(true);
        pending.resolve(healthy);
        expect(await take).toMatchObject({ reason: 'cancelled_by_panic', state: 'IDLE' });
        expect(subObs.setProgramScene).toHaveBeenCalledTimes(1);
        expect(subObs.setProgramScene).toHaveBeenCalledWith('STANDBY');
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(mainObs.setProgramScene).not.toHaveBeenCalledWith('ENTRY_FULLSCREEN');
    });

    test('successful scene-write response without Sub Program activation cannot take Main', async () => {
        const { coordinator, subObs, mainObs } = setup();
        subObs.setProgramScene.mockResolvedValue();
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({
            reason: 'program_not_confirmed', state: 'DEGRADED', currentEntry: null
        });
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
        expect(subObs.restartMedia).not.toHaveBeenCalled();
    });

    test('media ending during TAKE delay cannot switch Main to the ended entry', async () => {
        const { coordinator, subObs, mainObs } = setup({ takeDelayMs: 1, sleep: async () => undefined });
        subObs.getMediaStatus.mockResolvedValueOnce({ mediaState: 'OBS_MEDIA_STATE_PLAYING' })
            .mockResolvedValue({ mediaState: 'OBS_MEDIA_STATE_ENDED' });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'media_not_playing' });
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('readiness expiring during final Program query blocks Main', async () => {
        let time = 10000;
        const { coordinator, subObs, mainObs } = setup({ now: () => time, healthMaxAgeMs: 1 });
        subObs.getProgramScene.mockResolvedValueOnce('STANDBY').mockResolvedValueOnce('ENTRY_001')
            .mockImplementationOnce(async () => {
                time += 2;
                return 'ENTRY_001';
            });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'not_ready' });
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('an external Sub scene change during TAKE delay blocks Main and Main mismatch cannot claim ON_AIR', async () => {
        const { coordinator, subObs, mainObs } = setup({ takeDelayMs: 1, sleep: async () => undefined });
        subObs.getProgramScene.mockResolvedValueOnce('STANDBY').mockResolvedValueOnce('ENTRY_001')
            .mockResolvedValue('STANDBY');
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'program_not_confirmed' });
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
        const second = setup();
        second.mainObs.setProgramScene.mockResolvedValue();
        await second.coordinator.execute('NEXT');
        expect(await second.coordinator.execute('TAKE')).toMatchObject({ reason: 'program_not_confirmed', state: 'DEGRADED' });
    });

    test('NEXT selects without touching playback; TAKE requires NEXT and starts each independent scene once', async () => {
        const { coordinator, mainObs, subObs } = setup();
        expect(await coordinator.execute('TAKE')).toMatchObject({ ok: false, reason: 'not_ready' });
        expect(await coordinator.execute('NEXT')).toMatchObject({ state: 'READY', selectedEntry: entries[0], currentEntry: null });
        await coordinator.execute('NEXT');
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(await coordinator.execute('TAKE')).toMatchObject({ state: 'ON_AIR', currentEntry: entries[0], currentEntryIndex: 1 });
        expect(subObs.setProgramScene).toHaveBeenCalledWith('ENTRY_001');
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(subObs.getMediaStatus).toHaveBeenCalledWith('ENTRY_001_MEDIA');
        await coordinator.execute('VENUE');
        await coordinator.execute('ENTRY');
        expect(subObs.setProgramScene).toHaveBeenCalledTimes(1);
        expect(await coordinator.execute('TAKE')).toMatchObject({ ok: false, reason: 'not_ready' });
        expect(await coordinator.execute('NEXT')).toMatchObject({ selectedEntry: entries[1], currentEntry: entries[0] });
        expect(await coordinator.execute('TAKE')).toMatchObject({ currentEntryIndex: 2 });
        expect(subObs.setProgramScene).toHaveBeenLastCalledWith('ENTRY_002');
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(mainObs.setProgramScene).toHaveBeenLastCalledWith('ENTRY_FULLSCREEN');
        expect(await coordinator.execute('NEXT')).toMatchObject({ reason: 'queue_exhausted' });
    });

    test('inactive source without restart-on-activate receives exactly one explicit restart', async () => {
        const { coordinator, subObs } = setup();
        subObs.inspectEntry.mockResolvedValue({ configured: true, restartOnActivate: false, inactive: true });
        await coordinator.execute('NEXT');
        await coordinator.execute('TAKE');
        expect(subObs.restartMedia).toHaveBeenCalledTimes(1);
        expect(subObs.restartMedia).toHaveBeenCalledWith('ENTRY_001_MEDIA');
    });

    test('already active or shared source is rejected without restarting it', async () => {
        const { coordinator, subObs, mainObs } = setup();
        subObs.inspectEntry.mockResolvedValue({ configured: true, restartOnActivate: true, inactive: false });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'entry_not_inactive' });
        expect(subObs.restartMedia).not.toHaveBeenCalled();
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('failed readiness is retried for the same entry and rechecked at TAKE', async () => {
        const { coordinator, readinessProvider, subObs } = setup();
        readinessProvider.mockResolvedValueOnce({ ...healthy, assetReady: false });
        expect(await coordinator.execute('NEXT')).toMatchObject({ reason: 'not_ready', selectedEntry: entries[0] });
        expect(await coordinator.execute('NEXT')).toMatchObject({ state: 'READY', selectedEntry: entries[0] });
        readinessProvider.mockResolvedValue({ ...healthy, ndiHealthy: false });
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'not_ready' });
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('Main stays unchanged if selected media never plays or NDI becomes unhealthy during activation', async () => {
        const { coordinator, subObs, mainObs } = setup({ sleep: async () => undefined });
        subObs.getMediaStatus.mockResolvedValue({ mediaState: 'OBS_MEDIA_STATE_ERROR' });
        await coordinator.execute('NEXT');
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'media_not_playing', state: 'DEGRADED' });
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
        const second = setup();
        await second.coordinator.execute('NEXT');
        second.readinessProvider.mockResolvedValueOnce(healthy).mockResolvedValueOnce(healthy)
            .mockResolvedValue({ ...healthy, ndiHealthy: false });
        expect(await second.coordinator.execute('TAKE')).toMatchObject({ reason: 'not_ready' });
        expect(second.mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('ordinary commands wait in order and check Director again before executing', async () => {
        const gate = deferred();
        const entered = deferred();
        const { coordinator, mainObs } = setup({ takeDelayMs: 1, sleep: () => {
            entered.resolve(); return gate.promise;
        } });
        await coordinator.execute('NEXT');
        const take = coordinator.execute('TAKE');
        await entered.promise;
        let director = true;
        const venue = coordinator.execute('VENUE', { authorize: () => director });
        director = false;
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
        gate.resolve();
        expect((await take).ok).toBe(true);
        expect(await venue).toMatchObject({ reason: 'director_required' });
        expect(mainObs.setProgramScene).toHaveBeenCalledTimes(1);
    });

    test('PANIC bypasses TAKE delay, cancels old queued commands and prevents delayed Main ENTRY', async () => {
        const gate = deferred();
        const entered = deferred();
        const { coordinator, mainObs, subObs } = setup({ takeDelayMs: 1, sleep: () => {
            entered.resolve(); return gate.promise;
        } });
        await coordinator.execute('NEXT');
        const take = coordinator.execute('TAKE');
        await entered.promise;
        const oldEntry = coordinator.execute('ENTRY');
        expect(await coordinator.execute('PANIC')).toMatchObject({ ok: true, state: 'IDLE' });
        // New safe commands do not wait for the obsolete delay.
        expect((await coordinator.execute('VENUE')).ok).toBe(true);
        gate.resolve();
        expect(await take).toMatchObject({ reason: 'cancelled_by_panic' });
        expect(await oldEntry).toMatchObject({ reason: 'cancelled_by_panic' });
        expect(mainObs.setProgramScene).not.toHaveBeenCalledWith('ENTRY_FULLSCREEN');
        expect(subObs.setProgramScene).toHaveBeenLastCalledWith('STANDBY');
        expect(coordinator.snapshot()).toMatchObject({ state: 'IDLE', programView: 'VENUE', subView: 'STANDBY' });
    });

    test('PANIC orders safe Sub action after an already in-flight scene write and still returns Main immediately', async () => {
        const gate = deferred();
        const entered = deferred();
        const { coordinator, mainObs, subObs } = setup();
        subObs.setProgramScene.mockImplementationOnce(() => {
            entered.resolve(); return gate.promise;
        });
        await coordinator.execute('NEXT');
        const take = coordinator.execute('TAKE');
        await entered.promise;
        const panic = coordinator.execute('PANIC');
        // Wait for the independent Main mutation instead of time-based sleeps.
        await coordinator.mutations.main;
        expect(mainObs.setProgramScene).toHaveBeenCalledWith('VRC_VENUE');
        expect(subObs.setProgramScene).toHaveBeenCalledTimes(1);
        gate.resolve();
        expect((await panic).ok).toBe(true);
        expect(await take).toMatchObject({ reason: 'cancelled_by_panic' });
        expect(subObs.setProgramScene.mock.calls.map(([scene]) => scene)).toEqual(['ENTRY_001', 'STANDBY']);
        expect(subObs.restartMedia).not.toHaveBeenCalled();
    });

    test('late read failure after PANIC does not overwrite safe state', async () => {
        const pending = deferred();
        const entered = deferred();
        const { coordinator, readinessProvider } = setup();
        readinessProvider.mockImplementationOnce(() => {
            entered.resolve(); return pending.promise;
        });
        const next = coordinator.execute('NEXT');
        await entered.promise;
        await coordinator.execute('PANIC');
        pending.reject(new Error('provider failed with private details'));
        expect(await next).toMatchObject({ reason: 'cancelled_by_panic', state: 'IDLE' });
        expect(JSON.stringify(coordinator.snapshot())).not.toContain('private details');
    });

    test('stale readiness cannot keep Ready feedback true', async () => {
        let time = 10000;
        const { coordinator } = setup({ now: () => time, healthMaxAgeMs: 1000 });
        await coordinator.execute('NEXT');
        time += 1001;
        expect(coordinator.snapshot()).toMatchObject({ state: 'IDLE', readiness: { stale: true, checkedAt: 10000 } });
        expect(await coordinator.execute('TAKE')).toMatchObject({ reason: 'not_ready' });
    });

    test('current-entry cutaway health does not become readiness evidence for the next selection', async () => {
        const { coordinator } = setup();
        await coordinator.execute('NEXT');
        await coordinator.execute('TAKE');
        await coordinator.execute('NEXT');
        await coordinator.execute('ENTRY');
        expect(coordinator.snapshot()).toMatchObject({
            state: 'IDLE', selectedEntry: entries[1], readiness: { entryId: 'one' }
        });
        expect(await coordinator.execute('NEXT')).toMatchObject({ state: 'READY', readiness: { entryId: 'two' } });
    });
});
