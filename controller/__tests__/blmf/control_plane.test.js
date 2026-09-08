const ControlPlane = require('../../blmf/control_plane');
const DirectorLease = require('../../blmf/director_lease');
const CommandLedger = require('../../blmf/command_ledger');

function envelope(command, overrides = {}) {
    return {
        command,
        bridgeId: 'mac-a',
        sessionId: 'session-a',
        commandId: `${command}-1`,
        sequence: 1,
        sentAt: 10000,
        ...overrides
    };
}

describe('ControlPlane', () => {
    let coordinator;
    let lease;
    let ledger;
    let logger;
    let plane;

    beforeEach(() => {
        coordinator = {
            execute: jest.fn().mockResolvedValue({ ok: true, state: 'IDLE' }),
            snapshot: jest.fn().mockReturnValue({ state: 'IDLE', programView: 'VENUE', subView: 'STANDBY' })
        };
        lease = new DirectorLease({ ttlMs: 15000, now: () => 10000 });
        ledger = new CommandLedger({ maxAgeMs: 10000, now: () => 10000 });
        logger = { info: jest.fn(), warning: jest.fn() };
        plane = new ControlPlane({ lease, ledger, coordinator, logger });
    });

    test('requires Director lease for normal commands but not PANIC', async () => {
        const operator = { id: 'backup', canPanic: true };
        expect((await plane.command(operator, envelope('TAKE'))).reason).toBe('director_required');
        expect((await plane.command(operator, envelope('PANIC', { commandId: 'panic-1', sequence: 2 }))).ok).toBe(true);
        expect(coordinator.execute).toHaveBeenCalledWith('PANIC');
    });

    test('rejects PANIC when operator is not permitted', async () => {
        const result = await plane.command({ id: 'viewer', canPanic: false }, envelope('PANIC'));
        expect(result).toMatchObject({ ok: false, reason: 'panic_not_allowed' });
        expect(coordinator.execute).not.toHaveBeenCalled();
    });

    test('binds Director operations to operator and bridge', () => {
        expect(plane.claim({ id: 'azumag' }, 'mac-a').ok).toBe(true);
        expect(plane.heartbeat({ id: 'azumag' }, 'mac-b').ok).toBe(false);
        expect(plane.state({ id: 'azumag' }, 'mac-a').isDirector).toBe(true);
        expect(plane.release({ id: 'azumag' }, 'mac-a').ok).toBe(true);
    });

    test('runs replay protection before coordinator execution', async () => {
        const operator = { id: 'azumag', canPanic: true };
        plane.claim(operator, 'mac-a');
        expect((await plane.command(operator, envelope('VENUE'))).ok).toBe(true);
        expect((await plane.command(operator, envelope('VENUE'))).reason).toBe('duplicate_command');
        expect(coordinator.execute).toHaveBeenCalledTimes(1);
    });

    test('logs authenticated operator and bridge without credentials', async () => {
        const operator = { id: 'azumag', canPanic: true };
        plane.claim(operator, 'mac-a');
        await plane.command(operator, envelope('VENUE'));
        expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
            event: 'blmf_command',
            operatorId: 'azumag',
            bridgeId: 'mac-a',
            command: 'VENUE'
        }));
    });
});
