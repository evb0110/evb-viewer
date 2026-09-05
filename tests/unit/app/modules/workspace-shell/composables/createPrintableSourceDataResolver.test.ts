import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import { requireDocumentRevisionToken } from '@contracts';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { AnnotationApplication } from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { asAnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { usePdfViewerSaveTransaction } from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import { createPrintableSourceDataResolver } from '@app/modules/workspace-shell/composables/createPrintableSourceDataResolver';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { TEST_PDF_SAVE_BYTE_ROUTE_DECISION } from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';

const PRINT_FRONTIER_REVISION = requireDocumentRevisionToken('print-frontier-revision');

interface IPrintTestViewer {runSaveTransaction(request: IPdfViewerSaveTransactionRequest): Promise<IPdfViewerSaveTransactionResult>;}

function createTransactionResult(
    finalBytes: Uint8Array,
    callbacks: Partial<IPdfViewerSaveTransactionResult> = {},
): IPdfViewerSaveTransactionResult {
    return {
        source: 'serialized-rewrite',
        baseBytes: null,
        serializedBytes: null,
        serializedResult: {
            finalBytes,
            saveMode: 'rewrite',
            source: 'serialized-rewrite',
            changedObjectRefs: [],
        },
        nativeMutationProjection: null,
        fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
        annotationSavePlan: TEST_PDF_SAVE_BYTE_ROUTE_DECISION.annotationPlan,
        ...callbacks,
    };
}

async function flushPendingWork() {
    for (let tick = 0; tick < 8; tick += 1) {
        await Promise.resolve();
    }
}

function createResolverHarness(options: {
    dirty?: boolean;
    pdfData?: Uint8Array | null;
    sourceBytes?: Uint8Array | null;
    viewer?: IPrintTestViewer | null;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
} = {}) {
    const hasPendingUnsavedChanges = ref(options.dirty ?? true);
    const pdfData = shallowRef<Uint8Array | null>(options.pdfData ?? null);
    const pdfViewerRef = shallowRef<IPrintTestViewer | null>(options.viewer ?? null);
    const getSourcePdfData = vi.fn(async () => options.sourceBytes ?? Uint8Array.of(4, 4));
    const serializePdfForSave = vi.fn(async (data: Uint8Array) => data);
    const getPrintableSourceData = createPrintableSourceDataResolver({
        hasPendingUnsavedChanges,
        pdfData,
        pdfViewerRef,
        source: {
            getSourcePdfData,
            serializePdfForSave,
        },
        ...(options.runWithDocumentOperationLease
            ? {runWithDocumentOperationLease: options.runWithDocumentOperationLease}
            : {}),
    });

    return {
        getPrintableSourceData,
        hasPendingUnsavedChanges,
        pdfData,
        pdfViewerRef,
        getSourcePdfData,
        serializePdfForSave,
    };
}

describe('createPrintableSourceDataResolver', () => {
    it('prints loaded bytes without a transaction or a lease when the document is clean', async () => {
        const leaseKinds: TDocumentOperationKind[] = [];
        const runSaveTransaction = vi.fn(async () => createTransactionResult(Uint8Array.of(1)));
        const harness = createResolverHarness({
            dirty: false,
            pdfData: Uint8Array.of(7, 7, 7),
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: async (kind, operation) => {
                leaseKinds.push(kind);
                return operation();
            },
        });

        await expect(harness.getPrintableSourceData()).resolves.toEqual(Uint8Array.of(7, 7, 7));

        expect(runSaveTransaction).not.toHaveBeenCalled();
        expect(harness.getSourcePdfData).not.toHaveBeenCalled();
        expect(leaseKinds).toEqual([]);
    });

    it('reads the source when a clean document has no loaded bytes', async () => {
        const harness = createResolverHarness({
            dirty: false,
            pdfData: null,
            sourceBytes: Uint8Array.of(5, 5),
        });

        await expect(harness.getPrintableSourceData()).resolves.toEqual(Uint8Array.of(5, 5));
        expect(harness.getSourcePdfData).toHaveBeenCalledTimes(1);
    });

    it('materializes a dirty document under the document operation lease without acknowledging the frontier', async () => {
        const leaseKinds: TDocumentOperationKind[] = [];
        const commitAnnotationSave = vi.fn();
        const runSaveTransaction = vi.fn(async () => createTransactionResult(
            Uint8Array.of(3, 2, 1),
            {commitAnnotationSave},
        ));
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: async (kind, operation) => {
                leaseKinds.push(kind);
                return operation();
            },
        });

        await expect(harness.getPrintableSourceData()).resolves.toEqual(Uint8Array.of(3, 2, 1));

        expect(leaseKinds).toEqual(['print-materialize']);
        expect(runSaveTransaction).toHaveBeenCalledWith({
            mode: 'print',
            forceWriterSave: true,
            serializeResult: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
            source: {
                getSourcePdfData: harness.getSourcePdfData,
                serializePdfForSave: harness.serializePdfForSave,
            },
        });
        expect(commitAnnotationSave).not.toHaveBeenCalled();
        expect(harness.hasPendingUnsavedChanges.value).toBe(true);
    });

    it('holds the print transaction until an in-flight save acknowledges its own frontier', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const events: string[] = [];
        const saveAcknowledged = Promise.withResolvers<undefined>();
        const runSaveTransaction = vi.fn(async () => {
            events.push('print-transaction-start');
            return createTransactionResult(Uint8Array.of(9));
        });
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const save = controller.operationLease.runExclusive('save', async () => {
            events.push('save-transaction-start');
            await saveAcknowledged.promise;
            events.push('save-acknowledged');
        });
        const print = harness.getPrintableSourceData();

        await flushPendingWork();
        expect(runSaveTransaction).not.toHaveBeenCalled();
        expect(controller.operationLease.isBusy.value).toBe(true);

        saveAcknowledged.resolve(undefined);
        await save;
        await expect(print).resolves.toEqual(Uint8Array.of(9));

        expect(events).toEqual([
            'save-transaction-start',
            'save-acknowledged',
            'print-transaction-start',
        ]);
        expect(controller.operationLease.isBusy.value).toBe(false);
    });

    it('blocks a queued page mutation until the print materialization finishes', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const events: string[] = [];
        const printMaterialized = Promise.withResolvers<undefined>();
        const runSaveTransaction = vi.fn(async () => {
            events.push('print-transaction-start');
            await printMaterialized.promise;
            events.push('print-transaction-end');
            return createTransactionResult(Uint8Array.of(6));
        });
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const print = harness.getPrintableSourceData();
        await flushPendingWork();
        const pageMutation = controller.operationLease.runExclusive('page-operation', async () => {
            events.push('page-mutation');
        });

        await flushPendingWork();
        expect(events).toEqual(['print-transaction-start']);
        // The close and document-switch gates poll this flag, so a print that
        // holds the lease also holds off teardown.
        expect(controller.operationLease.isBusy.value).toBe(true);

        printMaterialized.resolve(undefined);
        await expect(print).resolves.toEqual(Uint8Array.of(6));
        await pageMutation;

        expect(events).toEqual([
            'print-transaction-start',
            'print-transaction-end',
            'page-mutation',
        ]);
    });

    it('skips a redundant materialization when a queued save already cleaned the document', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const saveCompleted = Promise.withResolvers<undefined>();
        const runSaveTransaction = vi.fn(async () => createTransactionResult(Uint8Array.of(1)));
        const harness = createResolverHarness({
            dirty: true,
            sourceBytes: Uint8Array.of(8, 8),
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const save = controller.operationLease.runExclusive('save', async () => {
            await saveCompleted.promise;
            harness.hasPendingUnsavedChanges.value = false;
        });
        const print = harness.getPrintableSourceData();

        await flushPendingWork();
        saveCompleted.resolve(undefined);
        await save;

        await expect(print).resolves.toEqual(Uint8Array.of(8, 8));
        expect(runSaveTransaction).not.toHaveBeenCalled();
    });

    it('falls back to persisted bytes when the viewer is gone by the time the lease is granted', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const closed = Promise.withResolvers<undefined>();
        const runSaveTransaction = vi.fn(async () => createTransactionResult(Uint8Array.of(1)));
        const harness = createResolverHarness({
            dirty: true,
            sourceBytes: Uint8Array.of(2, 2),
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const teardown = controller.operationLease.runExclusive('page-operation', async () => {
            await closed.promise;
            harness.pdfViewerRef.value = null;
        });
        const print = harness.getPrintableSourceData();

        await flushPendingWork();
        closed.resolve(undefined);
        await teardown;

        await expect(print).resolves.toEqual(Uint8Array.of(2, 2));
        expect(runSaveTransaction).not.toHaveBeenCalled();
    });

    it('never starts a transaction when the print was canceled before it asked for the lease', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const runSaveTransaction = vi.fn(async () => createTransactionResult(Uint8Array.of(1)));
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });
        const abortController = new AbortController();
        abortController.abort();

        await expect(harness.getPrintableSourceData({signal: abortController.signal})).resolves.toBeNull();

        expect(runSaveTransaction).not.toHaveBeenCalled();
        expect(controller.operationLease.isBusy.value).toBe(false);
    });

    it('drops a queued print materialization when the print is canceled while waiting for the lease', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const saveCompleted = Promise.withResolvers<undefined>();
        const runSaveTransaction = vi.fn(async () => createTransactionResult(Uint8Array.of(1)));
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });
        const abortController = new AbortController();

        const save = controller.operationLease.runExclusive('save', async () => {
            await saveCompleted.promise;
        });
        const print = harness.getPrintableSourceData({signal: abortController.signal});

        await flushPendingWork();
        abortController.abort();
        saveCompleted.resolve(undefined);
        await save;

        await expect(print).resolves.toBeNull();
        expect(runSaveTransaction).not.toHaveBeenCalled();
        expect(controller.operationLease.isBusy.value).toBe(false);
    });

    it('releases the lease when the print transaction fails and keeps the failure visible to the caller', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const transactionError = new Error('Print materialization failed');
        const runSaveTransaction = vi.fn(async () => {
            throw transactionError;
        });
        const harness = createResolverHarness({
            dirty: true,
            sourceBytes: Uint8Array.of(4),
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        await expect(harness.getPrintableSourceData()).rejects.toThrow('Print materialization failed');

        expect(controller.operationLease.isBusy.value).toBe(false);
        await expect(controller.operationLease.runExclusive('save', async () => 'save-ran')).resolves.toBe('save-ran');
    });

    it('runs one serialized transaction per repeated print', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const events: string[] = [];
        let printIndex = 0;
        const runSaveTransaction = vi.fn(async () => {
            printIndex += 1;
            const index = printIndex;
            events.push(`start-${index}`);
            await Promise.resolve();
            events.push(`end-${index}`);
            return createTransactionResult(Uint8Array.of(index));
        });
        const harness = createResolverHarness({
            dirty: true,
            viewer: {runSaveTransaction},
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const first = harness.getPrintableSourceData();
        const second = harness.getPrintableSourceData();

        await expect(first).resolves.toEqual(Uint8Array.of(1));
        await expect(second).resolves.toEqual(Uint8Array.of(2));
        expect(events).toEqual([
            'start-1',
            'end-1',
            'start-2',
            'end-2',
        ]);
        expect(controller.operationLease.isBusy.value).toBe(false);
    });
    // Issue #93 acceptance check 2: two real save transactions, one real
    // annotation frontier. Without the lease the print transaction captured a
    // second frontier while the save was still in flight, and both frontiers
    // passed `assertAnnotationSaveCurrent` across the single acknowledgement,
    // because the CAS baseline hashes `{id, revision, deleted, pageIndex}` and
    // `acknowledgeSave` only advances `persistedRevision`.
    it('opens the print frontier only after the in-flight save acknowledges, and materializes the acknowledged source', async () => {
        const controller = createWorkspaceDocumentController({tabId: 'tab-print'});
        const application = new AnnotationApplication('print-frontier-document');
        const note = application.store.createNote({
            kind: 'note',
            identity: {id: asAnnotationId('print-frontier-note')},
            pageIndex: 0,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'unsaved note the print must not race',
            position: {
                left: 0.1,
                top: 0.2,
                width: 0.01,
                height: 0.01,
            },
            color: '#ffcc00',
            open: false,
        });
        const unsavedSourceBytes = Uint8Array.of(1, 1, 1);
        const savedSourceBytes = Uint8Array.of(2, 2, 2);
        const documentBytes = shallowRef(unsavedSourceBytes);
        const events: string[] = [];
        const materializedPersistedRevisions: number[] = [];
        const {runSaveTransaction} = usePdfViewerSaveTransaction({
            annotationApplication: shallowRef(application),
            documentRevisionToken: computed(() => PRINT_FRONTIER_REVISION),
        });
        const runTransaction = vi.fn(async (request: IPdfViewerSaveTransactionRequest) => {
            events.push(`transaction-start:${request.mode}`);
            const result = await runSaveTransaction(request);
            events.push(`transaction-settled:${request.mode}`);
            return result;
        });
        // Page labels stay dirty once the save acknowledges the annotation
        // frontier, so the queued print still has to materialize.
        const pageLabelsDirty = ref(true);
        const getPrintableSourceData = createPrintableSourceDataResolver({
            hasPendingUnsavedChanges: computed(() => (
                application.store.hasChangesSinceSavedBaseline() || pageLabelsDirty.value
            )),
            pdfData: shallowRef(null),
            pdfViewerRef: shallowRef<IPrintTestViewer | null>({runSaveTransaction: runTransaction}),
            source: {
                getSourcePdfData: async () => documentBytes.value,
                serializePdfForSave: async (bytes: Uint8Array) => bytes,
            },
            runWithDocumentOperationLease: controller.operationLease.runExclusive,
        });

        const saveFrontierCaptured = Promise.withResolvers<undefined>();
        const durableWriteCompleted = Promise.withResolvers<undefined>();
        let openTransactionsAtAcknowledgement = 0;
        const save = controller.operationLease.runExclusive('save', async () => {
            const saveTransaction = await runTransaction({mode: 'persist'});
            saveFrontierCaptured.resolve(undefined);
            await durableWriteCompleted.promise;
            documentBytes.value = savedSourceBytes;
            await saveTransaction.assertAnnotationSaveCurrent?.();
            openTransactionsAtAcknowledgement = runTransaction.mock.calls.length;
            saveTransaction.commitAnnotationSave?.();
            events.push('save-acknowledged');
        });
        const print = getPrintableSourceData();

        // The save now holds an open frontier; flushing gives an unleased print
        // every chance to open a second one before the acknowledgement.
        await saveFrontierCaptured.promise;
        await flushPendingWork();
        expect(events).toEqual([
            'transaction-start:persist',
            'transaction-settled:persist',
        ]);
        expect(materializedPersistedRevisions).toEqual([]);
        expect(application.store.get(note.identity.id)).toMatchObject({persistedRevision: -1});

        durableWriteCompleted.resolve(undefined);
        await save;
        await expect(print).resolves.toEqual(savedSourceBytes);

        // Exactly one frontier was open while the save acknowledged.
        expect(openTransactionsAtAcknowledgement).toBe(1);
        expect(events).toEqual([
            'transaction-start:persist',
            'transaction-settled:persist',
            'save-acknowledged',
            'transaction-start:print',
            'transaction-settled:print',
        ]);
        // The print materialized the acknowledged frontier and the post-ack
        // source bytes, not the pre-acknowledgement snapshot the save owned.
        expect(materializedPersistedRevisions).toEqual([]);
        expect(application.store.get(note.identity.id)).toMatchObject({persistedRevision: 0});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(false);

        expect(runTransaction).toHaveBeenCalledTimes(2);
        expect(runTransaction.mock.calls[1]?.[0]).toMatchObject({
            mode: 'print',
            forceWriterSave: true,
            serializeResult: true,
        });
        // The print owns a post-acknowledgement frontier of its own.
        const printTransaction = await runTransaction.mock.results[1]?.value;
        await expect(printTransaction?.assertAnnotationSaveCurrent?.()).resolves.toBeUndefined();
        expect(controller.operationLease.isBusy.value).toBe(false);
    });
});
