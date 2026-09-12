import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    useBookmarkState,
    usePageLabelState,
} from '@app/modules/pdf-viewer/public';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceCommandLedger } from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';

interface IMetadataSessionOptions {
    pdfDocument: ShallowRef<IPdfDocument | null>;
    totalPages: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Readonly<Ref<TDocumentRevisionToken | null>>;
    markDirty: () => void;
    fileHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    fileHistorySessionVersion?: Readonly<Ref<number>> | undefined;
    annotationHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    annotationHistoryResetVersion?: Readonly<Ref<number>> | undefined;
    undoFile?: (() => Promise<boolean>) | undefined;
    redoFile?: (() => Promise<boolean>) | undefined;
    setWorkspaceCommandSink?: ((sink: IWorkspaceCommandSink | null) => void) | undefined;
}

export const useMetadataSession = (options: IMetadataSessionOptions) => {
    const {
        pdfDocument,
        totalPages,
        workingCopyPath,
        documentRevisionToken,
        markDirty,
        setWorkspaceCommandSink,
    } = options;

    let metadataHistory: ReturnType<typeof useWorkspaceMetadataHistory> | null = null;
    const workspaceUndoTimeline = useWorkspaceCommandLedger();
    const commandSink: IWorkspaceCommandSink = {
        register: workspaceUndoTimeline.registerCommand,
        reset: workspaceUndoTimeline.resetSource,
        forget: workspaceUndoTimeline.forgetSourceEntries,
        undo: workspaceUndoTimeline.undoTimeline,
        redo: workspaceUndoTimeline.redoTimeline,
    };
    setWorkspaceCommandSink?.(commandSink);

    const pageLabelState = usePageLabelState({
        pdfDocument,
        totalPages,
        markDirty,
        workingCopyPath,
        ...(documentRevisionToken !== undefined ? {documentRevisionToken} : {}),
        readPageLabelRanges: async (): Promise<IPdfPageLabelRange[]> => {
            const path = workingCopyPath.value;
            if (!path) {
                throw new Error('Cannot read PDF page labels without a working copy');
            }
            return getDocumentFilesCapability().readPdfPageLabelRanges(path);
        },
        onPageLabelsSynchronized: () => metadataHistory?.resetToCurrentState(),
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: () => metadataHistory?.markCurrentStateClean(),
    });
    const {
        pageLabels,
        pageLabelModel,
        pageLabelRanges,
        pageLabelsDirty,
    } = pageLabelState;

    const bookmarkState = useBookmarkState({
        markDirty,
        onBookmarksSynchronized: () => metadataHistory?.resetToCurrentState(),
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: () => metadataHistory?.markCurrentStateClean(),
    });
    const {
        bookmarkItems,
        bookmarksResolved,
        bookmarksDirty,
    } = bookmarkState;

    watch(pdfDocument, () => {
        bookmarksResolved.value = false;
    }, { immediate: true });

    metadataHistory = useWorkspaceMetadataHistory({
        bookmarkItems,
        bookmarksDirty,
        pageLabels,
        pageLabelModel,
        pageLabelRanges,
        pageLabelsDirty,
        totalPages,
        commandSink,
    });
    metadataHistory.resetToCurrentState();

    return {
        pageLabelState,
        bookmarkState,
        metadataHistory,
        clearPreservedSourceReloadMetadata: () => metadataHistory?.clearPreservedSourceReloadState(),
        consumePreservedSourceReloadMetadata: () => metadataHistory.consumePreservedSourceReloadState(),
        preserveMetadataForNextSourceReload: () => metadataHistory?.preserveCurrentStateForNextSourceReload(),
        workspaceUndoTimeline,
        workspaceCommandSink: commandSink,
    };
};
