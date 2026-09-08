const StreamCasterClient = require('../streamcaster_client');

function response(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: jest.fn().mockResolvedValue(body)
    };
}

describe('StreamCasterClient', () => {
    test('sends authenticated Director lifecycle requests bound to bridge id', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(200, { ok: true }));
        const client = new StreamCasterClient({
            baseUrl: 'http://100.64.0.10:8080/',
            token: 'operator-secret',
            bridgeId: 'pc-a',
            sessionId: 'session-a',
            fetchImpl,
            now: () => 10000,
            idFactory: () => 'command-id'
        });

        await client.claimDirector();
        await client.heartbeatDirector();
        await client.releaseDirector();

        expect(fetchImpl).toHaveBeenNthCalledWith(1,
            'http://100.64.0.10:8080/api/blmf/director/claim',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Authorization: 'Bearer operator-secret' }),
                body: JSON.stringify({ bridgeId: 'pc-a' })
            })
        );
        expect(fetchImpl.mock.calls[1][1].body).toBe(JSON.stringify({ bridgeId: 'pc-a' }));
        expect(fetchImpl.mock.calls[2][1].body).toBe(JSON.stringify({ bridgeId: 'pc-a' }));
    });

    test('uses stable session, unique command ids, and monotonically increasing sequence', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(200, { ok: true, state: 'IDLE' }));
        let id = 0;
        const client = new StreamCasterClient({
            baseUrl: 'http://controller:8080',
            token: 'secret',
            bridgeId: 'pc-a',
            sessionId: 'session-fixed',
            fetchImpl,
            now: () => 12345,
            idFactory: () => `id-${++id}`
        });

        await client.sendCommand('VENUE');
        await client.sendCommand('ENTRY');

        const first = JSON.parse(fetchImpl.mock.calls[0][1].body);
        const second = JSON.parse(fetchImpl.mock.calls[1][1].body);
        expect(first).toMatchObject({
            command: 'VENUE', bridgeId: 'pc-a', sessionId: 'session-fixed',
            commandId: 'id-1', sequence: 1, sentAt: 12345
        });
        expect(second).toMatchObject({
            command: 'ENTRY', bridgeId: 'pc-a', sessionId: 'session-fixed',
            commandId: 'id-2', sequence: 2, sentAt: 12345
        });
    });

    test('preserves structured server rejection reasons instead of throwing them away', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(403, { ok: false, reason: 'director_required' }));
        const client = new StreamCasterClient({
            baseUrl: 'http://controller:8080', token: 'secret', bridgeId: 'pc-b',
            sessionId: 's', fetchImpl, now: () => 1, idFactory: () => 'id'
        });
        await expect(client.sendCommand('TAKE')).resolves.toEqual({
            ok: false, reason: 'director_required', status: 403
        });
    });

    test('reads protected state for this bridge', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(response(200, { ok: true, isDirector: true }));
        const client = new StreamCasterClient({
            baseUrl: 'http://controller:8080', token: 'secret', bridgeId: 'pc a',
            sessionId: 's', fetchImpl
        });
        expect(await client.getState()).toMatchObject({ ok: true, isDirector: true });
        expect(fetchImpl.mock.calls[0][0]).toBe('http://controller:8080/api/blmf/state?bridgeId=pc%20a');
    });
});
