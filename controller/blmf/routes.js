const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503
};

const express = require('express');

function createBlmfRouter({ controlPlane, registry }) {
    const router = express.Router();

    router.use((req, res, next) => {
        const operator = registry.authenticateBearer(req.get('Authorization'));
        if (!operator) {
            return res.status(HTTP_STATUS.UNAUTHORIZED).json({ ok: false, reason: 'unauthorized' });
        }
        req.blmfOperator = operator;
        next();
    });

    router.post('/director/claim', (req, res) => {
        respond(res, controlPlane.claim(req.blmfOperator, req.body && req.body.bridgeId));
    });

    router.post('/director/heartbeat', (req, res) => {
        respond(res, controlPlane.heartbeat(req.blmfOperator, req.body && req.body.bridgeId));
    });

    router.post('/director/release', (req, res) => {
        respond(res, controlPlane.release(req.blmfOperator, req.body && req.body.bridgeId));
    });

    router.post('/commands', async (req, res) => {
        const result = await controlPlane.command(req.blmfOperator, req.body);
        respond(res, result);
    });

    router.get('/state', (req, res) => {
        res.json(controlPlane.state(req.blmfOperator, req.query.bridgeId));
    });

    return router;
}

function respond(res, result) {
    return res.status(statusFor(result)).json(result);
}

function statusFor(result) {
    if (result.ok) {
        return HTTP_STATUS.OK;
    }
    switch (result.reason) {
    case 'director_required':
    case 'not_director':
    case 'panic_not_allowed':
        return HTTP_STATUS.FORBIDDEN;
    case 'director_busy':
    case 'duplicate_command':
    case 'out_of_order':
    case 'stale_command':
    case 'not_ready':
    case 'ndi_not_ready':
    case 'preparer_unavailable':
        return HTTP_STATUS.CONFLICT;
    case 'bridge_id_required':
    case 'invalid_command':
    case 'invalid_envelope':
        return HTTP_STATUS.BAD_REQUEST;
    case 'command_failed':
        return HTTP_STATUS.SERVICE_UNAVAILABLE;
    default:
        return HTTP_STATUS.INTERNAL_SERVER_ERROR;
    }
}

module.exports = createBlmfRouter;
module.exports.statusFor = statusFor;
