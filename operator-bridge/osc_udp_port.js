const dgram = require('dgram');
const EventEmitter = require('events');

class OscUdpPort extends EventEmitter {
    constructor({ localAddress, localPort, remoteAddress, remotePort }) {
        super();
        this.localAddress = localAddress;
        this.localPort = localPort;
        this.remoteAddress = remoteAddress;
        this.remotePort = remotePort;
        this.socket = null;
        this.opened = false;
    }

    open() {
        if (this.socket) {
            return;
        }
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (packet) => {
            try {
                this.emit('message', decodeMessage(packet));
            } catch (error) {
                this.emit('error', error);
            }
        });
        this.socket.on('error', (error) => this.emit('error', error));
        this.socket.on('listening', () => {
            this.opened = true;
            this.emit('ready');
        });
        this.socket.on('close', () => {
            this.opened = false;
            this.socket = null;
        });
        this.socket.bind(this.localPort, this.localAddress);
    }

    send(message) {
        if (!this.socket || !this.opened) {
            throw new Error('OSC UDP port is not ready');
        }
        const packet = encodeMessage(message);
        this.socket.send(packet, this.remotePort, this.remoteAddress);
    }

    close() {
        if (this.socket) {
            this.socket.close();
        }
    }
}

function encodeMessage({ address, args = [] }) {
    if (typeof address !== 'string' || !address.startsWith('/')) {
        throw new Error('Invalid OSC address');
    }
    const typeTags = [','];
    const payloads = [];
    for (const value of args) {
        if (typeof value === 'boolean') {
            typeTags.push(value ? 'T' : 'F');
        } else if (Number.isInteger(value)) {
            typeTags.push('i');
            const payload = Buffer.alloc(4);
            payload.writeInt32BE(value, 0);
            payloads.push(payload);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
            typeTags.push('f');
            const payload = Buffer.alloc(4);
            payload.writeFloatBE(value, 0);
            payloads.push(payload);
        } else if (typeof value === 'string') {
            typeTags.push('s');
            payloads.push(encodeOscString(value));
        } else {
            throw new Error('Unsupported OSC argument type');
        }
    }
    return Buffer.concat([
        encodeOscString(address),
        encodeOscString(typeTags.join('')),
        ...payloads
    ]);
}

function decodeMessage(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 8) {
        throw new Error('Invalid OSC packet');
    }
    const addressResult = readOscString(packet, 0);
    if (!addressResult.value.startsWith('/')) {
        throw new Error('Invalid OSC address');
    }
    const tagsResult = readOscString(packet, addressResult.nextOffset);
    if (!tagsResult.value.startsWith(',')) {
        throw new Error('Invalid OSC type tag');
    }

    let offset = tagsResult.nextOffset;
    const args = [];
    for (const tag of tagsResult.value.slice(1)) {
        switch (tag) {
            case 'i':
                ensureBytes(packet, offset, 4);
                args.push(packet.readInt32BE(offset));
                offset += 4;
                break;
            case 'f':
                ensureBytes(packet, offset, 4);
                args.push(packet.readFloatBE(offset));
                offset += 4;
                break;
            case 's': {
                const stringResult = readOscString(packet, offset);
                args.push(stringResult.value);
                offset = stringResult.nextOffset;
                break;
            }
            case 'T':
                args.push(true);
                break;
            case 'F':
                args.push(false);
                break;
            default:
                throw new Error(`Unsupported OSC type tag: ${tag}`);
        }
    }
    return { address: addressResult.value, args };
}

function encodeOscString(value) {
    const raw = Buffer.from(`${value}\0`, 'utf8');
    const paddedLength = align4(raw.length);
    const output = Buffer.alloc(paddedLength);
    raw.copy(output);
    return output;
}

function readOscString(packet, offset) {
    if (offset < 0 || offset >= packet.length) {
        throw new Error('Invalid OSC string offset');
    }
    const end = packet.indexOf(0, offset);
    if (end < 0) {
        throw new Error('Invalid OSC string');
    }
    const nextOffset = align4(end + 1);
    if (nextOffset > packet.length) {
        throw new Error('Invalid OSC string padding');
    }
    return {
        value: packet.toString('utf8', offset, end),
        nextOffset
    };
}

function ensureBytes(packet, offset, length) {
    if (offset < 0 || offset + length > packet.length) {
        throw new Error('Invalid OSC argument payload');
    }
}

function align4(value) {
    return Math.ceil(value / 4) * 4;
}

module.exports = OscUdpPort;
module.exports.encodeMessage = encodeMessage;
module.exports.decodeMessage = decodeMessage;
