import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import type {TDocumentRef} from '@contracts/documentRef';
import {createDocumentInstanceId} from '@contracts/documentInstanceId';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { getDocumentRefBaseName } from '@app/utils/documentRef';
import { isEqual } from 'es-toolkit/predicate';
import type { ITabMetadataCore } from '@contracts/windowTabs';
import type {
    IWorkspaceExpose,
    IWorkspaceOpenFailure,
} from '@app/types/workspaceExpose';
import {
    didPresent,
    type IWorkspaceOpenAdmission,
    type IWorkspaceOpenOperation,
    type TWorkspaceOpenFinish,
} from '@app/types/documentOpenOutcome';
import type {
    IDocumentOperationOwnership, TDocumentOperationKind, TRunWithDocumentOperationLease,
} from '@app/types/documentOperationKind';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import {
    createWorkspaceDocumentView,
    type IWorkspaceDocumentView,
    type IWorkspaceDocumentViewRecord,
    type IWorkspaceDocumentViewSeed,
} from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentView';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import {
    createSessionId, requireSessionId,
} from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import { rememberReadingView } from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import {
    NO_DOCUMENT_JOB_RELEASE,
    type TEndDocumentJobRelease,
} from '@app/modules/workspace-shell/document-sessions/documentJobRelease';
import type { IPdfPageShapeRead } from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import type {
    IWorkspaceDocumentFile,
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
    IWorkspaceDocumentTransaction,
    IWorkspaceRecordedFailure,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';

export type {
    IWorkspaceDocumentFile,
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
    IWorkspaceDocumentView,
};

interface IWorkspaceDocumentCloseRequest {
    /** Asked in the close's lease turn when the document is dirty. */
    decide?: () => Promise<TDirtyCloseDecision>;
    ownership?: IDocumentOperationOwnership;
    assertCurrent?: () => void;
}

type TFrontierStep = (assertCurrent: () => void) => Promise<void>;

/** What the document host lends its controller: its authored state and how to settle it. */
export interface IDocumentMutationFrontier {
    read: () => string;
    isDirty: () => boolean;
    prepare: TFrontierStep;
    close: TFrontierStep;
    /** What an accepted close resets, against the identity the document has before it retires. */
    retire?: () => void;
    /** Ends the document's running reload or Save adoption until the returned end; `end(true)` publishes it again. */
    release?: () => TEndDocumentJobRelease;
}

export interface IDocumentOperationLease {
    activeKind: ComputedRef<TDocumentOperationKind | null>;
    isBusy: ComputedRef<boolean>;
    /** Busy with an operation other than a background recovery copy, which only reads the document. */
    isForegroundBusy: ComputedRef<boolean>;
    runExclusive: TRunWithDocumentOperationLease;
}

/** A document the shell assigns to a tab before any workspace has loaded it. */
export type TWorkspaceDocumentAssignment = Omit<ITabMetadataCore, 'originalBackend'> & {
    recoveryWorkingCopyPath?: TDocumentRef | null | undefined;
    /** The reader asked to open it; its hidden tab opens it when shown. Otherwise the tab restores what it held. */
    deferredReaderOpen?: boolean | undefined;
};

export type TReadonlyWorkspaceDocumentTarget = Readonly<IWorkspaceDocumentTarget>;
export type TReadonlyWorkspaceDocumentFile = Readonly<IWorkspaceDocumentFile>;
export type TReadonlyWorkspaceDocumentIdentity = Readonly<IWorkspaceDocumentIdentity>;
export type TReadonlyWorkspaceDocumentTransaction = Readonly<Omit<IWorkspaceDocumentTransaction, 'target'>> & {
    readonly target: TReadonlyWorkspaceDocumentTarget | null;
};
export type TReadonlyWorkspaceDocumentSnapshot = Readonly<Omit<
    IWorkspaceDocumentSnapshot,
    'identity' | 'activeTransaction' | 'failure'
>> & {
    readonly identity: TReadonlyWorkspaceDocumentIdentity;
    readonly activeTransaction: TReadonlyWorkspaceDocumentTransaction | null;
    readonly failure: Readonly<IWorkspaceRecordedFailure> | null;
};

export interface IWorkspaceOpenRequest {
    kind: Exclude<TWorkspaceDocumentTransactionKind, 'close'>;
    target: TReadonlyWorkspaceDocumentTarget | null;
    acceptDocumentWithoutVisual?: boolean | undefined;
    /** Continues the open this caller already claimed before mounting its workspace. */
    transactionId?: string | undefined;
    /** The page-shape read the open's input started, if it started one. */
    pageShape?: IPdfPageShapeRead | null | undefined;
    /** The file whose pages the open shows, when not the target's source (a recovered, decrypted or
     * generated working copy); null while there is none to read yet, as before a password. */
    pageShapeSource?: TDocumentRef | null | undefined;
    /** The open brings its reader's own view (a moved tab), which outranks reading history. */
    carriesView?: boolean | undefined;
}

/**
 * The owner of one document's record, phase, dirty state and the commands
 * that reach it, and of the tab views that show it. The shell reads its
 * snapshot; the document's file session writes its record, and each view
 * writes its own view record.
 */
export interface IWorkspaceDocumentController {
    readonly snapshot: Readonly<Ref<TReadonlyWorkspaceDocumentSnapshot>>;
    /** The loaded document's file; the shell reads the identity derived from it. */
    readonly file: Readonly<ShallowRef<TReadonlyWorkspaceDocumentFile>>;
    readonly views: Readonly<ShallowRef<ReadonlyMap<string, IWorkspaceDocumentView>>>;
    readonly operationLease: IDocumentOperationLease;
    assign(document: TWorkspaceDocumentAssignment): void;
    /** Whether the assigned document waits to open as the reader's own open; any claimed open ends the wait. */
    isDeferredReaderOpen(): boolean;
    claimOpen(request: IWorkspaceOpenRequest, onPresented?: () => void): string;
    /** `run` does the open's file work and returns what it admitted; the open finishes with its presentation. */
    runOpen(request: IWorkspaceOpenRequest, run: (shape: IPdfOpeningGeometry | null, transactionId: string) => Promise<IWorkspaceOpenAdmission | null>): IWorkspaceOpenOperation;
    setOpeningLabel(label: string | null): void;
    commitFile(patch: Partial<IWorkspaceDocumentFile>, openTransactionId?: string | null): void;
    markFailed(failure: IWorkspaceOpenFailure | null): void;
    /** Tells why the document failed outside an open, without changing its phase. */
    reportFailure(failure: IWorkspaceOpenFailure): void;
    dismissFailure(): void;
    bindMutationFrontier(frontier: IDocumentMutationFrontier): void;
    readMutationFrontier(): string | null;
    releaseJobs(): TEndDocumentJobRelease;
    prepareTransfer: TFrontierStep;
    getView(tabId: string): IWorkspaceDocumentView | null;
    addView(tabId: string, seed?: IWorkspaceDocumentViewSeed): IWorkspaceDocumentView;
    /** Removes a tab's view and returns how many views remain. */
    removeView(tabId: string): number;
    attachWorkspace(tabId: string, workspace: IWorkspaceExpose): void;
    detachWorkspace(tabId: string, workspace: IWorkspaceExpose): void;
    close(request: IWorkspaceDocumentCloseRequest): Promise<boolean>;
    dispose(): void;
    createCommandTarget(tabId: string, mode?: 'current' | 'active-transaction'): TWorkspaceCommandTarget;
    validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    };
}


const EMPTY_FILE: TReadonlyWorkspaceDocumentFile = {
    originalPath: null,
    workingCopyPath: null,
    revisionInfo: null,
    revisionToken: null,
    isDjvu: false,
    sourceSha256: null,
};

function createEmptyIdentity(): IWorkspaceDocumentIdentity {
    return {
        documentSessionKey: null,
        documentInstanceId: null,
        documentRef: null,
        originalPath: null,
        workingCopyPath: null,
        fileName: null,
        isDjvu: false,
        revisionInfo: null,
    };
}

export function identityHasDocument(identity: TReadonlyWorkspaceDocumentIdentity) {
    return identity.revisionInfo !== null
        || identity.originalPath !== null
        || identity.fileName !== null
        || identity.isDjvu;
}

/** The tab title, path and dirty dot the shell shows for this document. */
export function describeTabDocument(snapshot: TReadonlyWorkspaceDocumentSnapshot): ITabMetadataCore {
    const target = snapshot.phase === 'opening' ? snapshot.activeTransaction?.target ?? null : null;
    const originalPath = target?.originalPath ?? snapshot.identity.originalPath;
    const originalBackend = resolveDocumentRefBackend(originalPath);
    return {
        fileName: snapshot.openingLabel ?? target?.fileName ?? snapshot.identity.fileName,
        originalPath,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        documentInstanceId: snapshot.identity.documentInstanceId,
        isDirty: snapshot.dirty,
        isDjvu: target?.isDjvu ?? snapshot.identity.isDjvu,
    };
}

/** A workspace mounted for any view of the document, for document-wide commands. */
export function getDocumentWorkspace(controller: Pick<IWorkspaceDocumentController, 'views'>) {
    return [...controller.views.value.values()].find(view => view.mountedWorkspace.value)?.mountedWorkspace.value ?? null;
}

/** The tab holds a document or is opening or closing one. A tab whose open failed is empty again. */
export function snapshotOccupiesTab(snapshot: TReadonlyWorkspaceDocumentSnapshot) {
    return identityHasDocument(snapshot.identity) || snapshot.activeTransaction !== null;
}

function createDocumentOperationLease(): IDocumentOperationLease {
    const active = shallowRef<{
        kind: TDocumentOperationKind;
        ownership: IDocumentOperationOwnership
    } | null>(null);
    const pendingCount = ref(0);
    const pendingRecoveryCount = ref(0);
    let queueTail: Promise<void> = Promise.resolve();

    async function runExclusive<T>(kind: TDocumentOperationKind, operation: (ownership: IDocumentOperationOwnership) => Promise<T>, holder?: IDocumentOperationOwnership) {
        // The lease is not re-entrant: its holder's own work runs inside the held turn.
        holder?.assertCurrent();
        if (holder) {return operation(holder);}
        pendingCount.value += 1;
        const isRecovery = kind === 'recovery-snapshot';
        if (isRecovery) {pendingRecoveryCount.value += 1;}
        const operationPromise = queueTail
            .catch(() => undefined)
            .then(async () => {
                const ownership: IDocumentOperationOwnership = {assertCurrent: () => {
                    if (active.value?.ownership !== ownership) {throw new Error('Document operation ownership has ended');}
                }};
                active.value = {
                    kind,
                    ownership,
                };
                try {
                    return await operation(ownership);
                } finally {
                    active.value = null;
                    pendingCount.value = Math.max(0, pendingCount.value - 1);
                    if (isRecovery) {pendingRecoveryCount.value = Math.max(0, pendingRecoveryCount.value - 1);}
                }
            });

        queueTail = operationPromise.then(() => undefined, () => undefined);
        return operationPromise;
    }

    return {
        activeKind: computed(() => active.value?.kind ?? null),
        isBusy: computed(() => pendingCount.value > 0),
        isForegroundBusy: computed(() => pendingCount.value > pendingRecoveryCount.value),
        runExclusive,
    };
}

export function createWorkspaceDocumentController(options: {
    tabId: string;
    assignment?: TWorkspaceDocumentAssignment | null | undefined;
    /** Tells the user why the document failed; the controller only records it. */
    reportFailure?: ((failure: IWorkspaceRecordedFailure) => void) | undefined;
}): IWorkspaceDocumentController {
    const tabId = options.tabId;
    const sessionId = createSessionId('workspace-document-session');
    const state = shallowRef<TReadonlyWorkspaceDocumentSnapshot>({
        sessionId,
        sessionRevision: 0,
        phase: 'empty',
        identity: createEmptyIdentity(),
        activeTransaction: null,
        openingLabel: null,
        failure: null,
        dirty: false,
        recoveryWorkingCopyPath: null,
    });
    const views = shallowRef(new Map<string, IWorkspaceDocumentViewRecord>());
    const operationLease = createDocumentOperationLease();
    const openWaiters = new Map<string, {accepted: PromiseWithResolvers<boolean>; finished: PromiseWithResolvers<TWorkspaceOpenFinish>; onPresented?: (() => void) | undefined}>();
    let activeClose: Promise<boolean> | null = null;
    let deferredReaderOpen = false;
    const file = shallowRef<TReadonlyWorkspaceDocumentFile>(EMPTY_FILE);
    const mutationFrontier = shallowRef<IDocumentMutationFrontier | null>(null);
    const liveDirty = computed(() => mutationFrontier.value?.isDirty() === true);
    // A loaded document is as dirty as its host's frontier; until it loads,
    // a restored or moved tab keeps the dirty state the shell assigned it.
    const snapshot = computed<TReadonlyWorkspaceDocumentSnapshot>(() => {
        const loaded = file.value.workingCopyPath !== null || file.value.isDjvu;
        const dirty = loaded ? liveDirty.value : state.value.dirty;
        return dirty === state.value.dirty ? state.value : {
            ...state.value,
            dirty,
        };
    });

    function update(patch: Partial<TReadonlyWorkspaceDocumentSnapshot>, bumpRevision = false) {
        const current = state.value;
        const next = {
            ...current,
            ...patch,
        };
        if (!bumpRevision && isEqual(current, next)) {
            return;
        }
        state.value = {
            ...next,
            sessionRevision: current.sessionRevision + (bumpRevision ? 1 : 0),
        };
    }

    function settle(transaction: TReadonlyWorkspaceDocumentTransaction, finish: TWorkspaceOpenFinish) {
        const waiter = openWaiters.get(transaction.id);
        openWaiters.delete(transaction.id);
        waiter?.accepted.resolve(false);
        // Commands for this open are captured at presentation, before an
        // awaiting caller can start another open in the same workspace.
        if (didPresent(finish)) {waiter?.onPresented?.();}
        waiter?.finished.resolve(finish);
    }

    function settleMountWaiters(workspace: IWorkspaceExpose | null) {
        for (const view of views.value.values()) {
            view.settleMountWaiters(workspace);
        }
    }

    function addView(viewTabId: string, seed?: IWorkspaceDocumentViewSeed) {
        const existing = views.value.get(viewTabId);
        if (existing) {
            return existing;
        }
        const view = createWorkspaceDocumentView(viewTabId, {
            isDocumentFailed: () => snapshot.value.phase === 'failed',
            seed,
        });
        views.value = new Map(views.value).set(viewTabId, view);
        return view;
    }

    function removeView(viewTabId: string) {
        views.value.get(viewTabId)?.retire();
        const next = new Map(views.value);
        next.delete(viewTabId);
        views.value = next;
        return next.size;
    }

    function restingPhase() {
        return identityHasDocument(snapshot.value.identity) ? 'presented' as const : 'empty' as const;
    }

    // An open that loses its tab to a newer open, a close or a disposal
    // ends superseded; the newer owner decides the phase.
    function supersedeActiveTransaction() {
        const transaction = snapshot.value.activeTransaction;
        if (transaction) {
            settle(transaction, {status: 'superseded'});
        }
    }

    function assign(document: TWorkspaceDocumentAssignment) {
        supersedeActiveTransaction();
        const identity: IWorkspaceDocumentIdentity = {
            ...createEmptyIdentity(),
            fileName: document.fileName,
            originalPath: document.originalPath,
            documentRef: document.originalPath,
            isDjvu: document.isDjvu,
        };
        const hasDocument = identityHasDocument(identity);
        deferredReaderOpen = hasDocument && document.deferredReaderOpen === true;
        update({
            phase: hasDocument ? 'presented' : 'empty',
            identity: hasDocument
                ? {
                    ...identity,
                    documentSessionKey: crypto.randomUUID(),
                    documentInstanceId: document.documentInstanceId ?? createDocumentInstanceId(),
                }
                : identity,
            activeTransaction: null,
            openingLabel: null,
            failure: null,
            dirty: document.isDirty,
            recoveryWorkingCopyPath: document.recoveryWorkingCopyPath ?? null,
        }, true);
    }

    function claimOpen(request: IWorkspaceOpenRequest, onPresented?: () => void) {
        supersedeActiveTransaction();
        deferredReaderOpen = false;
        const transaction: TReadonlyWorkspaceDocumentTransaction = {
            id: `workspace-document-transaction:${crypto.randomUUID()}`,
            kind: request.kind,
            target: request.target,
        };
        openWaiters.set(transaction.id, {
            accepted: Promise.withResolvers<boolean>(),
            finished: Promise.withResolvers<TWorkspaceOpenFinish>(),
            onPresented,
        });
        update({
            activeTransaction: transaction,
            openingLabel: null,
            failure: null,
        }, true);
        return transaction.id;
    }

    function runOpen(request: IWorkspaceOpenRequest, run: (shape: IPdfOpeningGeometry | null, transactionId: string) => Promise<IWorkspaceOpenAdmission | null>): IWorkspaceOpenOperation {
        const transactionId = request.transactionId ?? claimOpen(request);
        const transaction = snapshot.value.activeTransaction;
        const waiter = openWaiters.get(transactionId);
        if (!transaction || transaction.id !== transactionId || !waiter) {
            return {accepted: Promise.resolve(false), finished: Promise.resolve({status: 'superseded'})};
        }
        update({activeTransaction: {
            ...transaction,
            kind: request.kind,
            target: request.target,
        }});
        const isActive = () => snapshot.value.activeTransaction?.id === transactionId;
        // The intent is busy while its shape is admitted. Publishing opening
        // and claiming its surface happen together, so Start never uncovers
        // an idle viewport between the two owners.
        const begin = (shape: IPdfOpeningGeometry | null = null) => {
            if (!isActive()) {
                return null;
            }
            update({phase: 'opening'});
            return run(shape, transaction.id);
        };
        // The open ends with its document's presentation in the views, or
        // when no view has to show it, or a newer open or a close takes the tab.
        Promise.resolve(request.pageShape ? request.pageShape.answer.then(begin) : begin()).then(async (admission) => {
            if (!isActive()) {return;}
            if (!admission) {return markFailed(null);}
            waiter.accepted.resolve(true);
            const finish = await admission.presentation?.catch((): TWorkspaceOpenFinish => ({status: 'failed', failure: null}));
            if (!isActive()) {return;}
            if (!finish || didPresent(finish)) {
                present(finish ?? {status: 'accepted-without-visual'});
            } else {
                markFailed(finish.status === 'failed' ? finish.failure : null, finish);
            }
        }).catch((error: unknown) => {
            if (isActive()) {
                waiter.accepted.resolve(false);
                waiter.finished.reject(error);
                openWaiters.delete(transaction.id);
                markFailed(null);
            }
        });
        return {accepted: waiter.accepted.promise, finished: waiter.finished.promise};
    }

    function setOpeningLabel(label: string | null) {
        update({openingLabel: label});
    }

    // The file session writes the record here; the identity the shell reads
    // follows in the same call, so no copy of it can lag behind.
    function commitFile(patch: Partial<IWorkspaceDocumentFile>, openTransactionId?: string | null) {
        const committed: IWorkspaceDocumentFile = {
            ...file.value,
            ...patch,
        };
        // The source hash belongs to the bytes it was read from.
        if (!('sourceSha256' in patch) && (committed.workingCopyPath !== file.value.workingCopyPath || committed.revisionToken !== file.value.revisionToken)) {
            committed.sourceSha256 = null;
        }
        // Only the open in progress, passing its own id, commits another document, even at the same record.
        const opensDocument = snapshot.value.activeTransaction?.kind === 'open' && snapshot.value.activeTransaction.id === openTransactionId;
        if (!opensDocument && isEqual(committed, file.value)) {
            return;
        }
        file.value = committed;
        const current = snapshot.value.identity;
        const next: IWorkspaceDocumentIdentity = {
            ...createEmptyIdentity(),
            fileName: getDocumentRefBaseName(committed.originalPath) ?? getDocumentRefBaseName(committed.workingCopyPath),
            originalPath: committed.originalPath,
            isDjvu: committed.isDjvu,
            revisionInfo: committed.revisionInfo,
            documentRef: committed.revisionInfo?.documentRef ?? committed.originalPath,
            workingCopyPath: committed.revisionInfo?.documentRef ?? null,
        };
        if (!identityHasDocument(next)) {
            if (identityHasDocument(current)) {
                update({
                    identity: next,
                    phase: snapshot.value.phase === 'presented' ? 'empty' : snapshot.value.phase,
                    recoveryWorkingCopyPath: null,
                }, true);
            }
            return;
        }
        const sameLogicalDocument = identityHasDocument(current) && !opensDocument;
        const resumesCheckpointWorkingCopy = snapshot.value.recoveryWorkingCopyPath !== null
            && snapshot.value.recoveryWorkingCopyPath === next.workingCopyPath;
        const identity = {
            ...next,
            documentSessionKey: sameLogicalDocument
                ? current.documentSessionKey
                : crypto.randomUUID(),
            documentInstanceId: sameLogicalDocument || resumesCheckpointWorkingCopy
                ? current.documentInstanceId
                : createDocumentInstanceId(),
        };
        if (isEqual(identity, current)) {
            return;
        }
        update({identity}, true);
    }

    function present(finish: TWorkspaceOpenFinish) {
        const transaction = snapshot.value.activeTransaction;
        if (!transaction) {
            return;
        }
        const resumesCheckpointWorkingCopy = snapshot.value.recoveryWorkingCopyPath !== null
            && snapshot.value.recoveryWorkingCopyPath === snapshot.value.identity.workingCopyPath;
        // A new open is a new document instance even for the same file;
        // a restore resumes the instance the tab already owned.
        update({
            phase: 'presented',
            activeTransaction: null,
            openingLabel: null,
            failure: null,
            recoveryWorkingCopyPath: null,
            ...(transaction.kind === 'open' && !resumesCheckpointWorkingCopy
                ? {identity: {
                    ...snapshot.value.identity,
                    documentInstanceId: createDocumentInstanceId(),
                }}
                : {}),
        }, true);
        settle(transaction, finish);
    }

    /** A null failure is a cancelled open: the tab returns to what it held. */
    function markFailed(failure: IWorkspaceOpenFailure | null, finish?: TWorkspaceOpenFinish) {
        const transaction = snapshot.value.activeTransaction;
        if (!transaction && !failure) {
            return;
        }
        const recorded = failure
            ? {
                ...failure,
                fileName: failure.fileName ?? (transaction
                    ? transaction.target?.fileName ?? null
                    : snapshot.value.identity.fileName),
            }
            : null;
        update({
            phase: recorded ? 'failed' : restingPhase(),
            activeTransaction: null,
            openingLabel: null,
            failure: recorded,
        }, true);
        if (transaction) {
            settle(transaction, recorded ? {status: 'failed', failure: recorded} : finish ?? {status: 'cancelled'});
        }
        if (recorded) {
            settleMountWaiters(null);
            options.reportFailure?.(recorded);
        }
    }

    function reportFailure(failure: IWorkspaceOpenFailure) {
        options.reportFailure?.({
            ...failure,
            fileName: failure.fileName ?? snapshot.value.identity.fileName,
        });
    }

    function dismissFailure() {
        if (snapshot.value.phase === 'failed') {
            update({
                phase: restingPhase(),
                failure: null,
            });
        }
    }

    function attachWorkspace(viewTabId: string, workspace: IWorkspaceExpose) {
        dismissFailure();
        const view = views.value.get(viewTabId);
        if (!view) {
            BrowserLogger.error('workspace', 'A workspace mounted for a tab that does not view its document', {
                tabId: viewTabId,
                sessionId: snapshot.value.sessionId,
            }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
            return;
        }
        view.mount(workspace);
    }

    function detachWorkspace(viewTabId: string, workspace: IWorkspaceExpose) {
        if (!views.value.get(viewTabId)?.unmount(workspace) || getDocumentWorkspace({views})) {
            return;
        }
        // An open cannot outlive the views that run it; the next mount
        // restores the document from its identity.
        const transaction = snapshot.value.activeTransaction;
        if (transaction && transaction.kind !== 'close') {
            markFailed(null);
        }
    }

    function resetToEmpty() {
        update({
            phase: 'empty',
            identity: createEmptyIdentity(),
            activeTransaction: null,
            openingLabel: null,
            failure: null,
            dirty: false,
            recoveryWorkingCopyPath: null,
        }, true);
    }

    function runClose(request: IWorkspaceDocumentCloseRequest, ownership: IDocumentOperationOwnership, persist: boolean) {
        // A document closes with its last view; that view's place is kept. An
        // accepted close resets what the document leaves behind; a move does not.
        const onCloseCommit = async (retires = true) => {
            for (const tabId of views.value.keys()) {
                await rememberReadingView(controller, tabId);
            }
            supersedeActiveTransaction();
            resetToEmpty();
            if (retires) {mutationFrontier.value?.retire?.();}
        };
        const frontier = mutationFrontier.value;
        if (request.ownership && frontier) {
            // The transfer already owns admission. Close through the document's
            // lifecycle, rather than waiting for this same lease to become idle.
            request.ownership.assertCurrent();
            return frontier.close(request.assertCurrent ?? (() => undefined)).then(async () => {
                await onCloseCommit(false);
                return true;
            });
        }
        return getDocumentWorkspace({views})?.handleCloseFileFromUi({
            persist,
            ownership,
            onCloseCommit,
        })
            ?? onCloseCommit().then(() => true);
    }

    // A user Close decides in its own lease turn, after the work requested
    // before it; a transfer closes in the turn it already holds.
    function close(request: IWorkspaceDocumentCloseRequest) {
        if (request.ownership) {return runClose(request, request.ownership, false);}
        activeClose ??= operationLease.runExclusive('close', async (ownership) => {
            const decision = snapshot.value.dirty ? await request.decide?.() ?? 'discard' : 'discard';
            return decision !== 'cancel' && runClose(request, ownership, decision === 'save');
        }).finally(() => {
            activeClose = null;
        });
        return activeClose;
    }

    function dispose() {
        supersedeActiveTransaction();
        settleMountWaiters(null);
    }

    function createCommandTarget(viewTabId: string, mode: 'current' | 'active-transaction' = 'current'): TWorkspaceCommandTarget {
        const current = snapshot.value;
        const documentBackend = resolveDocumentRefBackend(current.identity.documentRef);
        const documentRevisionToken = current.identity.revisionInfo?.token;
        const common = {
            tabId: requireTabId(viewTabId),
            sessionId: requireSessionId(current.sessionId),
            documentRef: current.identity.documentRef,
            ...(documentBackend === undefined ? {} : {documentBackend}),
            documentInstanceId: current.identity.documentInstanceId,
            ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
        };
        return mode === 'active-transaction' && current.activeTransaction
            ? {
                ...common,
                kind: 'transaction',
                transactionId: current.activeTransaction.id,
            }
            : {
                ...common,
                kind: 'revision',
                sessionRevision: current.sessionRevision,
            };
    }

    function validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    } {
        const current = snapshot.value;
        if (!views.value.has(target.tabId)) {return {
            ok: false,
            reason: 'tab-id-mismatch',
        };}
        const expected = createCommandTarget(target.tabId, target.kind === 'transaction' ? 'active-transaction' : 'current');
        // Capture and validation share the same identity projection. Optional
        // backend/revision fields only constrain commands that supplied them.
        const fields = {
            sessionId: 'session-id-mismatch',
            documentInstanceId: 'document-instance-id-mismatch',
            documentRef: 'document-ref-mismatch',
            ...(target.documentBackend === undefined ? {} : {documentBackend: 'document-backend-mismatch'}),
            ...(target.documentRevisionToken === undefined ? {} : {documentRevisionToken: 'document-revision-token-mismatch'}),
        };
        for (const [
            field,
            reason,
        ] of Object.entries(fields)) {
            const actual: unknown = Reflect.get(target, field);
            if ((field === 'documentInstanceId' ? actual ?? null : actual) !== Reflect.get(expected, field)) {return {
                ok: false,
                reason,
            };}
        }
        const matches = target.kind === 'transaction'
            ? current.activeTransaction?.id === target.transactionId
            : current.sessionRevision === target.sessionRevision;
        return matches ? {ok: true} : {
            ok: false,
            reason: target.kind === 'transaction' ? 'transaction-id-mismatch' : 'session-revision-mismatch',
        };
    }

    addView(tabId);
    if (options.assignment) {
        assign(options.assignment);
    }

    const controller: IWorkspaceDocumentController = {
        snapshot,
        file,
        views,
        operationLease,
        assign,
        isDeferredReaderOpen: () => deferredReaderOpen,
        claimOpen,
        runOpen,
        setOpeningLabel,
        commitFile,
        markFailed,
        reportFailure,
        dismissFailure,
        bindMutationFrontier: (frontier) => { mutationFrontier.value = frontier; },
        readMutationFrontier: () => mutationFrontier.value?.read() ?? null,
        releaseJobs: () => mutationFrontier.value?.release?.() ?? NO_DOCUMENT_JOB_RELEASE,
        prepareTransfer: async (assertCurrent) => {
            assertCurrent();
            await mutationFrontier.value?.prepare(assertCurrent);
        },
        getView: viewTabId => views.value.get(viewTabId) ?? null,
        addView,
        removeView,
        attachWorkspace,
        detachWorkspace,
        close,
        dispose,
        createCommandTarget,
        validateCommandTarget,
    };
    return controller;
}
