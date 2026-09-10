import type * as TViMockOriginalModule from '@app/utils/platformDocuments';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {createPdfjsDocumentSourceLoader} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {pdfjsDocumentTeardownCoordinator} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfjsDocumentTeardownCoordinator';

const mocks = vi.hoisted(() => {
    class MockPdfDataRangeTransport {
        public readonly abort = vi.fn();
        public readonly onDataRange = vi.fn();
        public requestDataRange: ((begin: number, end: number) => void) | null = null;

        constructor(
            public readonly length: number,
            public readonly initialData: Uint8Array,
        ) {}
    }

    return {
        MockPdfDataRangeTransport,
        createObjectURL: vi.fn(() => 'blob:overlap'),
        createPdfjsDocumentOptions: vi.fn(() => ({})),
        documentFiles: {readFileRange: vi.fn()},
        getDocument: vi.fn(),
        logPdfRenderTrace: vi.fn(),
        onRangeReadFailure: vi.fn(),
        preparePdfjsBrowserRuntime: vi.fn(async () => {}),
        revokeObjectURL: vi.fn(),
        browserLogger: {
            debug: vi.fn(),
            warn: vi.fn(),
        },
    };
});

vi.mock('@app/services/pdfjs/runtimeLib', () => ({
    default: {
        getDocument: mocks.getDocument,
        PDFDataRangeTransport: mocks.MockPdfDataRangeTransport,
    },
    configurePdfjsWorkerSrc: vi.fn(),
    createPdfjsDocumentOptions: mocks.createPdfjsDocumentOptions,
    preparePdfjsBrowserRuntime: mocks.preparePdfjsBrowserRuntime,
}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: mocks.browserLogger}));
vi.mock('@app/utils/pdfRenderTrace', () => ({logPdfRenderTrace: mocks.logPdfRenderTrace}));
vi.mock('@app/utils/platformDocuments', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getDocumentFilesCapability: () => mocks.documentFiles,
}));

interface IMockTask {
    destroy: ReturnType<typeof vi.fn>;
    promise: Promise<Record<string, unknown>>;
}

interface IMockPendingTask {
    resolve: (document: Record<string, unknown>) => void;
    task: IMockTask;
}

interface IPdfjsDocumentOptions {
    range?: InstanceType<typeof mocks.MockPdfDataRangeTransport>;
    url?: string;
}

const CHUNK_BYTES = 1024 * 1024;

function createPathSource(path: string, size = CHUNK_BYTES * 2) {
    return {
        kind: 'path' as const,
        path: requireDocumentRef(path),
        size,
    };
}

describe('createPdfjsDocumentSourceLoader', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentFiles.readFileRange.mockReset();
        mocks.getDocument.mockReset();
        mocks.createObjectURL.mockReset();
        mocks.createObjectURL.mockReturnValue('blob:overlap');
        mocks.revokeObjectURL.mockReset();
        mocks.preparePdfjsBrowserRuntime.mockReset();
        mocks.preparePdfjsBrowserRuntime.mockResolvedValue(undefined);
        mocks.createPdfjsDocumentOptions.mockReset();
        mocks.createPdfjsDocumentOptions.mockReturnValue({});
        mocks.documentFiles.readFileRange.mockImplementation(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));
        vi.stubGlobal('URL', {
            createObjectURL: mocks.createObjectURL,
            revokeObjectURL: mocks.revokeObjectURL,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('retires every prior source handle before installing the latest open', async () => {
        const pendingTasks: IMockPendingTask[] = [];
        mocks.getDocument.mockImplementation((_options: IPdfjsDocumentOptions) => {
            let resolve!: (document: Record<string, unknown>) => void;
            const promise = new Promise<Record<string, unknown>>(resolveDocument => {
                resolve = resolveDocument;
            });
            const task: IMockTask = {
                destroy: vi.fn(async () => {}),
                promise,
            };
            pendingTasks.push({
                resolve,
                task,
            });
            return task;
        });

        let renderVersion = 1;
        const loader = createPdfjsDocumentSourceLoader({
            getRenderVersion: () => renderVersion,
            onRangeReadFailure: mocks.onRangeReadFailure,
        });

        const firstOpen = loader.open(createPathSource('/tmp/first.pdf'), renderVersion);
        await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
        const firstOptions = mocks.getDocument.mock.calls[0]?.[0] as IPdfjsDocumentOptions;
        const firstTransport = firstOptions.range;
        const firstTask = pendingTasks[0]?.task;
        expect(firstTransport).toBeInstanceOf(mocks.MockPdfDataRangeTransport);
        expect(firstTask).toBeDefined();

        await expect(loader.open(createPathSource('/tmp/stale.pdf'), 0)).resolves.toBeNull();
        await expect(loader.open(new Blob([new Uint8Array((16 * 1024 * 1024) + 1)]), renderVersion))
            .rejects
            .toThrow('PDF.js blob loading is capped');
        expect(firstTransport?.abort).not.toHaveBeenCalled();
        expect(firstTask?.destroy).not.toHaveBeenCalled();

        renderVersion = 2;
        const secondOpen = loader.open(new Blob(['second']), renderVersion);
        await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
        await pdfjsDocumentTeardownCoordinator.waitForIdle('');

        expect(firstTransport?.abort).toHaveBeenCalledOnce();
        expect(firstTask?.destroy).toHaveBeenCalledOnce();
        expect(mocks.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));

        const secondTask = pendingTasks[1]?.task;
        expect(secondTask).toBeDefined();

        renderVersion = 3;
        const thirdOpen = loader.open(createPathSource('/tmp/latest.pdf'), renderVersion);
        await vi.waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(3));
        await pdfjsDocumentTeardownCoordinator.waitForIdle('');

        expect(secondTask?.destroy).toHaveBeenCalledOnce();
        expect(mocks.revokeObjectURL).toHaveBeenCalledWith('blob:overlap');

        const latestOptions = mocks.getDocument.mock.calls[2]?.[0] as IPdfjsDocumentOptions;
        const latestTransport = latestOptions.range;
        const latestTask = pendingTasks[2]?.task;
        expect(latestTransport).toBeInstanceOf(mocks.MockPdfDataRangeTransport);
        expect(latestTransport).not.toBe(firstTransport);
        expect(latestTask).toBeDefined();

        loader.abortTransport('test cleanup');
        expect(latestTransport?.abort).toHaveBeenCalledOnce();
        loader.destroyLoadingTask('test cleanup rejected', 'test cleanup failed');
        await pdfjsDocumentTeardownCoordinator.waitForIdle('');
        expect(latestTask?.destroy).toHaveBeenCalledOnce();

        for (const pendingTask of pendingTasks) {
            pendingTask.resolve({});
        }
        await expect(Promise.all([
            firstOpen,
            secondOpen,
            thirdOpen,
        ])).resolves.toHaveLength(3);
    });

    it('cancels a pending range preload before the replacement is submitted', async () => {
        const pendingReads = Promise.withResolvers<Uint8Array>();
        mocks.documentFiles.readFileRange.mockReturnValue(pendingReads.promise);
        mocks.getDocument.mockReturnValue({
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({numPages: 1}),
        });

        const loader = createPdfjsDocumentSourceLoader({
            getRenderVersion: () => 1,
            onRangeReadFailure: mocks.onRangeReadFailure,
        });

        const firstOpen = loader.open(createPathSource('/tmp/pending.pdf'), 1);
        await vi.waitFor(() => expect(mocks.documentFiles.readFileRange).toHaveBeenCalledTimes(2));

        loader.cancelPendingOpen();
        await expect(loader.open(new Blob(['replacement']), 1)).resolves.toEqual({numPages: 1});
        await expect(firstOpen).resolves.toBeNull();
        expect(mocks.getDocument).toHaveBeenCalledOnce();
    });

    it('preserves native tail range offsets above the signed 32-bit boundary', async () => {
        const size = 3_000_000_000;
        const path = '/tmp/large-document.pdf';
        const tailStart = size - CHUNK_BYTES;
        const requestedStart = tailStart - CHUNK_BYTES;
        const requestedEnd = requestedStart + 4096;
        mocks.getDocument.mockReturnValue({
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({numPages: 1}),
        });

        const loader = createPdfjsDocumentSourceLoader({
            getRenderVersion: () => 1,
            onRangeReadFailure: mocks.onRangeReadFailure,
        });

        await expect(loader.open(createPathSource(path, size), 1)).resolves.toEqual({numPages: 1});

        expect(tailStart).toBeGreaterThan(2 ** 31);
        expect(mocks.documentFiles.readFileRange).toHaveBeenNthCalledWith(
            1,
            path,
            0,
            CHUNK_BYTES,
        );
        expect(mocks.documentFiles.readFileRange).toHaveBeenNthCalledWith(
            2,
            path,
            tailStart,
            CHUNK_BYTES,
        );

        const options = mocks.getDocument.mock.calls[0]?.[0] as IPdfjsDocumentOptions;
        const transport = options.range;
        expect(transport).toBeInstanceOf(mocks.MockPdfDataRangeTransport);
        expect(transport?.requestDataRange).not.toBeNull();

        transport?.requestDataRange?.(requestedStart, requestedEnd);
        await vi.waitFor(() => expect(transport?.onDataRange).toHaveBeenCalledWith(
            requestedStart,
            expect.any(Uint8Array),
        ));

        const [
            observedStart,
            observedData,
        ] = transport!.onDataRange.mock.calls[0] as [number, Uint8Array];
        expect(observedStart).toBe(requestedStart);
        expect(observedData.byteLength).toBe(requestedEnd - requestedStart);
        expect(mocks.documentFiles.readFileRange).toHaveBeenNthCalledWith(
            3,
            path,
            requestedStart,
            requestedEnd - requestedStart,
        );
    });

    it('keeps the loading task available for a range failure after initial loading', async () => {
        const rangeError = new Error('range read failed after initial loading');
        const task = {
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({numPages: 2}),
        };
        mocks.getDocument.mockReturnValue(task);
        mocks.documentFiles.readFileRange.mockImplementationOnce(async (
            _path: string,
            _offset: number,
            length: number,
        ) => new Uint8Array(length));
        mocks.documentFiles.readFileRange.mockRejectedValueOnce(rangeError);

        let loader!: ReturnType<typeof createPdfjsDocumentSourceLoader>;
        loader = createPdfjsDocumentSourceLoader({
            getRenderVersion: () => 1,
            onRangeReadFailure: () => {
                loader.destroyLoadingTask(
                    'test range failure cleanup rejected',
                    'test range failure cleanup failed',
                );
            },
        });

        await expect(loader.open(createPathSource('/tmp/range-failure.pdf'), 1)).resolves.toEqual({numPages: 2});

        const options = mocks.getDocument.mock.calls[0]?.[0] as IPdfjsDocumentOptions;
        options.range?.requestDataRange?.(CHUNK_BYTES, CHUNK_BYTES * 2);
        await vi.waitFor(() => expect(task.destroy).toHaveBeenCalledOnce());
        await pdfjsDocumentTeardownCoordinator.waitForIdle('');

        expect(task.destroy).toHaveBeenCalledOnce();
    });
});
