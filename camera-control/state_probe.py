"""Print what the running camera server is seeing, for scripts to read.

The OSC ports are already held by the server itself, so a separate listener
cannot answer "is VRChat sending to us?" while it runs. The server knows, and
this asks it over the local UI port, which needs no Tailscale identity.
"""
import argparse
import asyncio
import json
import sys

import aiohttp


def verdict(state, feedback_port):
    """One line a launcher can print, and whether it is good news."""
    if state is None:
        return False, 'camera server did not answer'
    if state.get('anyOscAge') is None:
        return False, (f'VRChat is sending nothing to {feedback_port}: check OSC in the Action'
                       f' Menu and the Steam launch option --osc=9000:127.0.0.1:{feedback_port}')
    if state.get('oscAge') is None:
        return True, (f'VRChat traffic is arriving on {feedback_port}, but no camera values yet:'
                      ' open the VRChat camera and move it')
    return True, f'camera values arriving on {feedback_port} ({state["oscAge"]:.1f}s ago)'


async def newest_state(url, seconds):
    """The server streams state at 10 Hz; take the last one in a short window."""
    origin = url.rstrip('/')
    async with aiohttp.ClientSession() as session:
        async with session.ws_connect(origin + '/ws', origin=origin) as ws:
            latest, clock = None, asyncio.get_running_loop()
            end = clock.time() + seconds
            while clock.time() < end:
                try:
                    message = await asyncio.wait_for(ws.receive(), timeout=seconds)
                except asyncio.TimeoutError:
                    break
                if message.type is not aiohttp.WSMsgType.TEXT:
                    break
                data = json.loads(message.data)
                if data.get('type') == 'state':
                    latest = data
            return latest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8765')
    parser.add_argument('--feedback-port', type=int, default=9001)
    parser.add_argument('--seconds', type=float, default=1.5)
    parser.add_argument('--json', action='store_true', help='Print the raw state instead')
    args = parser.parse_args()
    try:
        state = asyncio.run(newest_state(args.url, args.seconds))
    except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as exc:
        print(f'camera server not reachable at {args.url}: {exc}')
        return 2
    if args.json:
        print(json.dumps(state, ensure_ascii=False))
        return 0 if state else 2
    good, line = verdict(state, args.feedback_port)
    print(line)
    return 0 if good else 1


if __name__ == '__main__':
    sys.exit(main())
