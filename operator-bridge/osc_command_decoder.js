const COMMANDS = new Map([
    [1, 'NEXT'],
    [2, 'TAKE'],
    [3, 'VENUE'],
    [4, 'STANDBY'],
    [5, 'ENTRY'],
    [250, 'CLAIM_DIRECTOR'],
    [251, 'RELEASE_DIRECTOR'],
    [255, 'PANIC']
]);

class OscCommandDecoder {
    constructor() {
        this.armed = true;
    }

    accept(value) {
        if (value === 0) {
            this.armed = true;
            return null;
        }
        if (!this.armed) {
            return null;
        }
        this.armed = false;
        return COMMANDS.get(value) || null;
    }
}

module.exports = OscCommandDecoder;
