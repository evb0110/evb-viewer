import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {DOCUMENT_WORKING_COPY_PLATFORM_FEATURE} from '@contracts/documentsPlatformFeature';
import {getRawElectronPlatformApi} from '@app/utils/electronPlatformBridge';
import {
    CORE_IPC_SEND_CHANNELS, IPC_INVOKE_REQUEST_ID_FIELD,
} from '@electron/platform-ipc/coreContract';
import {
    IpcInvokeTimeoutError,
    createIpcInvoker,
    createPlatformFeaturePreloadClient,
    createTypedIpcEventSubscriber,
} from '@electron/preload/ipcClient';

interface ITestInvokeMap {
    'native:slow': {
        args: [value: string];
        result: string;
    };
    'regular:slow': {
        args: [];
        result: string;
    };
}

describe('createIpcInvoker timeout policy', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects configured channels with channel-scoped timeout context', async () => {
        vi.useFakeTimers();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'> = {
            invoke: vi.fn(() => new Promise(() => {})),
            send: vi.fn(),
        };
        const invoke = createIpcInvoker<ITestInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: {'native:slow': 250}});

        const pending = invoke('native:slow', 'payload');
        const assertion = expect(pending).rejects.toBeInstanceOf(IpcInvokeTimeoutError);
        await vi.advanceTimersByTimeAsync(250);

        await assertion;
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            'native:slow',
            'payload',
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
        expect(ipcRenderer.send).toHaveBeenCalledWith(
            'ipc:invokeCanceled',
            {[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)},
        );
    });

    it('leaves unconfigured channels without a renderer-side timeout', async () => {
        vi.useFakeTimers();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'> = {
            invoke: vi.fn(() => new Promise(() => {})),
            send: vi.fn(),
        };
        const invoke = createIpcInvoker<ITestInvokeMap>(ipcRenderer);
        const rejected = vi.fn();

        void invoke('regular:slow').catch(rejected);
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();

        expect(rejected).not.toHaveBeenCalled();
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('regular:slow');
    });

    it('passes invoke results through without decoding', async () => {
        const result = {invalidForAnySchema: true};
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'> = {
            invoke: vi.fn(async () => result),
            send: vi.fn(),
        };
        const invoke = createIpcInvoker<ITestInvokeMap>(ipcRenderer);

        await expect(invoke('regular:slow')).resolves.toBe(result);
    });
});


describe('renderer IPC abort propagation', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    function setup(timed = true) {
        const reply = Promise.withResolvers<unknown>();
        const ipcRenderer = {
            invoke: vi.fn((_channel: string, ..._args: unknown[]) => reply.promise),
            send: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const feature = DOCUMENT_WORKING_COPY_PLATFORM_FEATURE;
        const spec = feature.methods.parsePdfAnnotations;
        const preload = createPlatformFeaturePreloadClient(ipcRenderer as never, {
            ...feature,
            methods: {
                ...feature.methods,
                parsePdfAnnotations: {
                    ...spec,
                    ipc: {
                        args: spec.ipc.args,
                        result: spec.ipc.result,
                        ...(timed ? {timeoutMs: spec.ipc.timeoutMs} : {}),
                    },
                },
            },
        });
        // contextBridge copies plain values and proxies callbacks. A native
        // AbortSignal must never be handed to it.
        const parsePdfAnnotations = vi.fn((path, options) => {
            if (options.signal instanceof AbortSignal) {
                throw new Error('AbortSignal cannot cross contextBridge');
            }
            return preload.parsePdfAnnotations(path, {...options}).catch((error: unknown) => {
                // Error custom fields, including name, are lost at the bridge.
                throw new Error(error instanceof Error ? error.message : String(error));
            });
        });
        vi.stubGlobal('window', {electronAPI: {documentWorkingCopy: {parsePdfAnnotations}}});
        const parse = (signal: AbortSignal) => getRawElectronPlatformApi()!.documentWorkingCopy.parsePdfAnnotations(
            requireDocumentRef('/managed/working.pdf'),
            {
                expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:abort-test'),
                signal,
            },
        );
        return {
            ipcRenderer,
            parse,
            reply,
            parsePdfAnnotations,
        };
    }

    it.each([
        true,
        false,
    ])('rejects with AbortError and cancels that request (timed: %s)', async timed => {
        const {
            ipcRenderer, parse, reply,
        } = setup(timed);
        const controller = new AbortController();
        const pending = parse(controller.signal);
        const aborted = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        expect(ipcRenderer.invoke).toHaveBeenCalledOnce();
        const metadata = ipcRenderer.invoke.mock.calls[0]!.at(-1);
        expect(metadata).toEqual({[IPC_INVOKE_REQUEST_ID_FIELD]: expect.any(String)});
        controller.abort();
        await aborted;
        expect(ipcRenderer.send).toHaveBeenCalledExactlyOnceWith(CORE_IPC_SEND_CHANNELS.ipcInvokeCanceled, metadata);
        expect(ipcRenderer.invoke.mock.calls[0]![2]).toEqual({expectedDocumentRevisionToken: 'drt1:abort-test'});
        reply.reject(new Error('Main work aborted later'));
    });

    it('does not start an invoke for an already aborted signal', async () => {
        const {
            ipcRenderer, parse,
        } = setup();
        const controller = new AbortController();
        controller.abort();
        await expect(parse(controller.signal)).rejects.toMatchObject({name: 'AbortError'});
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
        expect(ipcRenderer.send).not.toHaveBeenCalled();
    });

    it.each([
        'resolve',
        'reject',
    ] as const)('stops observing the signal after the invoke settles by %s', async settlement => {
        const {
            ipcRenderer, parse, reply,
        } = setup();
        const controller = new AbortController();
        const pending = parse(controller.signal);
        const assertion = settlement === 'resolve'
            ? expect(pending).resolves.toEqual({finished: true})
            : expect(pending).rejects.toThrow('Native failure');
        if (settlement === 'resolve') reply.resolve({finished: true});
        else reply.reject(new Error('Native failure'));
        await assertion;
        controller.abort();
        expect(ipcRenderer.send).not.toHaveBeenCalled();
    });

    it('clears the timed invoke deadline when the caller aborts', async () => {
        vi.useFakeTimers();
        const {
            ipcRenderer, parse,
        } = setup();
        const controller = new AbortController();
        const pending = parse(controller.signal);
        const aborted = expect(pending).rejects.toMatchObject({name: 'AbortError'});
        controller.abort();
        await aborted;
        await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
        expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
    });

    it('stops observing the signal when the invoke times out', async () => {
        vi.useFakeTimers();
        const {
            ipcRenderer, parse,
        } = setup();
        const controller = new AbortController();
        const pending = parse(controller.signal);
        const timedOut = expect(pending).rejects.toThrow('IPC invoke timed out');
        await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
        await timedOut;
        controller.abort();
        expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
    });
});

describe('createTypedIpcEventSubscriber diagnostics', () => {
    it('reports decoder exceptions with the event channel and decoder message', () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'on' | 'removeListener' | 'send'> = {
            on: vi.fn((channel, listener) => {
                listeners.set(channel, listener as (_event: unknown, payload: unknown) => void);
                return Object.create(null) as IpcRenderer;
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            const subscriber = createTypedIpcEventSubscriber<{'scan-cleanup:job:state': {status: 'running'};}>(ipcRenderer);
            subscriber.onDecodedPayload(
                'scan-cleanup:job:state',
                () => { throw new Error('completedUnits exceeds totalUnits'); },
                vi.fn(),
            );
            listeners.get('scan-cleanup:job:state')?.({}, {status: 'invalid'});

            expect(ipcRenderer.send).toHaveBeenCalledWith(
                CORE_IPC_SEND_CHANNELS.rendererLog,
                expect.objectContaining({data: {
                    channel: 'scan-cleanup:job:state',
                    decoderError: 'completedUnits exceeds totalUnits',
                }}),
            );
        } finally {
            warning.mockRestore();
        }
    });
});
