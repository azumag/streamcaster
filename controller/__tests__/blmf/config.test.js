const loadBlmfConfig = require('../../blmf/config');

describe('loadBlmfConfig', () => {
    const enabled = {
        BLMF_ENABLED: 'true', BLMF_OPERATORS_JSON: '[]',
        BLMF_MAIN_OBS_PASSWORD: 'test', BLMF_SUB_OBS_URL: 'ws://sub:4455', BLMF_SUB_OBS_PASSWORD: 'test'
    };
    test('loads scene mappings without retaining unrelated fields', () => {
        expect(loadBlmfConfig({ ...enabled, BLMF_ENTRIES_JSON: JSON.stringify([
            { id: 'one', sceneName: 'ENTRY_001', mediaInput: 'ENTRY_001_MEDIA', ignored: 'private' },
            { id: 'two', sceneName: 'ENTRY_002', mediaInput: 'ENTRY_002_MEDIA' }
        ]) }).entries).toEqual([
            { id: 'one', sceneName: 'ENTRY_001', mediaInput: 'ENTRY_001_MEDIA' },
            { id: 'two', sceneName: 'ENTRY_002', mediaInput: 'ENTRY_002_MEDIA' }
        ]);
    });
    test.each(['private-invalid-json', '[]', '{}', '[null]', '[{"id":"one"}]',
        JSON.stringify([{ id: 'a', sceneName: 'A', mediaInput: 'SHARED' }, { id: 'b', sceneName: 'B', mediaInput: 'SHARED' }])
    ])('rejects malformed or shared-source mappings without echoing the value', (value) => {
        expect(() => loadBlmfConfig({ ...enabled, BLMF_ENTRIES_JSON: value }))
            .toThrow('BLMF_ENTRIES_JSON must be a non-empty array of unique id/sceneName/mediaInput mappings');
    });
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
