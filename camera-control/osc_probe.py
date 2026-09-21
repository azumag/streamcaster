"""Where is VRChat actually sending OSC? Listen on the candidate ports and say.

VRChat runs under Easy Anti-Cheat, so its command line cannot be read back and
the Steam launch option cannot be confirmed that way. Watching the sockets is
the only honest answer. Run this with the camera server stopped.
"""
import argparse
import asyncio

from osc_codec import decode

CAMERA = '/usercamera/'


class Listener(asyncio.DatagramProtocol):
    def __init__(self, seen):
        self.seen = seen

    def datagram_received(self, data, addr):
        if addr[0] != '127.0.0.1':
            return
        self.seen['packets'] += 1
        try:
            address, _values, _types = decode(data)
        except (ValueError, UnicodeError):
            self.seen['undecodable'] += 1
            return
        if address.startswith(CAMERA):
            self.seen['camera'] += 1
        self.seen['addresses'].add(address)


def summarize(results, expect=None):
    """Turn what each port saw into the next thing to do."""
    lines = []
    for port, seen in sorted(results.items()):
        if seen.get('error'):
            lines.append(f'{port}: could not listen ({seen["error"]})')
            continue
        lines.append(f'{port}: {seen["packets"]} packets, {seen["camera"]} camera, '
                     f'{seen["undecodable"]} undecodable')
    live = {port: seen for port, seen in results.items() if seen.get('packets')}
    if not live:
        lines.append('VRChat sent nothing. Enable OSC in the Action Menu (Options > OSC),'
                     ' and check the Steam launch option.')
        return lines
    busiest = max(live, key=lambda port: live[port]['packets'])
    if expect is not None and busiest != expect:
        lines.append(f'VRChat is sending to {busiest}, but this setup expects {expect}.'
                     f' Set the Steam launch option to --osc=9000:127.0.0.1:{expect},'
                     ' then restart VRChat.')
    else:
        lines.append(f'VRChat is sending to {busiest}, which matches this setup.')
    if not live[busiest]['camera']:
        lines.append('No /usercamera/ values yet: open the VRChat camera and move it.')
    return lines


async def watch(ports, seconds):
    loop = asyncio.get_running_loop()
    results, transports = {}, []
    for port in ports:
        seen = {'packets': 0, 'camera': 0, 'undecodable': 0, 'addresses': set()}
        results[port] = seen
        try:
            transport, _ = await loop.create_datagram_endpoint(
                lambda seen=seen: Listener(seen), local_addr=('127.0.0.1', port))
        except OSError as exc:
            # Usually the camera server itself, or the operator bridge, holds it.
            seen['error'] = exc.strerror or str(exc)
            continue
        transports.append(transport)
    try:
        await asyncio.sleep(seconds)
    finally:
        for transport in transports:
            transport.close()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ports', type=int, nargs='+', default=[9001, 9002])
    parser.add_argument('--seconds', type=float, default=10.0)
    parser.add_argument('--expect', type=int, help='The port this setup wants VRChat to use')
    args = parser.parse_args()
    print(f'Listening on {args.ports} for {args.seconds:g}s. Move the VRChat camera now.',
          flush=True)
    results = asyncio.run(watch(args.ports, args.seconds))
    for line in summarize(results, args.expect):
        print(line, flush=True)


if __name__ == '__main__':
    main()
