# Windows 2 OBS / BLMF PoC

This package reproduces the Windows-local PoC configuration and Web/OSC controller.
It is separate from the original Mac Sub / Windows Main architecture and from the
production controller's readiness-gated TAKE. Related: [Issue #47](https://github.com/azumag/streamcaster/issues/47).

## Topology and scope

```text
VRChat --Spout2--> Main OBS --program output--> Twitch / YouTube (operator setup)
                     ^
Windows Sub OBS --Full NDI Program--+
       +--RTMP ~2000kbps--> VRCDN (operator setup)

Browser / VRChat OSC --> local Web/OSC controller
                         | Main: authenticated OBS WebSocket, localhost:4456
                         | Sub: session-checked local command/observation files + Lua
```

Both OBS instances are dedicated portable installations. No normal OBS profile,
registry setting, firewall rule or active process is changed by setup.
NDI sends the **whole Sub Program**, including scene switches and overlays. Spout2
is used for **VRChat capture**, not as the Sub transport. NDI must not be routed
over Tailscale. This package does not enable Tailscale Serve or SSH.

Included: dynamic ENTRY scene catalog, selection/execution, shared Director lease,
OSC rearm, Main-only cuts, STANDBY, media progress, reconnect, observer, launchers,
configuration generator, tests and distribution fingerprint. Not included: OBS or
plugin binaries, footage, avatar/world assets, credentials, account settings or logs.

## Prerequisites and pinned distribution

Use Windows x64, Node.js 20+, Python 3.10+ x64 and an RTX/NVENC-compatible driver.
The verified hardware was Windows 10 / i5-10400F / RTX 3060. Hardware performance
is not guaranteed by configuration reproduction.

Prepare a **clean distribution folder**, e.g. `C:\BLMF-dist`, from official packages:

| Component | Validated version | Official source |
|---|---|---|
| OBS Studio, Windows x64 ZIP | 32.2.2 | [release](https://github.com/obsproject/obs-studio/releases/tag/32.2.2) |
| DistroAV | 6.2.1 | [release](https://github.com/DistroAV/DistroAV/releases/tag/6.2.1) |
| NDI Runtime | 6.3.2.0 | [official installation guide](https://docs.ndi.video/all/using-ndi/using-ndi-with-software/getting-started-with-ndi-in-obs-for-windows-or-mac) |
| Spout2 OBS plugin | 1.12.0 | [releases](https://github.com/Off-World-Live/obs-spout2-plugin/releases) |
| Multiple RTMP outputs (optional) | observed artifact 0.7.4.0 | [releases](https://github.com/sorayuki/obs-multi-rtmp/releases) |

OBS 32.2.2 requires NVIDIA driver 570 or newer for NVENC, per its release notes.
Use portable plugin packages; a system-wide installer can affect other OBS installs.
Expand OBS and plugins so their `bin`, `data`, `obs-plugins` directories are merged
under the clean folder. Put the officially acquired NDI runtime DLL and its supplied
dependencies under `ndi-runtime`. Do not copy an OBS `config` directory into this folder.
NDI download availability/licensing is controlled by its vendor; no runtime is redistributed here.

Required layout:

```text
C:\BLMF-dist\
  bin\64bit\obs64.exe
  data\obs-plugins\...             (plugin data as supplied)
  obs-plugins\64bit\distroav.dll
  obs-plugins\64bit\win-spout.dll  (with its Spout dependencies)
  ndi-runtime\Processing.NDI.Lib.x64.dll
```

`distribution-manifest.json` records hashes of the four validated components.
`Setup.ps1` checks them before copying. Preserve the corresponding official archives
locally if exact vendor versions disappear. Do not silently substitute latest versions:
revalidate and update the manifest as a reviewed change. Optional multi-RTMP is not
needed for the controller/NDI tests and its account configuration is always manual.

## New installation

From the repository root (ordinary PowerShell, OBS may remain running elsewhere):

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run blmf:windows:test
python tools/blmf-windows-poc/setup_test.py
& tools/blmf-windows-poc/Setup.ps1 -Distribution C:\BLMF-dist
```

Default destination: `tools/blmf-windows-poc/.runtime` (ignored by Git).
For another **new** directory use `-HomePath C:\BLMF-local`; pass that same path to
all launchers and media scripts. Setup refuses existing directories, protects its
ACL for the current user/SYSTEM/Administrators, copies only distribution folders,
and generates fresh OBS settings. Never use this command to update a live installation.

Generate disposable test footage using an installed FFmpeg with libx264 and lavfi:

```powershell
python tools/blmf-windows-poc/generate-test-media.py --home tools/blmf-windows-poc/.runtime
```

Use `--ffmpeg C:\path\ffmpeg.exe` if not in PATH. It creates a 30-second 1080p60
test pattern with left 440Hz/right 880Hz tones, without overwriting existing media.
This clip does not have synchronized E2E measurement timecode.

## OBS setup and first connection

1. Start the dedicated Sub:
   `& tools/blmf-windows-poc/Start-OBS.ps1 -Role sub`
   Profile/collection: `BLMF Windows Sub PoC`. Initial scene: STANDBY.
   DistroAV Main/Program output name: `BLMF_WINDOWS_SUB_POC`; Preview output disabled.
   Check Tools → Scripts contains `.runtime/control/local-sub-observer.lua`.
2. Start the dedicated Main:
   `& tools/blmf-windows-poc/Start-OBS.ps1 -Role main`
   Profile/collection: `BLMF_WINDOWS_LOCAL_TEST`. Initial scene: VRC_VENUE.
3. In Main ENTRY_FULLSCREEN → WINDOWS_SUB_FULL_NDI properties, select the **actual
   discovered full source name** `HOSTNAME (BLMF_WINDOWS_SUB_POC)`, Highest bandwidth.
   Do not type only `BLMF_WINDOWS_SUB_POC`, and do not reuse another machine's hostname.
   Optional read-only discovery: `python tools/blmf-windows-poc/discover-ndi.py --home tools/blmf-windows-poc/.runtime`.
   Discovery alone does not prove picture/audio reception.
4. Run VRChat and select its actual Spout sender in Main VRC_VENUE → VRCHAT_SPOUT.
   Global Desktop Audio/Mic captures are absent. If venue audio is needed, add an
   application audio capture **only inside VRC_VENUE**. ENTRY_FULLSCREEN uses NDI
   audio exclusively; do not add VRChat audio there. Verify the actual output mix.
5. Both WebSockets start **disabled with authentication required**. Before enabling
   Main 4456, verify firewall policy restricts that dedicated OBS executable/port to
   local access; OBS WebSocket may listen on all interfaces. No WAN forwarding or
   broad allow rule. Enable Main under Tools → WebSocket Server Settings, retaining
   authentication and its generated password. The controller reads this local file;
   do not paste its password into a terminal, chat or Git. Sub WebSocket stays disabled.
6. Start the controller: `& tools/blmf-windows-poc/Start-Controller.ps1`.
   Open <http://127.0.0.1:18765/>. Click **OBSに再接続**, then **操作を開始**.
   The UI remains available when either OBS is offline; restart that dedicated OBS
   and reconnect. Reconnect does not change scenes, restart media or start outputs.

All profiles use 1920×1080 / 60fps / 48kHz stereo. Test ENTRY_001 contains a looping
Media Source; ENTRY_002 is blue. Add production `ENTRY_*` scenes in Sub and refresh
the controller's list. Each scene owns its media/overlays; choose restart/loop behavior
in OBS as appropriate for the show. The controller only switches scenes.

VRCDN server is prefilled with `rtmp://ingest.vrcdn.live/live`, but the key is empty.
Enter it privately in **Sub OBS**. Sub output is NVENC H.264 2000kbps / AAC160kbps.
Main Twitch/YouTube destinations are not imported or configured. Configure them in
Main OBS or its multi-RTMP plugin privately. Neither launcher nor controller starts
or stops streams/recordings. Stop the other sender before using the same VRCDN key.

## Controller operation and lifecycle

The UI reads Sub `ENTRY_*` scenes in OBS frontend order. Previous/Next only selects.
Execute switches Sub to the selected scene and Main to ENTRY_FULLSCREEN. Main venue
or NDI buttons never touch Sub playback. STANDBY switches Sub but preserves outputs.
Media progress is local OBS observation, not proof that delayed venue playback ended.

VRChat sends `/avatar/parameters/BLMF_Command` to `127.0.0.1:9001`:

| Value | Action |
|---|---|
| 0 | Rearm; send between presses |
| 250 / 251 | Claim / release shared Director |
| 3 / 5 | Main VRC_VENUE / ENTRY_FULLSCREEN |
| 4 | Sub STANDBY |
| 6 / 7 / 8 | Select previous / next / execute selected |

Only one local controller should own UDP9001/HTTP18765. The original production
operator-bridge uses the same default UDP port; do not start both. All UI clients
share one operator authority. There is no independent per-person role/login here.

`Stop-Controller.ps1` closes only the controller. Stop OBS separately when desired.
Restarting the controller releases the lease and selection: claim/select again;
it never replays the last scene command. `npm run blmf:windows:start` is the foreground
alternative. Set `BLMF_POC_HOME` for a nondefault installation.

Optional `.runtime/control/ui.local.json`: `{"httpPort":18765,"udpPort":9001}`.
For Tailscale Serve, also set `publicOrigin` to your actual HTTPS `*.ts.net` origin.
The app remains loopback-only. Tailscale grants must authorize the intended shared
operators; enabling Serve is a separate network configuration step. Never use Funnel.
NDI and OBS WebSocket are not published by this option.

## Starting the whole rig at once

`Start-BLMF-Local.ps1` starts both portable OBS instances, the camera control and
the controller, waits for each to report ready, and stops them again with `-Stop`
(add `-StopObs` to close OBS too, which is how OBS keeps its configuration: it
writes on exit, so killing it loses the session's changes). `-NoObs`, `-NoCamera`
and `-NoBrowser` skip parts; `-Force` stops a camera server left from an earlier
run. `Start-BLMF-Local.cmd` is the double-clickable wrapper.

Running it again is how anything that was closed is brought back. If the
controller is already up, the launcher leaves it alone, starts the camera control
if it has stopped and only the OBS instances that are not running, waits for both
OBS to be ready and asks the controller to reconnect.
Everything already running is left as it is, so pressing the shortcut twice
starts nothing twice.

It holds no machine paths. Copy `blmf-launcher.example.json` to
`blmf-launcher.local.json` beside the script and edit it; `-ConfigPath` or
`BLMF_LAUNCHER_CONFIG` override the location. Only `runtime.root` is required and
the rest default to the names `Setup.ps1` creates under it. Missing configuration
stops the launcher rather than guessing a path that exists on one machine. The
file stays out of git (`*.local.json`), and holds no secrets.

`cameraControl.photoDir` is passed on as `--photo-dir`, the folder VRChat writes
photos to (usually `%USERPROFILE%\Pictures\VRChat`). The camera UI shows the
newest image in it after a capture. Leave the key out and the preview is off.

`cameraControl.publicOrigin` and `remotePort` turn on remote access, and must be
set together: they become `--public-origin` and `--remote-port`, the separate
loopback port Tailscale Serve forwards to. The camera server decides who may
operate by which listening port a connection arrived on, so the Serve target has
to be a different port from the local UI. The Serve configuration itself is
Tailscale's and persists on its own; the launcher does not create or change it.

Stopping kills the camera process tree, not just the recorded PID: on Windows the
venv `python.exe` is a shim that launches the real interpreter as a child, and
stopping only the shim leaves the ports held and the next start failing.

The launcher reports VRChat's OSC route from what actually arrives, via
`camera-control/state_probe.py`. VRChat runs under Easy Anti-Cheat so its command
line cannot be read, and Steam keeps launch options in memory while running, so
both of the obvious checks can call a correctly configured rig unset. With the
camera server stopped, `camera-control/osc_probe.py` answers the same question by
listening on the candidate ports directly.

## Moving an installation

OBS stores media, script and recording locations as absolute paths, so a moved or
copied runtime home loads no observer script and records to a path that is gone.
`python relocate.py --home <runtime home>` repairs those, with OBS closed.

It only rewrites values that are actually broken, and only when the replacement is
unambiguous: a working path is never "corrected", because an operator may have
pointed it somewhere deliberately. Ambiguous or missing targets are reported for a
human instead of guessed.

## Reproduction and upgrade boundary

`npm run blmf:windows:test` includes a fresh temporary installation and actual HTTP
startup/shutdown without OBS. `setup_test.py` verifies no overwrite, isolated
paths, empty stream keys and disabled/authenticated WebSockets. For the actual Lua
collector test, set `BLMF_OBS_BIN` to an acquired OBS `bin/64bit` directory and run
`python tools/blmf-windows-poc/local-sub-observer.test.py` (Windows only).

To upgrade an existing PoC, first validate a newly generated installation. Schedule
any live cutover separately, stop its controller before replacing code, and reload
the copied Lua script in Sub during an agreed maintenance window. This repository
commit does not replace an already-running outputs-based controller or OBS instance.

Acceptance on each machine: moving NDI video and stereo audio; three Main cutaway
cycles while Sub media advances; VRChat concurrent load/skipped frames; no duplicate
venue audio in ENTRY_FULLSCREEN; one/both OBS restarts and reconnect; VRCDN venue
playback; actual Twitch/YouTube rehearsal. E2E latency requires simultaneous source/
receiver observation. Unit tests and config generation do not prove those media paths.

Do not commit `.runtime`, OBS account settings, `service.json`, local state/command
files, logs, recordings, keys, or passwords. Back up private settings separately with
appropriate access controls. Public templates are generated from explicit fields,
not redacted exports of live OBS settings.
