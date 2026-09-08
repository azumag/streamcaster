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
