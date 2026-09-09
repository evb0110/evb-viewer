import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

async function loadModule() {
    vi.resetModules();
    return import('@electron/native-tools/runNativeToolCommand');
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

describe('runNativeToolCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.runNativeCommand.mockResolvedValue({
            exitCode: 0,
            stderr: '',
            stdout: '1\n',
        });
    });

    it('performs a cached Rust native tool protocol handshake before use', async () => {
        const {runNativeToolCommand} = await loadModule();

        await runNativeToolCommand('/tools/evb-pdf-page-ops', ['page-sizes']);
        await runNativeToolCommand('/tools/evb-pdf-page-ops', ['page-sizes']);

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(3);
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            1,
            '/tools/evb-pdf-page-ops',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-page-ops',
            ['page-sizes'],
            expect.any(Object),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            3,
            '/tools/evb-pdf-page-ops',
            ['page-sizes'],
            expect.any(Object),
        );
    });

    it('runs shared protocol handshakes without caller cancellation controls', async () => {
        const {runNativeToolCommand} = await loadModule();
        const controller = new AbortController();
        const log = vi.fn();

        await runNativeToolCommand('/tools/evb-pdf-search', ['search'], {
            cancelGroup: 'search-request-1',
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            signal: controller.signal,
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        const handshakeOptions = mocks.runNativeCommand.mock.calls[0]?.[2];
        const commandOptions = mocks.runNativeCommand.mock.calls[1]?.[2];
        expect(handshakeOptions).toMatchObject({
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            timeoutMs: 5_000,
        });
        expect(handshakeOptions.signal).toBeInstanceOf(AbortSignal);
        expect(handshakeOptions.signal).not.toBe(controller.signal);
        expect(handshakeOptions.onSpawn).toBeUndefined();
        expect(commandOptions).toMatchObject({
            cancelGroup: 'search-request-1',
            cwd: '/work',
            env: {EVB_TEST: '1'},
            log,
            signal: controller.signal,
        });
    });

    it('terminates the shared protocol child when its last caller aborts', async () => {
        const handshake = createDeferred<{
            exitCode: number;
            stderr: string;
            stdout: string;
        }>();
        mocks.runNativeCommand.mockImplementationOnce(() => handshake.promise);
        const {runNativeToolCommand} = await loadModule();
        const caller = new AbortController();

        const result = runNativeToolCommand('/tools/evb-pdf-search', ['search'], {signal: caller.signal});
        const handshakeSignal = mocks.runNativeCommand.mock.calls[0]?.[2]?.signal as AbortSignal;

        caller.abort(new DOMException('caller canceled', 'AbortError'));

        await expect(result).rejects.toThrow('caller canceled');
        expect(handshakeSignal.aborted).toBe(true);
    });

    it('forwards every execution limit after completing the shared handshake', async () => {
        const {runNativeToolCommand} = await loadModule();
        const onSpawn = vi.fn();

        await runNativeToolCommand('/tools/evb-pdf-search.exe', ['search'], {
            allowedExitCodes: [
                0,
                2,
            ],
            commandLabel: 'search request',
            maxStderrBytes: 2_048,
            maxStdoutBytes: 4_096,
            onSpawn,
            rejectOnStdoutTruncation: true,
            timeoutMs: 12_000,
        });

        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-search.exe',
            ['search'],
            expect.objectContaining({
                allowedExitCodes: [
                    0,
                    2,
                ],
                commandLabel: 'search request',
                maxStderrBytes: 2_048,
                maxStdoutBytes: 4_096,
                onSpawn,
                rejectOnStdoutTruncation: true,
                timeoutMs: 12_000,
            }),
        );
    });

    it('lets one caller abort its wait without canceling a shared protocol handshake', async () => {
        const handshake = createDeferred<{
            exitCode: number;
            stderr: string;
            stdout: string;
        }>();
        mocks.runNativeCommand.mockImplementationOnce(() => handshake.promise);
        const {runNativeToolCommand} = await loadModule();
        const canceledCaller = new AbortController();
        const continuingCaller = new AbortController();

        const canceledResult = runNativeToolCommand('/tools/evb-pdf-search', [
            'search',
            'first',
        ], {
            cancelGroup: 'search-request-1',
            signal: canceledCaller.signal,
        });
        const continuingResult = runNativeToolCommand('/tools/evb-pdf-search', [
            'search',
            'second',
        ], {
            cancelGroup: 'search-request-2',
            signal: continuingCaller.signal,
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runNativeCommand.mock.calls[0]?.[2]).not.toHaveProperty('cancelGroup');
        expect(mocks.runNativeCommand.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);

        canceledCaller.abort(new DOMException('first caller canceled', 'AbortError'));
        await expect(canceledResult).rejects.toThrow('first caller canceled');
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);

        handshake.resolve({
            exitCode: 0,
            stderr: '',
            stdout: '1\n',
        });
        await expect(continuingResult).resolves.toMatchObject({
            exitCode: 0,
            stderr: '',
            stdout: '1\n',
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-search',
            [
                'search',
                'second',
            ],
            expect.objectContaining({
                cancelGroup: 'search-request-2',
                signal: continuingCaller.signal,
            }),
        );
    });

    it('rejects an already-aborted protocol wait before starting the shared probe', async () => {
        const {verifyNativeToolProtocol} = await loadModule();
        const controller = new AbortController();
        controller.abort(new DOMException('already canceled', 'AbortError'));

        await expect(verifyNativeToolProtocol(
            '/tools/evb-pdf-page-ops',
            {signal: controller.signal},
        )).rejects.toThrow('already canceled');

        expect(mocks.runNativeCommand).not.toHaveBeenCalled();
    });

    it('rejects unsupported Rust native tool protocols before running the real command', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '99\n',
        });
        const {runNativeToolCommand} = await loadModule();

        await expect(runNativeToolCommand('/tools/evb-pdf-search', ['search'])).rejects.toMatchObject({
            name: 'NativeToolProtocolVersionError',
            message: 'evb-pdf-search unsupported native protocol version: expected 1, got 99',
        });
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            '/tools/evb-pdf-search',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
    });

    it('reports scan-cleanup protocol mismatches with the typed version error', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '2\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        const mismatch = await verifyNativeToolProtocol('/tools/evb-scan-cleanup')
            .catch((error: unknown) => error);

        expect(mismatch).toMatchObject({
            name: 'NativeToolProtocolVersionError',
            toolName: 'evb-scan-cleanup',
            expectedVersion: 10,
            actualVersion: '2',
        });
    });

    it('rejects lower revisions for tools without a capability fallback', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '3\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-pdf-image-combine')).rejects.toMatchObject({
            name: 'NativeToolProtocolVersionError',
            toolName: 'evb-pdf-image-combine',
            expectedVersion: 4,
            actualVersion: '3',
        });
    });

    it('allows the legacy scan-cleanup revision with inferred optional capabilities', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '9\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup')).resolves.toEqual({
            protocolVersion: 9,
            capabilities: ['manifest-v3'],
        });
        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup', {requiredCapabilities: ['structured-warning-events']})).rejects.toMatchObject({
            name: 'NativeToolProtocolCapabilityError',
            capability: 'structured-warning-events',
        });
    });

    it('rejects scalar scan-cleanup revision 10 because it cannot advertise capabilities', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '10\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup')).rejects.toMatchObject({
            name: 'NativeToolProtocolCapabilityError',
            capability: null,
        });
    });

    it('rejects a structured revision 9 handshake claiming a revision 10 capability', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
                protocolVersion: 9,
                capabilities: [
                    'manifest-v3',
                    'structured-warning-events',
                ],
            }) + '\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup')).rejects.toMatchObject({
            name: 'NativeToolProtocolCapabilityError',
            capability: 'structured-warning-events',
        });
    });

    it('consumes structured capability names from a newer handshake', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
                protocolVersion: 10,
                capabilities: [
                    'manifest-v3',
                    'structured-warning-events',
                ],
            }) + '\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup', {requiredCapabilities: ['structured-warning-events']})).resolves.toEqual({
            protocolVersion: 10,
            capabilities: [
                'manifest-v3',
                'structured-warning-events',
            ],
        });
    });

    it('rejects a structured handshake that omits its capability list', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({protocolVersion: 10}) + '\n',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-scan-cleanup')).rejects.toMatchObject({
            name: 'NativeToolProtocolCapabilityError',
            capability: null,
        });
    });

    it('reports empty and unknown native tool protocol responses', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '',
        });
        const {verifyNativeToolProtocol} = await loadModule();

        await expect(verifyNativeToolProtocol('/tools/evb-pdf-search'))
            .rejects.toMatchObject({
                actualVersion: '<empty>',
                expectedVersion: 1,
            });
        await expect(verifyNativeToolProtocol('/tools/evb-unknown-tool'))
            .rejects.toMatchObject({
                actualVersion: 'unknown tool',
                expectedVersion: -1,
            });
    });

    it('retries failed native tool handshakes instead of caching them forever', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'bogus\n',
        });
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: '4\n',
        });
        mocks.runNativeCommand.mockResolvedValueOnce({
            exitCode: 0,
            stderr: '',
            stdout: 'ok\n',
        });
        const {runNativeToolCommand} = await loadModule();

        await expect(runNativeToolCommand('/tools/evb-pdf-image-combine', [
            '--output',
            'out.pdf',
        ])).rejects.toThrow('expected 4, got bogus');
        await expect(runNativeToolCommand('/tools/evb-pdf-image-combine', [
            '--output',
            'out.pdf',
        ])).resolves.toMatchObject({
            exitCode: 0,
            stderr: '',
            stdout: 'ok\n',
        });

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(3);
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            1,
            '/tools/evb-pdf-image-combine',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/evb-pdf-image-combine',
            ['--protocol-version'],
            expect.objectContaining({timeoutMs: 5_000}),
        );
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            3,
            '/tools/evb-pdf-image-combine',
            [
                '--output',
                'out.pdf',
            ],
            expect.any(Object),
        );
    });

    it('does not handshake non-evb commands', async () => {
        const {runNativeToolCommand} = await loadModule();

        await runNativeToolCommand('/tools/qpdf', ['--version']);

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(1);
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            '/tools/qpdf',
            ['--version'],
            expect.any(Object),
        );
    });
});
