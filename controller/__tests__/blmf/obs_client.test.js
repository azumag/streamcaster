const ObsClient = require('../../blmf/obs_client');

describe('ObsClient', () => {
    test('inspects selected scene, media and activity without returning source settings', async () => {
        const call = jest.fn(async (method) => ({
            GetSceneItemList: { sceneItems: [{ sourceName: 'ENTRY_001_MEDIA', sceneItemEnabled: true }] },
            GetInputSettings: { inputKind: 'ffmpeg_source', inputSettings: {
                is_local_file: true, local_file: '/private/local/video.mp4', close_when_inactive: true, restart_on_activate: true
            } },
            GetInputDefaultSettings: { defaultInputSettings: {} },
            GetSourceActive: { videoActive: false, videoShowing: false },
            GetCurrentProgramScene: { currentProgramSceneName: 'STANDBY' },
            GetMediaInputStatus: { mediaState: 'OBS_MEDIA_STATE_PLAYING', mediaCursor: 120, mediaDuration: 30000 },
            GetStreamStatus: { outputActive: true, outputReconnecting: true }
        }[method]));
        const obs = new ObsClient({ clientFactory: () => ({ call, on: jest.fn() }) });
        const result = await obs.inspectEntry({ sceneName: 'ENTRY_001', mediaInput: 'ENTRY_001_MEDIA' });
        expect(result).toEqual({ configured: true, restartOnActivate: true, inactive: true });
        expect(JSON.stringify(result)).not.toContain('/private');
        expect(await obs.getProgramScene()).toBe('STANDBY');
        expect(await obs.getMediaStatus('ENTRY_001_MEDIA')).toMatchObject({ mediaState: 'OBS_MEDIA_STATE_PLAYING' });
        expect(await obs.getStreamActive()).toBe(false);
        expect(call).toHaveBeenCalledWith('GetSourceActive', { sourceName: 'ENTRY_001_MEDIA' });
        expect(call).not.toHaveBeenCalledWith('GetStreamServiceSettings');
    });
    test.each([undefined, false])('uses the effective restart setting when OBS omits defaults or explicitly overrides them', async (override) => {
        const settings = { local_file: '/fixture/video.mp4', close_when_inactive: true };
        if (override !== undefined) {
            settings.restart_on_activate = override;
        }
        const call = jest.fn(async (method) => ({
            GetSceneItemList: { sceneItems: [{ sourceName: 'MEDIA', sceneItemEnabled: true }] },
            GetInputSettings: { inputKind: 'ffmpeg_source', inputSettings: settings },
            GetInputDefaultSettings: { defaultInputSettings: { is_local_file: true, restart_on_activate: true } },
            GetSourceActive: { videoActive: false }
        }[method]));
        const obs = new ObsClient({ clientFactory: () => ({ call, on: jest.fn() }) });
        expect(await obs.inspectEntry({ sceneName: 'ENTRY', mediaInput: 'MEDIA' })).toEqual({
            configured: true, inactive: true, restartOnActivate: override === undefined
        });
        expect(call).toHaveBeenCalledWith('GetInputDefaultSettings', { inputKind: 'ffmpeg_source' });
    });
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
