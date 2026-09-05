import type {
    PDFDocumentProxy,
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type {
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionSource,
} from '@app/modules/pdf-viewer/public';
import { isNativeDocumentRef } from '@app/utils/documentRef';
import type {
    IWorkspaceSerializedSaveBody,
    TWorkspaceSavePlan,
} from '@app/modules/workspace-shell/composables/file-operations/workspaceSavePlan';

interface IWorkspaceSaveTransactionRequestDependencies {
    metadata: {
        pageLabelRanges: {value: IPdfPageLabelRange[]};
        bookmarkItems: {value: IPdfBookmarkEntry[]};
        untitledBookmarkLabel: string;
        totalPages: {value: number};
    };
    pdf: {
        document: {value: PDFDocumentProxy | null};
        getSourceData: IPdfViewerSaveTransactionSource['getSourcePdfData'];
    };
    persistence: {
        trySavePdfNativeMutations?: unknown;
        trySaveEmbeddedNoteTextUpdates?: unknown;
    };
}

export function getSaveMode(plan: TWorkspaceSavePlan): TPdfSaveMode {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy'
        ? 'save_as_rewrite'
        : 'rewrite';
}

export function getSaveFlow(plan: TWorkspaceSavePlan): 'save' | 'save_as' {
    return plan.request.kind === 'save-as' || plan.request.kind === 'optimize-copy'
        ? 'save_as'
        : 'save';
}

export function requiresNativePathBackedSave(plan: TWorkspaceSavePlan) {
    return isNativeDocumentRef(plan.target.expectedWorkingPath);
}

export function buildSaveTransactionRequest(
    plan: TWorkspaceSavePlan,
    deps: IWorkspaceSaveTransactionRequestDependencies,
    body: IWorkspaceSerializedSaveBody,
    options: {
        allowNativeMutationPlan: boolean;
        planOnly?: boolean;
    },
): IPdfViewerSaveTransactionRequest {
    const documentStructure: IPdfViewerSaveTransactionDocumentStructure = {
        pageLabelsDirty: plan.dirtyState.pageLabels,
        pageLabelRanges: deps.metadata.pageLabelRanges.value,
        bookmarksDirty: plan.dirtyState.bookmarks,
        bookmarkItems: deps.metadata.bookmarkItems.value,
        untitledBookmarkLabel: deps.metadata.untitledBookmarkLabel,
        totalPages: deps.metadata.totalPages.value > 0
            ? deps.metadata.totalPages.value
            : deps.pdf.document.value?.numPages ?? 0,
    };
    const nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities = {
        hasNativePdfMutationCapability: options.allowNativeMutationPlan
            && Boolean(
                deps.persistence.trySavePdfNativeMutations
                ?? deps.persistence.trySaveEmbeddedNoteTextUpdates,
            ),
        canPersistNativeMetadataMutations: options.allowNativeMutationPlan
            && Boolean(deps.persistence.trySavePdfNativeMutations),
    };

    return {
        mode: 'persist',
        saveMode: getSaveMode(plan),
        saveFlowMode: getSaveFlow(plan),
        forceWriterSave: false,
        includeManagedShapes: body.includeManagedShapes,
        rewriteShapeState: plan.dirtyState.shapes,
        forceRewrite: body.forceRewrite,
        ...(options.planOnly !== undefined ? {planOnly: options.planOnly} : {}),
        dirtyState: {
            annotationDirty: plan.dirtyState.annotationDirty,
            hasAnnotationChanges: plan.dirtyState.annotationChanges,
            shapeStateDirty: plan.dirtyState.shapes,
        },
        nativeCapabilities,
        documentStructure,
        source: {getSourcePdfData: deps.pdf.getSourceData},
        workingPath: requiresNativePathBackedSave(plan)
            ? plan.target.expectedWorkingPath
            : null,
        serializeResult: true,
    };
}
