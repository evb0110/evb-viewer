import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
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
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceOpenFailure,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import { requireSessionId } from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
    IWorkspaceDocumentTransaction,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';

export type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTarget,
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
}

/**
 * The per-tab owner of document identity, phase, dirty state and the commands
 * that reach the tab's workspace. The shell reads its snapshot; the mounted
 * workspace writes it through these methods.
 */
export interface IWorkspaceDocumentController {
    readonly tabId: string;
    readonly snapshot: Readonly<ShallowRef<IWorkspaceDocumentSnapshot>>;
    readonly toolbarSnapshot: Readonly<ShallowRef<IWorkspaceToolbarSnapshot>>;
    readonly viewState: Readonly<ShallowRef<ITabViewSessionState>>;
    readonly mountedWorkspace: Readonly<ShallowRef<IWorkspaceExpose | null>>;
    readonly operationLease: IDocumentOperationLease;
    assign(document: TWorkspaceDocumentAssignment): void;
    runOpen(request: IWorkspaceOpenRequest, run: () => Promise<boolean>): Promise<boolean>;
    setOpeningLabel(label: string | null): void;
    commitDocument(document: IWorkspaceCommittedDocument): void;
    markPresented(): void;
    markFailed(failure: IWorkspaceOpenFailure | null): void;
    dismissFailure(): void;
    setDirty(dirty: boolean): void;
    publishToolbarSnapshot(snapshot: IWorkspaceToolbarSnapshot): void;
    applyViewState(state: ITabViewSessionState): void;
    attachWorkspace(workspace: IWorkspaceExpose): void;
    detachWorkspace(workspace: IWorkspaceExpose): void;
    whenMounted(): Promise<IWorkspaceExpose | null>;
    close(request: {persist: boolean}): Promise<boolean>;
    dispose(): void;
    createCommandTarget(mode?: 'current' | 'active-transaction'): TWorkspaceCommandTarget;
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

/** The tab holds a document or is opening or closing one. A tab whose open failed is empty again. */
export function snapshotOccupiesTab(snapshot: IWorkspaceDocumentSnapshot) {
    return identityHasDocument(snapshot.identity) || snapshot.phase === 'opening' || snapshot.phase === 'closing';
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
}): IWorkspaceDocumentController {
    const tabId = options.tabId;
    nextSessionIndex += 1;
    const sessionId = requireSessionId(`workspace-document-session:${tabId}:${Date.now()}:${nextSessionIndex}`);
    const snapshot = shallowRef<IWorkspaceDocumentSnapshot>({
        tabId,
        sessionId,
        sessionRevision: 0,
        phase: 'empty',
        identity: createEmptyIdentity(),
        activeTransaction: null,
        openingLabel: null,
        failure: null,
        dirty: false,
        recoveryWorkingCopyPath: null,
        mounted: false,
    });
    const toolbarSnapshot = shallowRef(createDefaultWorkspaceToolbarSnapshot());
    const viewState = shallowRef(createTabViewSessionState(toolbarSnapshot.value));
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
    const operationLease = createDocumentOperationLease();
    const mountWaiters = new Set<(workspace: IWorkspaceExpose | null) => void>();
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

    function runOpen(request: IWorkspaceOpenRequest, run: () => Promise<boolean>) {
        supersedeActiveTransaction();
        nextTransactionIndex += 1;
        const transaction: IWorkspaceDocumentTransaction = {
            id: `workspace-document-transaction:${tabId}:${request.kind}:${nextTransactionIndex}`,
            kind: request.kind,
            target: request.target,
            acceptDocumentWithoutVisual: request.acceptDocumentWithoutVisual === true,
        };
        const settled = Promise.withResolvers<boolean>();
        settleWaiters.set(transaction.id, settled);
        update({
            phase: 'opening',
            activeTransaction: transaction,
            openingLabel: null,
            failure: null,
        }, true);
        const isActive = () => snapshot.value.activeTransaction?.id === transaction.id;
        // The open ends when the viewer presents or fails, or when a newer
        // open or a close takes the tab, even if the source is still loading.
        run().then((accepted) => {
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
        const identity = {
            ...next,
            documentSessionKey: sameLogicalDocument
                ? current.documentSessionKey
                : createDocumentSessionKey(tabId, next.documentRef),
            documentInstanceId: sameLogicalDocument
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
        // A new open is a new document instance even for the same file;
        // a restore resumes the instance the tab already owned.
        update({
            phase: 'presented',
            activeTransaction: null,
            openingLabel: null,
            failure: null,
            recoveryWorkingCopyPath: null,
            ...(transaction.kind === 'open'
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
        if (!transaction) {
            return;
        }
        update({
            phase: failure ? 'failed' : restingPhase(),
            activeTransaction: null,
            openingLabel: null,
            failure: failure
                ? {
                    ...failure,
                    fileName: transaction.target?.fileName ?? null,
                }
                : null,
        }, true);
        settle(transaction, false);
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

    function publishToolbarSnapshot(next: IWorkspaceToolbarSnapshot) {
        if (!isEqual(toolbarSnapshot.value, next)) {
            toolbarSnapshot.value = next;
        }
    }

    function applyViewState(state: ITabViewSessionState) {
        if (!isEqual(viewState.value, state)) {
            viewState.value = state;
        }
    }

    function attachWorkspace(workspace: IWorkspaceExpose) {
        mountedWorkspace.value = workspace;
        update({mounted: true});
        for (const resolve of mountWaiters) {
            resolve(workspace);
        }
        mountWaiters.clear();
    }

    function detachWorkspace(workspace: IWorkspaceExpose) {
        if (mountedWorkspace.value !== workspace) {
            return;
        }
        mountedWorkspace.value = null;
        // An open cannot outlive the view that runs it; the next mount
        // restores the tab's document from its identity.
        const transaction = snapshot.value.activeTransaction;
        if (transaction && transaction.kind !== 'close') {
            update({
                phase: restingPhase(),
                activeTransaction: null,
                openingLabel: null,
            }, true);
            settle(transaction, false);
        }
        update({mounted: false});
    }

    function whenMounted() {
        if (mountedWorkspace.value) {
            return Promise.resolve(mountedWorkspace.value);
        }
        return new Promise<IWorkspaceExpose | null>((resolve) => {
            mountWaiters.add(resolve);
        });
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
        const workspace = mountedWorkspace.value;
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
        for (const resolve of mountWaiters) {
            resolve(null);
        }
        mountWaiters.clear();
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

    function createCommandTarget(mode: 'current' | 'active-transaction' = 'current'): TWorkspaceCommandTarget {
        const current = snapshot.value;
        const common = {
            tabId: requireTabId(current.tabId),
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
                target.tabId !== current.tabId,
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

    if (options.assignment) {
        assign(options.assignment);
    }

    return {
        tabId,
        snapshot,
        toolbarSnapshot,
        viewState,
        mountedWorkspace,
        operationLease,
        assign,
        runOpen,
        setOpeningLabel,
        commitDocument,
        markPresented,
        markFailed,
        dismissFailure,
        setDirty,
        publishToolbarSnapshot,
        applyViewState,
        attachWorkspace,
        detachWorkspace,
        whenMounted,
        close,
        dispose,
        createCommandTarget,
        validateCommandTarget,
    };
}
