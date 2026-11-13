import { uniq } from 'es-toolkit/array';
import {
    invertPageIdentityDelta,
    getPageIdentityDeltaNextPageCount,
    mapPageNumberThroughPageIdentityDelta,
    type IPageIdentityDelta,
} from '@contracts/electronApiPageOps';
import { requirePageNumber } from '@contracts/pageNumbers';
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
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import { createWorkingCopySnapshotFromData } from '@app/services/pdf-file/createWorkingCopySnapshotFromData';
import { IPC_DIRECT_BINARY_PAYLOAD_MAX_BYTES } from '@contracts/electronApiDocuments';
import {
    isPathPdfSource, type TPdfDocumentAnnotations,
} from '@app/modules/pdf-viewer/public';

export interface IPdfLoadedState {
    pdfData: Uint8Array | null;
    pdfSrc: TPdfSource;
}

export interface ILazyHistoryBaseline {
    workingPath: TDocumentRef;
    revision: TDocumentRevisionToken;
    size: number;
}

type TDocumentHistoryEntry = TPdfHistoryEntry;
interface IFileCommand {
    id: string;
    before: TDocumentHistoryEntry;
    after: TDocumentHistoryEntry;
    beforeState: object;
    afterState: object;
    pageIdentityDelta?: IPageIdentityDelta;
}

interface IApplyLoadedPdfStateOptions {
    markDirty?: boolean;
    preserveHistory?: boolean;
    previousPath?: TDocumentRef | null;
    beforeSourceCommit?: (revision: TDocumentRevisionToken | null) => Promise<(() => void) | undefined>;
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

export interface IHistoryRevisionSwapOptions {
    documentAnnotations?: () => TPdfDocumentAnnotations;
    prepareHistoryRevisionSwap?: (revision: TDocumentRevisionToken, delta: IPageIdentityDelta | undefined) => Promise<(() => void) | undefined>;
}

interface ICreateDocumentHistoryDeps extends IHistoryRevisionSwapOptions {
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
    const commands = shallowRef<IFileCommand[]>([]);
    const currentFileState = shallowRef<object>({});
    let savedFileState = currentFileState.value;
    let currentCheckpoint: TDocumentHistoryEntry | null = null;
    let stagedBaseline: TDocumentHistoryEntry | null = null;
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);
    let workspaceCommandSink: IWorkspaceCommandSink | null = null;
    let mutationHistoryBaselineStaging: Promise<boolean> | null = null;

    function setWorkspaceCommandSink(sink: IWorkspaceCommandSink | null) {
        workspaceCommandSink = sink;
    }

    function retainedEntries() {
        return new Set([
            ...commands.value.flatMap(command => [
                command.before,
                command.after,
            ]),
            ...[
                currentCheckpoint,
                stagedBaseline,
            ].filter((entry): entry is TDocumentHistoryEntry => entry !== null),
        ]);
    }

    function releaseEntries(entries: TDocumentHistoryEntry[]) {
        const retained = retainedEntries();
        const paths = new Set([...retained].flatMap(entry => entry.kind === 'path' ? [entry.path] : []));
        scheduleHistoryEntryCleanup(entries.filter(entry => !retained.has(entry) && (entry.kind !== 'path' || !paths.has(entry.path))));
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

    function clearHistory() {
        const released = [...retainedEntries()];
        workspaceCommandSink?.reset('file');
        commands.value = [];
        currentCheckpoint = stagedBaseline = null;
        releaseEntries(released);
    }

    async function resetHistory(snapshot: Uint8Array | null, options?: {
        reuseSnapshot?: boolean;
        isCurrent?: (() => boolean) | undefined;
    }) {
        if (options?.isCurrent?.() === false) return false;
        const entry = snapshot ? await createHistoryEntryFromSnapshot(snapshot, options) : null;
        if (options?.isCurrent?.() === false) {
            if (entry) releaseEntries([entry]);
            return false;
        }
        clearHistory();
        currentFileState.value = {};
        savedFileState = currentFileState.value;
        currentCheckpoint = entry;
        return true;
    }

    function syncDirtyFromHistory() {
        state.isDirty.value = state.recoveryDirtyBaseline.value || currentFileState.value !== savedFileState;
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

    // Desktop and the browser both keep a path source's managed working copy;
    // the browser's lives in its document store.
    function getPathHistorySource(path: TDocumentRef) {
        const sources = [
            state.pdfReloadSrc.value,
            state.pdfSrc.value,
        ];
        return sources.find(source => (
            isPathPdfSource(source)
            && source.path === path
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

    function shouldStoreHistorySnapshotAsWorkingCopy(snapshot: Uint8Array) {
        return (
            snapshot.byteLength > MAX_IN_MEMORY_HISTORY_SNAPSHOT_BYTES
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

        // A path source already has an authoritative, managed working copy.
        // Do not turn a save/recovery byte hint into another whole-PDF
        // renderer allocation. The hint only tells this method that a new
        // history state exists; the path clone is the snapshot.
        const pathSource = expectedWorkingPath
            ? getPathHistorySource(expectedWorkingPath)
            : null;
        if (pathSource) {
            try {
                if (!expectedWorkingPath) {
                    return null;
                }
                return await createCurrentPathHistoryEntry(
                    expectedWorkingPath,
                    pathSource.size,
                );
            } catch (snapshotError) {
                BrowserLogger.warn('pdf-file', 'Failed to create path-backed history snapshot', {
                    path: expectedWorkingPath,
                    bytes: pathSource.size,
                    error: snapshotError,
                });
                return null;
            }
        }

        if (expectedWorkingPath && shouldStoreHistorySnapshotAsWorkingCopy(snapshot)) {
            try {
                const entry = await createPathHistoryEntryFromSnapshot(snapshot, expectedWorkingPath);
                if (entry) {
                    return entry;
                }
            } catch (snapshotError) {
                BrowserLogger.warn('pdf-file', 'Failed to create a working-copy history snapshot', {
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

    function captureHistoryCleanState() {
        const frontier = currentFileState.value;
        const session = fileHistorySessionVersion.value;
        return () => {
            if (session === fileHistorySessionVersion.value) {
                savedFileState = frontier;
                state.recoveryDirtyBaseline.value = false;
                if (currentFileState.value === frontier) {
                    const released = [...retainedEntries()];
                    currentCheckpoint = stagedBaseline = null;
                    releaseEntries(released);
                }
                syncDirtyFromHistory();
            }
            return Promise.resolve();
        };
    }

    async function stageHistoryBaselineForMutation() {
        const path = state.workingCopyPath.value;
        if (!path) return false;
        const sessionVersion = fileHistorySessionVersion.value;
        const before = await deps.documentFiles().getDocumentRevision(path);
        if (!state.isActiveWorkingCopy(path) || sessionVersion !== fileHistorySessionVersion.value
            || (state.documentRevisionToken.value !== null && state.documentRevisionToken.value !== before.token)) return false;
        const {size} = await deps.documentFiles().statFile(path);
        const entry = state.pdfData.value && !getPathHistorySource(path)
            ? await createHistoryEntryFromSnapshot(state.pdfData.value)
            : await createPathHistoryEntry(path, size);
        if (!entry) return false;
        const after = await deps.documentFiles().getDocumentRevision(path).catch(error => {
            releaseEntries([entry]);
            throw error;
        });
        if (!state.isActiveWorkingCopy(path) || sessionVersion !== fileHistorySessionVersion.value || before.token !== after.token) {
            releaseEntries([entry]);
            return false;
        }
        const previous = stagedBaseline;
        stagedBaseline = entry;
        if (previous) releaseEntries([previous]);
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

    async function reloadWorkingCopyRevision() {
        const path = state.workingCopyPath.value;
        if (!path) return false;
        const nextState = await deps.readPdfStateFromPath(path);
        return state.isActiveWorkingCopy(path) && await deps.applyLoadedPdfState(path, nextState, {
            preserveHistory: true,
            isCurrent: () => state.isActiveWorkingCopy(path),
        }) !== false;
    }

    async function reloadWorkingCopyIntoHistory(opts?: {pageIdentityDelta?: IPageIdentityDelta}) {
        const path = state.workingCopyPath.value;
        if (!path) return false;
        const nextState = await deps.readPdfStateFromPath(path);
        if (!state.isActiveWorkingCopy(path)) return false;
        const entry = nextState.pdfData
            ? await createHistoryEntryFromSnapshot(nextState.pdfData)
            : await createCurrentPathHistoryEntry(path, nextState.pdfSrc.size);
        if (!entry) return false;
        if (!pushHistoryEntry(entry, opts?.pageIdentityDelta)) {
            releaseEntries([entry]);
            return false;
        }
        state.pdfData.value = nextState.pdfData;
        state.pdfSrc.value = nextState.pdfSrc;
        state.pdfReloadSrc.value = nextState.pdfSrc;
        return true;
    }

    function pushHistoryEntry(entry: TDocumentHistoryEntry, pageIdentityDelta?: IPageIdentityDelta) {
        const before = stagedBaseline ?? currentCheckpoint;
        if (!before || !workspaceCommandSink || (entry.kind === 'bytes' && entry.snapshot.byteLength > MAX_FILE_HISTORY_BYTES)) return false;
        const command: IFileCommand = {
            id: crypto.randomUUID(),
            before,
            after: entry,
            beforeState: currentFileState.value,
            afterState: {},
            ...(pageIdentityDelta ? {pageIdentityDelta} : {}),
        };
        const released = currentCheckpoint;
        currentCheckpoint = entry;
        stagedBaseline = null;
        commands.value = [
            ...commands.value,
            command,
        ];
        const store = deps.documentAnnotations?.().application.value.store;
        const releaseAnnotations = store?.retainHistoryTargets();
        const annotationChange = pageIdentityDelta ? store?.remapPages(pageIdentityDelta) : undefined;
        const replay = async (direction: 'undo' | 'redo') => {
            const restored = await restoreHistoryEntry(direction === 'undo' ? before : entry,
                direction === 'undo' && pageIdentityDelta ? invertPageIdentityDelta(pageIdentityDelta) : pageIdentityDelta,
                direction === 'undo' ? annotationChange?.undo : annotationChange?.redo);
            if (restored) {
                currentFileState.value = direction === 'undo' ? command.beforeState : command.afterState;
                const previous = currentCheckpoint;
                currentCheckpoint = direction === 'undo' ? before : entry;
                stagedBaseline = null;
                if (previous) releaseEntries([previous]);
                syncDirtyFromHistory();
            }
            return restored;
        };
        workspaceCommandSink.register({
            source: 'file',
            entityIds: [command.id],
            undo: () => replay('undo'),
            cmd: () => replay('redo'),
            estimatedBytes: [
                before,
                entry,
            ].reduce((sum, endpoint) => sum + (endpoint.kind === 'bytes' ? endpoint.snapshot.byteLength : 0), 0),
            onDiscard: () => {
                releaseAnnotations?.();
                commands.value = commands.value.filter(retained => retained !== command);
                releaseEntries([
                    before,
                    entry,
                ]);
            },
        });
        currentFileState.value = command.afterState;
        if (released) releaseEntries([released]);
        while (commands.value.length > 1 && (commands.value.length >= MAX_HISTORY_ENTRIES
            || [...retainedEntries()].reduce((sum, endpoint) => sum + (endpoint.kind === 'bytes' ? endpoint.snapshot.byteLength : 0), 0) > MAX_FILE_HISTORY_BYTES)) {
            workspaceCommandSink.forget('file', new Set([commands.value[0]!.id]));
        }
        fileHistoryMutationVersion.value += 1;
        syncDirtyFromHistory();
        return true;
    }

    async function pushHistorySnapshot(snapshot: Uint8Array, options?: {
        reuseSnapshot?: boolean;
        pageIdentityDelta?: IPageIdentityDelta
    }) {
        const entry = await createHistoryEntryFromSnapshot(snapshot, options);
        if (!entry) return false;
        const pushed = pushHistoryEntry(entry, options?.pageIdentityDelta);
        if (!pushed) releaseEntries([entry]);
        return pushed;
    }

    async function restoreHistoryEntry(entry: TDocumentHistoryEntry | undefined, delta?: IPageIdentityDelta, applyAnnotations?: () => void) {
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
            if (workingPath) {
                const revision = await deps.documentFiles().getDocumentRevision(workingPath);
                if (!canApplyRestore()) return false;
                const commitRevisionSwap = await deps.prepareHistoryRevisionSwap?.(revision.token, delta);
                if (!canApplyRestore()) return false;
                if (commitRevisionSwap) commitRevisionSwap();
                applyAnnotations?.();
                state.documentRevisionInfo.value = revision;
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
            isCurrent: canApplyRestore,
            beforeSourceCommit: async (revision) => {
                const commit = revision ? await deps.prepareHistoryRevisionSwap?.(revision, delta) : undefined;
                return () => { commit?.(); applyAnnotations?.(); };
            },
        });
        return didApply !== false;
    }

    function mapHistoryPage(direction: 'undo' | 'redo', page: number) {
        const command = commands.value.find(entry => (direction === 'undo' ? entry.afterState : entry.beforeState) === currentFileState.value);
        const delta = direction === 'undo' && command?.pageIdentityDelta
            ? invertPageIdentityDelta(command.pageIdentityDelta) : command?.pageIdentityDelta;
        return delta ? mapPageNumberThroughPageIdentityDelta(delta, requirePageNumber(page))
            ?? Math.max(1, Math.min(page, getPageIdentityDeltaNextPageCount(delta) ?? page)) : page;
    }

    function incrementSessionVersion() {
        fileHistorySessionVersion.value += 1;
        workspaceCommandSink?.reset();
    }

    function getHistoryDebugState() {
        return {
            retainedCheckpointCount: retainedEntries().size,
            retainedFileCommandCount: commands.value.length,
            isFileStateSaved: currentFileState.value === savedFileState,
        };
    }

    return {
        captureHistoryCleanState,
        cleanupPreviousWorkingCopy,
        clearHistory,
        ensureHistoryBaselineForMutation,
        fileHistoryMutationVersion,
        fileHistorySessionVersion,
        getHistoryDebugState,
        mapHistoryPage,
        incrementSessionVersion,
        pushHistoryEntry,
        pushHistorySnapshot,
        reloadWorkingCopyIntoHistory,
        reloadWorkingCopyRevision,
        resetHistory,
        setWorkspaceCommandSink,
        syncDirtyFromHistory,
    };
}
