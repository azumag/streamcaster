const OscCommandDecoder = require('../osc_command_decoder');

describe('OscCommandDecoder', () => {
    test('emits one command for a nonzero edge and waits for zero to re-arm', () => {
        const decoder = new OscCommandDecoder();
        expect(decoder.accept(2)).toBe('TAKE');
        expect(decoder.accept(2)).toBeNull();
        expect(decoder.accept(0)).toBeNull();
        expect(decoder.accept(2)).toBe('TAKE');
    });

    test('maps every production-safe avatar command', () => {
        const decoder = new OscCommandDecoder();
        const mapping = [
            [1, 'NEXT'],
            [2, 'TAKE'],
            [3, 'VENUE'],
            [4, 'STANDBY'],
            [5, 'ENTRY'],
            [250, 'CLAIM_DIRECTOR'],
            [251, 'RELEASE_DIRECTOR'],
            [255, 'PANIC']
        ];
        for (const [value, command] of mapping) {
            expect(decoder.accept(value)).toBe(command);
            expect(decoder.accept(0)).toBeNull();
        }
    });

    test('unknown nonzero values do not execute and require zero before another edge', () => {
        const decoder = new OscCommandDecoder();
        expect(decoder.accept(99)).toBeNull();
        expect(decoder.accept(2)).toBeNull();
        decoder.accept(0);
        expect(decoder.accept(2)).toBe('TAKE');
    });
});
