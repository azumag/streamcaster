# BLMF 2026 Remote Operator Bridge

## Purpose

The operator bridge lets authorized PCVR staff control the BLMF StreamCaster control plane from a VRChat avatar, including from different physical locations.

The bridge is deliberately not part of the media path. Losing an operator PC, Tailscale, OSC, or StreamCaster control connection must not stop Twitch, YouTube, VRCDN, NDI, or an already-running entry video.

```text
VRChat avatar
  -> OSC 127.0.0.1:9001
  -> operator-bridge
  -> authenticated HTTP over Tailscale
  -> StreamCaster on Main/control PC
  -> obs-websocket
     -> Main OBS (local)
     -> Sub OBS (event LAN or Tailscale control connection)
```

Full NDI stays on the wired event LAN. Do not route Full NDI through Tailscale for normal production use.

## Safety model

- Exactly one active Director lease may issue normal production commands.
- Every authenticated operator with `canPanic` may issue `PANIC`, even while another operator is Director.
- `PANIC` changes Main to `VRC_VENUE` and Sub to `STANDBY`; it does not stop any stream output.
- `VENUE` changes Main only. Sub continues the current entry, allowing `VENUE` -> `ENTRY` cutaways.
- `ENTRY` changes Main only and never restarts Sub playback.
- `STANDBY` changes Sub only.

## VRChat avatar command parameter

Create an Int avatar parameter named `BLMF_Command` and use Button controls that return to zero after the edge.

| Value | Command | Director required |
| ---: | --- | --- |
| 0 | Re-arm / no command | No |
| 1 | NEXT | Yes |
| 2 | TAKE | Yes |
| 3 | VENUE | Yes |
| 4 | STANDBY | Yes |
| 5 | ENTRY | Yes |
| 250 | CLAIM_DIRECTOR | No |
| 251 | RELEASE_DIRECTOR | Current Director |
| 255 | PANIC | No; authenticated `canPanic` operator only |

A held non-zero value is executed once. Another command cannot execute until `BLMF_Command` returns to zero. Unknown non-zero values are ignored and also require zero to re-arm.

## VRChat feedback parameters

The bridge writes these values back to the same local VRChat client on UDP port 9000:

- `BLMF_Ready` (Bool)
- `BLMF_OnAir` (Bool)
- `BLMF_Error` (Bool)
- `BLMF_IsDirector` (Bool)
- `BLMF_CurrentEntryIndex` (Int)

Feedback is sent only when a value changes to avoid unnecessary OSC traffic.

## Operator PC configuration

Requirements:

- PC/PCVR VRChat client with OSC enabled.
- Tailscale connected to the BLMF tailnet.
- Node.js 18 or newer.
- A unique `BLMF_BRIDGE_ID` for this machine.
- A per-operator bearer token issued in the central `BLMF_OPERATORS_JSON` configuration.

```bash
export STREAMCASTER_URL=http://<controller-tailscale-ip>:8080
export BLMF_OPERATOR_TOKEN=<operator-specific-secret>
export BLMF_BRIDGE_ID=<unique-machine-id>
npm start --workspace operator-bridge
```

Optional settings:

```bash
VRCHAT_OSC_IN_PORT=9001
VRCHAT_OSC_OUT_PORT=9000
BLMF_STATE_POLL_INTERVAL_MS=1000
BLMF_DIRECTOR_HEARTBEAT_INTERVAL_MS=5000
```

VRChat talks only to `127.0.0.1`. The operator bridge is the only component that talks to StreamCaster over Tailscale. Never put an OBS websocket password or StreamCaster operator bearer token into an avatar or world asset.

The bridge fails before opening OSC sockets if the controller URL, operator token, or bridge ID is missing. Tokens are not written to normal logs.

## Director lease behavior

1. An operator presses `CLAIM_DIRECTOR`.
2. StreamCaster binds the lease to the authenticated operator and that bridge ID.
3. The bridge renews the lease while StreamCaster reports that bridge as Director.
4. Another operator may stay connected and receive state, but normal commands are rejected.
5. Any authorized backup operator can still issue `PANIC`.
6. If the Director PC disappears, the current video/scenes stay unchanged. The lease expires independently, after which another operator can claim it.

Normal commands carry a session ID, unique command ID, monotonic sequence, and timestamp. StreamCaster rejects stale, duplicated, and out-of-order envelopes before executing an OBS action.

## Tailscale policy

Use the narrow policy in `docs/blmf/tailscale-grants.example.hujson` as a starting point. It grants only:

- operator machines -> StreamCaster control HTTP port;
- StreamCaster/Main control machine -> Sub OBS websocket port.

Application bearer authentication remains mandatory even if Tailscale already authorizes the network connection. Tailscale is the reachability/security boundary, not the application identity mechanism.

Current Tailscale documentation recommends Grants for new policies. See:

- https://tailscale.com/docs/reference/syntax/grants
- https://tailscale.com/docs/reference/examples/grants

Do not add a broad `* -> *` BLMF rule just to make rehearsal easier.

## Two-location rehearsal checklist

Before production, rehearse with at least two operators on different internet connections.

1. Verify Main and Sub OBS are already streaming/outputting before StreamCaster control starts.
2. Verify Full NDI travels over the wired event LAN, not the remote operator tunnel.
3. Start StreamCaster with `BLMF_ENABLED=true` and confirm `/api/blmf/state` requires authentication.
4. Start operator A bridge, enable VRChat OSC, and verify all feedback parameters update.
5. A claims Director and exercises `VENUE`, `ENTRY`, and `STANDBY` with test scenes.
6. Start operator B from a different location. Confirm B cannot `TAKE` or change scenes while A is Director.
7. Confirm B can `PANIC` and both safe scene changes are attempted.
8. Disconnect A's network without releasing Director. Confirm current OBS scenes and outputs do not change.
9. After lease expiry, confirm B can claim Director.
10. Replay/duplicate an already-used command envelope and confirm StreamCaster rejects it.
11. Kill one OBS websocket connection and confirm the other safe PANIC action is still attempted.
12. Restore control connectivity and confirm no output process had to be restarted.

## Current implementation boundary

Scene-based entries can be configured with `BLMF_ENTRIES_JSON`:

```json
[
  {"id":"ENTRY_001","sceneName":"ENTRY_001","mediaInput":"ENTRY_001_MEDIA"},
  {"id":"ENTRY_002","sceneName":"ENTRY_002","mediaInput":"ENTRY_002_MEDIA"}
]
```

Each ID, scene and media input must be unique. These are existing, independent Sub OBS Media Sources. Sub uses `STANDBY` between entries and DistroAV Main Output for the whole Program; VRCDN uses the same Program. Configure these outputs in OBS beforehand. The coordinator does not provision NDI, resolve its sender name, change stream settings, or start/stop outputs.

`NEXT` selects the first entry, then the entry after the most recently started entry. It only reads readiness; it does not change Sub's scene, file or playback. Repeated NEXT retries the same selected entry instead of skipping it. A successful TAKE consumes that selection. The list does not wrap; exhausted queues require a future queue-management interface. Failed TAKE after Sub activation keeps the selection for a retry after STANDBY and NEXT. PANIC discards the pending selection.

`TAKE` requires READY and rechecks readiness before activating Sub and again before switching Main. It merges OBS default input settings with explicit source settings to obtain the effective `restart_on_activate` value: activation owns the restart when true; otherwise TAKE issues one explicit restart. An unknown setting fails closed. A source already active in Program, or a selected scene already on Program, is rejected; use STANDBY first. Media must report PLAYING within ten polls spaced 100 ms apart (plus request time). Sub Program is checked after activation; both Sub Program and PLAYING are checked again immediately before Main changes. Main Program is queried after its change before reporting ON_AIR. These queries assume the PoC's cut transitions and exclusive control; they are not proof of actual received video/audio. Failures before Main's scene command leave Main unchanged; a failed post-change confirmation reports DEGRADED and requires operator reconciliation. Sources must be enabled direct children of their configured scenes, local Media Sources with `close_when_inactive=true`; groups/nested media require future support.

The authenticated state/command responses include `selectedEntry`, `currentEntry`, and one-based `currentEntryIndex` (zero before any entry starts). Current means the most recently started entry; it remains identified during VENUE, STANDBY and PANIC, with `subView` distinguishing standby. Readiness is an as-of observation with `entryId`, `checkedAt` and `stale`, not continuous monitoring. Expired observations suppress READY feedback. `BLMF_HEALTH_MAX_AGE_MS` defaults to 5000 ms.

The runtime accepts two internal, read-only evidence adapters:

- `assetReadinessProvider(entry)` returns `{entryId, ready, observedAt}`. It must attest to validated local media actually assigned to that exact scene/input, including file identity/integrity. A configured path or source name alone is not validation.
- `ndiHealthProvider()` returns `{healthy, observedAt}`, based on recent actual receiver media evidence. Discovery, source existence or dimensions alone are insufficient.

`observedAt` is coordinator-clock epoch milliseconds. Missing, failed, future, stale or wrong-entry evidence fails closed. The runtime also checks OBS connections, enabled scene/input configuration and Sub output active without reconnecting. Output active is not proof of VRCDN venue playback. Neither adapter is wired to a production observation service in this slice: the default application remains fail-closed for NEXT/TAKE until that integration is supplied. Never substitute constant true values for real validation.

Normal commands execute serially and recheck Director ownership and command age when leaving the queue. PANIC invalidates previous queued/in-progress commands and bypasses TAKE's readiness/settling waits. Each OBS safe-scene write follows any already-issued mutation on that same connection; a failed Main action does not prevent the Sub attempt. A hung in-flight OBS request can delay that same OBS's fallback, so manual OBS control remains necessary for connection failures. No stale TAKE may issue a new fullscreen change after PANIC.

This slice does not add startup reconciliation, automatic media-end return, live media-position polling, file validation tooling or NDI monitoring. Use controlled scene rehearsal until those integrations and the real two-PC acceptance tests are complete.

## Network exposure requirement

For BLMF production, run the enabled control plane on the Main/control PC inside the event network/tailnet. Do **not** enable the BLMF control plane on the old public Lightsail deployment while port 8080 is reachable from the public internet.

Tailscale Grants govern traffic that traverses the tailnet; they do not firewall a separate public-IP path to the same Express listener. Use the host firewall/router so the production controller is reachable only from localhost, the event LAN where explicitly required, and Tailscale. The bearer token remains mandatory as defense in depth.
