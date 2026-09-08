# BLMF 2026 StreamCaster Architecture Design

## Purpose

StreamCaster 2026 is the BLMF event playout/control system. It does not relay the primary video itself. Its job is to keep two OBS instances and the operator controls in sync while the video planes remain independent and continuously connected.

## Confirmed event topology

- Main PC runs VRChat and Main OBS.
- Main OBS streams the event program to Twitch and YouTube.
- Sub PC plays entry videos in Sub OBS.
- Sub OBS sends a ~2000 kbps H.264 rendition directly to VRCDN for projection inside the VRChat venue.
- The same Sub OBS playback clock is sent to Main OBS as a high-quality Full NDI feed.
- Main OBS switches between the VRChat venue view and the high-quality entry-video fullscreen view.
- The operator can trigger the primary playout actions from VRChat without stopping any streaming session.

## Design principles

1. One playback clock: an entry video is played only on Sub OBS. Main never starts a second copy of the entry video.
2. Persistent outputs: VRCDN, NDI, Twitch, and YouTube outputs stay alive during normal scene changes.
3. Control-plane separation: StreamCaster controls OBS; it is not in the media path.
4. Fail visually safe: failures return the public program to the VRChat venue and the venue screen to standby without ending external streams.
5. Readiness before TAKE: TAKE is rejected unless the required asset and control paths are ready.

## Media plane

```text
                                    +--> RTMP H.264 ~2000 kbps --> VRCDN --> VRChat venue screen
Entry file --> Sub OBS entry_player -+
                                    +--> Full NDI ----------------> Main OBS ENTRY_FULLSCREEN

VRChat client -----------------------------------------------------> Main OBS VRC_VENUE

Main OBS program --------------------------------------------------> Twitch
                                                               +---> YouTube
```

### Why Full NDI for Sub -> Main

The PCs are expected to be on the same event LAN. Full NDI avoids another H.264 encode/decode generation before the final Twitch/YouTube encode and gives low-latency, high-quality LAN transport. Main and Sub must be connected by wired Gigabit Ethernet; Wi-Fi is not a supported production topology.

### VRCDN output

Sub OBS sends VRCDN directly. Main PC is not part of this path. The target profile starts at H.264 ~2000 kbps, AAC 48 kHz, with final GOP/audio values locked after rehearsal against the actual VRCDN ingest requirements.

## Main OBS

Required program scenes:

- `VRC_VENUE`: VRChat event view and normal venue audio.
- `ENTRY_FULLSCREEN`: Full NDI video/audio from Sub PC, filling the canvas.
- `TECHNICAL_DIFFICULTIES`: optional emergency slate.

When `ENTRY_FULLSCREEN` is on-air, the same entry audio coming back from the VRChat venue must not also reach the Twitch/YouTube mix. The NDI audio is authoritative for the entry. This prevents doubling, echo, and phase artifacts.

Main OBS keeps Twitch/YouTube streaming active independently of StreamCaster. If StreamCaster dies, OBS continues its current program/output.

## Sub OBS

Required scenes/sources:

- `STANDBY`: BLMF standby video/graphic, looped.
- `ENTRY`: contains Media Source `entry_player`.

Sub outputs:

- VRCDN stream: persistent H.264 output at the rehearsed 2000 kbps profile.
- Full NDI output: persistent high-quality program/dedicated output to Main.

Entry files are local before show time. TAKE never waits for a Google Drive download.

## StreamCaster Coordinator

The coordinator is the single source of truth for operator intent and orchestration state. It connects to:

- Main OBS websocket on localhost.
- Sub OBS websocket on the wired LAN.
- Local VRChat OSC output/input.

It does not own the lifetime of the OBS streaming outputs. It owns scene/media orchestration only.

## State machine

```text
BOOTING -> IDLE -> PREPARING -> READY -> TAKING -> ON_AIR -> RETURNING -> IDLE
                  |            |         |          |
                  +----------> DEGRADED / ERROR <---+
                                   |
                                 PANIC
                                   |
                                  IDLE
```

### IDLE

- Main program: `VRC_VENUE`.
- Sub program: `STANDBY`.
- VRCDN output remains connected.
- NDI output remains available.

### PREPARING

- Resolve NEXT entry from the run queue.
- Verify local asset and readiness metadata.
- Set Sub `entry_player` to the target file.
- Seek/restart to position zero without putting it on-air.
- Confirm Main/Sub websocket connections.

### READY

Required readiness gates:

- Main OBS websocket connected.
- Sub OBS websocket connected.
- Asset marked ready.
- Sub VRCDN output active.
- NDI path considered healthy.

TAKE from any other state is rejected unless an explicit manual override is used from the engineering UI.

### TAKING

Order:

1. Put Sub on `ENTRY`.
2. Restart/play `entry_player`.
3. Confirm media state becomes playing.
4. Wait configurable `main_take_delay_ms` if rehearsal shows it is needed.
5. Put Main on `ENTRY_FULLSCREEN`.
6. Enter `ON_AIR`.

### ON_AIR

- Track media position and duration.
- Surface remaining time.
- Observe end/error events.
- Allow operator `VENUE` at any time.

Automatic return on media end is configurable; default behavior for the first rehearsal is enabled but must be validated before show day.

### RETURNING

1. Main -> `VRC_VENUE`.
2. Sub -> `STANDBY`.
3. Mark current queue item done.
4. Advance NEXT.
5. Return to `IDLE` or immediately `PREPARING` if auto-prepare is enabled.

`VENUE` during `ON_AIR` is only a Main OBS camera cut: it switches Main to `VRC_VENUE` while Sub keeps playing the entry for VRCDN and NDI. `ENTRY` switches Main back to `ENTRY_FULLSCREEN` without restarting Sub playback. `STANDBY` is a separate Sub-side action used between entries.

## PANIC

PANIC means "safe visual fallback", not "stop streaming".

It performs best-effort, independently:

1. Main -> `VRC_VENUE`.
2. Sub -> `STANDBY`.
3. Keep Twitch/YouTube active.
4. Keep VRCDN active.
5. Keep NDI active.
6. Record the fault and leave dangerous controls blocked until state is reconciled.

A failure in one PANIC action must not prevent the other action from being attempted.

## VRChat operator control

Primary production path: each authorized PCVR operator runs a local OSC Bridge. VRChat talks only to `127.0.0.1`; the bridge forwards normalized authenticated commands to the central StreamCaster control service over Tailscale. Remote VRChat clients never connect directly to either OBS websocket endpoint.

Commands:

- `NEXT`: prepare the next queue item.
- `TAKE`: take the ready entry on-air.
- `ENTRY`: switch Main to the still-running NDI entry feed.
- `VENUE`: switch Main to the VRChat venue while Sub playback continues.
- `STANDBY`: return Sub to its standby scene between entries.
- `PANIC`: immediate safe fallback of Main to venue and Sub to standby.

`STOP_STREAM`, OBS restart, and output stop are deliberately not exposed through VRChat controls. Commands are edge-triggered and debounced/idempotent so a held parameter cannot repeatedly TAKE.

Multiple operators may be online concurrently. Exactly one active Director lease may issue `NEXT`, `TAKE`, `ENTRY`, `VENUE`, or `STANDBY`; any authorized operator may issue `PANIC`. A lost operator connection never changes the current program. After the Director lease expires, another operator may claim it.

Tailscale restricts which users/devices can reach the control service. StreamCaster additionally authenticates each operator bridge with an operator-specific secret, logs operator and bridge identity, rejects stale/duplicate/out-of-order commands, and never trusts a caller-supplied operator name as authentication.

State feedback flows in the reverse direction: StreamCaster -> operator bridge over Tailscale -> local VRChat OSC. Feedback includes Ready, OnAir, Error, Director identity/state, and CurrentEntryIndex.

A later world-specific Udon control path may be added only after its external-communication and authentication constraints are proven in rehearsal; it is not required for v1 production readiness.

## Asset pipeline

Assets are synchronized before the event to Sub local storage.

For each file:

- stable entry ID and display title
- local path
- SHA-256 or equivalent integrity hash
- duration
- width/height
- frame rate and VFR indication
- video codec/pixel format
- audio codec/sample rate/channel count
- validation timestamp and READY/INVALID state

Use ffprobe for validation. Normalize/transcode only assets that need it; avoid unnecessary master-file generation loss.

## Health model

Expose independent health signals rather than one misleading green status:

- Main OBS websocket connected
- Main current program scene
- Main external stream output active
- Sub OBS websocket connected
- Sub media state
- Sub VRCDN output active
- NDI path ready
- Current asset ready
- OSC recent/healthy

The UI may derive an overall status, but individual evidence remains visible.

## Failure policy

### NDI unavailable

- Block TAKE into `ENTRY_FULLSCREEN`.
- Keep Main on `VRC_VENUE`.
- Do not stop VRCDN.

### VRCDN unavailable

- Mark DEGRADED and alert operator.
- Keep Main Twitch/YouTube program running.
- Let OBS output auto-reconnect; do not kill/recreate the event playout session as the first recovery step.

### Sub OBS websocket unavailable

- Main remains/returns to `VRC_VENUE`.
- TAKE blocked.

### Main OBS websocket unavailable

- Main OBS output continues independently.
- StreamCaster reports degraded control.
- Manual OBS scene switching is the fallback.

### StreamCaster crash/restart

- OBS outputs continue.
- On startup, query both OBS instances and rebuild state from observed scene/media/output facts instead of assuming IDLE.

## Production UI

Primary operator surface:

- health strip: Main OBS / Sub OBS / VRCDN / NDI / OSC
- CURRENT entry
- NEXT entry
- READY state
- elapsed/remaining time
- PREPARE NEXT
- TAKE
- RETURN TO VENUE
- PANIC

Engineering/dangerous actions are on a separate screen with explicit confirmation:

- stop VRCDN
- stop Twitch/YouTube
- restart OBS
- force state reconciliation/override

## Security and network boundaries

- Main/Sub OBS websocket authentication required.
- Sub websocket port is allowed only from Main/event LAN; never WAN-exposed.
- No stream key is exposed in the browser or VRChat parameter layer.
- StreamCaster's operator API is authenticated and event-LAN/local only for production.
- The 2025 default of globally exposing the control UI is not acceptable for the 2026 production profile.

## Reuse from StreamCaster 2025

Reuse candidates:

- Google Drive code as an offline/pre-event asset sync source.
- Existing REST/UI/test scaffolding where it reduces work.
- Existing fixture/standby assets and operational knowledge.

Replace/remove from the production path:

- UDP sender/receiver video switching.
- FFmpeg spawn/kill per entry.
- nginx-rtmp as the switching mechanism.
- mandatory relay FFmpeg stage.
- download-on-TAKE behavior.
- browser-local switching flags as the authoritative state machine.

## Implementation slices

1. Dual OBS control core: websocket clients, scene/media primitives, state reconciliation, PANIC.
2. Sub/Main media PoC: persistent VRCDN output + Full NDI + Main fullscreen switching.
3. Queue and asset readiness: manifest, ffprobe validation, PREPARE/READY/CURRENT/NEXT.
4. VRChat OSC controls and state feedback.
5. Production UI and health model.
6. Rehearsal/failure injection and runbook.

## Production acceptance criteria

- A single Sub playback produces both the VRCDN venue rendition and Main NDI rendition.
- Main can switch `VRC_VENUE` <-> `ENTRY_FULLSCREEN` without restarting Twitch/YouTube.
- Sub can change entry/standby without restarting the VRCDN session under normal operation.
- Entry fullscreen uses authoritative NDI audio with no doubled venue copy.
- PANIC restores safe scenes within a few seconds while external outputs continue.
- StreamCaster restart does not stop OBS outputs and reconciles observed state.
- Primary actions are operable from VRChat via OSC.
- Every entry is prevalidated/READY before show time.
- A 60+ minute rehearsal and the documented failure-injection matrix pass before production.
