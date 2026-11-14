import {
    type IPdfDocument,
    useBookmarkState,
    usePageLabelState,
    type createPdfReloadWaiter,
} from '@app/modules/pdf-viewer/public';
import type { Ref } from 'vue';
import { isEqual } from 'es-toolkit/predicate';
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
    // What the working bytes hold of each field, as last read from them or written to them.
    const workingMetadata: {bookmarkItems?: unknown; pageLabelRanges?: unknown} = {};
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

    // The owners read their first state while they are being created, before these exist.
    let currentMetadata: (field: 'bookmarkItems' | 'pageLabelRanges') => unknown = () => undefined;
    /** The field's value as written to the working bytes, or as read from them when `written` is absent. */
    function acknowledgeWorkingMetadata<T>(field: 'bookmarkItems' | 'pageLabelRanges', written?: T) {
        const value = written ?? currentMetadata(field);
        if (value !== undefined) workingMetadata[field] = structuredClone(toRaw(value));
        return written;
    }
    const differsFromWorkingBytes = (field: 'bookmarkItems' | 'pageLabelRanges', value: unknown) => (
        field in workingMetadata && !isEqual(workingMetadata[field], toRaw(value))
    );

    function synchronizeMetadata(field: 'bookmarkItems' | 'pageLabelRanges') {
        acknowledgeWorkingMetadata(field);
        if (preservesSourceReload()) return;
        if (preservedReload) metadataHistory?.captureCleanState()(field);
        else metadataHistory?.markCurrentStateClean(field);
    }

    const bookmarkState = useBookmarkState({
        markDirty,
        preservesSourceReload,
        onBookmarksSynchronized: () => synchronizeMetadata('bookmarkItems'),
        onBookmarksDirty: () => metadataHistory?.recordCurrentState(),
        onBookmarksSaved: written => metadataHistory?.markCurrentStateClean('bookmarkItems', acknowledgeWorkingMetadata('bookmarkItems', written)),
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
        onPageLabelsSaved: written => metadataHistory?.markCurrentStateClean('pageLabelRanges', acknowledgeWorkingMetadata('pageLabelRanges', written)),
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


    currentMetadata = field => (field === 'bookmarkItems' ? bookmarkItems.value : pageLabelRanges.value);
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
        /** The fields that differ from the saved file or from the working bytes: an undo can return to the saved file's state after a write put the edit in the bytes. */
        captureRecovery: (): IWorkspaceMetadataRecovery => {
            const bookmarks = bookmarkState.captureRecovery(differsFromWorkingBytes('bookmarkItems', bookmarkItems.value));
            const labels = pageLabelState.captureRecovery(differsFromWorkingBytes('pageLabelRanges', pageLabelRanges.value));
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
