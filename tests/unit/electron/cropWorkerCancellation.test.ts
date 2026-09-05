import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    cropPagesLocal: vi.fn(),
    on: vi.fn(),
    postMessage: vi.fn(),
    workerData: {
        type: 'crop',
        workingCopyPath: '/tmp/document.pdf',
        pages: [7],
        margins: {
            top: 1,
            bottom: 1,
            left: 1,
            right: 1,
        },
    },
}));

vi.mock('worker_threads', () => ({
    parentPort: {
        on: mocks.on,
        postMessage: mocks.postMessage,
    },
    workerData: mocks.workerData,
}));

vi.mock('@electron/features/page-ops/main/cropLocal', () => ({
    cropPagesLocal: mocks.cropPagesLocal,
    removeCropFromPagesLocal: vi.fn(),
}));

describe('cropWorker cancellation', () => {
    it('passes cancellation through to the crop operation', async () => {
        let receivedSignal: AbortSignal | undefined;
        let resolveStarted: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
            resolveStarted = resolve;
        });
        mocks.cropPagesLocal.mockImplementation(async (
            _workingCopyPath: string,
            _pages: number[],
            _margins: unknown,
            signal: AbortSignal,
        ) => {
            receivedSignal = signal;
            resolveStarted?.();
            await new Promise<never>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), {once: true});
            });
        });

        const workerImport = import('@electron/features/page-ops/main/cropWorker');
        await started;

        const cancelHandler = mocks.on.mock.calls.find(call => call[0] === 'message')?.[1] as
            | ((message: unknown) => void)
            | undefined;
        expect(cancelHandler).toBeTypeOf('function');
        cancelHandler?.({type: 'cancel'});
        await workerImport;

        expect(receivedSignal?.aborted).toBe(true);
        expect(mocks.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'result',
            ok: false,
            error: 'Crop worker canceled',
        }));
    });
});
