const OperatorRegistry = require('../../blmf/operator_registry');

describe('OperatorRegistry', () => {
    test('maps a bearer token to configured operator identity', () => {
        const registry = OperatorRegistry.fromJson('[{"id":"azumag","token":"secret-a"}]');
        expect(registry.authenticateBearer('Bearer secret-a')).toEqual({ id: 'azumag', canPanic: true });
    });

    test('honors explicit canPanic false', () => {
        const registry = OperatorRegistry.fromJson('[{"id":"backup","token":"secret-b","canPanic":false}]');
        expect(registry.authenticateBearer('Bearer secret-b')).toEqual({ id: 'backup', canPanic: false });
    });

    test('rejects unknown or missing bearer tokens', () => {
        const registry = OperatorRegistry.fromJson('[{"id":"azumag","token":"secret-a"}]');
        expect(registry.authenticateBearer('Bearer wrong')).toBeNull();
        expect(registry.authenticateBearer(undefined)).toBeNull();
    });

    test('rejects empty or malformed operator configuration', () => {
        expect(() => OperatorRegistry.fromJson('[]')).toThrow('At least one BLMF operator is required');
        expect(() => OperatorRegistry.fromJson('[{"id":"azumag"}]')).toThrow('BLMF operator id and token are required');
    });
});
