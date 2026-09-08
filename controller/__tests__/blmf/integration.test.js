const express = require('express');
const request = require('supertest');
const createBlmfIntegration = require('../../blmf/integration');

describe('BLMF controller integration', () => {
    test('is transparent when feature flag is disabled', async () => {
        const integration = createBlmfIntegration({ env: {} });
        const app = express();
        app.use('/api/blmf', integration.middleware);
        app.use((_req, res) => res.status(404).json({ fallback: true }));

        const response = await request(app).get('/api/blmf/state');
        expect(response.status).toBe(404);
        expect(response.body.fallback).toBe(true);
    });

    test('fails closed while enabled runtime has not started', async () => {
        const integration = createBlmfIntegration({ env: { BLMF_ENABLED: 'true' } });
        const app = express();
        app.use('/api/blmf', integration.middleware);

        const response = await request(app).get('/api/blmf/state');
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ ok: false, reason: 'blmf_starting' });
    });

    test('starts runtime then delegates BLMF requests', async () => {
        const router = express.Router();
        router.get('/state', (_req, res) => res.json({ ok: true, state: 'IDLE' }));
        const runtime = {
            router,
            start: jest.fn().mockResolvedValue({ mainConnected: false, subConnected: true }),
            stop: jest.fn().mockResolvedValue([])
        };
        const configLoader = jest.fn().mockReturnValue({ enabled: true });
        const runtimeFactory = jest.fn().mockReturnValue(runtime);
        const integration = createBlmfIntegration({
            env: { BLMF_ENABLED: 'true' },
            configLoader,
            runtimeFactory,
            logger: { info: jest.fn(), warning: jest.fn() }
        });
        const app = express();
        app.use('/api/blmf', integration.middleware);

        const started = await integration.start();
        const response = await request(app).get('/api/blmf/state');

        expect(started).toEqual({ enabled: true, mainConnected: false, subConnected: true });
        expect(configLoader).toHaveBeenCalled();
        expect(runtimeFactory).toHaveBeenCalled();
        expect(response.status).toBe(200);
        expect(response.body.state).toBe('IDLE');
        await integration.stop();
        expect(runtime.stop).toHaveBeenCalled();
    });

    test('propagates invalid enabled configuration before server listen', async () => {
        const integration = createBlmfIntegration({
            env: { BLMF_ENABLED: 'true' },
            configLoader: () => {
                throw new Error('invalid BLMF config');
            }
        });
        await expect(integration.start()).rejects.toThrow('invalid BLMF config');
    });
});
