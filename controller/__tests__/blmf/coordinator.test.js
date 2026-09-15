const BlmfCoordinator = require('../../blmf/coordinator');

function makeObs() {
    return {
        setProgramScene: jest.fn().mockResolvedValue(),
        restartMedia: jest.fn().mockResolvedValue()
    };
}

describe('BlmfCoordinator', () => {
    test('VENUE only changes Main and ENTRY does not restart Sub playback', async () => {
        const mainObs = makeObs();
        const subObs = makeObs();
        const coordinator = new BlmfCoordinator({
            mainObs,
            subObs,
            readinessProvider: async () => ({ ndiHealthy: true })
        });

        expect((await coordinator.execute('VENUE')).ok).toBe(true);
        expect((await coordinator.execute('ENTRY')).ok).toBe(true);

        expect(mainObs.setProgramScene).toHaveBeenNthCalledWith(1, 'VRC_VENUE');
        expect(mainObs.setProgramScene).toHaveBeenNthCalledWith(2, 'ENTRY_FULLSCREEN');
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
        expect(subObs.restartMedia).not.toHaveBeenCalled();
    });

    test('STANDBY only changes Sub', async () => {
        const mainObs = makeObs();
        const subObs = makeObs();
        const coordinator = new BlmfCoordinator({ mainObs, subObs, readinessProvider: async () => ({}) });

        expect((await coordinator.execute('STANDBY')).ok).toBe(true);
        expect(subObs.setProgramScene).toHaveBeenCalledWith('STANDBY');
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('PANIC attempts both safe actions even when Main fails', async () => {
        const mainObs = makeObs();
        const subObs = makeObs();
        mainObs.setProgramScene.mockRejectedValue(new Error('main down'));
        const coordinator = new BlmfCoordinator({ mainObs, subObs, readinessProvider: async () => ({}) });

        const result = await coordinator.execute('PANIC');

        expect(mainObs.setProgramScene).toHaveBeenCalledWith('VRC_VENUE');
        expect(subObs.setProgramScene).toHaveBeenCalledWith('STANDBY');
        expect(result.ok).toBe(false);
        expect(result.state).toBe('DEGRADED');
        expect(result.panicResults.main.ok).toBe(false);
        expect(result.panicResults.sub.ok).toBe(true);
    });

    test('TAKE is rejected unless every readiness gate is true', async () => {
        const mainObs = makeObs();
        const subObs = makeObs();
        const coordinator = new BlmfCoordinator({
            mainObs,
            subObs,
            readinessProvider: async () => ({
                mainConnected: true,
                subConnected: true,
                assetReady: true,
                vrcdnActive: true,
                ndiHealthy: false
            })
        });

        const result = await coordinator.execute('TAKE');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('not_ready');
        expect(mainObs.setProgramScene).not.toHaveBeenCalled();
        expect(subObs.setProgramScene).not.toHaveBeenCalled();
    });

    test('TAKE starts Sub once before taking Main fullscreen', async () => {
        const calls = [];
        const mainObs = makeObs();
        const subObs = makeObs();
        subObs.setProgramScene.mockImplementation(async (scene) => calls.push(`sub:${scene}`));
        subObs.restartMedia.mockImplementation(async (input) => calls.push(`restart:${input}`));
        mainObs.setProgramScene.mockImplementation(async (scene) => calls.push(`main:${scene}`));
        const coordinator = new BlmfCoordinator({
            mainObs,
            subObs,
            readinessProvider: async () => ({
                mainConnected: true,
                subConnected: true,
                assetReady: true,
                vrcdnActive: true,
                ndiHealthy: true
            }),
            sleep: async () => calls.push('delay'),
            preparer: { prepareNext: async () => ({ ready: true }) },
            takeDelayMs: 25
        });

        await coordinator.execute('NEXT');
        const result = await coordinator.execute('TAKE');
        expect(result.ok).toBe(true);
        expect(result.state).toBe('ON_AIR');
        expect(calls).toEqual(['sub:ENTRY', 'restart:entry_player', 'delay', 'main:ENTRY_FULLSCREEN']);
    });

    test('NEXT fails closed until queue preparer is wired', async () => {
        const coordinator = new BlmfCoordinator({ mainObs: makeObs(), subObs: makeObs(), readinessProvider: async () => ({}) });
        expect(await coordinator.execute('NEXT')).toMatchObject({ ok: false, reason: 'preparer_unavailable' });
    });
});
