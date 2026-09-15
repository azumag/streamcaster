"""Bounded OSC 1.0 message codec for the documented camera types only.

Not a generic OSC server. VRChat sends messages rather than bundles; bundles
are intentionally rejected. The bridge may forward raw local feedback to the
existing operator bridge separately, without interpreting avatar parameters.
"""
import math
import struct


def _string(value: str) -> bytes:
    if '\0' in value:
        raise ValueError('OSC strings cannot contain NUL')
    raw = value.encode('utf-8') + b'\0'
    return raw + b'\0' * (-len(raw) % 4)


def encode(address: str, values: list, types: str) -> bytes:
    if not address.startswith('/') or len(values) != len(types):
        raise ValueError('Invalid OSC address or arity')
    payload = bytearray(_string(address) + _string(',' + types))
    for value, kind in zip(values, types):
        if kind == 'f' and type(value) in (int, float) and math.isfinite(value):
            payload.extend(struct.pack('>f', value))
        elif kind == 'i' and type(value) is int:
            payload.extend(struct.pack('>i', value))
        elif kind in 'TF' and type(value) is bool and value == (kind == 'T'):
            pass
        else:
            raise ValueError('Unsupported OSC value/type')
    return bytes(payload)


def decode(data: bytes) -> tuple[str, list, str]:
    if not data or len(data) > 4096 or len(data) % 4:
        raise ValueError('Invalid OSC size')
    offset = 0

    def read_string():
        nonlocal offset
        end = data.find(b'\0', offset)
        if end < 0:
            raise ValueError('Unterminated OSC string')
        value = data[offset:end].decode('utf-8')
        next_offset = (end + 4) & ~3
        if next_offset > len(data) or any(data[end:next_offset]):
            raise ValueError('Invalid OSC padding')
        offset = next_offset
        return value

    address, tags = read_string(), read_string()
    if not address.startswith('/') or not tags.startswith(',') or len(tags) > 17:
        raise ValueError('Unsupported OSC address/types')
    values = []
    for kind in tags[1:]:
        if kind in 'if':
            if offset + 4 > len(data):
                raise ValueError('Truncated OSC value')
            value = struct.unpack_from('>' + kind, data, offset)[0]
            offset += 4
            if not math.isfinite(value):
                raise ValueError('Non-finite OSC value')
            values.append(value)
        elif kind in 'TF':
            values.append(kind == 'T')
        else:
            raise ValueError('Unsupported OSC type')
    if offset != len(data):
        raise ValueError('Trailing OSC bytes')
    return address, values, tags[1:]
