import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {IPC_INVOKE_REQUEST_ID_FIELD} from '@electron/platform-ipc/coreContract';
import {
    IpcInvokeTimeoutError,
    createCodecIpcInvoker,
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
