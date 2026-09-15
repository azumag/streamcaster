class ObsClient {
    constructor({ url, password, clientFactory } = {}) {
        this.url = url;
        this.password = password;
        this.clientFactory = clientFactory || (() => {
            const { OBSWebSocket } = require('obs-websocket-js');
            return new OBSWebSocket();
        });
        this.client = this.clientFactory();
        this.connected = false;
        this.client.on('ConnectionClosed', () => {
            this.connected = false;
        });
    }

    async connect() {
        try {
            const result = await this.client.connect(this.url, this.password);
            this.connected = true;
            return result;
        } catch (error) {
            this.connected = false;
            throw error;
        }
    }

    async disconnect() {
        await this.client.disconnect();
        this.connected = false;
    }

    isConnected() {
        return this.connected;
    }

    async setProgramScene(sceneName) {
        return this.client.call('SetCurrentProgramScene', { sceneName });
    }

    async restartMedia(inputName) {
        return this.client.call('TriggerMediaInputAction', {
            inputName,
            mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
        });
    }

    async getStreamActive() {
        const status = await this.client.call('GetStreamStatus');
        return status.outputActive === true && status.outputReconnecting !== true;
    }

    async getProgramScene() {
        const result = await this.client.call('GetCurrentProgramScene');
        return result.currentProgramSceneName;
    }

    async getMediaStatus(inputName) {
        const result = await this.client.call('GetMediaInputStatus', { inputName });
        return { mediaState: result.mediaState, mediaCursor: result.mediaCursor, mediaDuration: result.mediaDuration };
    }

    async inspectEntry({ sceneName, mediaInput }) {
        const { sceneItems } = await this.client.call('GetSceneItemList', { sceneName });
        const { inputKind, inputSettings } = await this.client.call('GetInputSettings', { inputName: mediaInput });
        const { defaultInputSettings } = await this.client.call('GetInputDefaultSettings', { inputKind });
        const settings = { ...defaultInputSettings, ...inputSettings };
        const { videoActive } = await this.client.call('GetSourceActive', { sourceName: mediaInput });
        // Only return readiness facts; never return local paths or arbitrary OBS settings.
        return {
            configured: sceneItems.some((item) => item.sourceName === mediaInput && item.sceneItemEnabled === true) &&
                inputKind === 'ffmpeg_source' && settings.is_local_file === true &&
                typeof settings.local_file === 'string' && settings.local_file.length > 0 &&
                settings.close_when_inactive === true && typeof settings.restart_on_activate === 'boolean',
            restartOnActivate: settings.restart_on_activate === true,
            inactive: videoActive === false
        };
    }
}

module.exports = ObsClient;
