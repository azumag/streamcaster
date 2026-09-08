const OperatorRegistry = require('../../blmf/operator_registry');
const DirectorLease = require('../../blmf/director_lease');
const CommandLedger = require('../../blmf/command_ledger');
const BlmfCoordinator = require('../../blmf/coordinator');
const ControlPlane = require('../../blmf/control_plane');

function payload(command, sequence, commandId, bridgeId) {
    return {
        command,
        bridgeId,
        sessionId: `session-${bridgeId}`,
        commandId,
        sequence,
        sentAt: 10000
    };
}

describe('BLMF control plane integration', () => {
    test('enforces Director ownership, safe PANIC, readiness, and replay protection end-to-end', async () => {
        const registry = OperatorRegistry.fromJson(JSON.stringify([
            { id: 'operator-a', token: 'token-a', canPanic: true },
            { id: 'operator-b', token: 'token-b', canPanic: true }
        ]));
        const a = registry.authenticateBearer('Bearer token-a');
        const b = registry.authenticateBearer('Bearer token-b');
        const mainObs = { setProgramScene: jest.fn().mockResolvedValue() };
        const subObs = {
            setProgramScene: jest.fn().mockResolvedValue(),
            restartMedia: jest.fn().mockResolvedValue()
        };
        const coordinator = new BlmfCoordinator({
            mainObs,
            subObs,
            readinessProvider: async () => ({
                mainConnected: true,
                subConnected: true,
                assetReady: false,
                vrcdnActive: true,
                ndiHealthy: false
            })
        });
        const plane = new ControlPlane({
            lease: new DirectorLease({ ttlMs: 15000, now: () => 10000 }),
            ledger: new CommandLedger({ maxAgeMs: 10000, now: () => 10000 }),
            coordinator,
            logger: { info: jest.fn(), warning: jest.fn() }
        });

        expect(plane.claim(a, 'bridge-a').ok).toBe(true);
        expect(await plane.command(a, payload('NEXT', 1, 'a-next', 'bridge-a')))
            .toMatchObject({ ok: false, reason: 'preparer_unavailable' });
        expect(await plane.command(a, payload('TAKE', 2, 'a-take', 'bridge-a')))
            .toMatchObject({ ok: false, reason: 'not_ready' });
        expect(await plane.command(a, payload('VENUE', 3, 'a-venue', 'bridge-a')))
            .toMatchObject({ ok: true });
        expect(mainObs.setProgramScene).toHaveBeenCalledWith('VRC_VENUE');
        expect(subObs.restartMedia).not.toHaveBeenCalled();

        expect(await plane.command(b, payload('TAKE', 1, 'b-take', 'bridge-b')))
            .toMatchObject({ ok: false, reason: 'director_required' });
        expect(await plane.command(b, payload('PANIC', 2, 'b-panic', 'bridge-b')))
            .toMatchObject({ ok: true, state: 'IDLE' });
        expect(mainObs.setProgramScene).toHaveBeenLastCalledWith('VRC_VENUE');
        expect(subObs.setProgramScene).toHaveBeenLastCalledWith('STANDBY');

        expect(plane.release(a, 'bridge-a').ok).toBe(true);
        expect(plane.claim(b, 'bridge-b').ok).toBe(true);

        const first = await plane.command(b, payload('VENUE', 3, 'replay-id', 'bridge-b'));
        const replay = await plane.command(b, payload('VENUE', 4, 'replay-id', 'bridge-b'));
        expect(first.ok).toBe(true);
        expect(replay).toEqual({ ok: false, reason: 'duplicate_command' });
    });
});
