const osc = require('osc');
const OscCommandDecoder = require('./osc_command_decoder');
const StreamCasterClient = require('./streamcaster_client');
const BridgeService = require('./bridge_service');

const DEFAULTS = {
    oscInPort: 9001,
    oscOutPort: 9000,
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 5000
};

function loadConfig(env = process.env) {
    requireValue(env, 'STREAMCASTER_URL');
    requireValue(env, 'BLMF_OPERATOR_TOKEN');
    requireValue(env, 'BLMF_BRIDGE_ID');
    return {
        streamCasterUrl: env.STREAMCASTER_URL,
        token: env.BLMF_OPERATOR_TOKEN,
        bridgeId: env.BLMF_BRIDGE_ID,
        oscHost: '127.0.0.1',
        oscInPort: positiveInt(env.VRCHAT_OSC_IN_PORT, DEFAULTS.oscInPort),
        oscOutPort: positiveInt(env.VRCHAT_OSC_OUT_PORT, DEFAULTS.oscOutPort),
        pollIntervalMs: positiveInt(env.BLMF_STATE_POLL_INTERVAL_MS, DEFAULTS.pollIntervalMs),
        heartbeatIntervalMs: positiveInt(env.BLMF_DIRECTOR_HEARTBEAT_INTERVAL_MS, DEFAULTS.heartbeatIntervalMs)
    };
}

function createService(config, logger = console) {
    const oscPort = new osc.UDPPort({
        localAddress: config.oscHost,
        localPort: config.oscInPort,
        remoteAddress: config.oscHost,
        remotePort: config.oscOutPort,
        metadata: false
    });
    const client = new StreamCasterClient({
        baseUrl: config.streamCasterUrl,
        token: config.token,
        bridgeId: config.bridgeId
    });
    return new BridgeService({
        oscPort,
        client,
        decoder: new OscCommandDecoder(),
        pollIntervalMs: config.pollIntervalMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        logger
    });
}

async function main(env = process.env) {
    const config = loadConfig(env);
    const service = createService(config);
    await service.start();
    console.log(`[operator-bridge] ready: bridge=${config.bridgeId}`);

    const stop = () => {
        service.stop();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return service;
}

function requireValue(env, key) {
    if (typeof env[key] !== 'string' || env[key].trim().length === 0) {
        throw new Error(`${key} is required`);
    }
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[operator-bridge] startup failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { loadConfig, createService, main };
