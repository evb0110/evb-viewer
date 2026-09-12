import type { Ref } from 'vue';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TSplitPayload } from '@contracts/windowTabs';
import { BrowserLogger } from '@app/utils/browserLogger';
import { createWorkingCopySnapshotFromData } from '@app/services/pdf-file/createWorkingCopySnapshotFromData';
import { readDocumentBytes } from '@app/utils/documentBytes';
import type {
    IWorkspaceDocumentViewerSplitPort,
    IWorkspacePdfViewerSplitPort,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TPdfSource } from '@app/types/pdfUi';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';
import {
    isNativeDocumentRef,
    resolveDocumentRefBackend,
} from '@app/utils/documentRef';
import {
    getWorkspaceViewerAdapter,
    resolveWorkspaceViewerAdapter,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import { retainDocumentOpenWorkingCopyForRetry } from '@app/modules/workspace-shell/composables/document-session/createDocumentOpenFlow';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import { isPathPdfSource } from '@app/modules/pdf-viewer/public/nativePreviewRouting';
import {
    consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError,
    type INativePdfSaveTransactionOptions,
} from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';

interface IUseWorkspaceSplitPayloadOptions {
    readonly [key: string]: unknown;
    pdfSrc: Ref<TPdfSource | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
    hasPendingTabChanges: Ref<boolean>;
    requiresSaveAsOnFirstSave: Ref<boolean>;
    pdfViewerRef: Ref<IWorkspacePdfViewerSplitPort | null>;
    documentViewerRef: Ref<IWorkspaceDocumentViewerSplitPort | null>;
    pdfData: Ref<Uint8Array | null>;
    openFileWithViewerLifecycle: (result: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    getNativeSaveTransactionOptions?: () => INativePdfSaveTransactionOptions;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

type TPdfSnapshotSplitPayload = Extract<TSplitPayload, { kind: 'pdfSnapshot' }>;
const PDF_VIEWER_ADAPTER = getWorkspaceViewerAdapter('pdf');
const DJVU_VIEWER_ADAPTER = getWorkspaceViewerAdapter('djvu');

function isDjvuSplitPayload(payload: TSplitPayload): payload is Extract<TSplitPayload, {kind: 'djvu'}> {
    return DJVU_VIEWER_ADAPTER.capabilities.sidebar
        && DJVU_VIEWER_ADAPTER.documentTypes.includes('djvu')
        && payload.kind === 'djvu';
}

function isPdfSplitPayload(payload: TSplitPayload): payload is TPdfSnapshotSplitPayload {
    return PDF_VIEWER_ADAPTER.capabilities.pdfDocument
        && PDF_VIEWER_ADAPTER.documentTypes.includes('pdf')
        && payload.kind === 'pdfSnapshot';
}

function normalizeSplitPayloadPage(page: number | undefined) {
    if (typeof page !== 'number' || !Number.isFinite(page)) {
        return null;
    }

    return Math.max(1, Math.floor(page));
}

function normalizeSplitPayloadTotalPages(total: number | undefined, fallbackPage: number) {
    if (typeof total !== 'number' || !Number.isFinite(total)) {
        return fallbackPage;
    }

    return Math.max(fallbackPage, Math.floor(total));
}

export const useWorkspaceSplitPayload = (options: IUseWorkspaceSplitPayloadOptions) => {
    const runWithDocumentOperationLease = options.runWithDocumentOperationLease
        ?? runWithoutDocumentOperationLease;

    function isPathBackedDesktopSnapshot() {
        const sourcePath = options.workingCopyPath.value;
        const source = options.pdfSrc.value;
        return Boolean(
            isPathPdfSource(source)
            && sourcePath
            && source.path === sourcePath
            && isNativeDocumentRef(sourcePath),
        );
    }

    function createPdfSnapshotPayload(snapshotPath: TDocumentRef, isDirty: boolean): TPdfSnapshotSplitPayload {
        const normalizedCurrentPage = normalizeSplitPayloadPage(options.currentPage.value) ?? 1;
        const originalBackend = resolveDocumentRefBackend(options.originalPath.value);
        const snapshotBackend = resolveDocumentRefBackend(snapshotPath);
        return {
            kind: 'pdfSnapshot',
            fileName: options.fileName.value ?? 'document.pdf',
            originalPath: options.originalPath.value,
            ...(originalBackend === undefined ? {} : {originalBackend}),
            snapshotPath,
            ...(snapshotBackend === undefined ? {} : {snapshotBackend}),
            isDirty,
            ...(options.requiresSaveAsOnFirstSave.value ? {isGenerated: true} : {}),
            currentPage: normalizedCurrentPage,
            totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
        };
    }

    async function captureCleanWorkingCopySnapshot(): Promise<TPdfSnapshotSplitPayload | null> {
        if (!options.workingCopyPath.value || options.hasPendingTabChanges.value) {
            return null;
        }

        try {
            const snapshotPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromPath(
                options.workingCopyPath.value,
                options.originalPath.value ?? undefined,
            );
            return createPdfSnapshotPayload(snapshotPath, false);
        } catch (error) {
            BrowserLogger.warn('workspace', 'Failed to create split payload from working copy path', {
                path: options.workingCopyPath.value,
                error,
            });
            return null;
        }
    }

    async function resolvePdfSnapshotData() {
        return runWithDocumentOperationLease('split-capture', async () => {
            const workingCopyPath = options.workingCopyPath.value;
            if (isNativeDocumentRef(workingCopyPath) && !options.pdfData.value) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-capability',
                    detail: 'Renderer split serialization cannot read a native path-backed working copy',
                });
            }
            const viewerTransaction = await options.pdfViewerRef.value?.runSaveTransaction({
                mode: 'snapshot',
                saveFlowMode: 'save',
                forceWriterSave: false,
                requiresManagedShapeBaseline: true,
                ...(workingCopyPath ? {workingPath: workingCopyPath} : {}),
                ...(options.getNativeSaveTransactionOptions?.() ?? {}),
                source: {getSourcePdfData: async () => {
                    if (options.pdfData.value) {
                        return options.pdfData.value;
                    }
                    return workingCopyPath ? readDocumentBytes(workingCopyPath) : null;
                }},
            });
            if (
                viewerTransaction?.nativeMutationProjection
                && workingCopyPath
                && options.documentRevisionToken?.value !== null
                && options.documentRevisionToken?.value !== undefined
            ) {
                const snapshotPath = await consumeNativePdfMutationProjection({
                    workingPath: workingCopyPath,
                    expectedDocumentRevisionToken: options.documentRevisionToken.value,
                    projection: viewerTransaction.nativeMutationProjection,
                    operation: 'clone',
                    originalPath: options.originalPath.value,
                    ...(viewerTransaction.verifyAnnotationSavePath
                        ? {verifyPathBeforeExpose: viewerTransaction.verifyAnnotationSavePath}
                        : {}),
                    ...(viewerTransaction.assertAnnotationSaveCurrent
                        ? {assertBeforeExpose: viewerTransaction.assertAnnotationSaveCurrent}
                        : {}),
                });
                if (snapshotPath) {
                    return readDocumentBytes(snapshotPath);
                }
            }
            if (options.pdfData.value) {
                return options.pdfData.value;
            }

            if (!workingCopyPath) {
                return null;
            }

            try {
                return await readDocumentBytes(workingCopyPath);
            } catch (error) {
                BrowserLogger.warn('workspace', 'Failed to read working copy for split payload', {
                    path: workingCopyPath,
                    error,
                });
                return null;
            }
        });
    }

    async function resolveNativePdfSnapshotPath(sourcePath: TDocumentRef) {
        return runWithDocumentOperationLease('split-capture', async () => {
            const expectedDocumentRevisionToken = options.documentRevisionToken?.value ?? null;
            const viewerTransaction = await options.pdfViewerRef.value?.runSaveTransaction({
                mode: 'snapshot',
                saveFlowMode: 'save',
                forceWriterSave: false,
                workingPath: sourcePath,
                ...(options.getNativeSaveTransactionOptions?.() ?? {}),
            });
            if (!viewerTransaction) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-projection',
                    detail: 'Native PDF split staging is unavailable',
                });
            }
            if (viewerTransaction.nativeRequiredFailure) {
                throw new NativePdfSaveRequiredError(viewerTransaction.nativeRequiredFailure);
            }
            if (!viewerTransaction.nativeMutationProjection) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-projection',
                    detail: 'Native PDF split staging did not produce a replayable mutation',
                });
            }
            if (expectedDocumentRevisionToken === null) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-capability',
                    detail: 'Native PDF split staging requires the document revision',
                });
            }
            await viewerTransaction.assertAnnotationSaveCurrent?.();
            return consumeNativePdfMutationProjection({
                workingPath: sourcePath,
                expectedDocumentRevisionToken,
                projection: viewerTransaction.nativeMutationProjection,
                operation: 'clone',
                originalPath: options.originalPath.value,
                ...(viewerTransaction.verifyAnnotationSavePath
                    ? {verifyPathBeforeExpose: viewerTransaction.verifyAnnotationSavePath}
                    : {}),
                ...(viewerTransaction.assertAnnotationSaveCurrent
                    ? {assertBeforeExpose: viewerTransaction.assertAnnotationSaveCurrent}
                    : {}),
            });
        });
    }

    async function capturePdfSnapshotPayload(): Promise<TSplitPayload> {
        const cleanWorkingCopySnapshot = await captureCleanWorkingCopySnapshot();
        if (cleanWorkingCopySnapshot) {
            return cleanWorkingCopySnapshot;
        }

        if (isPathBackedDesktopSnapshot()) {
            const sourcePath = options.workingCopyPath.value;
            if (!sourcePath) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-capability',
                    detail: 'Native PDF split staging requires the working-copy path',
                });
            }
            const snapshotPath = await resolveNativePdfSnapshotPath(sourcePath);
            if (!snapshotPath) {
                throw new NativePdfSaveRequiredError({
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'native-error',
                    detail: 'Native PDF split staging did not return a working copy',
                });
            }
            return createPdfSnapshotPayload(snapshotPath, true);
        }

        const snapshot = await resolvePdfSnapshotData();
        if (!snapshot) {
            return { kind: 'empty' };
        }

        const sourcePath = options.workingCopyPath.value;
        const snapshotPath = await createWorkingCopySnapshotFromData({
            fileName: options.fileName.value ?? 'document.pdf',
            data: snapshot,
            ...(sourcePath ? {sourcePath} : {}),
            originalPath: options.originalPath.value ?? undefined,
            files: getDocumentFilesCapability(),
            workingCopies: getDocumentWorkingCopyCapability(),
        });
        return createPdfSnapshotPayload(snapshotPath, options.hasPendingTabChanges.value);
    }

    async function captureSplitPayload(): Promise<TSplitPayload> {
        const activeViewerAdapter = resolveWorkspaceViewerAdapter({
            djvuSourcePath: options.djvuSourcePath.value,
            isDjvuMode: options.isDjvuMode.value,
            pdfSourcePath: isPathPdfSource(options.pdfSrc.value)
                ? options.pdfSrc.value.path
                : options.pdfSrc.value
                    ? parseDocumentRef('browser://documents/in-memory-pdf')
                    : null,
            shouldUseNativePdf: false,
        });
        // DjVu check must precede pdfSrc guard: DjVu mode has pdfSrc=null.
        if (activeViewerAdapter === DJVU_VIEWER_ADAPTER && activeViewerAdapter.capabilities.sidebar && options.djvuSourcePath.value) {
            const normalizedCurrentPage = normalizeSplitPayloadPage(
                options.documentViewerRef.value?.getCurrentPage?.() ?? options.currentPage.value,
            ) ?? 1;
            const sourceBackend = resolveDocumentRefBackend(options.djvuSourcePath.value);
            return {
                kind: 'djvu',
                sourcePath: options.djvuSourcePath.value,
                ...(sourceBackend === undefined ? {} : {sourceBackend}),
                currentPage: normalizedCurrentPage,
                totalPages: normalizeSplitPayloadTotalPages(options.totalPages.value, normalizedCurrentPage),
            };
        }

        if (!options.pdfSrc.value) {
            return { kind: 'empty' };
        }

        return capturePdfSnapshotPayload();
    }

    async function restoreSplitPayload(payload: TSplitPayload): Promise<TDocumentOpenOutcome> {
        if (payload.kind === 'empty') {
            return {status: 'cancelled'};
        }

        if (isDjvuSplitPayload(payload) && DJVU_VIEWER_ADAPTER.capabilities.sidebar) {
            const pageToRestore = normalizeSplitPayloadPage(payload.currentPage);
            if (pageToRestore) {
                options.currentPage.value = pageToRestore;
            }
            if (payload.totalPages && Number.isFinite(payload.totalPages)) {
                options.totalPages.value = Math.max(
                    options.totalPages.value,
                    Math.floor(payload.totalPages),
                    pageToRestore ?? 1,
                );
            }
            const outcome = await options.openFileWithViewerLifecycle({
                kind: 'djvu',
                workingPath: '',
                originalPath: payload.sourcePath,
            });
            if (outcome.status !== 'opened') {
                return outcome;
            }
            if (pageToRestore) {
                await nextTick();
                options.documentViewerRef.value?.scrollToPage(pageToRestore);
            }
            return outcome;
        }

        if (!isPdfSplitPayload(payload) || !PDF_VIEWER_ADAPTER.capabilities.pdfDocument) {
            return {status: 'cancelled'};
        }
        const pageToRestore = normalizeSplitPayloadPage(payload.currentPage);
        if (payload.totalPages && Number.isFinite(payload.totalPages)) {
            options.totalPages.value = Math.max(options.totalPages.value, Math.floor(payload.totalPages));
        }
        const restorePagePromise = pageToRestore && pageToRestore > 1
            ? options.waitForPdfReload(pageToRestore).catch((error) => {
                const restorePageError: unknown = error;
                BrowserLogger.debug('workspace', 'Split payload page restore wait failed', {
                    pageToRestore,
                    error: restorePageError,
                });
            })
            : null;

        const result: TOpenFileResult = {
            kind: 'pdf',
            workingPath: payload.snapshotPath,
            originalPath: payload.originalPath ?? payload.snapshotPath,
            ...(payload.isGenerated ? {isGenerated: true} : {}),
            ...(payload.isDirty ? {recoveryDirtyBaseline: true} : {}),
        };
        retainDocumentOpenWorkingCopyForRetry(result);
        const outcome = await options.openFileWithViewerLifecycle(result);
        if (outcome.status !== 'opened') {
            return outcome;
        }
        options.originalPath.value = payload.originalPath;

        if (restorePagePromise) {
            await restorePagePromise;
        }
        return outcome;
    }

    return {
        captureSplitPayload,
        restoreSplitPayload,
    };
};
