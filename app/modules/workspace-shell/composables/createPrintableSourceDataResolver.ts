import type { Ref } from 'vue';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { consumeNativePdfMutationProjection } from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';

interface IPrintSaveViewer {runSaveTransaction(request: IPdfViewerSaveTransactionRequest): Promise<IPdfViewerSaveTransactionResult>;}

interface ICreatePrintableSourceDataResolverDeps {
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    pdfData: Readonly<Ref<Uint8Array | null>>;
    pdfViewerRef: Readonly<Ref<IPrintSaveViewer | null>>;
    source: NonNullable<IPdfViewerSaveTransactionRequest['source']>;
    workingCopyPath: Readonly<Ref<TDocumentRef | null>>;
    originalPath: Readonly<Ref<TDocumentRef | null>>;
    documentRevisionToken: Readonly<Ref<TDocumentRevisionToken | null>>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

/**
 * Dirty printing materializes the live annotation frontier through the same
 * viewer save transaction the persistence paths use, so it must serialize on
 * the document operation lease as well. Without the lease a print transaction
 * can interleave with a save, a page mutation, or a close, and two frontiers
 * can pass the same annotation CAS across one acknowledgement.
 */
export function createPrintableSourceDataResolver(deps: ICreatePrintableSourceDataResolverDeps) {
    const runWithDocumentOperationLease = deps.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;

    async function readPersistedPrintableBytes() {
        return deps.pdfData.value ?? await deps.source.getSourcePdfData();
    }

    async function materializeDirtyPrintableBytes() {
        const printTransaction = await deps.pdfViewerRef.value?.runSaveTransaction({
            mode: 'print',
            forceWriterSave: true,
            requiresManagedShapeBaseline: true,
            includeManagedShapes: true,
            rewriteShapeState: true,
            source: deps.source,
        });
        const workingCopyPath = deps.workingCopyPath.value;
        const expectedDocumentRevisionToken = deps.documentRevisionToken.value;
        if (!printTransaction?.nativeMutationProjection || !workingCopyPath || !expectedDocumentRevisionToken) {
            return readPersistedPrintableBytes();
        }
        // Print never acknowledges the frontier: the document stays dirty and
        // the clone is a detached snapshot handed to the print pipeline. The
        // transaction returns a projection rather than bytes, so staging it is
        // the only way to print what the user currently sees.
        const snapshotRef = await consumeNativePdfMutationProjection({
            workingPath: workingCopyPath,
            expectedDocumentRevisionToken,
            projection: printTransaction.nativeMutationProjection,
            operation: 'clone',
            originalPath: deps.originalPath.value,
            ...(printTransaction.verifyAnnotationSavePath
                ? {verifyPathBeforeExpose: printTransaction.verifyAnnotationSavePath}
                : {}),
            ...(printTransaction.assertAnnotationSaveCurrent
                ? {assertBeforeExpose: printTransaction.assertAnnotationSaveCurrent}
                : {}),
        });
        return snapshotRef ? readDocumentBytes(snapshotRef) : readPersistedPrintableBytes();
    }

    return async function getPrintableSourceData(options?: {signal?: AbortSignal}) {
        if (!deps.hasPendingUnsavedChanges.value) {
            return readPersistedPrintableBytes();
        }
        if (options?.signal?.aborted) {
            return null;
        }

        return runWithDocumentOperationLease('print-materialize', async () => {
            if (options?.signal?.aborted) {
                return null;
            }
            if (!deps.hasPendingUnsavedChanges.value) {
                // A save, page mutation, or shutdown flush that owned the lease
                // first already persisted this frontier while print waited.
                return readPersistedPrintableBytes();
            }

            return materializeDirtyPrintableBytes();
        });
    };
}
