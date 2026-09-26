import type {
    ComputedRef, Ref, ShallowRef,
} from 'vue';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
// eslint-disable-next-line import-classic/no-restricted-paths -- Share the PDF structural contract as a type only.
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    IPdfBookmarkEntry, IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import type {IScrollSnapshot} from '@app/types/pdfUi';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    createPdfSourceDataReader,
    createPdfReloadWaiter,
    resolvePdfReloadPage,
    type IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import type {IWorkspaceSaveDependencies} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import {useWorkspaceSaveService} from '@app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService';
import type {TWorkspaceFailureSurface} from '@app/modules/workspace-shell/composables/useWorkspaceFailureSurface';
import type {TDocumentOperationKind} from '@app/types/documentOperationKind';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {hasViewerShapeChanges} from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

type TPageSaveViewer = IPdfViewerExpose & {
    captureScrollSnapshot?: () => IScrollSnapshot | null;
    restoreScrollSnapshot?: (
        snapshot: IScrollSnapshot | null,
        options?: {fallbackPage?: number | null},
    ) => void;
};

interface IPageSaveOrchestrationDeps {
    pdfData: Ref<Uint8Array | null>;
    pdfDocument: ShallowRef<IPdfDocument | null>;
    pdfViewerRef: Ref<TPageSaveViewer | null>;
    openSurface?: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'> | undefined;
    workingCopyPath: Ref<TDocumentRef | null>;
    originalPath: Ref<TDocumentRef | null>;
    documentSessionKey: Ref<string | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    wasEncrypted?: NonNullable<IWorkspaceSaveDependencies['document']['wasEncrypted']>;
    unencryptedSaveNotice?: NonNullable<IWorkspaceSaveDependencies['unencryptedSaveNotice']>;
    totalPages: Ref<number>;
    pageLabelsDirty: Ref<boolean>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    bookmarksDirty: Ref<boolean>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    annotationDirty: Ref<boolean>;
    annotationNoteWindowsCount: Ref<number>;
    pendingEmbeddedAnnotationDeleteCount: Ref<number>;
    hasAnnotationChanges: () => boolean;
    markAnnotationSaved: () => void;
    getAnnotationSaveStateToken?: () => unknown;
    markPageLabelsSaved: () => void;
    getPageLabelsSaveStateToken?: () => unknown;
    markBookmarksSaved: () => void;
    getBookmarksSaveStateToken?: () => unknown;
    isDirty: Ref<boolean>;
    hasPendingUnsavedChanges?: ComputedRef<boolean>;
    validatePdfPath: IWorkspaceSaveDependencies['persistence']['validatePdfPath'];
    saveFile: IWorkspaceSaveDependencies['persistence']['saveSerialized'];
    repairWorkingCopy?: IWorkspaceSaveDependencies['persistence']['repairWorkingCopy'];
    optimizeWorkingCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopy'];
    optimizeWorkingCopyAsCopy?: IWorkspaceSaveDependencies['persistence']['optimizeWorkingCopyAsCopy'];
    saveWorkingCopy: IWorkspaceSaveDependencies['persistence']['saveWorkingCopy'];
    trySavePdfNativeMutations?: IWorkspaceSaveDependencies['persistence']['trySavePdfNativeMutations'];
    trySaveEmbeddedNoteTextUpdates?: IWorkspaceSaveDependencies['persistence']['trySaveEmbeddedNoteTextUpdates'];
    saveWorkingCopyAs: IWorkspaceSaveDependencies['persistence']['saveAs'];
    optimizePdfOnSaveAs?: Ref<boolean>;
    persistAllAnnotationNotes: () => Promise<boolean>;
    loadRecentFiles: () => void;
    currentPage: Ref<number>;
    resetSearchCache: () => void;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
    failureSurface?: TWorkspaceFailureSurface;
}

export const usePageSaveOrchestration = (deps: IPageSaveOrchestrationDeps) => {
    const {t} = useTypedI18n();
    const getSourcePdfData = createPdfSourceDataReader({
        pdfData: deps.pdfData,
        workingCopyPath: deps.workingCopyPath,
        documentRevisionToken: deps.documentRevisionToken,
    });
    const saveDependencies: IWorkspaceSaveDependencies = {
        status: {
            isSaving: deps.isSaving,
            isSavingAs: deps.isSavingAs,
        },
        document: {
            sessionKey: deps.documentSessionKey,
            workingCopyPath: deps.workingCopyPath,
            originalPath: deps.originalPath,
            revisionToken: deps.documentRevisionToken,
            ...(deps.wasEncrypted ? {wasEncrypted: deps.wasEncrypted} : {}),
        },
        ...(deps.unencryptedSaveNotice ? {unencryptedSaveNotice: deps.unencryptedSaveNotice} : {}),
        ...(deps.hasPendingUnsavedChanges
            ? {hasPendingUnsavedChanges: deps.hasPendingUnsavedChanges}
            : {}),
        hasUnsavedChanges: () => (
            deps.isDirty.value
            || deps.annotationDirty.value
            || deps.hasAnnotationChanges()
            || deps.pageLabelsDirty.value
            || deps.bookmarksDirty.value
        ),
        ...(deps.optimizePdfOnSaveAs ? {optimizePdfOnSaveAs: deps.optimizePdfOnSaveAs} : {}),
        annotations: {
            dirty: deps.annotationDirty,
            markSaved: deps.markAnnotationSaved,
            ...(deps.getAnnotationSaveStateToken
                ? {getSaveStateToken: deps.getAnnotationSaveStateToken}
                : {}),
            hasChanges: deps.hasAnnotationChanges,
            hasPendingDeletes: () => deps.pendingEmbeddedAnnotationDeleteCount.value > 0,
            openNoteCount: deps.annotationNoteWindowsCount,
            persistOpenNotes: deps.persistAllAnnotationNotes,
        },
        metadata: {
            totalPages: deps.totalPages,
            pageLabelsDirty: deps.pageLabelsDirty,
            pageLabelRanges: deps.pageLabelRanges,
            bookmarksDirty: deps.bookmarksDirty,
            bookmarkItems: deps.bookmarkItems,
            untitledBookmarkLabel: t('bookmarks.untitled'),
            markPageLabelsSaved: deps.markPageLabelsSaved,
            ...(deps.getPageLabelsSaveStateToken
                ? {getPageLabelsSaveStateToken: deps.getPageLabelsSaveStateToken}
                : {}),
            markBookmarksSaved: deps.markBookmarksSaved,
            ...(deps.getBookmarksSaveStateToken
                ? {getBookmarksSaveStateToken: deps.getBookmarksSaveStateToken}
                : {}),
        },
        pdf: {
            document: deps.pdfDocument,
            viewer: deps.pdfViewerRef,
            commitEditorsForSave: async () => {
                await deps.pdfViewerRef.value?.commitPdfEditorsForSave?.();
            },
            runSaveTransaction: request => deps.pdfViewerRef.value?.runSaveTransaction(request)
                ?? Promise.reject(new Error('Missing PDF viewer save transaction')),
            getSourceData: getSourcePdfData,
        },
        persistence: {
            validatePdfPath: deps.validatePdfPath,
            saveSerialized: deps.saveFile,
            saveWorkingCopy: deps.saveWorkingCopy,
            saveAs: deps.saveWorkingCopyAs,
            ...(deps.repairWorkingCopy ? {repairWorkingCopy: deps.repairWorkingCopy} : {}),
            ...(deps.optimizeWorkingCopy ? {optimizeWorkingCopy: deps.optimizeWorkingCopy} : {}),
            ...(deps.optimizeWorkingCopyAsCopy
                ? {optimizeWorkingCopyAsCopy: deps.optimizeWorkingCopyAsCopy}
                : {}),
            ...(deps.trySavePdfNativeMutations
                ? {trySavePdfNativeMutations: deps.trySavePdfNativeMutations}
                : {}),
            ...(deps.trySaveEmbeddedNoteTextUpdates
                ? {trySaveEmbeddedNoteTextUpdates: deps.trySaveEmbeddedNoteTextUpdates}
                : {}),
            getWorkingCopySize: async path => (await getDocumentFilesCapability().statFile(path)).size,
        },
        shapes: {
            hasChanges: () => hasViewerShapeChanges(deps.pdfViewerRef.value),
            hasManagedShapes: () => (deps.pdfViewerRef.value?.getAllShapes().length ?? 0) > 0,
        },
        lifecycle: {
            loadRecentFiles: deps.loadRecentFiles,
            preparePostSaveReload: () => {
                const scrollSnapshot = deps.pdfViewerRef.value?.captureScrollSnapshot?.() ?? null;
                const pageToRestore = resolvePdfReloadPage(scrollSnapshot?.anchorPage ?? deps.currentPage.value);
                const reloadWaiter = createPdfReloadWaiter({
                    pdfDocument: deps.pdfDocument,
                    pdfViewerRef: deps.pdfViewerRef,
                    ...(deps.openSurface ? {openSurface: deps.openSurface} : {}),
                    resetSearchCache: deps.resetSearchCache,
                    pageToRestore,
                    restoreScroll: true,
                });
                return {
                    promise: reloadWaiter.promise,
                    cancel: () => reloadWaiter.cancel(),
                };
            },
        },
        ...(deps.runWithDocumentOperationLease
            ? {runWithDocumentOperationLease: deps.runWithDocumentOperationLease}
            : {}),
        ...(deps.failureSurface ? {failureSurface: deps.failureSurface} : {}),
    };
    return {
        getSourcePdfData,
        ...useWorkspaceSaveService(saveDependencies),
    };
};
