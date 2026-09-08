const DirectorLease = require('../../blmf/director_lease');

describe('DirectorLease', () => {
    let now;

    beforeEach(() => {
        now = 1000;
    });

    test('allows one bridge to claim and renew the Director lease', () => {
        const lease = new DirectorLease({ ttlMs: 15000, now: () => now });
        expect(lease.claim('azumag', 'mac-a').ok).toBe(true);
        now += 5000;
        expect(lease.heartbeat('azumag', 'mac-a').ok).toBe(true);
        expect(lease.snapshot().expiresAt).toBe(21000);
    });

    test('rejects another operator until the lease expires', () => {
        const lease = new DirectorLease({ ttlMs: 15000, now: () => now });
        lease.claim('azumag', 'mac-a');
        expect(lease.claim('operator-b', 'pc-b').ok).toBe(false);
        now += 15001;
        expect(lease.claim('operator-b', 'pc-b').ok).toBe(true);
    });

    test('binds heartbeat and release to the exact bridge holder', () => {
        const lease = new DirectorLease({ ttlMs: 15000, now: () => now });
        lease.claim('azumag', 'mac-a');
        expect(lease.heartbeat('azumag', 'mac-b').ok).toBe(false);
        expect(lease.release('azumag', 'mac-b').ok).toBe(false);
        expect(lease.release('azumag', 'mac-a').ok).toBe(true);
        expect(lease.snapshot()).toBeNull();
    });
});
