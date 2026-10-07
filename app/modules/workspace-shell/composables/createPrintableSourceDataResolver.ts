import type { Ref } from 'vue';
import { NativePdfSaveRequiredError } from '@app/modules/pdf-viewer/public';
import { getDocumentWorkingCopyCapability } from '@app/utils/platformDocuments';
import type { INativePdfSaveTransactionOptions } from '@app/modules/workspace-shell/composables/consumeNativePdfMutationProjection';
import type {
    IPdfViewerNativeMaterializationRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { consumeNativePdfMutationProjection } from '@app/modules/workspace-shell/composables/consumeNativePdfMutationProjection';

interface IPrintSaveViewer {runSaveTransaction(request: IPdfViewerNativeMaterializationRequest): Promise<IPdfViewerSaveTransactionResult>;}

interface ICreatePrintableSourceDataResolverDeps {
    hasPendingUnsavedChanges: Readonly<Ref<boolean>>;
    pdfViewerRef: Readonly<Ref<IPrintSaveViewer | null>>;
    save: {
        getSourcePdfData: () => Promise<Uint8Array | null>;
        getNativeSaveTransactionOptions: () => INativePdfSaveTransactionOptions;
    };
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
        return deps.save.getSourcePdfData();
    }

    async function materializeDirtyPrintableBytes() {
        const viewer = deps.pdfViewerRef.value;
        const workingCopyPath = deps.workingCopyPath.value;
        const expectedDocumentRevisionToken = deps.documentRevisionToken.value;
        if (!viewer || !workingCopyPath || !expectedDocumentRevisionToken) return null;
        const printTransaction = await viewer.runSaveTransaction({
            mode: 'print',
            saveFlowMode: 'save',
            ...deps.save.getNativeSaveTransactionOptions(),
            includeManagedShapes: true,
            rewriteShapeState: true,
            source: {getSourcePdfData: deps.save.getSourcePdfData},
        });
        if (printTransaction.verifiedUnchangedWorkingCopy) {
            await printTransaction.assertAnnotationSaveCurrent?.();
            const bytes = await readDocumentBytes(workingCopyPath);
            await printTransaction.assertAnnotationSaveCurrent?.();
            return bytes;
        }
        if (printTransaction.nativeRequiredFailure) throw new NativePdfSaveRequiredError(printTransaction.nativeRequiredFailure);
        if (!printTransaction.nativeMutationProjection) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'missing-native-projection',
            });
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
        if (!snapshotRef) return null;
        try {
            const bytes = await readDocumentBytes(snapshotRef);
            await printTransaction.assertAnnotationSaveCurrent?.();
            return bytes;
        } finally {
            await getDocumentWorkingCopyCapability().cleanupFile(snapshotRef);
        }
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
