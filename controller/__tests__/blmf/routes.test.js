const express = require('express');
const request = require('supertest');
const OperatorRegistry = require('../../blmf/operator_registry');
const DirectorLease = require('../../blmf/director_lease');
const CommandLedger = require('../../blmf/command_ledger');
const ControlPlane = require('../../blmf/control_plane');
const createBlmfRouter = require('../../blmf/routes');

function valid(command, overrides = {}) {
    return {
        command,
        bridgeId: 'mac-a',
        sessionId: 'session-a',
        commandId: `${command}-${Math.random()}`,
        sequence: 1,
        sentAt: 10000,
        ...overrides
    };
}

describe('BLMF routes', () => {
    let app;
    let coordinator;

    beforeEach(() => {
        const registry = OperatorRegistry.fromJson(JSON.stringify([
            { id: 'azumag', token: 'token-a', canPanic: true },
            { id: 'backup', token: 'token-b', canPanic: true }
        ]));
        const lease = new DirectorLease({ ttlMs: 15000, now: () => 10000 });
        const ledger = new CommandLedger({ maxAgeMs: 10000, now: () => 10000 });
        coordinator = {
            execute: jest.fn().mockResolvedValue({ ok: true, state: 'IDLE' }),
            snapshot: jest.fn().mockReturnValue({ state: 'IDLE', programView: 'VENUE', subView: 'STANDBY' })
        };
        const controlPlane = new ControlPlane({ lease, ledger, coordinator, logger: { info: jest.fn(), warning: jest.fn() } });
        app = express();
        app.use(express.json());
        app.use('/api/blmf', createBlmfRouter({ controlPlane, registry }));
    });

    test('requires bearer authentication', async () => {
        const response = await request(app).get('/api/blmf/state?bridgeId=mac-a');
        expect(response.status).toBe(401);
    });

    test('supports claim, heartbeat, state, and release for one Director', async () => {
        const auth = { Authorization: 'Bearer token-a' };
        expect((await request(app).post('/api/blmf/director/claim').set(auth).send({ bridgeId: 'mac-a' })).status).toBe(200);
        expect((await request(app).post('/api/blmf/director/heartbeat').set(auth).send({ bridgeId: 'mac-a' })).status).toBe(200);
        const state = await request(app).get('/api/blmf/state?bridgeId=mac-a').set(auth);
        expect(state.body.isDirector).toBe(true);
        expect((await request(app).post('/api/blmf/director/release').set(auth).send({ bridgeId: 'mac-a' })).status).toBe(200);
    });

    test('returns conflict while another Director lease is active', async () => {
        await request(app).post('/api/blmf/director/claim').set('Authorization', 'Bearer token-a').send({ bridgeId: 'mac-a' });
        const response = await request(app).post('/api/blmf/director/claim').set('Authorization', 'Bearer token-b').send({ bridgeId: 'pc-b' });
        expect(response.status).toBe(409);
        expect(response.body.reason).toBe('director_busy');
    });

    test('blocks normal command from backup but allows PANIC', async () => {
        await request(app).post('/api/blmf/director/claim').set('Authorization', 'Bearer token-a').send({ bridgeId: 'mac-a' });
        const blocked = await request(app).post('/api/blmf/commands').set('Authorization', 'Bearer token-b').send(valid('TAKE', { bridgeId: 'pc-b' }));
        expect(blocked.status).toBe(403);
        const panic = await request(app).post('/api/blmf/commands').set('Authorization', 'Bearer token-b').send(valid('PANIC', { bridgeId: 'pc-b', sequence: 2 }));
        expect(panic.status).toBe(200);
        expect(coordinator.execute).toHaveBeenCalledWith('PANIC');
    });

    test('returns conflict for duplicate commands', async () => {
        await request(app).post('/api/blmf/director/claim').set('Authorization', 'Bearer token-a').send({ bridgeId: 'mac-a' });
        const body = valid('VENUE', { commandId: 'same-id' });
        expect((await request(app).post('/api/blmf/commands').set('Authorization', 'Bearer token-a').send(body)).status).toBe(200);
        const replay = await request(app).post('/api/blmf/commands').set('Authorization', 'Bearer token-a').send(body);
        expect(replay.status).toBe(409);
        expect(replay.body.reason).toBe('duplicate_command');
    });
});
