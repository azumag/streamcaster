const loadBlmfConfig = require('../../blmf/config');

describe('loadBlmfConfig', () => {
    test('does not require BLMF secrets when disabled', () => {
        expect(loadBlmfConfig({})).toEqual({ enabled: false });
    });

    test('fails closed when enabled configuration is incomplete', () => {
        expect(() => loadBlmfConfig({ BLMF_ENABLED: 'true' })).toThrow('BLMF_OPERATORS_JSON is required');
    });

    test('loads safe defaults and explicit OBS credentials', () => {
        const config = loadBlmfConfig({
            BLMF_ENABLED: 'true',
            BLMF_OPERATORS_JSON: '[{"id":"azumag","token":"x"}]',
            BLMF_MAIN_OBS_PASSWORD: 'main-pw',
            BLMF_SUB_OBS_URL: 'ws://100.64.0.20:4455',
            BLMF_SUB_OBS_PASSWORD: 'sub-pw'
        });
        expect(config).toMatchObject({
            enabled: true,
            mainObsUrl: 'ws://127.0.0.1:4455',
            subObsUrl: 'ws://100.64.0.20:4455',
            directorLeaseTtlMs: 15000,
            commandMaxAgeMs: 10000,
            mediaInput: 'entry_player'
        });
    });
});
