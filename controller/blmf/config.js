const DEFAULT_DIRECTOR_LEASE_TTL_MS = 15000;
const DEFAULT_COMMAND_MAX_AGE_MS = 10000;
const DEFAULT_HEALTH_MAX_AGE_MS = 5000;

function loadBlmfConfig(env = process.env) {
    if (env.BLMF_ENABLED !== 'true') {
        return { enabled: false };
    }

    requireValue(env, 'BLMF_OPERATORS_JSON');
    requireValue(env, 'BLMF_MAIN_OBS_PASSWORD');
    requireValue(env, 'BLMF_SUB_OBS_URL');
    requireValue(env, 'BLMF_SUB_OBS_PASSWORD');

    return {
        enabled: true,
        operatorsJson: env.BLMF_OPERATORS_JSON,
        mainObsUrl: env.BLMF_MAIN_OBS_URL || 'ws://127.0.0.1:4455',
        mainObsPassword: env.BLMF_MAIN_OBS_PASSWORD,
        subObsUrl: env.BLMF_SUB_OBS_URL,
        subObsPassword: env.BLMF_SUB_OBS_PASSWORD,
        directorLeaseTtlMs: positiveInt(env.BLMF_DIRECTOR_LEASE_TTL_MS, DEFAULT_DIRECTOR_LEASE_TTL_MS),
        commandMaxAgeMs: positiveInt(env.BLMF_COMMAND_MAX_AGE_MS, DEFAULT_COMMAND_MAX_AGE_MS),
        takeDelayMs: nonNegativeInt(env.BLMF_MAIN_TAKE_DELAY_MS, 0),
        entries: parseEntries(env.BLMF_ENTRIES_JSON),
        healthMaxAgeMs: positiveInt(env.BLMF_HEALTH_MAX_AGE_MS, DEFAULT_HEALTH_MAX_AGE_MS),
        mediaInput: env.BLMF_ENTRY_MEDIA_INPUT || 'entry_player',
        scenes: {
            mainVenue: env.BLMF_MAIN_VENUE_SCENE || 'VRC_VENUE',
            mainEntry: env.BLMF_MAIN_ENTRY_SCENE || 'ENTRY_FULLSCREEN',
            subEntry: env.BLMF_SUB_ENTRY_SCENE || 'ENTRY',
            subStandby: env.BLMF_SUB_STANDBY_SCENE || 'STANDBY'
        }
    };
}

function parseEntries(value) {
    if (value === undefined) {
        return [];
    }
    let entries;
    try {
        entries = JSON.parse(value);
    } catch (_error) {
        throw new Error('BLMF_ENTRIES_JSON must be a non-empty array of unique id/sceneName/mediaInput mappings');
    }
    const fields = ['id', 'sceneName', 'mediaInput'];
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) =>
        !entry || fields.some((field) => typeof entry[field] !== 'string' || !entry[field].trim())
    ) || fields.some((field) => new Set(entries.map((entry) => entry[field])).size !== entries.length)) {
        throw new Error('BLMF_ENTRIES_JSON must be a non-empty array of unique id/sceneName/mediaInput mappings');
    }
    return entries.map(({ id, sceneName, mediaInput }) => ({ id, sceneName, mediaInput }));
}

function requireValue(env, key) {
    if (typeof env[key] !== 'string' || env[key].trim().length === 0) {
        throw new Error(`${key} is required when BLMF is enabled`);
    }
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

module.exports = loadBlmfConfig;
