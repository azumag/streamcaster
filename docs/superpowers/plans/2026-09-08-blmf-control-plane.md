# BLMF Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the BLMF 2026 safe control plane for two OBS instances and multiple remote VRChat operators connected over Tailscale, without putting StreamCaster in the media path.

**Architecture:** Add focused `controller/blmf/` modules for authentication, Director lease, replay protection, OBS websocket orchestration, and protected HTTP routes. Add a separate `operator-bridge/` workspace that converts local VRChat OSC button edges into authenticated HTTP commands over Tailscale and converts central state back into local OSC feedback. The existing 2025 UDP/RTMP controller remains untouched unless `BLMF_ENABLED=true`.

**Tech Stack:** Node.js >=18, CommonJS, Express 4, Jest 29, Supertest, `obs-websocket-js@5.0.7`, `osc@2.4.5`, Tailscale network policy outside the application.

**Spec:** `docs/superpowers/specs/2026-09-08-blmf-2026-architecture-design.md`

## Global Constraints

- StreamCaster never owns Twitch, YouTube, VRCDN, or NDI output lifetime.
- `VENUE` changes Main OBS only; Sub playback continues.
- `ENTRY` changes Main OBS only; it never restarts Sub playback.
- `STANDBY` changes Sub OBS only.
- `PANIC` independently attempts Main -> `VRC_VENUE` and Sub -> `STANDBY`; it never stops an output.
- Exactly one active Director lease may issue normal production commands.
- Any authenticated operator with `canPanic !== false` may issue `PANIC` even without the Director lease.
- Commands are rejected when stale, duplicated, or out-of-order within the same bridge session.
- Remote VRChat clients never connect directly to OBS websocket endpoints.
- `BLMF_ENABLED` defaults to false and preserves the 2025 behavior when disabled.
- `BLMF_OPERATORS_JSON` must be non-empty when BLMF mode is enabled; missing operator auth fails closed.
- Pin `obs-websocket-js` to 5.0.7 so the existing Node >=18 support floor is preserved.

---

### Task 1: Operator authentication, Director lease, and replay protection

**Files:**
- Create: `controller/blmf/operator_registry.js`
- Create: `controller/blmf/director_lease.js`
- Create: `controller/blmf/command_ledger.js`
- Test: `controller/__tests__/blmf/operator_registry.test.js`
- Test: `controller/__tests__/blmf/director_lease.test.js`
- Test: `controller/__tests__/blmf/command_ledger.test.js`

**Interfaces:**
- `OperatorRegistry.fromJson(json)` -> `OperatorRegistry`
- `registry.authenticateBearer(header)` -> `{ id, canPanic } | null`
- `new DirectorLease({ ttlMs, now })`
- `lease.claim(operatorId, bridgeId)` -> `{ ok, director }`
- `lease.heartbeat(operatorId, bridgeId)` -> `{ ok, director }`
- `lease.release(operatorId, bridgeId)` -> `{ ok, director }`
- `lease.isDirector(operatorId, bridgeId)` -> `boolean`
- `lease.snapshot()` -> `{ operatorId, bridgeId, expiresAt } | null`
- `new CommandLedger({ maxAgeMs, now })`
- `ledger.accept({ operatorId, bridgeId, sessionId, commandId, sequence, sentAt })` -> `{ ok, reason? }`

- [ ] **Step 1: Write failing authentication tests**

```js
const OperatorRegistry = require('../../blmf/operator_registry');

test('maps a bearer token to configured operator identity', () => {
    const registry = OperatorRegistry.fromJson('[{"id":"azumag","token":"secret-a"}]');
    expect(registry.authenticateBearer('Bearer secret-a')).toEqual({ id: 'azumag', canPanic: true });
});

test('rejects unknown or missing bearer tokens', () => {
    const registry = OperatorRegistry.fromJson('[{"id":"azumag","token":"secret-a"}]');
    expect(registry.authenticateBearer('Bearer wrong')).toBeNull();
    expect(registry.authenticateBearer(undefined)).toBeNull();
});

test('rejects empty operator configuration', () => {
    expect(() => OperatorRegistry.fromJson('[]')).toThrow('At least one BLMF operator is required');
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd controller && npx jest __tests__/blmf/operator_registry.test.js --runInBand`
Expected: FAIL because `operator_registry` does not exist.

- [ ] **Step 3: Implement `OperatorRegistry` minimally**

Use `crypto.timingSafeEqual` for equal-length token comparison. Parse only `id`, `token`, and optional `canPanic`; never expose tokens from public methods.

- [ ] **Step 4: Run authentication tests and verify GREEN**

Run: `cd controller && npx jest __tests__/blmf/operator_registry.test.js --runInBand`
Expected: PASS.

- [ ] **Step 5: Write failing Director lease tests**

```js
const DirectorLease = require('../../blmf/director_lease');

let now;
beforeEach(() => { now = 1000; });

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
```

- [ ] **Step 6: Run Director lease tests and verify RED**

Run: `cd controller && npx jest __tests__/blmf/director_lease.test.js --runInBand`
Expected: FAIL because `director_lease` does not exist.

- [ ] **Step 7: Implement `DirectorLease` and verify GREEN**

Expired leases are treated as absent. Release and heartbeat require the exact `{operatorId, bridgeId}` holder pair.

Run: `cd controller && npx jest __tests__/blmf/director_lease.test.js --runInBand`
Expected: PASS.

- [ ] **Step 8: Write failing replay-protection tests**

```js
const CommandLedger = require('../../blmf/command_ledger');

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
```

- [ ] **Step 9: Implement `CommandLedger`, run Task 1 tests, and commit**

Run: `cd controller && npx jest __tests__/blmf/operator_registry.test.js __tests__/blmf/director_lease.test.js __tests__/blmf/command_ledger.test.js --runInBand`
Expected: PASS.

Commit: `git commit -am "feat: add BLMF operator command guards"` plus newly created files.

---

### Task 2: OBS websocket adapter and safe coordinator

**Files:**
- Create: `controller/blmf/obs_client.js`
- Create: `controller/blmf/coordinator.js`
- Test: `controller/__tests__/blmf/obs_client.test.js`
- Test: `controller/__tests__/blmf/coordinator.test.js`
- Modify: `controller/package.json`
- Modify: `controller/package-lock.json`

**Interfaces:**
- `new ObsClient({ url, password, clientFactory })`
- `obs.connect()` / `obs.disconnect()` / `obs.isConnected()`
- `obs.setProgramScene(sceneName)`
- `obs.restartMedia(inputName)`
- `obs.getStreamActive()`
- `new BlmfCoordinator({ mainObs, subObs, readinessProvider, preparer, scenes, mediaInput, takeDelayMs, sleep })`
- `coordinator.execute(command)` -> `{ ok, state, reason?, panicResults? }`
- `coordinator.snapshot()` -> state object

- [ ] **Step 1: Write failing OBS adapter test**

```js
const ObsClient = require('../../blmf/obs_client');

test('maps scene and media actions to obs-websocket v5 requests', async () => {
    const call = jest.fn().mockResolvedValue({ outputActive: true });
    const raw = { connect: jest.fn().mockResolvedValue({}), disconnect: jest.fn(), call };
    const obs = new ObsClient({ url: 'ws://127.0.0.1:4455', password: 'pw', clientFactory: () => raw });
    await obs.connect();
    await obs.setProgramScene('VRC_VENUE');
    await obs.restartMedia('entry_player');
    expect(call).toHaveBeenCalledWith('SetCurrentProgramScene', { sceneName: 'VRC_VENUE' });
    expect(call).toHaveBeenCalledWith('TriggerMediaInputAction', {
        inputName: 'entry_player',
        mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'
    });
});
```

- [ ] **Step 2: Run and verify RED, then install pinned dependency**

Run: `cd controller && npx jest __tests__/blmf/obs_client.test.js --runInBand`
Expected: FAIL because `obs_client` does not exist.

Run: `cd controller && npm install --save-exact obs-websocket-js@5.0.7 --workspaces=false`

Then from the repository root run `npm install --package-lock-only` so both the controller-local CI lockfile and root workspace lockfile record the dependency.

- [ ] **Step 3: Implement `ObsClient` and verify GREEN**

The default factory must load the CommonJS-compatible `obs-websocket-js@5.0.7` export. Connection failures leave `isConnected()` false; disconnect events also clear connection state.

- [ ] **Step 4: Write failing coordinator safety tests**

```js
const BlmfCoordinator = require('../../blmf/coordinator');

test('VENUE only changes Main and ENTRY does not restart Sub playback', async () => {
    const mainObs = { setProgramScene: jest.fn() };
    const subObs = { setProgramScene: jest.fn(), restartMedia: jest.fn() };
    const c = new BlmfCoordinator({ mainObs, subObs, readinessProvider: async () => ({ ndiHealthy: true }) });
    await c.execute('VENUE');
    await c.execute('ENTRY');
    expect(mainObs.setProgramScene).toHaveBeenNthCalledWith(1, 'VRC_VENUE');
    expect(mainObs.setProgramScene).toHaveBeenNthCalledWith(2, 'ENTRY_FULLSCREEN');
    expect(subObs.setProgramScene).not.toHaveBeenCalled();
    expect(subObs.restartMedia).not.toHaveBeenCalled();
});

test('PANIC attempts both safe actions even when Main fails', async () => {
    const mainObs = { setProgramScene: jest.fn().mockRejectedValue(new Error('main down')) };
    const subObs = { setProgramScene: jest.fn().mockResolvedValue() };
    const c = new BlmfCoordinator({ mainObs, subObs, readinessProvider: async () => ({}) });
    const result = await c.execute('PANIC');
    expect(subObs.setProgramScene).toHaveBeenCalledWith('STANDBY');
    expect(result.ok).toBe(false);
    expect(result.state).toBe('DEGRADED');
});

test('TAKE is rejected unless every readiness gate is true', async () => {
    const c = new BlmfCoordinator({
        mainObs: { setProgramScene: jest.fn() },
        subObs: { setProgramScene: jest.fn(), restartMedia: jest.fn() },
        readinessProvider: async () => ({ mainConnected: true, subConnected: true, assetReady: true, vrcdnActive: true, ndiHealthy: false })
    });
    expect((await c.execute('TAKE')).reason).toBe('not_ready');
});
```

- [ ] **Step 5: Implement coordinator commands**

`TAKE`: readiness -> Sub `ENTRY` -> restart `entry_player` -> optional delay -> Main `ENTRY_FULLSCREEN` -> `ON_AIR`.
`VENUE`: Main `VRC_VENUE` only.
`ENTRY`: require `ndiHealthy`, Main `ENTRY_FULLSCREEN` only.
`STANDBY`: Sub `STANDBY` only.
`PANIC`: `Promise.allSettled` for Main venue and Sub standby; no stream/output calls.
`NEXT`: delegate to `preparer.prepareNext()` when present; otherwise reject with `preparer_unavailable`.

- [ ] **Step 6: Run Task 2 tests and commit**

Run: `cd controller && npx jest __tests__/blmf/obs_client.test.js __tests__/blmf/coordinator.test.js --runInBand`
Expected: PASS.

Commit: `feat: add dual OBS BLMF coordinator`.

---

### Task 3: Protected central control API

**Files:**
- Create: `controller/blmf/control_plane.js`
- Create: `controller/blmf/routes.js`
- Create: `controller/blmf/config.js`
- Test: `controller/__tests__/blmf/control_plane.test.js`
- Test: `controller/__tests__/blmf/routes.test.js`
- Modify: `controller/controller.js`
- Modify: `.env.example`

**Interfaces:**
- `new ControlPlane({ registry, lease, ledger, coordinator, now })`
- `controlPlane.claim(operator, bridgeId)`
- `controlPlane.heartbeat(operator, bridgeId)`
- `controlPlane.release(operator, bridgeId)`
- `controlPlane.command(operator, payload)`
- `controlPlane.state(operator)`
- `createBlmfRouter({ controlPlane, registry })` -> Express router
- `loadBlmfConfig(env)` -> validated config

- [ ] **Step 1: Write failing ControlPlane tests**

```js
test('requires Director lease for normal commands but not PANIC', async () => {
    const operator = { id: 'backup', canPanic: true };
    expect((await plane.command(operator, valid('TAKE'))).reason).toBe('director_required');
    expect((await plane.command(operator, valid('PANIC'))).ok).toBe(true);
});

test('binds the Director lease to both operator and bridge', () => {
    expect(plane.claim({ id: 'azumag' }, 'mac-a').ok).toBe(true);
    expect(plane.heartbeat({ id: 'azumag' }, 'mac-b').ok).toBe(false);
});
```

- [ ] **Step 2: Implement ControlPlane and verify GREEN**

Authenticate first in HTTP middleware. Run `CommandLedger.accept()` before coordinator execution. `PANIC` bypasses only the Director check, never authentication or replay protection.

- [ ] **Step 3: Write failing route tests**

Use Supertest with a small Express app and the actual router. Cover 401 missing token, 409 busy Director, 200 claim/heartbeat/release, 403 normal command from non-Director, 200 PANIC from backup operator, 409 stale/duplicate command, and protected state GET.

- [ ] **Step 4: Implement routes and config**

Endpoints:

```text
POST /api/blmf/director/claim
POST /api/blmf/director/heartbeat
POST /api/blmf/director/release
POST /api/blmf/commands
GET  /api/blmf/state
```

`BLMF_OPERATORS_JSON` format:

```json
[{"id":"azumag","token":"long-random-secret","canPanic":true}]
```

- [ ] **Step 5: Mount BLMF router behind feature flag**

In `controller.js`, register a BLMF router delegate before the existing 404 handler, but initialize its runtime in `startServer()` only when `BLMF_ENABLED === 'true'`. Invalid auth/config prevents listen; OBS connection failures do not stop the server and instead leave readiness false/degraded. When false, do not require operator config and leave all 2025 endpoints behaviorally unchanged.

- [ ] **Step 6: Run controller regression tests and commit**

Run: `cd controller && npm run lint && npm test -- --runInBand`
Expected: all existing and BLMF tests PASS.

Commit: `feat: expose authenticated BLMF control API`.

---

### Task 4: Local VRChat OSC command decoder and StreamCaster client

**Files:**
- Create: `operator-bridge/package.json`
- Create: `operator-bridge/osc_command_decoder.js`
- Create: `operator-bridge/streamcaster_client.js`
- Test: `operator-bridge/__tests__/osc_command_decoder.test.js`
- Test: `operator-bridge/__tests__/streamcaster_client.test.js`
- Modify: root `package.json`
- Modify: root `package-lock.json`

**Interfaces:**
- `new OscCommandDecoder()`
- `decoder.accept(value)` -> command name or `null`
- `new StreamCasterClient({ baseUrl, token, bridgeId, sessionId, fetchImpl, now })`
- `client.claimDirector()` / `heartbeatDirector()` / `releaseDirector()`
- `client.sendCommand(command)`
- `client.getState()`

OSC command Int mapping:

```text
0   NONE / re-arm
1   NEXT
2   TAKE
3   VENUE
4   STANDBY
5   ENTRY
250 CLAIM_DIRECTOR
251 RELEASE_DIRECTOR
255 PANIC
```

- [ ] **Step 1: Write failing edge decoder tests**

```js
test('emits one command for a nonzero edge and waits for zero to re-arm', () => {
    const d = new OscCommandDecoder();
    expect(d.accept(2)).toBe('TAKE');
    expect(d.accept(2)).toBeNull();
    expect(d.accept(0)).toBeNull();
    expect(d.accept(2)).toBe('TAKE');
});
```

- [ ] **Step 2: Implement decoder and verify GREEN**

Unknown values return `null` and do not execute a command.

- [ ] **Step 3: Write failing HTTP client tests**

Verify Authorization header, monotonic sequence, random command IDs, stable startup `sessionId`, `sentAt`, and that non-2xx responses return structured failures rather than throwing away server reason text.

- [ ] **Step 4: Implement StreamCaster client and verify GREEN**

Use Node 18 global `fetch`; no extra HTTP dependency.

- [ ] **Step 5: Add workspace metadata and commit**

Root `workspaces` becomes `['controller', 'operator-bridge']`. Bridge uses Jest 29 and `osc@2.4.5` in the next task.

Commit: `feat: add remote operator command bridge core`.

---

### Task 5: OSC runtime, feedback, and Director heartbeat

**Files:**
- Create: `operator-bridge/bridge_service.js`
- Create: `operator-bridge/index.js`
- Create: `operator-bridge/__tests__/bridge_service.test.js`
- Modify: `operator-bridge/package.json`
- Modify: root `package-lock.json`

**Interfaces:**
- `new BridgeService({ oscPort, client, decoder, pollIntervalMs, heartbeatIntervalMs, logger })`
- `bridge.start()` / `bridge.stop()`
- Input address: `/avatar/parameters/BLMF_Command`
- Feedback addresses:
  - `/avatar/parameters/BLMF_Ready` Bool
  - `/avatar/parameters/BLMF_OnAir` Bool
  - `/avatar/parameters/BLMF_Error` Bool
  - `/avatar/parameters/BLMF_IsDirector` Bool
  - `/avatar/parameters/BLMF_CurrentEntryIndex` Int

- [ ] **Step 1: Write failing bridge service tests**

Use a fake OSC port and fake client. Verify TAKE edge -> exactly one command request, CLAIM/RELEASE map to Director endpoints, backup PANIC works without Director, state changes produce OSC feedback only when values change, and a failed poll/heartbeat logs an error but never synthesizes a production command.

- [ ] **Step 2: Install OSC dependency and implement service**

Run from repository root: `npm install --workspace operator-bridge --save-exact osc@2.4.5`

Default local ports:
- listen to VRChat output: `127.0.0.1:9001`
- send VRChat input feedback: `127.0.0.1:9000`

The runtime reads:

```text
STREAMCASTER_URL
BLMF_OPERATOR_TOKEN
BLMF_BRIDGE_ID
VRCHAT_OSC_IN_PORT=9001
VRCHAT_OSC_OUT_PORT=9000
```

- [ ] **Step 3: Add CLI startup fail-closed validation**

Missing `STREAMCASTER_URL`, `BLMF_OPERATOR_TOKEN`, or `BLMF_BRIDGE_ID` exits nonzero before opening OSC sockets. The token is never logged.

- [ ] **Step 4: Run bridge tests and commit**

Run: `cd operator-bridge && npm test -- --runInBand`
Expected: PASS.

Commit: `feat: bridge VRChat OSC over Tailscale control API`.

---

### Task 6: Production docs, CI, and end-to-end control-plane verification

**Files:**
- Create: `docs/blmf/operator-bridge.md`
- Create: `docs/blmf/tailscale-grants.example.hujson`
- Create: `.github/workflows/operator-bridge-ci.yml`
- Modify: `README.md`
- Test: `controller/__tests__/blmf/control_plane.integration.test.js`

**Interfaces:**
- Tailscale example allows operator users/devices to reach only the StreamCaster control host/port required for BLMF.
- Application bearer auth remains mandatory even inside the tailnet.

- [ ] **Step 1: Write failing end-to-end in-process test**

Build real `OperatorRegistry`, `DirectorLease`, `CommandLedger`, `ControlPlane`, router, and a coordinator with fake OBS adapters. Assert this sequence:

```text
operator A claim -> NEXT rejected as preparer_unavailable
operator A TAKE rejected as not_ready
operator A VENUE accepted (Main only)
operator B TAKE rejected as director_required
operator B PANIC accepted (Main venue + Sub standby attempted)
operator A release -> operator B claim accepted
replayed command ID -> rejected
```

- [ ] **Step 2: Run integration test and verify RED/GREEN**

Run: `cd controller && npx jest __tests__/blmf/control_plane.integration.test.js --runInBand`
Expected after implementation: PASS.

- [ ] **Step 3: Add CI for operator bridge**

Matrix Node 18.x, 20.x, 22.x. Run root `npm ci`, then `npm test --workspace operator-bridge -- --runInBand`. Trigger on `operator-bridge/**`, root lock/workspace files, and its workflow file.

- [ ] **Step 4: Document Tailscale and rehearsal setup**

Document that Tailscale encrypts/authorizes network reachability but does not replace `BLMF_OPERATOR_TOKEN`. Include operator onboarding, claim/release, backup PANIC, lease expiry behavior, OSC enablement, local ports, and a two-location rehearsal checklist.

- [ ] **Step 5: Run full verification**

Run:

```bash
cd controller && npm run lint && npm test -- --runInBand
cd ../operator-bridge && npm test -- --runInBand
cd .. && git diff --check
```

Expected: all tests PASS, lint PASS, no whitespace errors.

- [ ] **Step 6: Commit final docs/CI**

Commit: `docs: add BLMF remote operator runbook`.

