import { uniq } from 'es-toolkit/array';
import type { TPdfSource } from '@app/types/pdfUi';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IDocumentMutationRevisionOptions,
    IDocumentsFileIoCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type {
    IByteHistoryEntry,
    IPathHistoryEntry,
    TPdfHistoryEntry,
} from '@app/services/pdf-file/pdfHistoryEntryTypes';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { appendHistoryEntry } from '@app/services/pdf-file/appendHistoryEntry';
import { areByteArraysEqual } from '@app/utils/areByteArraysEqual';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentRefBaseName,
    isNativeDocumentRef,
} from '@app/utils/documentRef';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import { createWorkingCopySnapshotFromData } from '@app/services/pdf-file/createWorkingCopySnapshotFromData';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import { isPathPdfSource } from '@app/modules/pdf-viewer/public/nativePreviewRouting';

export interface IPdfLoadedState {
    pdfData: Uint8Array | null;
    pdfSrc: TPdfSource;
}

export interface ILazyHistoryBaseline {
    workingPath: TDocumentRef;
    revision: TDocumentRevisionToken;
    size: number;
}

interface ILazyHistoryEntry extends ILazyHistoryBaseline {kind: 'lazy';}

type TDocumentHistoryEntry = TPdfHistoryEntry | ILazyHistoryEntry;

function isMaterializedHistoryEntry(entry: TDocumentHistoryEntry): entry is TPdfHistoryEntry {
    return entry.kind !== 'lazy';
}

interface IApplyLoadedPdfStateOptions {
    markDirty?: boolean;
    preserveHistory?: boolean;
    previousPath?: TDocumentRef | null;
    isCurrent?: (() => boolean) | undefined;
}

type TDocumentHistoryFileDeps = Pick<
    IDocumentsFileIoCapability,
    'getDocumentRevision' | 'savePdfData' | 'statFile' | 'writeFile'
>;

type TDocumentHistoryWorkingCopyDeps = Pick<
    IDocumentsWorkingCopyCapability,
    'cleanupFile' | 'createWorkingCopyFromData' | 'createWorkingCopyFromPath'
>;

interface ICreateDocumentHistoryDeps {
    applyLoadedPdfState: (
        path: TDocumentRef,
        nextState: IPdfLoadedState,
        options?: IApplyLoadedPdfStateOptions,
    ) => Promise<boolean | undefined>;
    clearPdfConformanceProfile: () => void;
    clearOcrCache: (path: TDocumentRef) => void;
    deferPdfConformanceProfile: (path: TDocumentRef) => void;
    documentFiles: () => TDocumentHistoryFileDeps;
    documentWorkingCopy: () => TDocumentHistoryWorkingCopyDeps;
    getOpenEpoch: () => number;
    isCurrentOpenEpoch: (token: number) => boolean;
    readPdfStateFromPath: (path: TDocumentRef) => Promise<IPdfLoadedState>;
    toPdfBlob: (snapshot: Uint8Array) => Blob;
}

// Retain 20 file states, so at most 19 page-operation transitions can be
// undone. A batched page operation contributes one state after it succeeds.
const MAX_HISTORY_ENTRIES = 20;
// Annotation commands use the other 16 MiB half of the app-wide 32 MiB undo cap.
const MAX_FILE_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_IN_MEMORY_HISTORY_SNAPSHOT_BYTES = 8 * 1024 * 1024;

function createDocumentMutationRevisionOptions(
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined,
): IDocumentMutationRevisionOptions | undefined {
    if (expectedDocumentRevisionToken === null || expectedDocumentRevisionToken === undefined) {
        return undefined;
    }
    return { expectedDocumentRevisionToken };
}

export function createDocumentHistory(
    state: IDocumentSessionState,
    deps: ICreateDocumentHistoryDeps,
) {
    const history = shallowRef<TDocumentHistoryEntry[]>([]);
    const historyIndex = ref(0);
    const historyCleanIndex = ref(-1);
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);
    let workspaceCommandSink: IWorkspaceCommandSink | null = null;
    let lazyHistoryBaseline: ILazyHistoryBaseline | null = null;
    let mutationHistoryBaselineStaging: Promise<boolean> | null = null;

    function setWorkspaceCommandSink(sink: IWorkspaceCommandSink | null) {
        workspaceCommandSink = sink;
    }

    function createByteHistoryEntry(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ): IByteHistoryEntry {
        return {
            kind: 'bytes',
            snapshot: options?.reuseSnapshot ? snapshot : snapshot.slice(),
        };
    }

    function scheduleHistoryEntryCleanup(entries: TDocumentHistoryEntry[]) {
        const snapshotPaths = uniq(entries.flatMap((entry) => entry.kind === 'path' ? [entry.path] : []));

        if (snapshotPaths.length === 0) {
            return;
        }

        for (const snapshotPath of snapshotPaths) {
            deps.documentWorkingCopy().cleanupFile(snapshotPath).catch((cleanupError: unknown) => {
                BrowserLogger.warn(
                    'pdf-file',
                    'Failed to cleanup history snapshot',
                    {
                        path: snapshotPath,
                        error: cleanupError,
                    },
                );
            });
        }
    }

    function replaceHistory(nextHistory: TDocumentHistoryEntry[], nextIndex: number, nextCleanIndex: number) {
        const removedEntries = history.value.filter(entry => !nextHistory.includes(entry));
        history.value = nextHistory;
        historyIndex.value = nextIndex;
        historyCleanIndex.value = nextCleanIndex;
        scheduleHistoryEntryCleanup(removedEntries);
    }

    function clearHistory() {
        lazyHistoryBaseline = null;
        replaceHistory([], 0, -1);
    }

    async function resetHistory(
        snapshot: Uint8Array | null,
        options?: {
            reuseSnapshot?: boolean;
            isCurrent?: (() => boolean) | undefined;
        },
    ) {
        if (options?.isCurrent?.() === false) {
            return false;
        }
        lazyHistoryBaseline = null;

        if (snapshot) {
            const entry = await createHistoryEntryFromSnapshot(snapshot, options);
            if (entry) {
                if (options?.isCurrent?.() === false) {
                    scheduleHistoryEntryCleanup([entry]);
                    return false;
                }
                replaceHistory([entry], 0, 0);
                return true;
            }
            // History is a resilience feature, not an open prerequisite. If a
            // large checkpoint cannot be staged, keep the document usable and
            // start with an empty history instead of aborting the open flow.
            if (options?.isCurrent?.() === false) {
                return false;
            }
            clearHistory();
            return true;
        } else {
            if (options?.isCurrent?.() === false) {
                return false;
            }
            clearHistory();
            return true;
        }
    }

    function syncDirtyFromHistory() {
        if (history.value.length === 0) {
            state.isDirty.value = false;
            return;
        }
        state.isDirty.value = state.recoveryDirtyBaseline.value
            || historyCleanIndex.value < 0
            || historyIndex.value !== historyCleanIndex.value;
    }

    async function cleanupPreviousWorkingCopy(path: TDocumentRef, nextPath: TDocumentRef) {
        if (path === nextPath) {
            return;
        }

        deps.clearOcrCache(path);
        try {
            await deps.documentWorkingCopy().cleanupFile(path);
        } catch (cleanupError) {
            BrowserLogger.warn(
                'pdf-file',
                'Failed to cleanup previous working copy',
                {
                    path,
                    error: cleanupError,
                },
            );
        }
    }

    async function createPathHistoryEntry(
        path: TDocumentRef,
        size: number,
    ): Promise<IPathHistoryEntry> {
        const snapshotPath = await deps.documentWorkingCopy().createWorkingCopyFromPath(
            path,
            state.originalPath.value ?? undefined,
        );
        return {
            kind: 'path',
            path: snapshotPath,
            size,
            originalPath: state.originalPath.value,
        };
    }

    function getNativePathHistorySource(path: TDocumentRef) {
        const sources = [
            state.pdfReloadSrc.value,
            state.pdfSrc.value,
        ];
        return sources.find(source => (
            isPathPdfSource(source)
            && source.path === path
            && state.isElectron.value
            && isNativeDocumentRef(path)
        )) ?? null;
    }

    async function createCurrentPathHistoryEntry(
        path: TDocumentRef,
        size: number,
    ): Promise<IPathHistoryEntry | null> {
        if (!state.isActiveWorkingCopy(path)) {
            return null;
        }

        const entry = await createPathHistoryEntry(path, size);
        if (state.isActiveWorkingCopy(path)) {
            return entry;
        }

        // The path clone may finish after an open/close or a newer working copy
        // took ownership of the session. Never retain a snapshot belonging to
        // that old session.
        await deps.documentWorkingCopy().cleanupFile(entry.path).catch((cleanupError: unknown) => {
            BrowserLogger.warn('pdf-file', 'Failed to cleanup stale path history snapshot', {
                path: entry.path,
                error: cleanupError,
            });
        });
        return null;
    }

    function shouldStoreHistorySnapshotOnDisk(snapshot: Uint8Array) {
        return (
            state.isElectron.value
            && snapshot.byteLength > MAX_IN_MEMORY_HISTORY_SNAPSHOT_BYTES
            && typeof deps.documentWorkingCopy().createWorkingCopyFromData === 'function'
        );
    }

    function getHistorySnapshotFileName() {
        return state.fileName.value ?? getDocumentRefBaseName(state.workingCopyPath.value) ?? 'document.pdf';
    }

    async function createPathHistoryEntryFromSnapshot(
        snapshot: Uint8Array,
        expectedWorkingPath: TDocumentRef,
    ): Promise<IPathHistoryEntry | null> {
        const snapshotPath = await createWorkingCopySnapshotFromData({
            fileName: getHistorySnapshotFileName(),
            data: snapshot,
            sourcePath: expectedWorkingPath,
            originalPath: state.originalPath.value ?? undefined,
            files: deps.documentFiles(),
            workingCopies: deps.documentWorkingCopy(),
        });
        if (!state.isActiveWorkingCopy(expectedWorkingPath)) {
            void deps.documentWorkingCopy().cleanupFile(snapshotPath);
            return null;
        }
        return {
            kind: 'path',
            path: snapshotPath,
            size: snapshot.byteLength,
            originalPath: state.originalPath.value,
        };
    }

    async function createHistoryEntryFromSnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ): Promise<TPdfHistoryEntry | null> {
        const expectedWorkingPath = state.workingCopyPath.value;

        // A native path source already has an authoritative, managed working
        // copy. Do not turn a save/recovery byte hint into another whole-PDF
        // renderer allocation. The hint only tells this method that a new
        // history state exists; the path clone is the snapshot.
        const nativePathSource = expectedWorkingPath
            ? getNativePathHistorySource(expectedWorkingPath)
            : null;
        if (nativePathSource) {
            try {
                if (!expectedWorkingPath) {
                    return null;
                }
                return await createCurrentPathHistoryEntry(
                    expectedWorkingPath,
                    nativePathSource.size,
                );
            } catch (snapshotError) {
                BrowserLogger.warn('pdf-file', 'Failed to create path-backed history snapshot', {
                    path: expectedWorkingPath,
                    bytes: nativePathSource.size,
                    error: snapshotError,
                });
                return null;
            }
        }

        if (expectedWorkingPath && shouldStoreHistorySnapshotOnDisk(snapshot)) {
            try {
                const entry = await createPathHistoryEntryFromSnapshot(snapshot, expectedWorkingPath);
                if (entry) {
                    return entry;
                }
            } catch (snapshotError) {
                BrowserLogger.warn('pdf-file', 'Failed to create disk-backed history snapshot', {
                    path: expectedWorkingPath,
                    bytes: snapshot.byteLength,
                    error: snapshotError,
                });
            }
        }

        if (expectedWorkingPath && !state.isActiveWorkingCopy(expectedWorkingPath)) {
            return null;
        }
        if (snapshot.byteLength > IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES) {
            return null;
        }
        return createByteHistoryEntry(snapshot, options);
    }

    async function markCurrentHistoryEntryClean(
        snapshot: Uint8Array | null,
        options?: {
            lazyBaseline?: ILazyHistoryBaseline;
            recordSnapshotChange?: boolean;
        },
    ) {
        state.recoveryDirtyBaseline.value = false;
        BrowserLogger.debug('workspace', 'Marking file history clean', () => ({
            hasSnapshot: Boolean(snapshot),
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: state.isDirty.value,
            recordSnapshotChange: options?.recordSnapshotChange !== false,
        }));
        if (options?.lazyBaseline) {
            lazyHistoryBaseline = options.lazyBaseline;
            const lazyEntry: ILazyHistoryEntry = {
                kind: 'lazy',
                ...options.lazyBaseline,
            };
            if (history.value.length === 0) {
                replaceHistory([lazyEntry], 0, 0);
            } else {
                const nextHistory = history.value.slice();
                nextHistory[historyIndex.value] = lazyEntry;
                replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
            }
            state.isDirty.value = false;
            return;
        }
        if (
            !snapshot
            && history.value[historyIndex.value]?.kind === 'lazy'
            && !await materializeLazyHistoryBaseline()
        ) {
            clearHistory();
        }
        lazyHistoryBaseline = null;
        if (!snapshot) {
            if (history.value.length === 0) {
                clearHistory();
            } else {
                historyCleanIndex.value = historyIndex.value;
                syncDirtyFromHistory();
            }
            state.isDirty.value = false;
            return;
        }

        const currentEntry = history.value[historyIndex.value] ?? null;
        if (currentEntry?.kind === 'bytes' && !areByteArraysEqual(currentEntry.snapshot, snapshot)) {
            if (options?.recordSnapshotChange === false) {
                // Annotation-only preserved-source saves update the clean file
                // baseline; they must not become file undo entries and steal
                // undo/redo from app-managed annotation history.
                const entry = await createHistoryEntryFromSnapshot(snapshot, { reuseSnapshot: true });
                if (!entry) {
                    return;
                }
                const nextHistory = history.value.slice();
                nextHistory[historyIndex.value] = entry;
                replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
            } else {
                await pushHistorySnapshot(snapshot, { reuseSnapshot: true });
            }
        } else if (currentEntry?.kind === 'path' && options?.recordSnapshotChange === false) {
            const entry = await createHistoryEntryFromSnapshot(snapshot, { reuseSnapshot: true });
            if (!entry) {
                return;
            }
            const nextHistory = history.value.slice();
            nextHistory[historyIndex.value] = entry;
            replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
        } else if (currentEntry?.kind === 'lazy') {
            const entry = await createHistoryEntryFromSnapshot(snapshot, { reuseSnapshot: true });
            if (!entry) {
                return;
            }
            const nextHistory = history.value.slice();
            nextHistory[historyIndex.value] = entry;
            replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
        } else if (!currentEntry) {
            await resetHistory(snapshot, { reuseSnapshot: true });
        }

        historyCleanIndex.value = historyIndex.value;
        syncDirtyFromHistory();
        state.isDirty.value = false;
        BrowserLogger.debug('workspace', 'File history marked clean', () => ({
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
            isDirty: state.isDirty.value,
        }));
    }

    async function materializeLazyHistoryBaseline() {
        const baseline = lazyHistoryBaseline;
        if (!baseline) {
            return true;
        }
        if (
            !state.isActiveWorkingCopy(baseline.workingPath)
            || state.documentRevisionToken.value !== baseline.revision
        ) {
            return false;
        }
        const before = await deps.documentFiles().getDocumentRevision(baseline.workingPath);
        if (before.token !== baseline.revision) {
            return false;
        }
        const entry = await createPathHistoryEntry(baseline.workingPath, baseline.size);
        const after = await deps.documentFiles().getDocumentRevision(baseline.workingPath).catch(async (error: unknown) => {
            await deps.documentWorkingCopy().cleanupFile(entry.path);
            throw error;
        });
        if (
            lazyHistoryBaseline !== baseline
            || !state.isActiveWorkingCopy(baseline.workingPath)
            || state.documentRevisionToken.value !== baseline.revision
            || after.token !== baseline.revision
        ) {
            await deps.documentWorkingCopy().cleanupFile(entry.path);
            return false;
        }
        const nextHistory = history.value.slice();
        if (nextHistory.length === 0) {
            nextHistory.push(entry);
            replaceHistory(nextHistory, 0, 0);
        } else {
            nextHistory[historyIndex.value] = entry;
            replaceHistory(nextHistory, historyIndex.value, historyIndex.value);
        }
        lazyHistoryBaseline = null;
        return true;
    }

    async function stageHistoryBaselineForMutation() {
        if (!await materializeLazyHistoryBaseline()) {
            return false;
        }
        if (history.value.length > 0) {
            return true;
        }

        const path = state.workingCopyPath.value;
        if (!path) {
            return false;
        }

        const sessionVersion = fileHistorySessionVersion.value;
        const before = await deps.documentFiles().getDocumentRevision(path);
        if (
            sessionVersion !== fileHistorySessionVersion.value
            || !state.isActiveWorkingCopy(path)
            || (
                state.documentRevisionToken.value !== null
                && state.documentRevisionToken.value !== before.token
            )
        ) {
            return false;
        }
        const {size} = await deps.documentFiles().statFile(path);
        const entry = await createPathHistoryEntry(path, size);
        const after = await deps.documentFiles().getDocumentRevision(path).catch(async (error: unknown) => {
            await deps.documentWorkingCopy().cleanupFile(entry.path);
            throw error;
        });
        if (
            sessionVersion !== fileHistorySessionVersion.value
            || !state.isActiveWorkingCopy(path)
            || before.token !== after.token
            || history.value.length > 0
        ) {
            await deps.documentWorkingCopy().cleanupFile(entry.path);
            return false;
        }
        replaceHistory([entry], 0, 0);
        syncDirtyFromHistory();
        return true;
    }

    async function ensureHistoryBaselineForMutation() {
        if (mutationHistoryBaselineStaging) {
            return mutationHistoryBaselineStaging;
        }

        const staging = stageHistoryBaselineForMutation().catch((error: unknown) => {
            BrowserLogger.warn('pdf-file', 'Failed to stage mutation history baseline', {
                path: state.workingCopyPath.value,
                error,
            });
            return false;
        });
        mutationHistoryBaselineStaging = staging;
        try {
            return await staging;
        } finally {
            if (mutationHistoryBaselineStaging === staging) {
                mutationHistoryBaselineStaging = null;
            }
        }
    }

    async function reloadWorkingCopyIntoHistory(opts?: { markDirty?: boolean }) {
        const path = state.workingCopyPath.value;
        if (!path) {
            return false;
        }

        const nextState = await deps.readPdfStateFromPath(path);
        if (!state.isActiveWorkingCopy(path)) {
            return false;
        }

        let didAppendHistory = false;
        if (nextState.pdfData) {
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            didAppendHistory = await pushHistorySnapshot(nextState.pdfData, { reuseSnapshot: true });
        } else {
            const snapshotEntry = await createPathHistoryEntry(path, nextState.pdfSrc.size);
            if (!state.isActiveWorkingCopy(path)) {
                void deps.documentWorkingCopy().cleanupFile(snapshotEntry.path);
                return false;
            }
            state.pdfData.value = nextState.pdfData;
            state.pdfSrc.value = nextState.pdfSrc;
            state.pdfReloadSrc.value = nextState.pdfSrc;
            didAppendHistory = pushHistoryEntry(snapshotEntry);
            if (!didAppendHistory) {
                scheduleHistoryEntryCleanup([snapshotEntry]);
            }
        }

        if (!didAppendHistory || !canUndo.value) {
            BrowserLogger.warn('pdf-file', 'Reloaded working copy without an undoable history transition', {
                path,
                didAppendHistory,
                historyLength: history.value.length,
                historyIndex: historyIndex.value,
            });
            return false;
        }

        state.isDirty.value = !!opts?.markDirty;
        return true;
    }

    function pushHistoryEntry(entry: TPdfHistoryEntry) {
        if (entry.kind === 'bytes' && entry.snapshot.byteLength > MAX_FILE_HISTORY_BYTES) {
            BrowserLogger.warn('pdf-file', 'Refusing oversized in-memory history entry', {
                bytes: entry.snapshot.byteLength,
                maxBytes: MAX_FILE_HISTORY_BYTES,
            });
            return false;
        }
        const materializedHistory = history.value.filter(isMaterializedHistoryEntry);
        if (materializedHistory.length !== history.value.length) {
            return false;
        }
        const nextState = appendHistoryEntry({
            history: materializedHistory,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        }, entry, {
            maxEntries: MAX_HISTORY_ENTRIES,
            maxBytes: MAX_FILE_HISTORY_BYTES,
        });

        // A post-mutation checkpoint without its baseline cannot be undone.
        // Reject it before publishing a command that would be disabled from
        // birth, and let the caller surface the missing history transition.
        if (nextState.historyIndex <= 0) {
            return false;
        }

        replaceHistory(nextState.history, nextState.historyIndex, nextState.historyCleanIndex);
        fileHistoryMutationVersion.value += 1;
        workspaceCommandSink?.register({
            source: 'file',
            undo,
            cmd: redo,
            canUndo: () => canUndo.value,
            canRedo: () => canRedo.value,
            ...(entry.kind === 'bytes' ? { estimatedBytes: entry.snapshot.byteLength } : {}),
        });
        syncDirtyFromHistory();
        return true;
    }

    async function pushHistorySnapshot(
        snapshot: Uint8Array,
        options?: { reuseSnapshot?: boolean },
    ) {
        const entry = await createHistoryEntryFromSnapshot(snapshot, options);
        if (!entry) {
            return false;
        }
        return pushHistoryEntry(entry);
    }

    const canUndo = computed(
        () => history.value.length > 0 && historyIndex.value > 0,
    );
    const canRedo = computed(
        () =>
            history.value.length > 0 && historyIndex.value < history.value.length - 1,
    );

    async function restoreHistoryEntry(entry: TDocumentHistoryEntry | undefined) {
        const restoreSessionVersion = fileHistorySessionVersion.value;
        const restoreOpenRequestId = deps.getOpenEpoch();

        function canApplyRestore() {
            return (
                restoreSessionVersion === fileHistorySessionVersion.value
                && deps.isCurrentOpenEpoch(restoreOpenRequestId)
            );
        }

        if (entry?.kind === 'bytes') {
            if (!canApplyRestore()) {
                return false;
            }
            const workingPath = state.workingCopyPath.value;
            if (workingPath) {
                await deps.documentFiles().writeFile(
                    workingPath,
                    entry.snapshot,
                    createDocumentMutationRevisionOptions(state.documentRevisionToken.value),
                );
            }
            if (!canApplyRestore()) {
                return false;
            }
            state.pdfData.value = entry.snapshot;
            state.pdfSrc.value = deps.toPdfBlob(entry.snapshot);
            state.pdfReloadSrc.value = state.pdfSrc.value;
            if (workingPath && state.isActiveWorkingCopy(workingPath)) {
                deps.deferPdfConformanceProfile(workingPath);
            } else {
                deps.clearPdfConformanceProfile();
            }
            return true;
        }

        if (entry?.kind !== 'path') {
            return false;
        }

        const nextWorkingPath = await deps.documentWorkingCopy().createWorkingCopyFromPath(
            entry.path,
            state.originalPath.value ?? entry.originalPath ?? undefined,
        );
        if (!canApplyRestore()) {
            void deps.documentWorkingCopy().cleanupFile(nextWorkingPath);
            return false;
        }
        const previousPath = state.workingCopyPath.value;
        const nextState = await deps.readPdfStateFromPath(nextWorkingPath);
        if (!canApplyRestore()) {
            void deps.documentWorkingCopy().cleanupFile(nextWorkingPath);
            return false;
        }
        const didApply = await deps.applyLoadedPdfState(nextWorkingPath, nextState, {
            preserveHistory: true,
            previousPath,
        });
        return didApply !== false;
    }

    async function undo() {
        if (!canUndo.value) {
            return false;
        }
        if (!await materializeLazyHistoryBaseline()) {
            return false;
        }
        const nextHistoryIndex = historyIndex.value - 1;
        const restored = await restoreHistoryEntry(history.value[nextHistoryIndex]);
        if (!restored) {
            return false;
        }
        historyIndex.value = nextHistoryIndex;
        syncDirtyFromHistory();
        return true;
    }

    async function redo() {
        if (!canRedo.value) {
            return false;
        }
        if (!await materializeLazyHistoryBaseline()) {
            return false;
        }
        const nextHistoryIndex = historyIndex.value + 1;
        const restored = await restoreHistoryEntry(history.value[nextHistoryIndex]);
        if (!restored) {
            return false;
        }
        historyIndex.value = nextHistoryIndex;
        syncDirtyFromHistory();
        return true;
    }

    function incrementSessionVersion() {
        fileHistorySessionVersion.value += 1;
        lazyHistoryBaseline = null;
        workspaceCommandSink?.reset();
    }

    function getHistoryDebugState() {
        return {
            historyLength: history.value.length,
            historyIndex: historyIndex.value,
            historyCleanIndex: historyCleanIndex.value,
        };
    }

    return {
        canRedo,
        canUndo,
        cleanupPreviousWorkingCopy,
        clearHistory,
        ensureHistoryBaselineForMutation,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        getHistoryDebugState,
        incrementSessionVersion,
        markCurrentHistoryEntryClean,
        pushHistoryEntry,
        pushHistorySnapshot,
        redo,
        reloadWorkingCopyIntoHistory,
        resetHistory,
        setWorkspaceCommandSink,
        syncDirtyFromHistory,
        undo,
    };
}
