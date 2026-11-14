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
    IDocumentsFileIoCapability,
    IDocumentsWorkingCopyCapability,
} from '@contracts/electronApiDocuments';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/documentSessionState';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {IWorkspaceCommandSink} from '@app/types/workspaceCommand';
import type { TPdfDocumentAnnotations } from '@app/modules/pdf-viewer/public';

export interface IPdfLoadedState {
    pdfData: Uint8Array | null;
    pdfSrc: TPdfSource;
}

/**
 * One undoable change of the document's bytes, between two revisions its working copy keeps. Undo and redo make
 * one of them current again; nothing is copied.
 */
interface IFileCommand {
    id: string;
    before: TDocumentRevisionToken;
    after: TDocumentRevisionToken;
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

type TDocumentHistoryWorkingCopyDeps = Pick<
    IDocumentsWorkingCopyCapability,
    'cleanupFile' | 'restoreDocumentRevision' | 'retainDocumentRevisions'
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
    clearOcrCache: (path: TDocumentRef) => void;
    documentFiles: () => Pick<IDocumentsFileIoCapability, 'getDocumentRevision'>;
    documentWorkingCopy: () => TDocumentHistoryWorkingCopyDeps;
    getOpenEpoch: () => number;
    isCurrentOpenEpoch: (token: number) => boolean;
    readPdfStateFromPath: (path: TDocumentRef) => Promise<IPdfLoadedState>;
}

// Retain 20 file states, so at most 19 page-operation transitions can be
// undone. A batched page operation contributes one state after it succeeds.
// The working copy keeps exactly the revisions these states name.
const MAX_HISTORY_ENTRIES = 20;

export function createDocumentHistory(
    state: IDocumentSessionState,
    deps: ICreateDocumentHistoryDeps,
) {
    const commands = shallowRef<IFileCommand[]>([]);
    const currentFileState = shallowRef<object>({});
    let savedFileState = currentFileState.value;
    let currentCheckpoint: TDocumentRevisionToken | null = null;
    let stagedBaseline: TDocumentRevisionToken | null = null;
    const fileHistoryMutationVersion = ref(0);
    const fileHistorySessionVersion = ref(0);
    let workspaceCommandSink: IWorkspaceCommandSink | null = null;
    let mutationHistoryBaselineStaging: Promise<boolean> | null = null;

    function setWorkspaceCommandSink(sink: IWorkspaceCommandSink | null) {
        workspaceCommandSink = sink;
    }

    /** Tells the working copy which revisions history names; it lets the others go. */
    function retainRevisions() {
        const path = state.workingCopyPath.value;
        if (!path) return;
        const revisions = new Set([
            ...commands.value.flatMap(command => [command.before, command.after]),
            ...[currentCheckpoint, stagedBaseline].filter(revision => revision !== null),
        ]);
        deps.documentWorkingCopy().retainDocumentRevisions(path, [...revisions]).catch((error: unknown) => {
            BrowserLogger.warn('pdf-file', 'Failed to retain the undo revisions', {path, error});
        });
    }

    function clearHistory() {
        workspaceCommandSink?.reset('file');
        commands.value = [];
        currentCheckpoint = stagedBaseline = null;
        retainRevisions();
    }

    /** History starts over at the revision the document has now. */
    function resetHistory(options?: {isCurrent?: (() => boolean) | undefined}) {
        if (options?.isCurrent?.() === false) return Promise.resolve(false);
        clearHistory();
        currentFileState.value = {};
        savedFileState = currentFileState.value;
        currentCheckpoint = state.documentRevisionToken.value;
        return Promise.resolve(true);
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

    function captureHistoryCleanState() {
        const frontier = currentFileState.value;
        const session = fileHistorySessionVersion.value;
        return () => {
            if (session === fileHistorySessionVersion.value) {
                savedFileState = frontier;
                state.recoveryDirtyBaseline.value = false;
                if (currentFileState.value === frontier) {
                    currentCheckpoint = stagedBaseline = null;
                    retainRevisions();
                }
                syncDirtyFromHistory();
            }
            return Promise.resolve();
        };
    }

    /** The revision a mutation is about to replace becomes the `before` of its history entry. */
    async function stageHistoryBaselineForMutation() {
        const path = state.workingCopyPath.value;
        if (!path) return false;
        const sessionVersion = fileHistorySessionVersion.value;
        const {token} = await deps.documentFiles().getDocumentRevision(path);
        if (!state.isActiveWorkingCopy(path) || sessionVersion !== fileHistorySessionVersion.value
            || (state.documentRevisionToken.value !== null && state.documentRevisionToken.value !== token)) return false;
        stagedBaseline = token;
        retainRevisions();
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
        const {token} = await deps.documentFiles().getDocumentRevision(path);
        if (!state.isActiveWorkingCopy(path) || !pushHistoryEntry(token, opts?.pageIdentityDelta)) return false;
        state.pdfData.value = nextState.pdfData;
        state.pdfSrc.value = nextState.pdfSrc;
        state.pdfReloadSrc.value = nextState.pdfSrc;
        return true;
    }

    function pushHistoryEntry(after: TDocumentRevisionToken, pageIdentityDelta?: IPageIdentityDelta) {
        const before = stagedBaseline ?? currentCheckpoint;
        if (!before || !workspaceCommandSink) return false;
        const command: IFileCommand = {
            id: crypto.randomUUID(),
            before,
            after,
            beforeState: currentFileState.value,
            afterState: {},
            ...(pageIdentityDelta ? {pageIdentityDelta} : {}),
        };
        currentCheckpoint = after;
        stagedBaseline = null;
        commands.value = [
            ...commands.value,
            command,
        ];
        const store = deps.documentAnnotations?.().application.value.store;
        const releaseAnnotations = store?.retainHistoryTargets();
        // A page operation's Undo shows the annotations as they were right before it, its Redo as they were
        // right after it: each swaps the current state with the one the other side left.
        const pageStore = pageIdentityDelta ? store : undefined;
        let otherAnnotations = pageStore?.snapshotState();
        if (pageIdentityDelta) pageStore?.remapPages(pageIdentityDelta);
        const swapAnnotations = () => {
            if (pageStore && otherAnnotations) otherAnnotations = pageStore.exchangeState(otherAnnotations);
        };
        const replay = async (direction: 'undo' | 'redo') => {
            const restored = await restoreRevision(direction === 'undo' ? before : after,
                direction === 'undo' && pageIdentityDelta ? invertPageIdentityDelta(pageIdentityDelta) : pageIdentityDelta,
                swapAnnotations);
            if (restored) {
                currentFileState.value = direction === 'undo' ? command.beforeState : command.afterState;
                currentCheckpoint = direction === 'undo' ? before : after;
                stagedBaseline = null;
                syncDirtyFromHistory();
            }
            return restored;
        };
        workspaceCommandSink.register({
            source: 'file',
            entityIds: [command.id],
            undo: () => replay('undo'),
            cmd: () => replay('redo'),
            onDiscard: () => {
                releaseAnnotations?.();
                commands.value = commands.value.filter(retained => retained !== command);
                retainRevisions();
            },
        });
        currentFileState.value = command.afterState;
        while (commands.value.length > 1 && commands.value.length >= MAX_HISTORY_ENTRIES) {
            workspaceCommandSink.forget('file', new Set([commands.value[0]!.id]));
        }
        retainRevisions();
        fileHistoryMutationVersion.value += 1;
        syncDirtyFromHistory();
        return true;
    }

    /** Makes `revision` current in the working copy and shows it: undo or redo, without a copy. */
    async function restoreRevision(revision: TDocumentRevisionToken, delta?: IPageIdentityDelta, applyAnnotations?: () => void) {
        const restoreSessionVersion = fileHistorySessionVersion.value;
        const restoreOpenRequestId = deps.getOpenEpoch();
        const canApplyRestore = () => restoreSessionVersion === fileHistorySessionVersion.value
            && deps.isCurrentOpenEpoch(restoreOpenRequestId);
        const path = state.workingCopyPath.value;
        if (!path || !canApplyRestore()) return false;
        const expected = state.documentRevisionToken.value;
        await deps.documentWorkingCopy().restoreDocumentRevision(path, revision, expected ? {expectedDocumentRevisionToken: expected} : undefined);
        if (!canApplyRestore()) return false;
        const nextState = await deps.readPdfStateFromPath(path);
        if (!canApplyRestore()) return false;
        return await deps.applyLoadedPdfState(path, nextState, {
            preserveHistory: true,
            isCurrent: canApplyRestore,
            beforeSourceCommit: async (token) => {
                const commit = token ? await deps.prepareHistoryRevisionSwap?.(token, delta) : undefined;
                return () => { commit?.(); applyAnnotations?.(); };
            },
        }) !== false;
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
        reloadWorkingCopyIntoHistory,
        reloadWorkingCopyRevision,
        resetHistory,
        setWorkspaceCommandSink,
        syncDirtyFromHistory,
    };
}
