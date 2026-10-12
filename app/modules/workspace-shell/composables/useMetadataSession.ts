import {
    type IPdfDocument,
    useBookmarkState,
    usePageLabelState,
    type createPdfReloadWaiter,
} from '@app/modules/pdf-viewer/public';
import type { Ref } from 'vue';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { useWorkspaceCommandLedger } from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';
import type {
    IWorkspaceCommandRegistration, IWorkspaceCommandSink,
} from '@app/types/workspaceCommand';
import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import type {IWorkspaceMetadataRecovery} from '@contracts/workspaceCheckpoint';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';

interface IMetadataSessionOptions {
    pdfDocument: Readonly<Ref<IPdfDocument | null>>;
    totalPages: Readonly<Ref<number>>;
    workingCopyPath: Ref<TDocumentRef | null>;
    documentRevisionToken?: Readonly<Ref<TDocumentRevisionToken | null>>;
    markDirty: () => void;
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
    // This reload scope holds the existing owner, never a second metadata copy.
    let preparePreservedReload: (() => ReturnType<typeof createPdfReloadWaiter>) | null = null;
    const preservesSourceReload = () => preparePreservedReload !== null;
    async function runWithPreservedMetadataReload<T>(
        operation: () => Promise<T>,
        prepareReload: () => ReturnType<typeof createPdfReloadWaiter>,
    ) {
        const previous = preparePreservedReload;
        preparePreservedReload = prepareReload;
        try { return await operation(); } finally { preparePreservedReload = previous; }
    }
    function registerCommand(command: IWorkspaceCommandRegistration) {
        const prepareReload = preparePreservedReload;
        if (command.source !== 'file' || !prepareReload) {
            workspaceUndoTimeline.registerCommand(command);
            return;
        }
        const run = (operation: IWorkspaceCommandRegistration['undo']) => runWithPreservedMetadataReload(async () => {
            const reload = prepareReload();
            try {
                const changed = await operation();
                if (changed) await reload.promise;
                return changed;
            } finally { reload.cancel(); }
        }, prepareReload);
        workspaceUndoTimeline.registerCommand({
            ...command,
            undo: () => run(command.undo),
            cmd: () => run(command.cmd),
        });
    }
    const commandSink: IWorkspaceCommandSink = {
        register: registerCommand,
        reset: workspaceUndoTimeline.resetSource,
        forget: workspaceUndoTimeline.forgetSourceEntries,
        undo: workspaceUndoTimeline.undoTimeline,
        redo: workspaceUndoTimeline.redoTimeline,
    };
    setWorkspaceCommandSink?.(commandSink);

    const bookmarkState = useBookmarkState({
        markDirty,
        preservesSourceReload,
        onBookmarksSynchronized: () => { if (!preservesSourceReload()) metadataHistory?.resetToCurrentState(); },
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: () => metadataHistory?.markCurrentStateClean(),
    });
    const {
        bookmarkItems,
        bookmarksResolved,
        bookmarksDirty,
    } = bookmarkState;

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
        preservesSourceReload,
        onPageLabelsSynchronized: () => { if (!preservesSourceReload()) metadataHistory?.resetToCurrentState(); },
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: () => metadataHistory?.markCurrentStateClean(),
        // The outline is re-read from new bytes, not from another view's copy of the same.
        onDocumentBytesChanged: () => {
            bookmarksResolved.value = false;
        },
    });
    const {
        pageLabels,
        pageLabelModel,
        pageLabelRanges,
        pageLabelsDirty,
    } = pageLabelState;


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
        consumePreservedSourceReloadMetadata: preservesSourceReload,
        runWithPreservedMetadataReload,
        workspaceUndoTimeline,
        workspaceCommandSink: commandSink,
        captureRecovery: (): IWorkspaceMetadataRecovery => {
            const bookmarks = bookmarkState.captureRecovery();
            const labels = pageLabelState.captureRecovery();
            return {
                ...(bookmarks ? {bookmarks} : {}),
                ...(labels ? {pageLabels: labels} : {}),
            };
        },
        restoreRecovery: (recovery: IWorkspaceMetadataRecovery) => {
            // Restored edits stay dirty, but do not create a second authored history.
            metadataHistory.restoreCurrentState(() => {
                if (recovery.bookmarks) bookmarkState.restoreRecovery(recovery.bookmarks);
                if (recovery.pageLabels) pageLabelState.restoreRecovery(recovery.pageLabels);
            });
        },
    };
};
