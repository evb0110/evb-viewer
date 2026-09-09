import type * as TViMockOriginalModule from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import type * as TViMockOriginalModule2 from '@app/utils/documentBytes';
import type * as TViMockOriginalModule3 from '@app/utils/platformDocuments';

import { requireDocumentRef } from '@contracts/documentRef';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import {
    EmbeddedShapeImportCapabilityError,
    importEmbeddedShapeAnnotationsFromPathInWorker,
    importEmbeddedShapeAnnotationsUsingWorker,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient';
import { readDocumentBytes } from '@app/utils/documentBytes';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_ANNOTATION_OPERATION_FAILED',
    occurredAt: 1,
    severity: 'error',
};
const failureReporter = {capture: vi.fn(() => failureReceipt)};

vi.mock('@app/utils/failureReporter', () => ({
    detectRendererDiagnosticsHost: () => 'hosted-browser',
    getRendererFailureReporter: () => failureReporter,
    initializeRendererFailureReporter: () => failureReporter,
}));

const documentMocks = vi.hoisted(() => ({
    readFileRange: vi.fn(),
    statFile: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    importEmbeddedShapeAnnotations: vi.fn(),
}));
vi.mock('@app/utils/documentBytes', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    readDocumentBytes: vi.fn(),
}));
vi.mock('@app/utils/platformDocuments', async (importOriginal_2) => ({
    ...(await importOriginal_2<typeof TViMockOriginalModule3>()),
    getDocumentFilesCapability: () => documentMocks,
}));

describe('importEmbeddedShapeAnnotationsUsingWorker', () => {
    beforeEach(() => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([]);
        documentMocks.readFileRange.mockReset();
        documentMocks.statFile.mockReset();
        vi.mocked(readDocumentBytes).mockReset();
        failureReporter.capture.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('falls back to the direct importer outside a browser worker runtime', async () => {
        const data = new Uint8Array([1]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(data)).resolves.toEqual([]);

        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledWith(data);
    });

    it('keeps the worker-unavailable browser path fallback explicitly bounded', async () => {
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        vi.mocked(readDocumentBytes).mockResolvedValue(bytes);

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('browser://documents/browser.pdf')))
            .resolves.toEqual([]);

        expect(readDocumentBytes).toHaveBeenCalledWith('browser://documents/browser.pdf', {maxBytes: EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES});
        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledWith(bytes);
    });

    it('refuses a native shape import when the desktop index bridge is missing', async () => {
        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('/tmp/native.pdf')))
            .rejects.toBeInstanceOf(EmbeddedShapeImportCapabilityError);

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('/tmp/native.pdf')))
            .rejects.toMatchObject({
                name: 'EmbeddedShapeImportCapabilityError',
                reason: 'native-index-capability-unavailable',
            });
        expect(readDocumentBytes).not.toHaveBeenCalled();
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('transfers an owned copy to a module worker without detaching session bytes', async () => {
        let postedData: Uint8Array | null = null;
        let postedTransfer: Transferable[] | undefined;
        const terminate = vi.fn();

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}, transfer?: Transferable[]) {
                postedData = message.data;
                postedTransfer = transfer;
                const event = { data: {
                    ok: true,
                    shapes: [],
                } } as MessageEvent;
                queueMicrotask(() => this.onmessage?.(event));
            }

            terminate() {
                terminate();
            }
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(data)).resolves.toEqual([]);

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
        expect(postedData).not.toBe(data);
        expect(postedData).toEqual(data);
        expect(postedTransfer).toEqual([postedData!.buffer]);
        expect(data.byteLength).toBe(3);
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('transfers a disposable path-read buffer without making another whole-file copy', async () => {
        let postedData: Uint8Array | null = null;
        let postedTransfer: Transferable[] | undefined;

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}, transfer?: Transferable[]) {
                postedData = message.data;
                postedTransfer = transfer;
                queueMicrotask(() => this.onmessage?.({data: {
                    ok: true,
                    shapes: [],
                }} as MessageEvent));
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const disposablePathRead = new Uint8Array([
            1,
            2,
            3,
        ]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(
            disposablePathRead,
            { transferOwnership: true },
        )).resolves.toEqual([]);

        expect(postedData).toBe(disposablePathRead);
        expect(postedTransfer).toEqual([disposablePathRead.buffer]);
    });

    it('copies a disposable subarray before transfer so unrelated backing bytes stay owned', async () => {
        let postedData: Uint8Array | null = null;

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}) {
                postedData = message.data;
                queueMicrotask(() => this.onmessage?.({data: {
                    ok: true,
                    shapes: [],
                }} as MessageEvent));
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const backing = new Uint8Array([
            9,
            1,
            2,
            3,
            8,
        ]);
        const subarray = backing.subarray(1, 4);

        await importEmbeddedShapeAnnotationsUsingWorker(subarray, {transferOwnership: true});

        expect(postedData).not.toBe(subarray);
        expect(postedData).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
        expect(postedData!.buffer).not.toBe(backing.buffer);
    });

    it('terminates the worker when request dispatch fails synchronously', async () => {
        const terminate = vi.fn();

        class RejectingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage() {
                throw new Error('Worker request could not be cloned');
            }

            terminate() {
                terminate();
            }
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', RejectingWorker);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(new Uint8Array([1])))
            .rejects.toThrow('Worker request could not be cloned');

        expect(terminate).toHaveBeenCalledOnce();
    });

    it('streams path-backed PDFs to the worker in bounded chunks', async () => {
        const posted: Array<{
            message: Record<string, unknown>;
            transfer?: Transferable[]
        }> = [];
        const documentSize = 5 * 1024 * 1024;
        documentMocks.statFile.mockResolvedValue({size: documentSize});
        documentMocks.readFileRange.mockImplementation(async (_path, _offset, length) => new Uint8Array(length));

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
                posted.push(transfer ? {
                    message,
                    transfer,
                } : {message});
                if (message.type === 'path-finish') {
                    queueMicrotask(() => this.onmessage?.({data: {
                        ok: true,
                        shapes: [],
                    }} as MessageEvent));
                }
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('browser://documents/large.pdf'))).resolves.toEqual([]);

        expect(documentMocks.readFileRange).toHaveBeenNthCalledWith(1, 'browser://documents/large.pdf', 0, 4 * 1024 * 1024);
        expect(documentMocks.readFileRange).toHaveBeenNthCalledWith(2, 'browser://documents/large.pdf', 4 * 1024 * 1024, 1024 * 1024);
        expect(posted.map(entry => entry.message.type)).toEqual([
            'path-start',
            'path-chunk',
            'path-chunk',
            'path-finish',
        ]);
    });

    it('stops path streaming when the worker deadline expires during a range read', async () => {
        vi.useFakeTimers();
        let finishRangeRead!: (data: Uint8Array) => void;
        const pendingRangeRead = new Promise<Uint8Array>((resolve) => {
            finishRangeRead = resolve;
        });
        documentMocks.statFile.mockResolvedValue({size: 5 * 1024 * 1024});
        documentMocks.readFileRange.mockReturnValue(pendingRangeRead);
        const postedTypes: unknown[] = [];
        const terminate = vi.fn();

        class PendingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>) {
                postedTypes.push(message.type);
            }

            terminate() {
                terminate();
            }
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', PendingWorker);

        const importPromise = importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('browser://documents/slow.pdf'));
        const timeoutExpectation = expect(importPromise)
            .rejects.toThrow('Embedded PDF shape import worker timed out');
        await vi.waitFor(() => expect(documentMocks.readFileRange).toHaveBeenCalledOnce());

        await vi.advanceTimersByTimeAsync(90_000);
        await timeoutExpectation;

        finishRangeRead(new Uint8Array(4 * 1024 * 1024));
        await vi.runAllTimersAsync();
        await Promise.resolve();

        expect(documentMocks.readFileRange).toHaveBeenCalledOnce();
        expect(postedTypes).toEqual(['path-start']);
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('refuses an oversized document before any worker work starts', async () => {
        const documentSize = 96 * 1024 * 1024 + 1;
        documentMocks.statFile.mockResolvedValue({size: documentSize});
        documentMocks.readFileRange.mockImplementation(async (_path, _offset, length) => new Uint8Array(length));
        const postedTypes: unknown[] = [];

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>) {
                postedTypes.push(message.type);
                if (message.type === 'path-finish') {
                    queueMicrotask(() => this.onmessage?.({data: {
                        ok: true,
                        shapes: [],
                    }} as MessageEvent));
                }
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker(requireDocumentRef('browser://documents/oversized.pdf')))
            .rejects.toThrow(RangeError);
        await expect(importEmbeddedShapeAnnotationsUsingWorker(new Uint8Array(documentSize)))
            .rejects.toThrow(RangeError);

        expect(postedTypes).toEqual([]);
        expect(documentMocks.readFileRange).not.toHaveBeenCalled();
    });

    it('terminates superseded worker parsing immediately', async () => {
        const terminate = vi.fn();
        const postMessage = vi.fn();
        class PendingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            postMessage() { postMessage(); }
            terminate() { terminate(); }
        }
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', PendingWorker);
        const controller = new AbortController();
        const importPromise = importEmbeddedShapeAnnotationsUsingWorker(
            new Uint8Array([1]),
            { signal: controller.signal },
        );

        controller.abort(new DOMException('Superseded source', 'AbortError'));

        await expect(importPromise).rejects.toMatchObject({name: 'AbortError'});
        await Promise.resolve();
        expect(terminate).toHaveBeenCalledOnce();
        expect(postMessage).not.toHaveBeenCalled();
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('owns an unexpected worker failure and carries one receipt through rejection', async () => {
        class FailingWorker {
            public static lastInstance: FailingWorker | null = null;
            public onmessage: ((event: MessageEvent) => void) | null = null;
            public onerror: ((event: ErrorEvent) => void) | null = null;

            public constructor() {
                FailingWorker.lastInstance = this;
            }

            public postMessage() {}

            public terminate() {}
        }
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FailingWorker);

        const importPromise = importEmbeddedShapeAnnotationsUsingWorker(new Uint8Array([1]));
        FailingWorker.lastInstance?.onerror?.({message: 'shape worker crashed'} as ErrorEvent);
        const error = await importPromise.then(
            () => { throw new Error('Expected a worker failure'); },
            value => {
                if (!(value instanceof Error)) {
                    throw new Error('Expected a worker failure');
                }
                return value as Error & {failure?: unknown};
            },
        );

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledWith(
            expect.objectContaining({local: expect.objectContaining({source: 'embedded-shape-annotations-worker-parent'})}),
            {runtime: 'browser-worker-parent'},
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });
});
