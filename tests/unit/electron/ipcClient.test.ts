import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    CORE_IPC_SEND_CHANNELS, IPC_INVOKE_REQUEST_ID_FIELD,
} from '@electron/platform-ipc/coreContract';
import {
    IpcInvokeTimeoutError,
    createCodecIpcInvoker,
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

const codecs = {
    'native:slow': {
        decodeArgs: value => [String(value[0])],
        decodeResult: String,
    },
    'regular:slow': {
        decodeArgs: () => [],
        decodeResult: String,
    },
} satisfies TIpcCodecMap<ITestInvokeMap>;

describe('createCodecIpcInvoker timeout policy', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects configured channels with channel-scoped timeout context', async () => {
        vi.useFakeTimers();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'send'> = {
            invoke: vi.fn(() => new Promise(() => {})),
            send: vi.fn(),
        };
        const invoke = createCodecIpcInvoker<ITestInvokeMap>(ipcRenderer, codecs, {invokeTimeoutMsByChannel: {'native:slow': 250}});

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
        const invoke = createCodecIpcInvoker<ITestInvokeMap>(ipcRenderer, codecs);
        const rejected = vi.fn();

        void invoke('regular:slow').catch(rejected);
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();

        expect(rejected).not.toHaveBeenCalled();
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('regular:slow');
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
                    decoderMessage: 'completedUnits exceeds totalUnits',
                }}),
            );
            expect(ipcRenderer.send).toHaveBeenCalledWith(
                CORE_IPC_SEND_CHANNELS.rendererDiagnostic,
                expect.objectContaining({
                    code: 'RENDERER_IPC_EVENT_DECODE_FAILED',
                    runtime: 'electron-renderer',
                    context: {},
                }),
                0,
            );
        } finally {
            warning.mockRestore();
        }
    });
});
