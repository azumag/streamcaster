const { encodeMessage, decodeMessage } = require('../osc_udp_port');

describe('minimal OSC UDP codec', () => {
    test('round-trips the VRChat Int command message', () => {
        const packet = encodeMessage({
            address: '/avatar/parameters/BLMF_Command',
            args: [255]
        });
        expect(decodeMessage(packet)).toEqual({
            address: '/avatar/parameters/BLMF_Command',
            args: [255]
        });
    });

    test('round-trips Bool and Int feedback messages', () => {
        expect(decodeMessage(encodeMessage({
            address: '/avatar/parameters/BLMF_Ready',
            args: [true]
        }))).toEqual({ address: '/avatar/parameters/BLMF_Ready', args: [true] });
        expect(decodeMessage(encodeMessage({
            address: '/avatar/parameters/BLMF_CurrentEntryIndex',
            args: [7]
        }))).toEqual({ address: '/avatar/parameters/BLMF_CurrentEntryIndex', args: [7] });
    });

    test('decodes metadata-style float/string types without executing unsupported packets', () => {
        const packet = encodeMessage({ address: '/test', args: [1.5, 'ok', false] });
        expect(decodeMessage(packet)).toEqual({ address: '/test', args: [1.5, 'ok', false] });
        expect(() => decodeMessage(Buffer.from('bad'))).toThrow('Invalid OSC');
    });
});
