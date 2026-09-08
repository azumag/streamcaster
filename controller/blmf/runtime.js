const OperatorRegistry = require('./operator_registry');
const DirectorLease = require('./director_lease');
const CommandLedger = require('./command_ledger');
const ObsClient = require('./obs_client');
const BlmfCoordinator = require('./coordinator');
const ControlPlane = require('./control_plane');
const createBlmfRouter = require('./routes');

function createBlmfRuntime(config, { obsClientFactory, logger = console, now = Date.now } = {}) {
    const registry = OperatorRegistry.fromJson(config.operatorsJson);
    const factory = obsClientFactory || ((options) => new ObsClient(options));
    const mainObs = factory({
        role: 'main',
        url: config.mainObsUrl,
        password: config.mainObsPassword
    });
    const subObs = factory({
        role: 'sub',
        url: config.subObsUrl,
        password: config.subObsPassword
    });

    const readinessProvider = async () => {
        const mainConnected = mainObs.isConnected();
        const subConnected = subObs.isConnected();
        let vrcdnActive = false;
        if (subConnected) {
            try {
                vrcdnActive = await subObs.getStreamActive();
            } catch (_error) {
                vrcdnActive = false;
            }
        }
        return {
            mainConnected,
            subConnected,
            assetReady: false,
            vrcdnActive,
            ndiHealthy: false
        };
    };

    const coordinator = new BlmfCoordinator({
        mainObs,
        subObs,
        readinessProvider,
        scenes: config.scenes,
        mediaInput: config.mediaInput,
        takeDelayMs: config.takeDelayMs
    });
    const lease = new DirectorLease({ ttlMs: config.directorLeaseTtlMs, now });
    const ledger = new CommandLedger({ maxAgeMs: config.commandMaxAgeMs, now });
    const controlPlane = new ControlPlane({ lease, ledger, coordinator, logger });
    const router = createBlmfRouter({ controlPlane, registry });

    return {
        router,
        coordinator,
        controlPlane,
        mainObs,
        subObs,
        async start() {
            const results = await Promise.allSettled([mainObs.connect(), subObs.connect()]);
            const labels = ['main', 'sub'];
            results.forEach((result, index) => {
                if (result.status === 'rejected' && logger && typeof logger.warning === 'function') {
                    logger.warning({
                        event: 'blmf_obs_connect_failed',
                        role: labels[index],
                        error: result.reason && result.reason.message ? result.reason.message : String(result.reason)
                    });
                }
            });
            return {
                mainConnected: mainObs.isConnected(),
                subConnected: subObs.isConnected()
            };
        },
        async stop() {
            return Promise.allSettled([
                mainObs.isConnected() ? mainObs.disconnect() : Promise.resolve(),
                subObs.isConnected() ? subObs.disconnect() : Promise.resolve()
            ]);
        }
    };
}

module.exports = createBlmfRuntime;
