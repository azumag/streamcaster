const loadBlmfConfig = require('./config');
const createBlmfRuntime = require('./runtime');

const HTTP_STATUS = {
    SERVICE_UNAVAILABLE: 503
};

function createBlmfIntegration({
    env = process.env,
    configLoader = loadBlmfConfig,
    runtimeFactory = createBlmfRuntime,
    logger = console
} = {}) {
    let runtime = null;

    const middleware = (req, res, next) => {
        if (env.BLMF_ENABLED !== 'true') {
            return next();
        }
        if (!runtime) {
            return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
                ok: false,
                reason: 'blmf_starting'
            });
        }
        return runtime.router(req, res, next);
    };

    return {
        middleware,
        async start() {
            const config = configLoader(env);
            if (!config.enabled) {
                return { enabled: false };
            }
            runtime = runtimeFactory(config, { logger });
            const status = await runtime.start();
            return { enabled: true, ...status };
        },
        async stop() {
            if (!runtime) {
                return [];
            }
            return runtime.stop();
        }
    };
}

module.exports = createBlmfIntegration;
