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
        return status.outputActive === true;
    }
}

module.exports = ObsClient;
