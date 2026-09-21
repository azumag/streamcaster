"""Standalone loopback WebSocket -> VRChat OSC prototype. See README.md."""
import argparse
import asyncio
from contextlib import suppress
from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit

from aiohttp import web, WSMsgType

from engine import Engine, Presets
from osc_codec import encode, decode

ROOT = Path(__file__).resolve().parent
ENGINE = web.AppKey('engine', Engine)
CONFIG = web.AppKey('config', object)
CLIENTS = web.AppKey('clients', set)
OPERATORS = web.AppKey('operators', dict)
HEADERS = {
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; "
                               "connect-src 'self'; img-src 'self'; base-uri 'none'; "
                               "form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
}


@dataclass(frozen=True)
class Config:
    port: int = 8765
    feedback_port: int = 9001
    osc_port: int = 9000
    forward_port: int | None = None
    public_origin: str | None = None
    remote_port: int | None = None
    enable_pose: bool = False
    presets: Path = ROOT / '.data' / 'presets.json'

    def __post_init__(self):
        for value in (self.port, self.feedback_port, self.osc_port):
            if type(value) is not int or not 1 <= value <= 65535:
                raise ValueError('Ports must be integers in 1-65535')
        # Remote access gets its own loopback port so "did this arrive through
        # Tailscale Serve?" is answered by the listening socket, which a client
        # cannot forge, instead of by a header it fully controls.
        if self.public_origin and self.remote_port is None:
            raise ValueError('Publishing needs --remote-port: the separate port Tailscale Serve forwards to')
        if self.remote_port is not None:
            if type(self.remote_port) is not int or not 1 <= self.remote_port <= 65535:
                raise ValueError('Ports must be integers in 1-65535')
            if self.remote_port == self.port:
                raise ValueError('Remote port must differ from the local UI port')
            if not self.public_origin:
                raise ValueError('--remote-port needs --public-origin')
        if self.feedback_port == self.osc_port:
            raise ValueError('OSC input and output ports must differ')
        if self.forward_port is not None:
            if (type(self.forward_port) is not int or not 1 <= self.forward_port <= 65535
                    or self.forward_port in (self.feedback_port, self.osc_port)):
                raise ValueError('Forward port must differ from OSC input and output')
        if self.public_origin:
            origin = urlsplit(self.public_origin)
            if (origin.scheme != 'https' or not origin.hostname or origin.username
                    or origin.password or origin.path or origin.query or origin.fragment
                    or self.public_origin != 'https://' + origin.netloc):
                raise ValueError('Public origin must be exactly https://host[:port], without a trailing slash')
            _ = origin.port  # Validate malformed/out-of-range ports as well.

    @property
    def local_origins(self):
        return {f'http://127.0.0.1:{self.port}', f'http://localhost:{self.port}'}

    @property
    def origins(self):
        return self.local_origins | ({self.public_origin} if self.public_origin else set())

    def origins_for(self, arrived_on):
        """Only the published origin may talk to the Serve port, and vice versa."""
        return {self.public_origin} if arrived_on == self.remote_port else self.local_origins

    @property
    def hosts(self):
        return {urlsplit(origin).netloc for origin in self.origins}


def response_headers(config, origins=None):
    # Explicit WS schemes also work in browsers that do not map connect-src
    # 'self' from HTTPS to WSS. Only configured, exact origins are permitted.
    sources = ' '.join(sorted(origin.replace('https://', 'wss://').replace('http://', 'ws://')
                              for origin in (config.origins if origins is None else origins)))
    return {**HEADERS, 'Content-Security-Policy': HEADERS['Content-Security-Policy'].replace(
        "connect-src 'self'", "connect-src 'self' " + sources)}


class Feedback(asyncio.DatagramProtocol):
    def __init__(self, engine, config):
        self.engine, self.config, self.transport = engine, config, None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if addr[0] != '127.0.0.1':
            return
        if self.config.forward_port:
            # Optional explicit fan-out; the existing operator bridge is unchanged.
            self.transport.sendto(data, ('127.0.0.1', self.config.forward_port))
        # Even a packet this codec rejects proves VRChat is sending to this port.
        self.engine.note_traffic()
        try:
            self.engine.receive(*decode(data))
        except (ValueError, UnicodeError):
            self.engine.invalid_osc += 1

    def error_received(self, exc):
        self.engine.udp_error = str(exc)
        self.engine.stop('UDP error; check VRChat')


def parse_message(raw):
    if not isinstance(raw, str) or len(raw) > 4096:
        raise ValueError('Expected a small text JSON message')
    def reject_constant(_):
        raise ValueError('JSON must not contain NaN/Infinity')
    message = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(message, dict):
        raise ValueError('Expected a JSON object')
    return message


@web.middleware
async def guard(request, handler):
    config = request.app[CONFIG]
    origins = config.origins_for(arrived_on(request))
    if request.host not in {urlsplit(origin).netloc for origin in origins}:
        raise web.HTTPForbidden(text='Host not allowed')
    # No credentials in URLs; no generic file serving or write HTTP APIs.
    if request.query_string:
        raise web.HTTPBadRequest(text='Query strings are not accepted')
    response = await handler(request)
    if not response.prepared:
        response.headers.update(response_headers(config, origins))
    return response


async def static_file(request):
    names = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}
    config = request.app[CONFIG]
    return web.FileResponse(ROOT / 'public' / names[request.path],
                            headers=response_headers(config, config.origins_for(arrived_on(request))))


async def health(request):
    # Readiness of THIS HTTP process, never proof VRChat/Spout/OBS works.
    return web.json_response({'service': 'streamcaster-camera-control', 'http': 'ready'})


def arrived_on(request):
    """Which of our listening ports accepted this connection. Clients cannot forge it."""
    socket_name = request.transport.get_extra_info('sockname') if request.transport else None
    return socket_name[1] if socket_name else None


def operator_label(request, config):
    """Who is asking, or None when nothing vouches for them.

    The Serve port is reachable only through Tailscale Serve, which adds identity
    headers for tailnet traffic and omits them for Funnel, so requiring one there
    keeps the public internet out even if Funnel is switched on by mistake. The
    local port is physical access to the VRChat PC itself and needs no header.

    Deciding by listening port matters: a header or Origin can be set freely by
    any non-browser client, so those cannot say where a request came from.
    """
    if arrived_on(request) != config.remote_port:
        return 'localhost'
    login = request.headers.get('Tailscale-User-Login', '')
    if not isinstance(login, str) or not login or len(login) > 254 or '\n' in login or '\r' in login:
        return None
    return login


async def websocket(request):
    config, engine = request.app[CONFIG], request.app[ENGINE]
    if request.headers.get('Origin') not in config.origins_for(arrived_on(request)):
        raise web.HTTPForbidden(text='Origin not allowed')
    operator = operator_label(request, config)
    if operator is None:
        # Reached the Serve port without a tailnet identity: Funnel or a bare proxy.
        raise web.HTTPForbidden(text='Tailscale identity required')
    clients = request.app[CLIENTS]
    if len(clients) >= 16:
        raise web.HTTPServiceUnavailable(text='Connection limit')
    ws = web.WebSocketResponse(max_msg_size=4096, heartbeat=10, compress=False)
    ws.headers.update(response_headers(config, config.origins_for(arrived_on(request))))
    # Reserve before awaiting upgrade to make the connection limit race-free.
    clients.add(ws)
    client, publisher = secrets.token_hex(8), None
    send_lock = asyncio.Lock()

    async def send(value):
        async with send_lock:
            await asyncio.wait_for(ws.send_json(value), timeout=1)

    async def publish():
        operators = request.app[OPERATORS]
        try:
            while not ws.closed:
                state = engine.state()
                # Name the holder so a shared surface shows who is driving.
                state['ownerName'] = operators.get(state['owner'])
                await send({**state, 'client': client, 'operator': operator})
                await asyncio.sleep(0.1)
        except (ConnectionError, RuntimeError, asyncio.TimeoutError):
            engine.release(client)
            await ws.close()

    try:
        await ws.prepare(request)
        request.app[OPERATORS][client] = operator
        await send({'type': 'authenticated', 'client': client, 'operator': operator})
        publisher = asyncio.create_task(publish())
        window, count = time.monotonic(), 0
        async for event in ws:
            if event.type != WSMsgType.TEXT:
                await ws.close(code=1008, message=b'Text JSON only')
                break
            now = time.monotonic()
            if now - window >= 1:
                window, count = now, 0
            count += 1
            if count > 80:
                engine.release(client)
                await ws.close(code=1008, message=b'Rate limit')
                break
            try:
                command = parse_message(event.data)
                engine.dispatch(client, command)
                # Telemetry, not an 'applied' acknowledgement, shows camera state.
                if command['op'] not in ('heartbeat', 'motion'):
                    await send({'type': 'accepted', 'op': command['op']})
            except ValueError as exc:
                await send({'type': 'error', 'message': str(exc)[:180]})
            except (TypeError, OverflowError, RecursionError):
                await send({'type': 'error', 'message': 'Invalid command structure or value.'})
            except OSError:
                engine.stop('I/O error')
                await send({'type': 'error', 'message': 'Local OSC or preset I/O failed; check server.'})
    except (ValueError, TypeError, UnicodeError, RecursionError):
        await ws.close(code=1008, message=b'Invalid authentication message')
    except (asyncio.TimeoutError, ConnectionError, RuntimeError):
        engine.release(client)
        if ws.prepared:
            await ws.close()
    finally:
        engine.release(client)
        clients.discard(ws)
        request.app[OPERATORS].pop(client, None)
        if publisher:
            publisher.cancel()
            with suppress(asyncio.CancelledError):
                await publisher
    return ws


def create_app(config):
    app = web.Application(middlewares=[guard], client_max_size=4096)
    app[CONFIG], app[CLIENTS], app[OPERATORS] = config, set(), {}
    transport = None

    def send(address, values, types):
        if transport is None:
            raise OSError('OSC transport not ready')
        transport.sendto(encode(address, values, types), ('127.0.0.1', config.osc_port))

    engine = Engine(send, Presets(config.presets), enable_pose=config.enable_pose)
    app[ENGINE] = engine

    async def lifetime(_):
        nonlocal transport
        loop = asyncio.get_running_loop()
        transport, _protocol = await loop.create_datagram_endpoint(
            lambda: Feedback(engine, config), local_addr=('127.0.0.1', config.feedback_port))

        async def motion_loop():
            previous = time.monotonic()
            while True:
                await asyncio.sleep(1 / 30)
                now = time.monotonic()
                try:
                    engine.tick(now - previous)
                except (OSError, ValueError, OverflowError):
                    engine.stop('Motion output failed; re-arm after checking server')
                previous = now

        task = asyncio.create_task(motion_loop())
        try:
            yield
        finally:
            engine.stop('Server shutting down')
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            transport.close()
            transport = None

    async def shutdown(_):
        engine.stop('Server shutting down')
        await asyncio.gather(*(ws.close(code=1001, message=b'Server shutdown')
                               for ws in tuple(app[CLIENTS])), return_exceptions=True)

    app.cleanup_ctx.append(lifetime)
    app.on_shutdown.append(shutdown)
    for path in ('/', '/app.js', '/style.css'):
        app.router.add_get(path, static_file)
    app.router.add_get('/healthz', health)
    app.router.add_get('/ws', websocket)
    return app


def run_sites(app, ports):
    """Serve the same app on several loopback ports until interrupted."""
    async def serve():
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        for port in ports:
            await web.TCPSite(runner, '127.0.0.1', port, shutdown_timeout=3).start()
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()

    with suppress(KeyboardInterrupt):
        asyncio.run(serve())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--feedback-port', type=int, default=9001)
    parser.add_argument('--osc-port', type=int, default=9000)
    parser.add_argument('--forward-port', type=int)
    parser.add_argument('--public-origin', default=os.environ.get('CAMERA_PUBLIC_ORIGIN'))
    parser.add_argument('--remote-port', type=int,
                        help='Separate loopback port for Tailscale Serve to forward to')
    parser.add_argument('--enable-pose-write', action='store_true')
    parser.add_argument('--presets', type=Path, default=ROOT / '.data' / 'presets.json')
    args = parser.parse_args()
    try:
        config = Config(port=args.port, feedback_port=args.feedback_port,
                        osc_port=args.osc_port, forward_port=args.forward_port,
                        public_origin=args.public_origin, remote_port=args.remote_port,
                        enable_pose=args.enable_pose_write, presets=args.presets)
        app = create_app(config)
        print(f'Camera UI: http://127.0.0.1:{config.port}', flush=True)
        print('Remote access: ' + (
            f'{config.public_origin} -> 127.0.0.1:{config.remote_port} (Tailscale identity required)'
            if config.public_origin else 'localhost only'), flush=True)
        print(f'OSC feedback: 127.0.0.1:{config.feedback_port}; send: 127.0.0.1:{config.osc_port}', flush=True)
        print('Pose writes: EXPERIMENTAL ENABLED' if config.enable_pose else 'Pose writes: disabled', flush=True)
        ports = [config.port] + ([config.remote_port] if config.remote_port else [])
        run_sites(app, ports)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'Camera server could not start: {exc}\nCheck port conflicts and configuration.\n')


if __name__ == '__main__':
    main()
