const { loadConfig } = require('../index');

describe('operator bridge config', () => {
    test('fails closed when central URL, token, or bridge id is missing', () => {
        expect(() => loadConfig({})).toThrow('STREAMCASTER_URL is required');
        expect(() => loadConfig({ STREAMCASTER_URL: 'http://controller:8080' })).toThrow('BLMF_OPERATOR_TOKEN is required');
        expect(() => loadConfig({
            STREAMCASTER_URL: 'http://controller:8080',
            BLMF_OPERATOR_TOKEN: 'secret'
        })).toThrow('BLMF_BRIDGE_ID is required');
    });

    test('uses localhost VRChat OSC port defaults', () => {
        expect(loadConfig({
            STREAMCASTER_URL: 'http://100.64.0.10:8080',
            BLMF_OPERATOR_TOKEN: 'secret',
            BLMF_BRIDGE_ID: 'pc-a'
        })).toMatchObject({
            streamCasterUrl: 'http://100.64.0.10:8080',
            token: 'secret',
            bridgeId: 'pc-a',
            oscInPort: 9001,
            oscOutPort: 9000,
            oscHost: '127.0.0.1'
        });
    });
});
