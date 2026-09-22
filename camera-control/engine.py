"""Camera-only command validation and deterministic motion/lease state machine."""
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

# Values come from VRChat 2025.3.3 camera endpoint documentation.
SETTINGS = {
    'Mode': ('i', 0, 6),
    'Zoom': ('f', 20, 150),
    'SmoothMovement': ('b', None, None),
    'SmoothingStrength': ('f', 0.1, 10),
    'Streaming': ('b', None, None),
    'Lock': ('b', None, None),
    'LookAtMe': ('b', None, None),
}
# Ownership ends when the socket closes, when the operator releases it, or
# after this long with no word at all. It is generous on purpose: the operator
# is watching VRChat, not this page, and browsers throttle a hidden tab's
# timers to about one tick a minute. A camera must not change hands, or grey
# out its own controls, because its operator alt-tabbed into the game.
# Runaway motion is not what this guards; INPUT_SECONDS is.
LEASE_SECONDS = 60.0
INPUT_SECONDS = 0.4
POSE_SECONDS = 5.0
CAPTURE_SECONDS = 1.0
# Wait for the camera to be properly at rest before the confirmation shot, so
# the picture shows where it stopped rather than where it was still going.
SETTLE_SECONDS = 0.8


def number(value, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'Number must be in [{low}, {high}]')
    return float(value)


def pose_value(value):
    if not isinstance(value, list) or len(value) != 6:
        raise ValueError('Pose requires six floats: x,y,z,pitch,yaw,roll')
    return [number(v, -100000, 100000) if i < 3 else number(v, -360, 360)
            for i, v in enumerate(value)]


def setting_value(name, value):
    if name not in SETTINGS:
        raise ValueError('Camera setting is not allowlisted')
    kind, low, high = SETTINGS[name]
    if kind == 'b':
        if type(value) is not bool:
            raise ValueError('A boolean is required')
        return value, 'T' if value else 'F'
    if kind == 'i':
        if type(value) is not int or value not in (0, 1, 2, 6):
            raise ValueError('Mode must be Off=0, Photo=1, Stream=2 or Drone=6')
        return value, 'i'
    return number(value, low, high), 'f'


def angle_lerp(a, b, t):
    return (a + ((b - a + 180) % 360 - 180) * t + 180) % 360 - 180


class Presets:
    """Small, server-side, atomic per-venue store. No client-supplied file paths."""
    def __init__(self, path: Path):
        self.path = path
        self.data = {}
        if path.exists():
            if path.stat().st_size > 131072:
                raise ValueError('Preset file is too large')
            data = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(data, dict) or len(data) > 16:
                raise ValueError('Invalid preset store')
            for profile, slots in data.items():
                self.profile(profile)
                if not isinstance(slots, dict) or len(slots) > 8:
                    raise ValueError('Invalid preset slots')
                for slot, value in slots.items():
                    self.slot(slot)
                    self.validate(value)
            self.data = data

    @staticmethod
    def profile(value):
        if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', value):
            raise ValueError('Venue ID must contain 1-40 letters, digits, _ or -')
        return value

    @staticmethod
    def slot(value):
        if not isinstance(value, str) or value not in '12345678' or len(value) != 1:
            raise ValueError('Preset slot must be 1-8')
        return value

    @staticmethod
    def validate(value):
        if not isinstance(value, dict) or set(value) != {'name', 'pose', 'zoom'}:
            raise ValueError('Invalid preset')
        if not isinstance(value['name'], str) or not 1 <= len(value['name']) <= 48:
            raise ValueError('Preset name must contain 1-48 characters')
        pose_value(value['pose'])
        number(value['zoom'], 20, 150)

    def put(self, profile, slot, value):
        self.profile(profile)
        self.slot(slot)
        self.validate(value)
        if profile not in self.data and len(self.data) >= 16:
            raise ValueError('Maximum 16 venues')
        # Commit in-memory state only after the atomic disk write succeeds.
        new = {key: dict(slots) for key, slots in self.data.items()}
        new.setdefault(profile, {})[slot] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent, prefix='.presets-', suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as file:
                json.dump(new, file, ensure_ascii=False, allow_nan=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        self.data = new


class Engine:
    def __init__(self, send, presets, *, enable_pose=False, clock=time.monotonic):
        self.send, self.presets, self.clock = send, presets, clock
        self.enable_pose = enable_pose
        self.owner = None
        self.lease_at = 0.0
        self.input_at = 0.0
        self.pose_at = None
        self.last_osc_at = None
        self.any_osc_at = None
        self.observed = {}
        self.requested = {}
        self.observed_at = {}
        self.requested_at = {}
        self.pose = None
        self.armed = False
        self.axes = [0.0] * 5
        self.velocity = [0.0] * 5
        self.speed = 1.0
        self.turn_speed = 30.0
        self.transition = None
        self.profile = 'default'
        self.reason = 'Not armed'
        self.sent = 0
        self.invalid_osc = 0
        self.udp_error = None
        self.move_at = 0.0
        self.contact_lost = False
        self.capture_at = None
        self.auto_capture = True
        self.settle_at = None
        self.was_moving = False

    def emit(self, name, values, types):
        # No browser-provided endpoint, host, port, file path or /input controls.
        self.send('/usercamera/' + name, values, types)
        self.sent += 1

    def capture(self, now):
        """Ask VRChat for a photo. False when the shutter is still cooling off."""
        if self.capture_at is not None and now - self.capture_at < CAPTURE_SECONDS:
            return False
        self.capture_at = now
        self.emit('Capture', [True], 'T')
        return True

    def moving(self):
        return self.transition is not None or any(self.axes) or any(self.velocity)

    def latest(self, name):
        """Our last command or VRChat's last report, whichever happened later.

        The operator can change a setting inside VRChat after we sent one, so
        neither side is authoritative on its own; only the newer value is.
        """
        sent = self.requested_at.get(name) if name in self.requested else None
        seen = self.observed_at.get(name) if name in self.observed else None
        # On a tie VRChat wins: its report is the camera, ours is only a request.
        if sent is not None and (seen is None or sent > seen):
            return self.requested[name]
        return self.observed[name] if seen is not None else None

    def resync(self):
        # Pose writes are absolute, so every move restarts from the last position
        # VRChat reported. Feedback is change-only: silence means "unchanged", not
        # "unknown", so age is a liveness alarm while moving (see tick), not a gate
        # on starting. This also picks up a camera moved by hand inside VRChat.
        if 'Pose' not in self.observed:
            raise ValueError('No Pose feedback yet; open and move the VRChat camera first')
        if self.contact_lost:
            raise ValueError('Lost Pose feedback while moving; check VRChat, then move the camera')
        self.pose = list(self.observed['Pose'])
        self.move_at = self.clock()

    def stop(self, reason='STOP', *, disarm=True):
        self.axes = [0.0] * 5
        self.velocity = [0.0] * 5
        self.transition = None
        self.reason = reason
        if disarm:
            self.armed = False
        # Pose commands are absolute, not latched VRChat /input axes.
        # Stop emitting new poses; do not stop OBS/Spout or move the local player.

    def release(self, client):
        if self.owner == client:
            self.stop('Operator released / disconnected')
            self.owner = None

    def note_traffic(self):
        """Something arrived from VRChat. Says the OSC path works, nothing more.

        Camera health still comes from /usercamera/ only, but without this an
        operator cannot tell "OSC is off or aimed elsewhere" from "the camera is
        simply sitting still", which look identical and need opposite fixes.
        """
        self.any_osc_at = self.clock()

    def receive(self, address, values, types):
        self.note_traffic()
        if address == '/usercamera/Pose':
            if types != 'ffffff':
                raise ValueError('Unexpected Pose typetag')
            value = pose_value(values)
            self.observed['Pose'] = value
            self.pose_at = self.clock()
            self.contact_lost = False
        elif address.startswith('/usercamera/') and address[12:] in SETTINGS:
            name = address[12:]
            if len(values) != 1:
                raise ValueError('Invalid setting feedback arity')
            value, expected = setting_value(name, values[0])
            if types != expected:
                raise ValueError('Unexpected setting typetag')
            previous = self.observed.get(name)
            self.observed[name] = value
            self.observed_at[name] = self.clock()
            if name == 'Mode' and (value == 0 or (previous is not None and value != previous)):
                self.stop('VRChat camera mode changed')
            if name in ('Lock', 'LookAtMe') and value:
                self.stop('VRChat camera lock/automatic aiming enabled')
        else:
            return  # Unrelated avatar traffic is not camera-health evidence.
        self.last_osc_at = self.clock()

    def dispatch(self, client, msg):
        if not isinstance(msg, dict) or not isinstance(msg.get('op'), str):
            raise ValueError('Expected a command object')
        op, now = msg['op'], self.clock()
        if op == 'stop':  # Every authenticated observer may stop motion.
            self.stop('Emergency STOP')
            return
        if op == 'claim':
            if self.owner is not None and self.owner != client and now - self.lease_at <= LEASE_SECONDS:
                raise ValueError('Another operator holds control')
            if self.owner != client:
                self.stop('Control acquired; arm from feedback')
            self.owner, self.lease_at = client, now
            return
        if self.owner != client or now - self.lease_at > LEASE_SECONDS:
            if self.owner == client:
                self.release(client)
            raise ValueError('Acquire control first')
        # Any command is proof the operator is still there, not only a heartbeat.
        self.lease_at = now
        if op == 'heartbeat':
            pass
        elif op == 'release':
            self.release(client)
        elif op == 'set':
            name = msg.get('name')
            if not isinstance(name, str):
                raise ValueError('Setting name is required')
            value, kind = setting_value(name, msg.get('value'))
            # Mode/lock/automatic aiming changes invalidate our position model.
            if name in ('Mode', 'Lock', 'LookAtMe'):
                self.stop('Camera behavior changed; re-arm before moving')
            if name == 'Zoom':
                self.transition = None
            self.emit(name, [value], kind)
            self.requested[name] = value
            self.requested_at[name] = now
        elif op == 'profile':
            self.profile = Presets.profile(msg.get('value'))
            self.stop('Venue changed; re-arm in the correct world')
            # Forget where the camera was, not merely when we heard it: another
            # world's coordinates must never be saved or moved to as if current.
            self.observed.pop('Pose', None)
            self.pose = None
            self.pose_at = None
        elif op == 'arm':
            if not self.enable_pose:
                raise ValueError('Pose writes disabled: start with --enable-pose-write for rehearsal')
            # Arming takes the last position VRChat reported, however long ago.
            # Within one server lifetime that report IS the camera: VRChat sends
            # Pose whenever it changes, so silence means the camera has not
            # moved. Demanding a report from the last five seconds meant framing
            # a shot, reaching the browser and pressing ARM inside that window,
            # which is not a thing an operator can do. Liveness is proven where
            # it matters instead: every move resyncs first, and contact loss
            # stops motion within five seconds of starting it.
            if self.observed.get('Mode') == 0:
                raise ValueError('Open the VRChat camera first')
            if self.observed.get('Lock') or self.observed.get('LookAtMe'):
                raise ValueError('Disable Camera Lock and Look At Me in VRChat before arming')
            self.resync()
            self.stop('Armed from observed pose')
            self.armed = True
        elif op == 'motion':
            if not self.armed:
                raise ValueError('Arm from observed Pose first')
            axes = msg.get('axes')
            if not isinstance(axes, list) or len(axes) != 5:
                raise ValueError('Expected strafe, forward, vertical, yaw, pitch')
            axes = [number(v, -1, 1) for v in axes]
            speed = number(msg.get('speed', 1), 0.05, 5)
            turn = number(msg.get('turnSpeed', 30), 1, 90)
            # Limit diagonal translation to the selected speed.
            length = math.sqrt(sum(v * v for v in axes[:3]))
            if length > 1:
                axes[:3] = [v / length for v in axes[:3]]
            if any(axes) and not self.moving():
                self.resync()  # Starting from rest: feedback may have gone quiet.
            self.axes, self.speed, self.turn_speed = axes, speed, turn
            self.input_at = now
            if any(axes):
                self.transition = None
            else:
                # Button release is a hard stop, never an inertial drift.
                self.velocity = [0.0] * 5
        elif op == 'capture':
            # Ask VRChat to take the photo; the file is VRChat's to write and
            # name. We only ever read the newest one back, never a named path.
            if self.observed.get('Mode') == 0:
                raise ValueError('Open the VRChat camera first')
            if not self.capture(now):
                raise ValueError('Capture again in a moment')
        elif op == 'autoCapture':
            if type(msg.get('value')) is not bool:
                raise ValueError('A boolean is required')
            self.auto_capture = msg['value']
            if not self.auto_capture:
                self.settle_at = None
        elif op == 'save':
            # Save what VRChat last reported. Feedback is change-only, so a still
            # camera goes quiet within seconds and demanding fresh feedback here
            # made saving impossible exactly when the shot was framed and held.
            if 'Pose' not in self.observed:
                raise ValueError('No Pose feedback yet; open and move the VRChat camera first')
            if self.contact_lost:
                raise ValueError('Lost Pose feedback while moving; check VRChat, then move the camera')
            if 'Zoom' not in self.observed:
                raise ValueError('Need observed Zoom; move its slider in VRChat first')
            if self.transition or any(self.axes) or any(self.velocity):
                raise ValueError('Stop camera movement before saving')
            self.presets.put(self.profile, msg.get('slot'), {
                'name': msg.get('name'), 'pose': list(self.observed['Pose']),
                'zoom': self.observed['Zoom'],
            })
        elif op == 'recall':
            if not self.armed:
                raise ValueError('Arm from observed Pose first')
            slot = Presets.slot(msg.get('slot'))
            target = self.presets.data.get(self.profile, {}).get(slot)
            if target is None:
                raise ValueError('Empty preset')
            duration = number(msg.get('duration', 2.5), 0, 30)
            # No invented zoom default: interpolation needs a real starting value.
            # A CUT lands on the preset's own zoom, so it never has to invent one
            # (VRChat reports Zoom only when it changes, so it is often unknown).
            if duration and 'Zoom' not in self.observed:
                raise ValueError('Need observed Zoom; move its slider in VRChat first')
            self.resync()
            start = list(self.pose)
            zoom = self.latest('Zoom')
            if zoom is None:
                zoom = target['zoom']
            self.stop('Preset transition', disarm=False)
            self.transition = (now, duration, start, zoom, target)
        else:
            raise ValueError('Unknown command')

    def tick(self, dt):
        now = self.clock()
        if self.owner is not None and now - self.lease_at > LEASE_SECONDS:
            self.release(self.owner)
        if not self.armed:
            self.settle_at, self.was_moving = None, False
            return
        # The operator cannot see the camera, so "did it actually get there?"
        # has no answer once a move ends. Take one photo when it comes to rest,
        # and drop it if the camera starts moving again: a picture of the way
        # there confirms nothing. Starting a new move cancels the pending shot.
        moving = self.moving()
        if moving:
            self.settle_at = None
        elif self.was_moving and self.auto_capture:
            self.settle_at = now + SETTLE_SECONDS
        self.was_moving = moving
        if self.settle_at is not None and now >= self.settle_at:
            self.settle_at = None
            if not self.contact_lost and self.observed.get('Mode') != 0:
                self.capture(now)
        # VRChat only emits Pose when it changes, so an idle camera always goes
        # quiet: silence alone never disarms. Once we move, VRChat echoes our own
        # writes, so continued silence means we lost contact. Measure from the
        # start of the move, not from the last idle reading.
        if now - max(self.pose_at or 0.0, self.move_at) > POSE_SECONDS and self.moving():
            self.contact_lost = True
            self.stop('Pose feedback stale; check VRChat', disarm=False)
            return
        if dt > 0.2 or dt <= 0:
            # A hiccup only invalidates motion that was integrating over it.
            # A still camera is exactly where it was, so stay armed.
            if self.moving():
                self.stop('Control loop stalled; re-arm')
            return
        if self.transition:
            started, duration, start, start_zoom, target = self.transition
            t = 1.0 if duration == 0 else min(1.0, (now - started) / duration)
            eased = t * t * (3 - 2 * t)
            self.pose = [a + (b - a) * eased if i < 3 else angle_lerp(a, b, eased)
                         for i, (a, b) in enumerate(zip(start, target['pose']))]
            zoom = start_zoom + (target['zoom'] - start_zoom) * eased
            self.emit('Pose', self.pose, 'ffffff')
            self.emit('Zoom', [zoom], 'f')
            self.requested['Zoom'] = zoom
            self.requested_at['Zoom'] = now
            if t >= 1:
                self.transition = None
            return
        if now - self.input_at > INPUT_SECONDS:
            # Only a live move times out. Repeating this while already still
            # would overwrite the reason the operator needs to read.
            if self.moving():
                self.stop('Input timeout', disarm=False)
            return
        alpha = 1 - math.exp(-dt / 0.12)
        targets = [v * (self.speed if i < 3 else self.turn_speed) for i, v in enumerate(self.axes)]
        self.velocity = [a + (b - a) * alpha for a, b in zip(self.velocity, targets)]
        if max(abs(v) for v in self.velocity) < 0.00001:
            return
        x, forward, up, yaw, pitch = self.velocity
        heading = math.radians(self.pose[4])
        candidate = list(self.pose)
        candidate[0] += (x * math.cos(heading) + forward * math.sin(heading)) * dt
        candidate[1] += up * dt
        candidate[2] += (forward * math.cos(heading) - x * math.sin(heading)) * dt
        candidate[3] = max(-85, min(85, angle_lerp(candidate[3], candidate[3], 0) + pitch * dt))
        candidate[4] = (candidate[4] + yaw * dt + 180) % 360 - 180
        self.pose = pose_value(candidate)
        self.emit('Pose', self.pose, 'ffffff')

    def state(self):
        now = self.clock()
        return {
            'type': 'state', 'owner': self.owner, 'armed': self.armed,
            'poseWriteEnabled': self.enable_pose, 'profile': self.profile,
            'observed': self.observed, 'requested': self.requested,
            'commandedPose': self.pose, 'transitioning': self.transition is not None,
            'oscAge': None if self.last_osc_at is None else round(now - self.last_osc_at, 2),
            'anyOscAge': None if self.any_osc_at is None else round(now - self.any_osc_at, 2),
            'poseAge': None if self.pose_at is None else round(now - self.pose_at, 2),
            'reason': self.reason, 'sent': self.sent, 'invalidOsc': self.invalid_osc,
            'contactLost': self.contact_lost,
            'captureAge': None if self.capture_at is None else round(now - self.capture_at, 2),
            'autoCapture': self.auto_capture,
            'udpError': self.udp_error,
            'presets': self.presets.data.get(self.profile, {}),
        }
