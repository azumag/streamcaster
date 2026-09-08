const crypto = require('crypto');

class OperatorRegistry {
    constructor(operators) {
        this.operators = operators.map((operator) => ({
            id: operator.id,
            token: operator.token,
            canPanic: operator.canPanic !== false
        }));
    }

    static fromJson(json) {
        let operators;
        try {
            operators = JSON.parse(json || '[]');
        } catch (_error) {
            throw new Error('BLMF operator configuration must be valid JSON');
        }

        if (!Array.isArray(operators) || operators.length === 0) {
            throw new Error('At least one BLMF operator is required');
        }

        for (const operator of operators) {
            if (!operator || typeof operator.id !== 'string' || !operator.id.trim() ||
                typeof operator.token !== 'string' || !operator.token) {
                throw new Error('BLMF operator id and token are required');
            }
        }

        return new OperatorRegistry(operators);
    }

    authenticateBearer(header) {
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            return null;
        }

        const candidate = header.slice('Bearer '.length);
        for (const operator of this.operators) {
            if (this.tokensEqual(candidate, operator.token)) {
                return { id: operator.id, canPanic: operator.canPanic };
            }
        }
        return null;
    }

    tokensEqual(left, right) {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);
        if (leftBuffer.length !== rightBuffer.length) {
            return false;
        }
        return crypto.timingSafeEqual(leftBuffer, rightBuffer);
    }
}

module.exports = OperatorRegistry;
