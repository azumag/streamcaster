const ObsClient = require('../../blmf/obs_client');

describe('ObsClient', () => {
    test('maps scene and media actions to obs-websocket v5 requests', async () => {
        const call = jest.fn().mockResolvedValue({ outputActive: true });
        const raw = {
            connect: jest.fn().mockResolvedValue({}),
            disconnect: jest.fn().mockResolvedValue(),
            call,
            on: jest.fn()
        };
        const obs = new ObsClient({
            url: 'ws://127.0.0.1:4455',
            password: 'pw',
            clientFactory: () => raw
        });

        await obs.connect();
        await obs.setProgramScene('VRC_VENUE');
        await obs.restartMedia('entry_player');
        const active = await obs.getStreamActive();

        expect(raw.connect).toHaveBeenCalledWith('ws://127.0.0.1:4455', 'pw');
        expect(call).toHaveBeenCalledWith('SetCurrentProgramScene', { sceneName: 'VRC_VENUE' });
        expect(call).toHaveBeenCalledWith('TriggerMediaInputAction', {
            inputName: 'entry_player',
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        });
        expect(call).toHaveBeenCalledWith('GetStreamStatus');
        expect(active).toBe(true);
        expect(obs.isConnected()).toBe(true);
    });

    test('clears connected state when the websocket closes', async () => {
        let closed;
        const raw = {
            connect: jest.fn().mockResolvedValue({}),
            disconnect: jest.fn().mockResolvedValue(),
            call: jest.fn(),
            on: jest.fn((event, handler) => {
                if (event === 'ConnectionClosed') {
                    closed = handler;
                }
            })
        };
        const obs = new ObsClient({ url: 'ws://main:4455', password: 'pw', clientFactory: () => raw });
        await obs.connect();
        closed();
        expect(obs.isConnected()).toBe(false);
    });
});
