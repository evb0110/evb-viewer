import { isEqual } from 'es-toolkit/predicate';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdfContracts';
import {
    createPageLabelModel,
    materializePageLabelsForCompatibility,
    PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES,
} from '@app/modules/document-viewer/public';
import type { IDocumentPageLabelModel } from '@app/modules/document-viewer/public';
import { maxWorkspaceMetadataHistoryEntries } from '@app/modules/workspace-shell/metadata/maxWorkspaceMetadataHistoryEntries';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';

interface IWorkspaceMetadataSnapshot {
    bookmarkItems: IPdfBookmarkEntry[];
    pageLabelRanges: IPdfPageLabelRange[];
}

// Serialized-size approximations of one entry's fixed fields, used so the history
// budget can be charged without stringifying whole snapshots on every edit.
const BOOKMARK_ENTRY_FIXED_BYTES = 120;
const PAGE_LABEL_RANGE_FIXED_BYTES = 64;

function estimateBookmarkBytes(entries: readonly IPdfBookmarkEntry[]): number {
    let total = 0;
    for (const entry of entries) {
        total += BOOKMARK_ENTRY_FIXED_BYTES
            + entry.title.length
            + estimateBookmarkBytes(entry.items);
    }
    return total;
}

function estimateSnapshotBytes(snapshot: IWorkspaceMetadataSnapshot) {
    let total = estimateBookmarkBytes(snapshot.bookmarkItems);
    for (const range of snapshot.pageLabelRanges) {
        total += PAGE_LABEL_RANGE_FIXED_BYTES + range.prefix.length;
    }
    return total;
}

export const useWorkspaceMetadataHistory = (deps: {
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    pageLabels: Ref<string[] | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabelModel?: Ref<IDocumentPageLabelModel> | undefined;
    pageLabelsDirty: Ref<boolean>;
    totalPages: Ref<number>;
    commandSink?: IWorkspaceCommandSink | undefined;
}) => {
    const history = shallowRef<IWorkspaceMetadataSnapshot[]>([]);
    const historyIndex = ref(-1);
    const cleanSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const preservedReloadSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const isApplyingSnapshot = ref(false);
    const metadataHistoryMutationVersion = ref(0);
    const metadataHistoryResetVersion = ref(0);

    function cloneSnapshot(
        snapshot: IWorkspaceMetadataSnapshot,
    ): IWorkspaceMetadataSnapshot {
        return {
            bookmarkItems: structuredClone(toRaw(snapshot.bookmarkItems)),
            pageLabelRanges: structuredClone(toRaw(snapshot.pageLabelRanges)),
        };
    }

    function captureCurrentSnapshot(): IWorkspaceMetadataSnapshot {
        return cloneSnapshot({
            bookmarkItems: deps.bookmarkItems.value,
            pageLabelRanges: deps.pageLabelRanges.value,
        });
    }

    function syncDirtyFlags(snapshot: IWorkspaceMetadataSnapshot) {
        const baseline = cleanSnapshot.value;
        if (!baseline) {
            deps.bookmarksDirty.value = false;
            deps.pageLabelsDirty.value = false;
            return;
        }

        deps.bookmarksDirty.value = !isEqual(snapshot.bookmarkItems, baseline.bookmarkItems);
        deps.pageLabelsDirty.value = !isEqual(snapshot.pageLabelRanges, baseline.pageLabelRanges);
    }

    function applySnapshot(snapshot: IWorkspaceMetadataSnapshot) {
        isApplyingSnapshot.value = true;
        try {
            deps.bookmarkItems.value = structuredClone(snapshot.bookmarkItems);
            deps.pageLabelRanges.value = structuredClone(snapshot.pageLabelRanges);
            if (deps.pageLabelModel) {
                deps.pageLabelModel.value = createPageLabelModel(
                    deps.totalPages.value,
                    deps.pageLabelRanges.value,
                );
            }
            deps.pageLabels.value = deps.totalPages.value <= PAGE_LABEL_SMALL_COMPATIBILITY_MAX_PAGES
                ? materializePageLabelsForCompatibility(
                    deps.totalPages.value,
                    deps.pageLabelRanges.value,
                )
                : null;
            syncDirtyFlags(snapshot);
        } finally {
            isApplyingSnapshot.value = false;
        }
    }

    function resetToCurrentState() {
        const snapshot = captureCurrentSnapshot();
        history.value = [snapshot];
        historyIndex.value = 0;
        cleanSnapshot.value = cloneSnapshot(snapshot);
        metadataHistoryResetVersion.value += 1;
        deps.commandSink?.reset('metadata');
        syncDirtyFlags(snapshot);
    }

    function markCurrentStateClean() {
        const snapshot = captureCurrentSnapshot();
        cleanSnapshot.value = cloneSnapshot(snapshot);
        syncDirtyFlags(snapshot);
    }

    function preserveCurrentStateForNextSourceReload() {
        preservedReloadSnapshot.value = captureCurrentSnapshot();
    }

    function clearPreservedSourceReloadState() {
        preservedReloadSnapshot.value = null;
    }

    function consumePreservedSourceReloadState() {
        const snapshot = preservedReloadSnapshot.value;
        preservedReloadSnapshot.value = null;
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    function recordCurrentState() {
        if (isApplyingSnapshot.value) {
            return;
        }

        const snapshot = captureCurrentSnapshot();
        const current = history.value[historyIndex.value] ?? null;
        if (!current) {
            history.value = [snapshot];
            historyIndex.value = 0;
            cleanSnapshot.value ??= cloneSnapshot(snapshot);
            syncDirtyFlags(snapshot);
            return;
        }

        if (isEqual(snapshot, current)) {
            syncDirtyFlags(snapshot);
            return;
        }

        const nextHistory = [
            ...history.value.slice(0, historyIndex.value + 1),
            snapshot,
        ];
        if (nextHistory.length > maxWorkspaceMetadataHistoryEntries) {
            const baseline = nextHistory[0];
            const trailing = nextHistory.slice(
                -(maxWorkspaceMetadataHistoryEntries - 1),
            );
            history.value = baseline
                ? [
                    baseline,
                    ...trailing,
                ]
                : trailing;
        } else {
            history.value = nextHistory;
        }
        historyIndex.value = history.value.length - 1;
        metadataHistoryMutationVersion.value += 1;
        deps.commandSink?.register({
            source: 'metadata',
            undo: undoMetadata,
            cmd: redoMetadata,
            canUndo: () => canUndoMetadata.value,
            canRedo: () => canRedoMetadata.value,
            estimatedBytes: estimateSnapshotBytes(snapshot) + estimateSnapshotBytes(current),
        });
        syncDirtyFlags(snapshot);
    }

    const canUndoMetadata = computed(() => historyIndex.value > 0);
    const canRedoMetadata = computed(
        () => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1,
    );

    function undoMetadata() {
        if (!canUndoMetadata.value) {
            return false;
        }

        historyIndex.value -= 1;
        const snapshot = history.value[historyIndex.value];
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    function redoMetadata() {
        if (!canRedoMetadata.value) {
            return false;
        }

        historyIndex.value += 1;
        const snapshot = history.value[historyIndex.value];
        if (!snapshot) {
            return false;
        }

        applySnapshot(snapshot);
        return true;
    }

    return {
        canUndoMetadata,
        canRedoMetadata,
        metadataHistoryMutationVersion,
        metadataHistoryResetVersion,
        resetToCurrentState,
        markCurrentStateClean,
        clearPreservedSourceReloadState,
        consumePreservedSourceReloadState,
        preserveCurrentStateForNextSourceReload,
        recordCurrentState,
        undoMetadata,
        redoMetadata,
    };
};
