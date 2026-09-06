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

interface IMetadataSessionOptions {
    pdfDocument: ShallowRef<IPdfDocument | null>;
    totalPages: Ref<number>;
    markDirty: () => void;
    /** @deprecated Producers now publish directly through setWorkspaceCommandSink. */
    fileHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    /** @deprecated Producers now publish directly through setWorkspaceCommandSink. */
    fileHistorySessionVersion?: Readonly<Ref<number>> | undefined;
    /** @deprecated The annotation producer now publishes direct commands. */
    annotationHistoryMutationVersion?: Readonly<Ref<number>> | undefined;
    /** @deprecated The annotation producer resets its ledger source directly. */
    annotationHistoryResetVersion?: Readonly<Ref<number>> | undefined;
    /** @deprecated Commands carry their own inverse. */
    undoFile?: (() => Promise<boolean>) | undefined;
    /** @deprecated Commands carry their own redo operation. */
    redoFile?: (() => Promise<boolean>) | undefined;
    setWorkspaceCommandSink?: ((sink: IWorkspaceCommandSink | null) => void) | undefined;
}

export const useMetadataSession = (options: IMetadataSessionOptions) => {
    const {
        pdfDocument,
        totalPages,
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
        consumePreservedSourceReloadMetadata: () => metadataHistory?.consumePreservedSourceReloadState() ?? false,
        preserveMetadataForNextSourceReload: () => metadataHistory?.preserveCurrentStateForNextSourceReload(),
        workspaceUndoTimeline,
        workspaceCommandSink: commandSink,
    };
};
