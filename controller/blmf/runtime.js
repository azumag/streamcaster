const OperatorRegistry = require('./operator_registry');
const DirectorLease = require('./director_lease');
const CommandLedger = require('./command_ledger');
const ObsClient = require('./obs_client');
const BlmfCoordinator = require('./coordinator');
const ControlPlane = require('./control_plane');
const createBlmfRouter = require('./routes');
const DEFAULT_HEALTH_MAX_AGE_MS = 5000;

function createBlmfRuntime(config, { obsClientFactory, logger = console, now = Date.now,
    assetReadinessProvider = async () => null, ndiHealthProvider = async () => null } = {}) {
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

    const healthMaxAgeMs = config.healthMaxAgeMs || DEFAULT_HEALTH_MAX_AGE_MS;
    const isFresh = (evidence) => evidence && Number.isFinite(evidence.observedAt) &&
        now() >= evidence.observedAt && now() - evidence.observedAt <= healthMaxAgeMs;
    const safeRead = async (read) => {
        try {
            return await read();
        } catch (_error) {
            return null;
        }
    };
    const readinessProvider = async (entry) => {
        const mainConnected = mainObs.isConnected();
        const subConnected = subObs.isConnected();
        const [vrcdnActive, inspection, asset, ndi] = await Promise.all([
            subConnected ? safeRead(() => subObs.getStreamActive()) : false,
            subConnected && entry ? safeRead(() => subObs.inspectEntry(entry)) : null,
            subConnected && entry ? safeRead(() => assetReadinessProvider(entry)) : null,
            mainConnected ? safeRead(() => ndiHealthProvider()) : null
        ]);
        return {
            mainConnected: mainConnected && mainObs.isConnected(),
            subConnected: subConnected && subObs.isConnected(),
            assetReady: !!(entry && inspection && inspection.configured && isFresh(asset) &&
                asset.entryId === entry.id && asset.ready === true),
            vrcdnActive: vrcdnActive === true,
            ndiHealthy: !!(isFresh(ndi) && ndi.healthy === true),
            validUntil: Math.min(asset && asset.observedAt || 0, ndi && ndi.observedAt || 0) + healthMaxAgeMs
        };
    };

    const coordinator = new BlmfCoordinator({
        mainObs,
        subObs,
        readinessProvider,
        scenes: config.scenes,
        mediaInput: config.mediaInput,
        takeDelayMs: config.takeDelayMs,
        entries: config.entries,
        healthMaxAgeMs: config.healthMaxAgeMs,
        now
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
