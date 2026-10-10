import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IPdfOpeningGeometry } from '@contracts/electronApiDocuments';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { isEqual } from 'es-toolkit/predicate';
import type { ITabMetadataCore } from '@contracts/windowTabs';
import type {
    IWorkspaceExpose,
    IWorkspaceOpenFailure,
} from '@app/types/workspaceExpose';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import {
    createWorkspaceDocumentView,
    type IWorkspaceDocumentView,
    type IWorkspaceDocumentViewRecord,
    type IWorkspaceDocumentViewSeed,
} from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentView';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { requireSessionId } from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IPdfPageShapeRead } from '@app/modules/workspace-shell/composables/document-session/resolvePdfOpeningGeometry';
import type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
    IWorkspaceDocumentTransaction,
    IWorkspaceRecordedFailure,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';

export type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
    IWorkspaceDocumentView,
};

export interface IDocumentOperationLease {
    activeKind: Ref<TDocumentOperationKind | null>;
    isBusy: ComputedRef<boolean>;
    runExclusive: <T>(kind: TDocumentOperationKind, operation: () => Promise<T>) => Promise<T>;
}

/** A document the shell assigns to a tab before any workspace has loaded it. */
export type TWorkspaceDocumentAssignment = Omit<ITabMetadataCore, 'originalBackend'> & {recoveryWorkingCopyPath?: TDocumentRef | null | undefined;};

/** What the mounted workspace reports about the document it holds. */
export interface IWorkspaceCommittedDocument {
    fileName: string | null;
    originalPath: TDocumentRef | null;
    isDjvu: boolean;
    revisionInfo: IDocumentRevisionInfo | null;
}

export interface IWorkspaceOpenRequest {
    kind: Exclude<TWorkspaceDocumentTransactionKind, 'close'>;
    target: IWorkspaceDocumentTarget | null;
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
 * The owner of one document's identity, phase, dirty state and the commands
 * that reach it, and of the tab views that show it. The shell reads its
 * snapshot; a mounted workspace writes it through these methods and writes
 * its own view through the view record.
 */
export interface IWorkspaceDocumentController {
    readonly snapshot: Readonly<ShallowRef<IWorkspaceDocumentSnapshot>>;
    readonly views: Readonly<ShallowRef<ReadonlyMap<string, IWorkspaceDocumentView>>>;
    readonly operationLease: IDocumentOperationLease;
    assign(document: TWorkspaceDocumentAssignment): void;
    claimOpen(request: IWorkspaceOpenRequest, onPresented?: () => void): string;
    runOpen(request: IWorkspaceOpenRequest, run: (shape: IPdfOpeningGeometry | null, transactionId: string) => Promise<boolean>): Promise<boolean>;
    setOpeningLabel(label: string | null): void;
    commitDocument(document: IWorkspaceCommittedDocument): void;
    markPresented(): void;
    markFailed(failure: IWorkspaceOpenFailure | null): void;
    /** Tells why the document failed outside an open, without changing its phase. */
    reportFailure(failure: IWorkspaceOpenFailure): void;
    dismissFailure(): void;
    setDirty(dirty: boolean): void;
    getView(tabId: string): IWorkspaceDocumentView | null;
    addView(tabId: string, seed?: IWorkspaceDocumentViewSeed): IWorkspaceDocumentView;
    /** Removes a tab's view and returns how many views remain. */
    removeView(tabId: string): number;
    attachWorkspace(tabId: string, workspace: IWorkspaceExpose): void;
    detachWorkspace(tabId: string, workspace: IWorkspaceExpose): void;
    close(request: {persist: boolean}): Promise<boolean>;
    dispose(): void;
    createCommandTarget(tabId: string, mode?: 'current' | 'active-transaction'): TWorkspaceCommandTarget;
    validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    };
}

let nextSessionIndex = 0;
let nextTransactionIndex = 0;
let nextDocumentSessionKeyIndex = 0;

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

export function identityHasDocument(identity: IWorkspaceDocumentIdentity) {
    return identity.revisionInfo !== null
        || identity.originalPath !== null
        || identity.fileName !== null
        || identity.isDjvu;
}

function getLogicalDocumentSignature(identity: Pick<IWorkspaceDocumentIdentity, 'originalPath' | 'fileName' | 'isDjvu' | 'documentRef'>) {
    const sourceRef = identity.originalPath ?? identity.documentRef;
    return JSON.stringify([
        sourceRef,
        sourceRef ? null : identity.fileName,
        identity.isDjvu,
    ]);
}

function createDocumentSessionKey(tabId: string, documentRef: string | null) {
    nextDocumentSessionKeyIndex += 1;
    return `workspace-document-instance:${tabId}:${Date.now()}:${nextDocumentSessionKeyIndex}:${documentRef ?? 'unknown'}`;
}

function createDocumentInstanceId() {
    return requireDocumentInstanceId(crypto.randomUUID());
}

/** The tab title, path and dirty dot the shell shows for this document. */
export function describeTabDocument(snapshot: IWorkspaceDocumentSnapshot): ITabMetadataCore {
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
export function snapshotOccupiesTab(snapshot: IWorkspaceDocumentSnapshot) {
    return identityHasDocument(snapshot.identity) || snapshot.activeTransaction !== null;
}

function createDocumentOperationLease(): IDocumentOperationLease {
    const activeKind = ref<TDocumentOperationKind | null>(null);
    const pendingCount = ref(0);
    let queueTail: Promise<void> = Promise.resolve();

    async function runExclusive<T>(kind: TDocumentOperationKind, operation: () => Promise<T>) {
        pendingCount.value += 1;
        const operationPromise = queueTail
            .catch(() => undefined)
            .then(async () => {
                activeKind.value = kind;
                try {
                    return await operation();
                } finally {
                    activeKind.value = null;
                    pendingCount.value = Math.max(0, pendingCount.value - 1);
                }
            });

        queueTail = operationPromise.then(() => undefined, () => undefined);
        return operationPromise;
    }

    return {
        activeKind,
        isBusy: computed(() => pendingCount.value > 0),
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
    nextSessionIndex += 1;
    const sessionId = requireSessionId(`workspace-document-session:${tabId}:${Date.now()}:${nextSessionIndex}`);
    const snapshot = shallowRef<IWorkspaceDocumentSnapshot>({
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
    const settleWaiters = new Map<string, PromiseWithResolvers<boolean>>();
    let activeClose: Promise<boolean> | null = null;

    function update(patch: Partial<IWorkspaceDocumentSnapshot>, bumpRevision = false) {
        const current = snapshot.value;
        const next = {
            ...current,
            ...patch,
        };
        if (!bumpRevision && isEqual(current, next)) {
            return;
        }
        snapshot.value = {
            ...next,
            sessionRevision: current.sessionRevision + (bumpRevision ? 1 : 0),
        };
    }

    function settle(transaction: IWorkspaceDocumentTransaction, presented: boolean) {
        settleWaiters.get(transaction.id)?.resolve(presented);
        settleWaiters.delete(transaction.id);
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
    // reports that it did not present; the newer owner decides the phase.
    function supersedeActiveTransaction() {
        const transaction = snapshot.value.activeTransaction;
        if (transaction) {
            settle(transaction, false);
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
        update({
            phase: hasDocument ? 'presented' : 'empty',
            identity: hasDocument
                ? {
                    ...identity,
                    documentSessionKey: createDocumentSessionKey(tabId, identity.documentRef),
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
        nextTransactionIndex += 1;
        const transaction: IWorkspaceDocumentTransaction = {
            id: `workspace-document-transaction:${tabId}:${request.kind}:${nextTransactionIndex}`,
            kind: request.kind,
            target: request.target,
            acceptDocumentWithoutVisual: request.acceptDocumentWithoutVisual === true,
        };
        const settled = Promise.withResolvers<boolean>();
        // Commands for this open are captured at presentation, before an
        // awaiting caller can start another open in the same workspace.
        settleWaiters.set(transaction.id, {
            ...settled,
            resolve: (presented) => {
                if (presented === true) onPresented?.();
                settled.resolve(presented);
            },
        });
        update({
            activeTransaction: transaction,
            openingLabel: null,
            failure: null,
        }, true);
        return transaction.id;
    }

    function runOpen(request: IWorkspaceOpenRequest, run: (shape: IPdfOpeningGeometry | null, transactionId: string) => Promise<boolean>) {
        const transactionId = request.transactionId ?? claimOpen(request);
        const transaction = snapshot.value.activeTransaction;
        const settled = settleWaiters.get(transactionId);
        if (!transaction || transaction.id !== transactionId || !settled) {
            return Promise.resolve(false);
        }
        update({activeTransaction: {
            ...transaction,
            kind: request.kind,
            target: request.target,
            acceptDocumentWithoutVisual: request.acceptDocumentWithoutVisual === true,
        }});
        const isActive = () => snapshot.value.activeTransaction?.id === transactionId;
        // The intent is busy while its shape is admitted. Publishing opening
        // and claiming its surface happen together, so Start never uncovers
        // an idle viewport between the two owners.
        const begin = (shape: IPdfOpeningGeometry | null = null) => {
            if (!isActive()) {
                return false;
            }
            update({phase: 'opening'});
            return run(shape, transaction.id);
        };
        // The open ends when the viewer presents or fails, or when a newer
        // open or a close takes the tab, even if the source is still loading.
        Promise.resolve(request.pageShape ? request.pageShape.answer.then(begin) : begin()).then((accepted) => {
            if (!accepted && isActive()) {
                markFailed(null);
            }
        }, (error: unknown) => {
            if (isActive()) {
                settled.reject(error);
                settleWaiters.delete(transaction.id);
                markFailed(null);
            }
        });
        return settled.promise;
    }

    function setOpeningLabel(label: string | null) {
        update({openingLabel: label});
    }

    function commitDocument(document: IWorkspaceCommittedDocument) {
        const current = snapshot.value.identity;
        const next: IWorkspaceDocumentIdentity = {
            ...createEmptyIdentity(),
            fileName: document.fileName,
            originalPath: document.originalPath,
            isDjvu: document.isDjvu,
            revisionInfo: document.revisionInfo,
            documentRef: document.revisionInfo?.documentRef ?? document.originalPath,
            workingCopyPath: document.revisionInfo?.documentRef ?? null,
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
        const sameLogicalDocument = identityHasDocument(current)
            && getLogicalDocumentSignature(current) === getLogicalDocumentSignature(next);
        const resumesCheckpointWorkingCopy = snapshot.value.recoveryWorkingCopyPath !== null
            && snapshot.value.recoveryWorkingCopyPath === next.workingCopyPath;
        const identity = {
            ...next,
            documentSessionKey: sameLogicalDocument
                ? current.documentSessionKey
                : createDocumentSessionKey(tabId, next.documentRef),
            documentInstanceId: sameLogicalDocument || resumesCheckpointWorkingCopy
                ? current.documentInstanceId
                : createDocumentInstanceId(),
        };
        if (isEqual(identity, current)) {
            return;
        }
        update({identity}, true);
    }

    function markPresented() {
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
        settle(transaction, true);
    }

    /** A null failure is a cancelled open: the tab returns to what it held. */
    function markFailed(failure: IWorkspaceOpenFailure | null) {
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
            settle(transaction, false);
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

    function setDirty(dirty: boolean) {
        update({dirty});
    }

    function attachWorkspace(viewTabId: string, workspace: IWorkspaceExpose) {
        if (snapshot.value.phase === 'failed') {
            update({
                phase: restingPhase(),
                failure: null,
            });
        }
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
            update({
                phase: restingPhase(),
                activeTransaction: null,
                openingLabel: null,
            }, true);
            settle(transaction, false);
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

    async function runClose(request: {persist: boolean}) {
        const workspace = getDocumentWorkspace({views});
        if (!workspace) {
            supersedeActiveTransaction();
            resetToEmpty();
            return true;
        }
        const previous = snapshot.value;
        const closed = await workspace.handleCloseFileFromUi({
            ...request,
            onCloseCommit: () => {
                supersedeActiveTransaction();
                nextTransactionIndex += 1;
                update({
                    phase: 'closing',
                    activeTransaction: {
                        id: `workspace-document-transaction:${tabId}:close:${nextTransactionIndex}`,
                        kind: 'close',
                        target: null,
                        acceptDocumentWithoutVisual: false,
                    },
                }, true);
            },
        });
        if (closed) {
            resetToEmpty();
        } else if (snapshot.value.phase === 'closing') {
            update({
                phase: previous.phase === 'opening' ? restingPhase() : previous.phase,
                activeTransaction: null,
            }, true);
        }
        return closed;
    }

    function close(request: {persist: boolean}) {
        activeClose ??= runClose(request).finally(() => {
            activeClose = null;
        });
        return activeClose;
    }

    function dispose() {
        supersedeActiveTransaction();
        settleMountWaiters(null);
    }

    function getTargetDocumentBackend(documentRef: string | null) {
        const parsedDocumentRef = parseDocumentRef(documentRef);
        const documentBackend = parsedDocumentRef === null
            ? undefined
            : resolveDocumentRefBackend(parsedDocumentRef);
        return documentBackend === undefined ? {} : {documentBackend};
    }

    function getTargetDocumentRevisionToken(info: IDocumentRevisionInfo | null) {
        return info?.token === undefined ? {} : {documentRevisionToken: info.token};
    }

    function createCommandTarget(viewTabId: string, mode: 'current' | 'active-transaction' = 'current'): TWorkspaceCommandTarget {
        const current = snapshot.value;
        const common = {
            tabId: requireTabId(viewTabId),
            sessionId: requireSessionId(current.sessionId),
            documentRef: current.identity.documentRef,
            ...getTargetDocumentBackend(current.identity.documentRef),
            documentInstanceId: current.identity.documentInstanceId,
            ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
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
        const mismatch = [
            [
                !views.value.has(target.tabId),
                'tab-id-mismatch',
            ],
            [
                target.sessionId !== current.sessionId,
                'session-id-mismatch',
            ],
            [
                (target.documentInstanceId ?? null) !== current.identity.documentInstanceId,
                'document-instance-id-mismatch',
            ],
            [
                target.documentRef !== current.identity.documentRef,
                'document-ref-mismatch',
            ],
            [
                target.documentBackend !== undefined
                && target.documentBackend !== resolveDocumentRefBackend(current.identity.documentRef),
                'document-backend-mismatch',
            ],
            [
                target.documentRevisionToken !== undefined
                && target.documentRevisionToken !== current.identity.revisionInfo?.token,
                'document-revision-token-mismatch',
            ],
            [
                target.kind === 'transaction'
                    ? current.activeTransaction?.id !== target.transactionId
                    : target.sessionRevision !== current.sessionRevision,
                target.kind === 'transaction' ? 'transaction-id-mismatch' : 'session-revision-mismatch',
            ],
        ] as const;
        const failed = mismatch.find(([isMismatch]) => isMismatch);
        return failed
            ? {
                ok: false,
                reason: failed[1],
            }
            : {ok: true};
    }

    addView(tabId);
    if (options.assignment) {
        assign(options.assignment);
    }

    return {
        snapshot,
        views,
        operationLease,
        assign,
        claimOpen,
        runOpen,
        setOpeningLabel,
        commitDocument,
        markPresented,
        markFailed,
        reportFailure,
        dismissFailure,
        setDirty,
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
}
