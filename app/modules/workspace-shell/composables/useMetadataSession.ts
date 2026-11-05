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
    let preservedReload: {
        prepareReload: (() => ReturnType<typeof createPdfReloadWaiter>) | undefined;
        restoreCleanState: (() => void) | undefined;
    } | null = null;
    const preservesSourceReload = () => preservedReload?.prepareReload !== undefined;
    async function runWithPreservedMetadataReload<T>(
        operation: () => Promise<T>,
        prepareReload?: () => ReturnType<typeof createPdfReloadWaiter>,
    ) {
        const previous = preservedReload;
        preservedReload = {
            prepareReload,
            restoreCleanState: metadataHistory?.captureCleanState(),
        };
        try {
            const result = await operation();
            await pageLabelState.whenPageLabelsSettled();
            return result;
        } finally {
            // Keep same-document admission for late views; file reset admits Open.
            preservedReload = previous ?? {
                prepareReload: undefined,
                restoreCleanState: undefined,
            };
        }
    }
    function registerCommand(command: IWorkspaceCommandRegistration) {
        const scope = preservedReload;
        if (command.source !== 'file') {
            workspaceUndoTimeline.registerCommand(command);
            return;
        }
        let restoreCleanState = scope?.restoreCleanState ?? metadataHistory?.captureCleanState();
        const replay = async (operation: IWorkspaceCommandRegistration['undo']) => {
            const inverse = metadataHistory?.captureCleanState();
            const reload = scope?.prepareReload?.();
            try {
                const changed = await operation();
                if (changed) {
                    await reload?.promise;
                    await pageLabelState.whenPageLabelsSettled();
                    restoreCleanState?.();
                    restoreCleanState = inverse;
                }
                return changed;
            } finally { reload?.cancel(); }
        };
        const run = (operation: IWorkspaceCommandRegistration['undo']) => runWithPreservedMetadataReload(() => replay(operation), scope?.prepareReload);
        workspaceUndoTimeline.registerCommand({
            ...command,
            undo: () => run(command.undo),
            cmd: () => run(command.cmd),
        });
    }
    const commandSink: IWorkspaceCommandSink = {
        register: registerCommand,
        reset: source => {
            if (source === 'file' || source === undefined) preservedReload = null;
            workspaceUndoTimeline.resetSource(source);
        },
        forget: workspaceUndoTimeline.forgetSourceEntries,
        undo: workspaceUndoTimeline.undoTimeline,
        redo: workspaceUndoTimeline.redoTimeline,
    };
    setWorkspaceCommandSink?.(commandSink);

    function synchronizeMetadata(field: 'bookmarkItems' | 'pageLabelRanges') {
        if (preservesSourceReload()) return;
        if (preservedReload) metadataHistory?.captureCleanState()(field);
        else metadataHistory?.markCurrentStateClean(field);
    }

    const bookmarkState = useBookmarkState({
        markDirty,
        preservesSourceReload,
        onBookmarksSynchronized: () => synchronizeMetadata('bookmarkItems'),
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: written => metadataHistory?.markCurrentStateClean('bookmarkItems', written),
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
        onPageLabelsSynchronized: () => synchronizeMetadata('pageLabelRanges'),
        onPageLabelsDirty: () => metadataHistory?.recordCurrentState(),
        onPageLabelsSaved: written => metadataHistory?.markCurrentStateClean('pageLabelRanges', written),
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
