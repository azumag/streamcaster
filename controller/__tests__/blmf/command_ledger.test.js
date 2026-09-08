const CommandLedger = require('../../blmf/command_ledger');

describe('CommandLedger', () => {
    test('rejects duplicate, out-of-order, and stale commands', () => {
        let now = 10000;
        const ledger = new CommandLedger({ maxAgeMs: 10000, now: () => now });
        const base = { operatorId: 'azumag', bridgeId: 'mac-a', sessionId: 's1', sentAt: now };

        expect(ledger.accept({ ...base, commandId: 'c1', sequence: 1 }).ok).toBe(true);
        expect(ledger.accept({ ...base, commandId: 'c1', sequence: 2 }).reason).toBe('duplicate_command');
        expect(ledger.accept({ ...base, commandId: 'c2', sequence: 1 }).reason).toBe('out_of_order');

        now = 25001;
        expect(ledger.accept({ ...base, commandId: 'c3', sequence: 3 }).reason).toBe('stale_command');
    });

    test('allows sequence reset for a new bridge session', () => {
        const ledger = new CommandLedger({ maxAgeMs: 10000, now: () => 10000 });
        expect(ledger.accept({ operatorId: 'a', bridgeId: 'b', sessionId: 's1', commandId: '1', sequence: 9, sentAt: 10000 }).ok).toBe(true);
        expect(ledger.accept({ operatorId: 'a', bridgeId: 'b', sessionId: 's2', commandId: '2', sequence: 1, sentAt: 10000 }).ok).toBe(true);
    });

    test('rejects incomplete envelopes', () => {
        const ledger = new CommandLedger({ maxAgeMs: 10000, now: () => 10000 });
        expect(ledger.accept({}).reason).toBe('invalid_envelope');
    });
});
