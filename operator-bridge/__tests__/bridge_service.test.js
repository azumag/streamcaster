const BridgeService = require('../bridge_service');
const OscCommandDecoder = require('../osc_command_decoder');

function fakeOscPort() {
    return {
        handlers: {},
        on: jest.fn(function on(event, handler) { this.handlers[event] = handler; }),
        open: jest.fn(),
        close: jest.fn(),
        send: jest.fn()
    };
}

function fakeClient() {
    return {
        claimDirector: jest.fn().mockResolvedValue({ ok: true }),
        heartbeatDirector: jest.fn().mockResolvedValue({ ok: true }),
        releaseDirector: jest.fn().mockResolvedValue({ ok: true }),
        sendCommand: jest.fn().mockResolvedValue({ ok: true, state: 'IDLE' }),
        getState: jest.fn().mockResolvedValue({
            ok: true,
            state: 'IDLE',
            isDirector: false,
            currentEntryIndex: 0
        })
    };
}

describe('BridgeService', () => {
    test('TAKE avatar edge sends exactly one command until zero re-arms it', async () => {
        const oscPort = fakeOscPort();
        const client = fakeClient();
        const service = new BridgeService({ oscPort, client, decoder: new OscCommandDecoder() });

        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [2] });
        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [2] });
        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [0] });
        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [2] });

        expect(client.sendCommand).toHaveBeenCalledTimes(2);
        expect(client.sendCommand).toHaveBeenNthCalledWith(1, 'TAKE');
        expect(client.sendCommand).toHaveBeenNthCalledWith(2, 'TAKE');
    });

    test('CLAIM and RELEASE use Director endpoints rather than production commands', async () => {
        const client = fakeClient();
        const service = new BridgeService({ oscPort: fakeOscPort(), client, decoder: new OscCommandDecoder() });

        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [250] });
        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [0] });
        await service.handleOscMessage({ address: '/avatar/parameters/BLMF_Command', args: [251] });

        expect(client.claimDirector).toHaveBeenCalledTimes(1);
        expect(client.releaseDirector).toHaveBeenCalledTimes(1);
        expect(client.sendCommand).not.toHaveBeenCalled();
    });

    test('ignores OSC addresses that are not the BLMF command parameter', async () => {
        const client = fakeClient();
        const service = new BridgeService({ oscPort: fakeOscPort(), client, decoder: new OscCommandDecoder() });
        await service.handleOscMessage({ address: '/avatar/parameters/Other', args: [2] });
        expect(client.sendCommand).not.toHaveBeenCalled();
    });

    test('state polling sends VRChat feedback only when values change', async () => {
        const oscPort = fakeOscPort();
        const client = fakeClient();
        client.getState.mockResolvedValue({
            ok: true,
            state: 'ON_AIR',
            isDirector: true,
            currentEntryIndex: 7
        });
        const service = new BridgeService({ oscPort, client, decoder: new OscCommandDecoder() });

        await service.pollState();
        expect(oscPort.send).toHaveBeenCalledTimes(5);
        expect(oscPort.send).toHaveBeenCalledWith({ address: '/avatar/parameters/BLMF_OnAir', args: [true] });
        expect(oscPort.send).toHaveBeenCalledWith({ address: '/avatar/parameters/BLMF_IsDirector', args: [true] });
        expect(oscPort.send).toHaveBeenCalledWith({ address: '/avatar/parameters/BLMF_CurrentEntryIndex', args: [7] });

        await service.pollState();
        expect(oscPort.send).toHaveBeenCalledTimes(5);

        client.getState.mockResolvedValue({ ok: true, state: 'IDLE', isDirector: true, currentEntryIndex: 7 });
        await service.pollState();
        expect(oscPort.send).toHaveBeenCalledTimes(6);
        expect(oscPort.send).toHaveBeenLastCalledWith({ address: '/avatar/parameters/BLMF_OnAir', args: [false] });
    });

    test('heartbeat runs only while this bridge is Director', async () => {
        const client = fakeClient();
        const service = new BridgeService({ oscPort: fakeOscPort(), client, decoder: new OscCommandDecoder() });
        await service.heartbeat();
        expect(client.heartbeatDirector).not.toHaveBeenCalled();

        client.getState.mockResolvedValue({ ok: true, state: 'IDLE', isDirector: true, currentEntryIndex: 0 });
        await service.pollState();
        await service.heartbeat();
        expect(client.heartbeatDirector).toHaveBeenCalledTimes(1);
    });

    test('poll and heartbeat failures never synthesize production commands', async () => {
        const client = fakeClient();
        const logger = { info: jest.fn(), warning: jest.fn(), error: jest.fn() };
        const service = new BridgeService({ oscPort: fakeOscPort(), client, decoder: new OscCommandDecoder(), logger });
        client.getState.mockResolvedValue({ ok: false, reason: 'network_error' });
        await service.pollState();
        service.isDirector = true;
        client.heartbeatDirector.mockResolvedValue({ ok: false, reason: 'network_error' });
        await service.heartbeat();

        expect(logger.warning).toHaveBeenCalled();
        expect(client.sendCommand).not.toHaveBeenCalled();
    });
    test('start waits for OSC ready before polling or scheduling timers', async () => {
        const oscPort = fakeOscPort();
        const client = fakeClient();
        const setIntervalFn = jest.fn().mockReturnValue({ timer: true });
        const service = new BridgeService({
            oscPort,
            client,
            decoder: new OscCommandDecoder(),
            setIntervalFn,
            clearIntervalFn: jest.fn()
        });

        const starting = service.start();
        expect(oscPort.open).toHaveBeenCalledTimes(1);
        expect(client.getState).not.toHaveBeenCalled();
        expect(setIntervalFn).not.toHaveBeenCalled();

        await oscPort.handlers.ready();
        await starting;
        expect(client.getState).toHaveBeenCalledTimes(1);
        expect(setIntervalFn).toHaveBeenCalledTimes(2);
    });

});
