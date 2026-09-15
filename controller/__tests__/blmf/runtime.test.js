const createBlmfRuntime = require('../../blmf/runtime');

function config() {
    return {
        enabled: true,
        operatorsJson: '[{"id":"azumag","token":"secret"}]',
        mainObsUrl: 'ws://main:4455',
        mainObsPassword: 'main-pw',
        subObsUrl: 'ws://sub:4455',
        subObsPassword: 'sub-pw',
        directorLeaseTtlMs: 15000,
        commandMaxAgeMs: 10000,
        takeDelayMs: 0,
        mediaInput: 'entry_player',
        scenes: {
            mainVenue: 'VRC_VENUE',
            mainEntry: 'ENTRY_FULLSCREEN',
            subEntry: 'ENTRY',
            subStandby: 'STANDBY'
        }
    };
}

describe('createBlmfRuntime', () => {
    function mappedRuntime(options = {}) {
        const entry = { id: 'one', sceneName: 'ENTRY_001', mediaInput: 'ENTRY_001_MEDIA' };
        const obsClientFactory = () => {
            let programScene = 'STANDBY';
            return {
                isConnected: () => true,
                getStreamActive: jest.fn().mockResolvedValue(true),
                inspectEntry: jest.fn().mockResolvedValue({ configured: true, restartOnActivate: true, inactive: true }),
                getProgramScene: jest.fn(async () => programScene),
                getMediaStatus: jest.fn().mockResolvedValue({ mediaState: 'OBS_MEDIA_STATE_PLAYING' }),
                setProgramScene: jest.fn(async (scene) => {
                    programScene = scene;
                }),
                restartMedia: jest.fn().mockResolvedValue()
            };
        };
        return createBlmfRuntime({ ...config(), entries: [entry], healthMaxAgeMs: 1000 }, {
            obsClientFactory, now: () => 10000,
            assetReadinessProvider: async () => ({ entryId: 'one', ready: true, observedAt: 10000 }),
            ndiHealthProvider: async () => ({ healthy: true, observedAt: 10000 }),
            ...options
        });
    }
    test('maps NEXT and TAKE through live configuration plus fresh, entry-specific evidence', async () => {
        const runtime = mappedRuntime();
        expect(await runtime.coordinator.execute('NEXT')).toMatchObject({ state: 'READY', selectedEntry: { id: 'one' } });
        expect(await runtime.coordinator.execute('TAKE')).toMatchObject({ state: 'ON_AIR', currentEntryIndex: 1 });
        expect(runtime.subObs.restartMedia).not.toHaveBeenCalled();
        expect(runtime.mainObs.setProgramScene).toHaveBeenCalledWith('ENTRY_FULLSCREEN');
    });
    test.each([
        { ndiHealthProvider: async () => null },
        { ndiHealthProvider: async () => ({ healthy: true, observedAt: 8999 }) },
        { ndiHealthProvider: async () => ({ healthy: true, observedAt: 10001 }) },
        { assetReadinessProvider: async () => ({ entryId: 'other', ready: true, observedAt: 10000 }) },
        { assetReadinessProvider: async () => ({ entryId: 'one', ready: true, observedAt: 8999 }) },
        { assetReadinessProvider: async () => {
            throw new Error('private diagnostic');
        } }
    ])('fails closed on absent, stale, future, mismatched or failed evidence', async (options) => {
        const runtime = mappedRuntime(options);
        const result = await runtime.coordinator.execute('NEXT');
        expect(result).toMatchObject({ ok: false, reason: 'not_ready' });
        expect(JSON.stringify(result)).not.toContain('private diagnostic');
        expect(runtime.subObs.setProgramScene).not.toHaveBeenCalled();
    });
    test('configuration presence alone is not asset readiness or NDI health', async () => {
        const runtime = mappedRuntime({ assetReadinessProvider: undefined, ndiHealthProvider: undefined });
        expect(await runtime.coordinator.execute('NEXT')).toMatchObject({
            ok: false, readiness: { assetReady: false, ndiHealthy: false }
        });
    });
    test('attempts both OBS connections and stays available when one fails', async () => {
        const clients = [];
        const obsClientFactory = ({ role }) => {
            const client = {
                role,
                connected: false,
                connect: jest.fn(async () => {
                    if (role === 'main') {
                        throw new Error('main unavailable');
                    }
                    client.connected = true;
                }),
                disconnect: jest.fn().mockResolvedValue(),
                isConnected: jest.fn(() => client.connected),
                getStreamActive: jest.fn().mockResolvedValue(true),
                setProgramScene: jest.fn().mockResolvedValue(),
                restartMedia: jest.fn().mockResolvedValue()
            };
            clients.push(client);
            return client;
        };
        const logger = { info: jest.fn(), warning: jest.fn(), error: jest.fn() };
        const runtime = createBlmfRuntime(config(), { obsClientFactory, logger, now: () => 10000 });

        const result = await runtime.start();

        expect(clients).toHaveLength(2);
        expect(clients[0].connect).toHaveBeenCalled();
        expect(clients[1].connect).toHaveBeenCalled();
        expect(result.mainConnected).toBe(false);
        expect(result.subConnected).toBe(true);
        expect(logger.warning).toHaveBeenCalled();
    });

    test('fails TAKE closed before asset and NDI readiness phases are wired', async () => {
        const obsClientFactory = () => ({
            connect: jest.fn().mockResolvedValue(),
            disconnect: jest.fn().mockResolvedValue(),
            isConnected: jest.fn().mockReturnValue(true),
            getStreamActive: jest.fn().mockResolvedValue(true),
            setProgramScene: jest.fn().mockResolvedValue(),
            restartMedia: jest.fn().mockResolvedValue()
        });
        const runtime = createBlmfRuntime(config(), { obsClientFactory, logger: { info: jest.fn(), warning: jest.fn() } });
        expect(await runtime.coordinator.execute('TAKE')).toMatchObject({ ok: false, reason: 'not_ready' });
    });
});
