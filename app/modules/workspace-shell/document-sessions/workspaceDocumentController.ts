import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    requireDocumentInstanceId,
    type TDocumentInstanceId,
} from '@contracts/documentInstanceId';
import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import type { TTabUpdate } from '@app/types/tabs';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import {
    areDocumentRevisionInfosEqual,
    areWorkspaceDocumentRecordsEqual,
    createPendingWorkspaceViewState,
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
    type TWorkspaceDocumentTabState,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { areSessionSnapshotsEqual } from '@app/modules/workspace-shell/document-sessions/areSessionSnapshotsEqual';
import {
    getWorkspaceViewerCapabilitiesForDocumentType,
    hasWorkspaceViewerDocumentCapabilities,
} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { tabHasDocumentHint } from '@app/modules/workspace-shell/tabs/tabHasDocumentHint';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { resolveWorkspaceTabUpdate } from '@app/modules/workspace-shell/state/resolveWorkspaceTabUpdate';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import type { TWorkspaceCommandTarget } from '@app/modules/workspace-shell/document-sessions/workspaceCommandTarget';
import type { IDocumentOpenIntent } from '@app/modules/workspace-shell/document-sessions/documentOpenIntent';
import { requireSessionId } from '@contracts/shared';
import { requireTabId } from '@contracts/windowTabs';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import {
    createWorkspaceDocumentOpenTransactions,
    type IWorkspaceDocumentOpenHost,
} from '@app/modules/workspace-shell/host/deferredWorkspaceHostDocumentOpen';

import type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTransaction,
    TWorkspaceDocumentPhase,
    TWorkspaceDocumentTransactionKind,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';

export type {
    IWorkspaceDocumentIdentity,
    IWorkspaceDocumentSnapshot,
    IWorkspaceDocumentTransaction,
};
export interface IDocumentOperationLease {
    activeKind: Ref<TDocumentOperationKind | null>;
    isBusy: ComputedRef<boolean>;
    runExclusive: <T>(kind: TDocumentOperationKind, operation: () => Promise<T>) => Promise<T>;
}
interface IOpenBatchProgress {
    processed: number;
    total: number;
}
interface IWorkspaceProjectionBinding {
    pendingDocumentPath: Ref<TDocumentRef | null | undefined>;
    openBatchProgress: Ref<IOpenBatchProgress | null | undefined>;
    hasPdf: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    documentIdentity: Ref<IDocumentRevisionInfo | null>;
    isDirty: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    toolbarSnapshot: Ref<IWorkspaceToolbarSnapshot>;
    currentViewState?: Ref<ITabViewSessionState | null | undefined> | undefined;
    formatPendingBatchLabel: (values: IOpenBatchProgress) => string;
    publishRecord: (record: IWorkspaceDocumentRecord) => void;
}
export interface IWorkspaceDocumentController {
    readonly tabId: string;
    readonly snapshot: Readonly<Ref<IWorkspaceDocumentSnapshot>>;
    readonly mountedWorkspace: ShallowRef<IWorkspaceExpose | null>;
    readonly operationLease: IDocumentOperationLease;
    beginTransaction(input: Omit<IWorkspaceDocumentTransaction, 'id' | 'tabId' | 'startedAt'>): IWorkspaceDocumentTransaction;
    finishTransaction(id: string, result: 'committed' | 'cancelled' | 'failed'): void;
    open<T>(intent: IDocumentOpenIntent, run: (signal: AbortSignal) => Promise<T>): Promise<T | false>;
    restore<T>(intent: IDocumentOpenIntent, run: (signal: AbortSignal) => Promise<T>): Promise<T | false>;
    reload<T>(intent: IDocumentOpenIntent, run: (signal: AbortSignal) => Promise<T>): Promise<T | false>;
    attachOpenTransactionHost(host: IWorkspaceDocumentOpenHost): () => void;
    requestDocumentPage(page: number): void;
    close(request: {persist: boolean}): Promise<boolean>;
    applyTabUpdate(updates: TTabUpdate): void;
    applyWorkspaceRecord(record: IWorkspaceDocumentRecord, source: 'host' | 'workspace'): void;
    applyRevisionInfo(info: IDocumentRevisionInfo | null): void;
    applyViewState(state: ITabViewSessionState): void;
    bindWorkspaceProjection(options: IWorkspaceProjectionBinding): void;
    attachWorkspace(workspace: IWorkspaceExpose): void;
    detachWorkspace(workspace?: IWorkspaceExpose): void;
    waitForWorkspace(target: TWorkspaceCommandTarget, timeoutMs?: number): Promise<IWorkspaceExpose | null>;
    createCommandTarget(mode?: 'current' | 'active-transaction'): TWorkspaceCommandTarget;
    validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    };
    toWorkspaceRecord(): IWorkspaceDocumentRecord;
}
interface ICreateWorkspaceDocumentControllerOptions {
    tabId: string;
    sessionId?: string;
    initialRecord?: IWorkspaceDocumentRecord | null;
    initialTab?: TTabUpdate | TWorkspaceDocumentTabState | null;
    initialViewState?: ITabViewSessionState | null;
    now?: () => number;
    createSessionId?: (tabId: string) => string;
    createTransactionId?: (input: {
        tabId: string;
        kind: TWorkspaceDocumentTransactionKind;
        nextTransactionIndex: number;
    }) => string;
    createDocumentSessionKey?: (input: {
        tabId: string;
        nextDocumentSessionIndex: number;
        documentRef: string | null;
    }) => string;
    createDocumentInstanceId?: () => TDocumentInstanceId;
    workspaceWaitTimeoutMs?: number;
}
interface IWorkspaceWaiter {
    target: TWorkspaceCommandTarget;
    resolve: (workspace: IWorkspaceExpose | null) => void;
    timer: ReturnType<typeof setTimeout>;
}
// A native opening preview keeps a large PDF usable while the page-tree check,
// source setup, and PDF.js first render finish. Leave enough time for slow file
// transports so the controller does not abort a visible open into a second tab.
const DEFAULT_DOCUMENT_OPEN_STAGE_TIMEOUT_MS = 120_000;
let nextSessionIndex = 0;
let nextGlobalDocumentSessionKeyIndex = 0;
function createDefaultSessionId(tabId: string) {
    nextSessionIndex += 1;
    return `workspace-document-session:${tabId}:${Date.now()}:${nextSessionIndex}`;
}
function createDefaultTransactionId(input: {
    tabId: string;
    kind: TWorkspaceDocumentTransactionKind;
    nextTransactionIndex: number;
}) {
    return `workspace-document-transaction:${input.tabId}:${input.kind}:${Date.now()}:${input.nextTransactionIndex}`;
}

function createDefaultDocumentSessionKey(input: {
    tabId: string;
    nextDocumentSessionIndex: number;
    documentRef: string | null;
}) {
    nextGlobalDocumentSessionKeyIndex += 1;
    return [
        'workspace-document-instance',
        input.tabId,
        Date.now(),
        input.nextDocumentSessionIndex,
        nextGlobalDocumentSessionKeyIndex,
        input.documentRef ?? 'unknown',
    ].join(':');
}

function createDefaultDocumentInstanceId() {
    return requireDocumentInstanceId(crypto.randomUUID());
}

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

function getLogicalDocumentSignature(identity: IWorkspaceDocumentIdentity) {
    const sourceRef = identity.originalPath
        ?? identity.revisionInfo?.documentRef
        ?? identity.documentRef
        ?? identity.workingCopyPath
        ?? null;
    if (!sourceRef && !identity.fileName && !identity.isDjvu) {
        return null;
    }
    return JSON.stringify({
        sourceRef,
        fallbackName: sourceRef ? null : identity.fileName,
        isDjvu: identity.isDjvu,
    });
}

function normalizeIdentityFromRecord(
    record: IWorkspaceDocumentRecord,
    previous: IWorkspaceDocumentIdentity,
    createDocumentSessionKey: (documentRef: string | null) => string,
    createDocumentInstanceId: () => TDocumentInstanceId,
    activeTransactionKind: TWorkspaceDocumentTransactionKind | null = null,
): IWorkspaceDocumentIdentity {
    const revisionInfo = record.documentIdentity;
    const hasDocument = revisionInfo !== null
        || record.tab.originalPath !== null
        || record.tab.fileName !== null
        || record.tab.isDjvu;

    if (!hasDocument) {
        return createEmptyIdentity();
    }

    const nextIdentity = {
        documentSessionKey: null,
        documentInstanceId: null,
        documentRef: revisionInfo?.documentRef ?? record.tab.originalPath ?? previous.documentRef,
        originalPath: record.tab.originalPath ?? null,
        workingCopyPath: revisionInfo?.documentRef ?? previous.workingCopyPath,
        fileName: record.tab.fileName ?? null,
        isDjvu: record.tab.isDjvu,
        revisionInfo,
    } satisfies IWorkspaceDocumentIdentity;
    const previousSignature = getLogicalDocumentSignature(previous);
    const nextSignature = getLogicalDocumentSignature(nextIdentity);
    const shouldPreserveLogicalIdentity = previous.documentSessionKey && previousSignature === nextSignature;
    const shouldMintDocumentInstance = (
        activeTransactionKind === 'open'
        || activeTransactionKind === 'restore'
        || activeTransactionKind === 'reload'
    )
        && !record.toolbarSnapshot.isOpeningDocument
        && !record.toolbarSnapshot.hasOpenError;
    const explicitDocumentInstanceId = record.tab.documentInstanceId ?? null;
    return {
        ...nextIdentity,
        documentSessionKey: shouldPreserveLogicalIdentity
            ? previous.documentSessionKey
            : createDocumentSessionKey(nextIdentity.documentRef),
        documentInstanceId: shouldMintDocumentInstance
            ? createDocumentInstanceId()
            : explicitDocumentInstanceId
                ?? (shouldPreserveLogicalIdentity ? previous.documentInstanceId : null)
                ?? createDocumentInstanceId(),
    };
}

function areIdentitiesEqual(
    first: IWorkspaceDocumentIdentity,
    second: IWorkspaceDocumentIdentity,
) {
    return first.documentSessionKey === second.documentSessionKey
        && first.documentInstanceId === second.documentInstanceId
        && first.documentRef === second.documentRef
        && first.originalPath === second.originalPath
        && first.workingCopyPath === second.workingCopyPath
        && first.fileName === second.fileName
        && first.isDjvu === second.isDjvu
        && areDocumentRevisionInfosEqual(first.revisionInfo, second.revisionInfo);
}

function createInitialRecord(options: ICreateWorkspaceDocumentControllerOptions) {
    return options.initialRecord
        ? createWorkspaceDocumentRecord(options.initialRecord)
        : createWorkspaceDocumentRecord({
            tab: options.initialTab ?? undefined,
            viewState: options.initialViewState ?? undefined,
        });
}

function resolvePhaseFromRecord(
    record: IWorkspaceDocumentRecord,
    activeTransaction: IWorkspaceDocumentTransaction | null,
    previousPhase?: TWorkspaceDocumentPhase,
): TWorkspaceDocumentPhase {
    if (activeTransaction?.kind === 'close') {
        return 'closing';
    }

    if (record.toolbarSnapshot.hasOpenError) {
        return 'error';
    }

    if (record.toolbarSnapshot.isOpeningDocument) {
        return activeTransaction?.kind === 'restore' ? 'restoring' : 'opening';
    }

    if (previousPhase === 'error' && !activeTransaction && !record.toolbarSnapshot.initialVisualReady) {
        return 'error';
    }

    if (activeTransaction?.kind === 'reload') {
        return 'reloading';
    }

    if (
        record.toolbarSnapshot.initialVisualReady
        && hasWorkspaceViewerDocumentCapabilities(record.toolbarSnapshot.viewerCapabilities)
    ) {
        return 'ready';
    }

    return 'empty';
}

function resolvePhaseForTransaction(kind: TWorkspaceDocumentTransactionKind): TWorkspaceDocumentPhase {
    if (kind === 'restore') {
        return 'restoring';
    }

    if (kind === 'reload') {
        return 'reloading';
    }

    if (kind === 'close') {
        return 'closing';
    }

    return 'opening';
}

function createSnapshotFromRecord(options: {
    tabId: string;
    sessionId: string;
    sessionRevision: number;
    record: IWorkspaceDocumentRecord;
    mounted: boolean;
    createDocumentSessionKey: (documentRef: string | null) => string;
    createDocumentInstanceId: () => TDocumentInstanceId;
}) {
    const identity = normalizeIdentityFromRecord(
        options.record,
        createEmptyIdentity(),
        options.createDocumentSessionKey,
        options.createDocumentInstanceId,
    );
    return {
        tabId: options.tabId,
        sessionId: options.sessionId,
        sessionRevision: options.sessionRevision,
        phase: resolvePhaseFromRecord(options.record, null),
        identity,
        activeTransaction: null,
        mounted: options.mounted,
        toolbarSnapshot: options.record.toolbarSnapshot,
        viewState: options.record.viewState,
        dirty: options.record.tab.isDirty,
        closeable: hasWorkspaceViewerDocumentCapabilities(options.record.toolbarSnapshot.viewerCapabilities),
        pendingDocumentPath: null,
        pendingClose: null,
    } satisfies IWorkspaceDocumentSnapshot;
}

function isDocumentRevisionTokenEqual(
    target: TWorkspaceCommandTarget,
    actual: IDocumentRevisionInfo | null,
) {
    if (target.documentRevisionToken === undefined) {
        return true;
    }

    return actual?.token === target.documentRevisionToken;
}

function getTargetDocumentRevisionToken(info: IDocumentRevisionInfo | null) {
    return info?.token === undefined ? {} : {documentRevisionToken: info.token};
}

function getTargetDocumentInstanceId(identity: IWorkspaceDocumentIdentity) {
    return {documentInstanceId: identity.documentInstanceId};
}

function getTargetDocumentBackend(documentRef: string | null) {
    const parsedDocumentRef = parseDocumentRef(documentRef);
    const documentBackend = parsedDocumentRef === null
        ? undefined
        : resolveDocumentRefBackend(parsedDocumentRef);
    return documentBackend === undefined ? {} : {documentBackend};
}

function createImmediateSerializedTransactionQueue() {
    let tail: Promise<unknown> = Promise.resolve();
    let depth = 0;

    return async function enqueue<T>(run: () => Promise<T>): Promise<T> {
        const queuedRun = depth === 0
            ? run()
            : tail.catch(() => undefined).then(run);
        depth += 1;
        tail = queuedRun.catch(() => undefined);
        try {
            return await queuedRun;
        } finally {
            depth = Math.max(0, depth - 1);
        }
    };
}

function createDocumentOperationLease(): IDocumentOperationLease {
    const activeKind = ref<TDocumentOperationKind | null>(null);
    const pendingCount = ref(0);
    let queueTail: Promise<void> = Promise.resolve();

    async function runExclusive<T>(kind: TDocumentOperationKind, operation: () => Promise<T>) {
        pendingCount.value += 1;
        const previousTail = queueTail;
        const operationPromise = previousTail
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

export function createWorkspaceDocumentController(
    options: ICreateWorkspaceDocumentControllerOptions,
): IWorkspaceDocumentController {
    const now = options.now ?? Date.now;
    const sessionId = requireSessionId(
        options.sessionId ?? options.createSessionId?.(options.tabId) ?? createDefaultSessionId(options.tabId),
    );
    const workspaceWaitTimeoutMs = options.workspaceWaitTimeoutMs ?? DEFAULT_DOCUMENT_OPEN_STAGE_TIMEOUT_MS;
    const createDocumentInstanceId = options.createDocumentInstanceId ?? createDefaultDocumentInstanceId;
    const mountedWorkspace = shallowRef<IWorkspaceExpose | null>(null);
    const operationLease = createDocumentOperationLease();
    const enqueueTransaction = createImmediateSerializedTransactionQueue();
    let nextDocumentSessionIndex = 0;

    function createDocumentSessionKey(documentRef: string | null) {
        nextDocumentSessionIndex += 1;
        return options.createDocumentSessionKey?.({
            tabId: options.tabId,
            nextDocumentSessionIndex,
            documentRef,
        }) ?? createDefaultDocumentSessionKey({
            tabId: options.tabId,
            nextDocumentSessionIndex,
            documentRef,
        });
    }

    const initialRecord = createInitialRecord(options);
    const snapshot = ref<IWorkspaceDocumentSnapshot>(createSnapshotFromRecord({
        tabId: options.tabId,
        sessionId,
        sessionRevision: 0,
        record: initialRecord,
        mounted: false,
        createDocumentSessionKey,
        createDocumentInstanceId,
    }));
    const openTransactions = createWorkspaceDocumentOpenTransactions({
        tabId: options.tabId,
        mountedWorkspace,
    });
    let openTransactionEpoch = 0;
    let activeOpenAbortController: AbortController | null = null;
    let activeClosePromise: Promise<boolean> | null = null;
    const waiters = new Set<IWorkspaceWaiter>();
    let nextTransactionIndex = 0;
    let closeRecordFenceActive = false;
    // The revision at which the current dirty state was asserted. A clean
    // record that still carries this revision (or none) is a projection that
    // lags the dirty bytes; a save mints a newer revision before it publishes
    // the clean flag, so a clean record at a newer revision is trusted.
    let dirtyRevisionInfo: IDocumentRevisionInfo | null = null;

    function updateSnapshot(
        updater: (current: IWorkspaceDocumentSnapshot) => IWorkspaceDocumentSnapshot,
        options: {incrementSessionRevision?: boolean} = {},
    ) {
        const current = snapshot.value;
        const next = updater(current);
        const nextSnapshot = {
            ...next,
            sessionRevision: options.incrementSessionRevision === true
                ? current.sessionRevision + 1
                : next.sessionRevision,
        };
        if (areSessionSnapshotsEqual(current, nextSnapshot)) {
            return false;
        }

        snapshot.value = nextSnapshot;
        if (!nextSnapshot.dirty) {
            dirtyRevisionInfo = null;
        } else if (!current.dirty || dirtyRevisionInfo === null) {
            dirtyRevisionInfo = nextSnapshot.identity.revisionInfo;
        }
        rejectStaleWaiters();
        return true;
    }

    function resolveWaiter(waiter: IWorkspaceWaiter, workspace: IWorkspaceExpose | null) {
        if (!waiters.has(waiter)) {
            return;
        }

        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(validateCommandTarget(waiter.target).ok ? workspace : null);
    }

    function rejectStaleWaiters() {
        for (const waiter of [...waiters]) {
            if (!validateCommandTarget(waiter.target).ok) {
                resolveWaiter(waiter, null);
            }
        }
    }

    function resolveAllWaiters(workspace: IWorkspaceExpose | null) {
        for (const waiter of [...waiters]) {
            resolveWaiter(waiter, workspace);
        }
    }

    function beginTransaction(
        input: Omit<IWorkspaceDocumentTransaction, 'id' | 'tabId' | 'startedAt'>,
    ): IWorkspaceDocumentTransaction {
        const supersededTransaction = snapshot.value.activeTransaction;
        if (supersededTransaction) {
            finishTransaction(supersededTransaction.id, 'cancelled');
        }

        nextTransactionIndex += 1;
        const transaction: IWorkspaceDocumentTransaction = {
            ...input,
            id: options.createTransactionId?.({
                tabId: options.tabId,
                kind: input.kind,
                nextTransactionIndex,
            }) ?? createDefaultTransactionId({
                tabId: options.tabId,
                kind: input.kind,
                nextTransactionIndex,
            }),
            tabId: options.tabId,
            startedAt: now(),
        };
        if (transaction.kind !== 'close') {
            closeRecordFenceActive = false;
        } else {
            closeRecordFenceActive = true;
        }

        updateSnapshot(current => ({
            ...current,
            phase: resolvePhaseForTransaction(transaction.kind),
            activeTransaction: transaction,
            pendingDocumentPath: transaction.documentRef,
            pendingClose: transaction.kind === 'close'
                ? {
                    persist: transaction.persist ?? true,
                    target: {
                        kind: 'transaction',
                        tabId: requireTabId(options.tabId),
                        sessionId,
                        documentRef: transaction.documentRef,
                        ...getTargetDocumentBackend(transaction.documentRef),
                        ...getTargetDocumentInstanceId(current.identity),
                        transactionId: transaction.id,
                        ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
                    },
                }
                : null,
        }), {incrementSessionRevision: true});

        return transaction;
    }

    function finishTransaction(id: string, result: 'committed' | 'cancelled' | 'failed') {
        if (snapshot.value.activeTransaction?.id !== id) {
            return;
        }

        const finishingClose = snapshot.value.activeTransaction.kind === 'close';
        const closedDocument = finishingClose && result === 'committed';
        if (finishingClose && !closedDocument) {
            closeRecordFenceActive = false;
        }
        updateSnapshot((current) => {
            if (closedDocument) {
                // The close call's own verdict is the only untainted signal that
                // the document is gone. The mounted workspace keeps publishing a
                // document-shaped record for as long as the host's pending-document
                // hint is alive, and that hint is derived from this record, so
                // waiting for the workspace to report emptiness never terminates.
                const emptyRecord = createWorkspaceDocumentRecord();
                return {
                    ...current,
                    phase: 'empty' as const,
                    identity: createEmptyIdentity(),
                    activeTransaction: null,
                    pendingDocumentPath: null,
                    pendingClose: null,
                    toolbarSnapshot: emptyRecord.toolbarSnapshot,
                    viewState: createTabViewSessionState(emptyRecord.toolbarSnapshot),
                    dirty: false,
                    closeable: false,
                };
            }

            const record = createWorkspaceDocumentRecord({
                tab: {
                    fileName: current.identity.fileName,
                    originalPath: current.identity.originalPath,
                    documentInstanceId: current.identity.documentInstanceId,
                    isDirty: current.dirty,
                    isDjvu: current.identity.isDjvu,
                },
                documentIdentity: current.identity.revisionInfo,
                toolbarSnapshot: current.toolbarSnapshot,
                viewState: current.viewState,
            });
            return {
                ...current,
                phase: result === 'failed'
                    ? 'error'
                    : resolvePhaseFromRecord(record, null),
                activeTransaction: null,
                pendingDocumentPath: null,
                pendingClose: null,
            };
        }, {incrementSessionRevision: true});
    }

    function applyWorkspaceRecord(record: IWorkspaceDocumentRecord, source: 'host' | 'workspace' = 'workspace') {
        const normalizedRecord = createWorkspaceDocumentRecord(record);
        const hasIncomingDocument = normalizedRecord.documentIdentity !== null
            || normalizedRecord.tab.originalPath !== null
            || normalizedRecord.tab.fileName !== null
            || normalizedRecord.tab.isDjvu;
        const activeKind = snapshot.value.activeTransaction?.kind ?? null;
        const incomingWorkingCopyPath = normalizedRecord.documentIdentity?.documentRef ?? null;
        const sameLogicalDocument = Boolean(
            snapshot.value.identity.originalPath
            && normalizedRecord.tab.originalPath === snapshot.value.identity.originalPath
            && (
                incomingWorkingCopyPath === snapshot.value.identity.workingCopyPath
                || incomingWorkingCopyPath === null
            ),
        );
        const sameIdentityLessDocument = normalizedRecord.documentIdentity === null
            && normalizedRecord.tab.originalPath === snapshot.value.identity.originalPath;
        const cleanRecordLagsDirtyState = areDocumentRevisionInfosEqual(
            dirtyRevisionInfo,
            normalizedRecord.documentIdentity,
        );
        const preserveDirtyDuringRestore = (
            (activeKind === 'restore' || activeKind === null)
            && snapshot.value.dirty
            && !normalizedRecord.tab.isDirty
            && normalizedRecord.toolbarSnapshot.isOpeningDocument
            && normalizedRecord.tab.originalPath === snapshot.value.identity.originalPath
            && (cleanRecordLagsDirtyState || normalizedRecord.documentIdentity === null)
        );
        if (
            source === 'workspace'
            && (
                preserveDirtyDuringRestore
                || (
                    activeKind === null
                    && snapshot.value.dirty
                    && !normalizedRecord.tab.isDirty
                    && sameLogicalDocument
                    && (cleanRecordLagsDirtyState || sameIdentityLessDocument)
                )
            )
        ) {
            // A pending restore or same-generation adoption record can lag the
            // recovery open. It must not turn retained unsaved bytes into a
            // clean document. A successful recovery publishes dirty=true. A
            // save mints a new revision first and publishes the clean flag at
            // that revision afterwards, so only a clean record at the revision
            // where dirty was asserted is a lag. Close clears identity.
            return;
        }
        if (
            !hasIncomingDocument
            && getLogicalDocumentSignature(snapshot.value.identity) !== null
            && activeKind === null
            && !closeRecordFenceActive
        ) {
            // A freshly mounted DocumentWorkspace publishes its empty initial
            // record before restoring the host-owned document session. Pane
            // reparenting and inactive-tab cooling can both expose that mount
            // boundary. Only an explicit close/open transaction may clear a
            // live identity; otherwise this transient record would relabel the
            // tab as New Tab and destroy the source needed for restoration.
            return;
        }
        if (
            closeRecordFenceActive
            && hasIncomingDocument
            && activeKind !== 'open'
            && activeKind !== 'restore'
            && activeKind !== 'reload'
        ) {
            return;
        }
        if (
            !snapshot.value.activeTransaction
            && areWorkspaceDocumentRecordsEqual(toWorkspaceRecord(), normalizedRecord)
        ) {
            return;
        }

        const nextIdentity = normalizeIdentityFromRecord(
            normalizedRecord,
            snapshot.value.identity,
            createDocumentSessionKey,
            createDocumentInstanceId,
            activeKind,
        );
        updateSnapshot((current) => {
            return {
                ...current,
                identity: nextIdentity,
                phase: resolvePhaseFromRecord(normalizedRecord, current.activeTransaction, current.phase),
                toolbarSnapshot: normalizedRecord.toolbarSnapshot,
                viewState: normalizedRecord.viewState,
                dirty: normalizedRecord.tab.isDirty,
                closeable: hasWorkspaceViewerDocumentCapabilities(normalizedRecord.toolbarSnapshot.viewerCapabilities),
                pendingDocumentPath: current.activeTransaction?.documentRef ?? null,
            };
        }, {incrementSessionRevision: !areIdentitiesEqual(
            snapshot.value.identity,
            nextIdentity,
        )});
    }

    function applyTabUpdate(updates: TTabUpdate) {
        const current = toWorkspaceRecord();
        const tab = {
            fileName: updates.fileName ?? current.tab.fileName,
            originalPath: updates.originalPath ?? current.tab.originalPath,
            documentInstanceId: updates.documentInstanceId
                ?? current.tab.documentInstanceId
                ?? null,
            isDirty: updates.isDirty ?? current.tab.isDirty,
            isDjvu: updates.isDjvu ?? current.tab.isDjvu,
        };
        if (tabHasDocumentHint(tab)) {
            // The shell assigning a file to this tab starts a new document
            // lifecycle, so the previous close's fence has nothing left to
            // reject. Leaving it armed would silently drop this document and
            // every workspace record that follows it.
            closeRecordFenceActive = false;
        }
        const pending = tabHasDocumentHint(tab)
            && current.toolbarSnapshot.hasPdf !== true
            && !hasWorkspaceViewerDocumentCapabilities(current.toolbarSnapshot.viewerCapabilities);
        applyWorkspaceRecord(pending
            ? createPendingWorkspaceDocumentRecord(
                tab,
                {
                    previousToolbarSnapshot: current.toolbarSnapshot,
                    previousViewState: current.viewState,
                },
            )
            : createWorkspaceDocumentRecord({
                tab,
                documentIdentity: current.documentIdentity,
                toolbarSnapshot: current.toolbarSnapshot,
                viewState: current.viewState,
            }));
    }

    function applyRevisionInfo(info: IDocumentRevisionInfo | null) {
        if (snapshot.value.identity.revisionInfo?.token === info?.token) {
            return;
        }

        updateSnapshot(current => ({
            ...current,
            identity: {
                ...current.identity,
                documentSessionKey: current.identity.documentSessionKey
                    ?? (info ? createDocumentSessionKey(info.documentRef) : null),
                documentInstanceId: current.identity.documentInstanceId
                    ?? (info ? createDocumentInstanceId() : null),
                documentRef: info?.documentRef ?? current.identity.originalPath,
                workingCopyPath: info?.documentRef ?? null,
                revisionInfo: info,
            },
        }), {incrementSessionRevision: true});
    }

    function applyViewState(state: ITabViewSessionState) {
        updateSnapshot(current => ({
            ...current,
            viewState: state,
        }));
    }

    function bindWorkspaceProjection(binding: IWorkspaceProjectionBinding) {
        function resolvePendingOpenDisplayName(): string | null {
            const progress = binding.openBatchProgress.value;
            if (!progress || progress.total <= 0) {
                return null;
            }
            return binding.formatPendingBatchLabel({
                processed: clamp(progress.processed, 0, progress.total),
                total: progress.total,
            });
        }

        const record = computed(() => {
            const pendingHint = binding.pendingDocumentPath.value
                ? buildPendingTabDocumentHint(binding.pendingDocumentPath.value)
                : null;
            // A PDF's managed working copy becomes available before the open
            // flow commits its original path. Keep the source hint authoritative
            // across that gap so `document.pdf` cannot leak into the shell.
            const pending = Boolean(
                pendingHint
                && !binding.isDjvuMode.value
                && (
                    !binding.hasPdf.value
                    || binding.originalPath.value === null
                ),
            );
            const tab = pending && pendingHint
                ? {
                    fileName: resolvePendingOpenDisplayName() ?? pendingHint.fileName ?? null,
                    originalPath: pendingHint.originalPath ?? null,
                    isDirty: binding.isDirty.value,
                    isDjvu: pendingHint.isDjvu ?? false,
                }
                : resolveWorkspaceTabUpdate({
                    fileName: binding.fileName.value,
                    pendingOpenDisplayName: resolvePendingOpenDisplayName(),
                    originalPath: binding.originalPath.value,
                    isDirty: binding.isDirty.value,
                    isDjvuMode: binding.isDjvuMode.value,
                    djvuSourcePath: binding.djvuSourcePath.value,
                });
            const toolbarSnapshot = pending && pendingHint
                ? {
                    ...binding.toolbarSnapshot.value,
                    hasPdf: true,
                    isDjvuMode: pendingHint.isDjvu ?? false,
                    isOpeningDocument: true,
                    viewerCapabilities: getWorkspaceViewerCapabilitiesForDocumentType(
                        pendingHint.isDjvu ? 'djvu' : 'pdf',
                    ),
                }
                : binding.toolbarSnapshot.value;
            const viewState = pending
                ? createPendingWorkspaceViewState(toolbarSnapshot)
                : createTabViewSessionState(
                    toolbarSnapshot,
                    binding.currentViewState?.value,
                );
            return createWorkspaceDocumentRecord({
                tab,
                documentIdentity: pending ? null : binding.documentIdentity.value,
                toolbarSnapshot,
                viewState,
            });
        });
        watch(record, nextRecord => binding.publishRecord(nextRecord), {immediate: true});
    }

    function attachWorkspace(workspace: IWorkspaceExpose) {
        if (mountedWorkspace.value === workspace) {
            return;
        }

        mountedWorkspace.value = workspace;
        updateSnapshot(current => ({
            ...current,
            mounted: true,
        }));
        resolveAllWaiters(workspace);
    }

    function detachWorkspace(workspace?: IWorkspaceExpose) {
        if (workspace && mountedWorkspace.value !== workspace) {
            return;
        }
        if (!mountedWorkspace.value) {
            resolveAllWaiters(null);
            return;
        }

        mountedWorkspace.value = null;
        updateSnapshot(current => ({
            ...current,
            mounted: false,
        }));
        resolveAllWaiters(null);
    }

    async function waitForWorkspace(
        target: TWorkspaceCommandTarget,
        timeoutMs = workspaceWaitTimeoutMs,
    ) {
        if (!validateCommandTarget(target).ok) {
            return null;
        }

        if (mountedWorkspace.value) {
            return mountedWorkspace.value;
        }

        const workspace = await new Promise<IWorkspaceExpose | null>((resolve) => {
            const waiter: IWorkspaceWaiter = {
                target,
                resolve,
                timer: setTimeout(() => {
                    resolveWaiter(waiter, null);
                }, timeoutMs),
            };
            waiters.add(waiter);

            if (mountedWorkspace.value) {
                resolveWaiter(waiter, mountedWorkspace.value);
            }
        });

        return validateCommandTarget(target).ok ? workspace : null;
    }

    function createCommandTarget(mode: 'current' | 'active-transaction' = 'current'): TWorkspaceCommandTarget {
        const current = snapshot.value;
        if (mode === 'active-transaction' && current.activeTransaction) {
            return {
                kind: 'transaction',
                tabId: requireTabId(current.tabId),
                sessionId: requireSessionId(current.sessionId),
                documentRef: current.activeTransaction.documentRef,
                ...getTargetDocumentBackend(current.activeTransaction.documentRef),
                ...getTargetDocumentInstanceId(current.identity),
                transactionId: current.activeTransaction.id,
                ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
            };
        }

        return {
            kind: 'revision',
            tabId: requireTabId(current.tabId),
            sessionId: requireSessionId(current.sessionId),
            documentRef: current.identity.documentRef,
            ...getTargetDocumentBackend(current.identity.documentRef),
            ...getTargetDocumentInstanceId(current.identity),
            sessionRevision: current.sessionRevision,
            ...getTargetDocumentRevisionToken(current.identity.revisionInfo),
        };
    }

    function validateCommandTarget(target: TWorkspaceCommandTarget): {ok: true} | {
        ok: false;
        reason: string
    } {
        const current = snapshot.value;
        if (target.tabId !== current.tabId) {
            return {
                ok: false,
                reason: 'tab-id-mismatch',
            };
        }

        if (target.sessionId !== current.sessionId) {
            return {
                ok: false,
                reason: 'session-id-mismatch',
            };
        }

        if ((target.documentInstanceId ?? null) !== current.identity.documentInstanceId) {
            return {
                ok: false,
                reason: 'document-instance-id-mismatch',
            };
        }

        if (target.documentRef !== current.identity.documentRef) {
            return {
                ok: false,
                reason: 'document-ref-mismatch',
            };
        }

        const currentDocumentBackend = resolveDocumentRefBackend(current.identity.documentRef);
        if (target.documentBackend !== undefined && target.documentBackend !== currentDocumentBackend) {
            return {
                ok: false,
                reason: 'document-backend-mismatch',
            };
        }

        if (!isDocumentRevisionTokenEqual(target, current.identity.revisionInfo)) {
            return {
                ok: false,
                reason: 'document-revision-token-mismatch',
            };
        }

        if (target.kind === 'transaction') {
            if (current.activeTransaction?.id !== target.transactionId) {
                return {
                    ok: false,
                    reason: 'transaction-id-mismatch',
                };
            }
            return {ok: true};
        }

        if (target.sessionRevision !== current.sessionRevision) {
            return {
                ok: false,
                reason: 'session-revision-mismatch',
            };
        }

        return {ok: true};
    }

    function toWorkspaceRecord() {
        const current = snapshot.value;
        return createWorkspaceDocumentRecord({
            tab: {
                fileName: current.identity.fileName,
                originalPath: current.identity.originalPath,
                documentInstanceId: current.identity.documentInstanceId,
                isDirty: current.dirty,
                isDjvu: current.identity.isDjvu,
            },
            documentIdentity: current.identity.revisionInfo,
            toolbarSnapshot: current.toolbarSnapshot,
            viewState: current.viewState,
        });
    }

    async function runOpenTransaction<T>(
        kind: Extract<TWorkspaceDocumentTransactionKind, 'open' | 'restore' | 'reload'>,
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) {
        const requestedOpenEpoch = openTransactionEpoch;
        return enqueueTransaction(async () => {
            const closeInFlight = activeClosePromise;
            if (closeInFlight) {
                await closeInFlight.catch(() => undefined);
            }
            if (requestedOpenEpoch !== openTransactionEpoch) {
                return false;
            }

            const abortController = new AbortController();
            activeOpenAbortController = abortController;
            if (intent.commandTarget && !validateCommandTarget(intent.commandTarget).ok) {
                activeOpenAbortController = null;
                return false;
            }

            const transaction = beginTransaction({
                kind,
                documentRef: intent.target?.originalPath ?? snapshot.value.identity.originalPath,
            });
            let committed = false;
            let sourceDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
            const sourceOpen = () => {
                if (abortController.signal.aborted) {
                    return Promise.resolve(false as const);
                }
                sourceDeadlineTimer = setTimeout(() => {
                    abortController.abort(new DOMException('Document open source stage timed out', 'TimeoutError'));
                }, DEFAULT_DOCUMENT_OPEN_STAGE_TIMEOUT_MS);
                return run(abortController.signal).finally(() => clearTimeout(sourceDeadlineTimer));
            };
            try {
                const result = await openTransactions.run<T | false>(
                    intent,
                    transaction.id,
                    transaction.documentRef,
                    sourceOpen,
                    abortController.signal,
                );
                if (abortController.signal.aborted || requestedOpenEpoch !== openTransactionEpoch) {
                    return false;
                }
                committed = result !== false;
                return result;
            } finally {
                clearTimeout(sourceDeadlineTimer);
                if (activeOpenAbortController === abortController) {
                    activeOpenAbortController = null;
                }
                finishTransaction(transaction.id, committed
                    ? 'committed'
                    : abortController.signal.aborted ? 'cancelled' : 'failed');
            }
        });
    }

    function open<T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) {
        return runOpenTransaction(
            intent.action.toLowerCase().includes('restore') ? 'restore' : 'open',
            intent,
            run,
        );
    }

    function restore<T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) {
        return runOpenTransaction('restore', intent, run);
    }

    function reload<T>(
        intent: IDocumentOpenIntent,
        run: (signal: AbortSignal) => Promise<T>,
    ) {
        return runOpenTransaction('reload', intent, run);
    }

    function close(request: {persist: boolean}) {
        if (activeClosePromise) {
            return activeClosePromise;
        }

        const closeTransaction: { id: string | null } = { id: null };
        const commitClose = () => {
            if (closeTransaction.id) {
                return;
            }
            openTransactionEpoch += 1;
            const transaction = beginTransaction({
                kind: 'close',
                documentRef: snapshot.value.identity.documentRef,
                persist: request.persist,
            });
            closeTransaction.id = transaction.id;
            activeOpenAbortController?.abort(new DOMException('Document open canceled by close', 'AbortError'));
        };
        const closePromise = (async () => {
            let closed = false;
            try {
                const workspace = mountedWorkspace.value;
                if (!workspace) {
                    const activeKind = snapshot.value.activeTransaction?.kind;
                    if (activeKind !== 'open' && activeKind !== 'restore' && activeKind !== 'reload') {
                        return false;
                    }
                    commitClose();
                    closed = true;
                    return true;
                }
                closed = await workspace.handleCloseFileFromUi({
                    ...request,
                    onCloseCommit: commitClose,
                });
                if (closed) {
                    // Keep compatibility with workspace adapters that predate
                    // the commit hook while the canonical UI path invokes it
                    // immediately before closing the document.
                    commitClose();
                }
                return closed;
            } finally {
                if (closeTransaction.id) {
                    finishTransaction(closeTransaction.id, closed ? 'committed' : 'cancelled');
                }
            }
        })();
        activeClosePromise = closePromise;
        void closePromise.then(
            () => {
                if (activeClosePromise === closePromise) activeClosePromise = null;
            },
            () => {
                if (activeClosePromise === closePromise) activeClosePromise = null;
            },
        );
        return closePromise;
    }

    return {
        tabId: options.tabId,
        snapshot,
        mountedWorkspace,
        operationLease,
        beginTransaction,
        finishTransaction,
        open,
        restore,
        reload,
        attachOpenTransactionHost: openTransactions.attachHost,
        requestDocumentPage: openTransactions.requestPage,
        close,
        applyTabUpdate,
        applyWorkspaceRecord,
        applyRevisionInfo,
        applyViewState,
        bindWorkspaceProjection,
        attachWorkspace,
        detachWorkspace,
        waitForWorkspace,
        createCommandTarget,
        validateCommandTarget,
        toWorkspaceRecord,
    };
}
