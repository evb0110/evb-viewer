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
    totalPages: Readonly<Ref<number>>;
    commandSink: IWorkspaceCommandSink;
}) => {
    const currentSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const cleanSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const preservedReloadSnapshot = shallowRef<IWorkspaceMetadataSnapshot | null>(null);
    const isApplyingSnapshot = ref(false);

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
            currentSnapshot.value = snapshot;
            syncDirtyFlags(snapshot);
        } finally {
            isApplyingSnapshot.value = false;
        }
    }

    function resetHistoryToCurrentState() {
        const snapshot = captureCurrentSnapshot();
        deps.commandSink.reset('metadata');
        currentSnapshot.value = snapshot;
        return snapshot;
    }

    function resetToCurrentState() {
        const snapshot = resetHistoryToCurrentState();
        cleanSnapshot.value = snapshot;
        syncDirtyFlags(snapshot);
    }

    function restoreCurrentState(restore: () => void) {
        isApplyingSnapshot.value = true;
        try {
            restore();
        } finally {
            isApplyingSnapshot.value = false;
        }
        const snapshot = resetHistoryToCurrentState();
        syncDirtyFlags(snapshot);
    }

    function markCurrentStateClean() {
        const snapshot = captureCurrentSnapshot();
        cleanSnapshot.value = snapshot;
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
        const current = currentSnapshot.value;
        if (!current) {
            currentSnapshot.value = snapshot;
            cleanSnapshot.value ??= snapshot;
            syncDirtyFlags(snapshot);
            return;
        }

        if (isEqual(snapshot, current)) {
            syncDirtyFlags(snapshot);
            return;
        }

        // The shared command owns both immutable inverse payloads. Dropping it
        // releases them; the metadata owner retains only the current/clean state.
        let before: IWorkspaceMetadataSnapshot | null = current;
        let after: IWorkspaceMetadataSnapshot | null = snapshot;
        currentSnapshot.value = snapshot;
        deps.commandSink.register({
            source: 'metadata',
            undo: () => {
                if (!before) return false;
                applySnapshot(before);
                return true;
            },
            cmd: () => {
                if (!after) return false;
                applySnapshot(after);
                return true;
            },
            estimatedBytes: estimateSnapshotBytes(snapshot) + estimateSnapshotBytes(current),
            onDiscard: () => {
                before = null;
                after = null;
            },
        });
        syncDirtyFlags(snapshot);
    }

    return {
        resetToCurrentState,
        restoreCurrentState,
        markCurrentStateClean,
        clearPreservedSourceReloadState,
        consumePreservedSourceReloadState,
        preserveCurrentStateForNextSourceReload,
        recordCurrentState,
    };
};
