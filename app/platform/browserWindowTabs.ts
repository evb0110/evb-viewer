import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
} from '@contracts/windowTabs';
import {
    windowTabIncomingTransferSchema,
    windowTabTransferAckSchema,
} from '@contracts/windowTabsValidation';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    abortBrowserTransferAuthority,
    loadBrowserTransferAuthority,
    mutateBrowserTransferAuthority,
    type IBrowserTransferAuthorityRecord,
} from '@app/platform/browser/browserDocumentIdb';
import {
    claimBrowserWorkspaceRecoveryOwner,
    clearBrowserWorkspaceRecovery,
    saveBrowserWorkspaceRecovery,
    touchBrowserWorkspaceRecovery,
    loadBrowserWorkspaceRecoveries,
    loadBrowserWorkspaceRecovery,
    RECOVERY_OWNER_LEASE_TIMEOUT_MS,
} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import {
    createBrowserDocumentLiveLease,
    releaseBrowserDocumentLiveLease,
    saveBrowserDocumentLiveLease,
    holdLeaseOwnerLock,
    holdsLeaseOwnerLock,
    loadLiveLeaseOwnerIds,
} from '@app/platform/browser/browserDocumentLeaseStore';
import type { TDocumentRef } from '@contracts/documentRef';
import * as v from 'valibot';
const WINDOW_TABS_CHANNEL = 'evb-viewer:browserWindowTabs';
const WINDOW_ID_QUERY_PARAM = 'evbWindowId';
const WINDOW_NAME_PREFIX = 'evb-viewer-window:';
const WINDOW_TABS_STATE_KEY = '__evbBrowserWindowTabsState';
const DEFAULT_TRANSFER_TIMEOUT_MS = 12_000;
const INCOMING_TRANSFER_NONCE_TTL_MS = 60_000;
const DISCOVERY_SETTLE_DELAY_MS = 60;
const FALLBACK_WINDOW_TITLE = 'EVB Viewer';
const CLOSE_CURRENT_WINDOW_TIMEOUT_MS = 150;
const TRANSFER_MESSAGE_SCHEMA_VERSION = 1;
function transferAuthorityId(transferId: string) {
    return `transfer:${transferId}`;
}

function buildTransferAuthorityRecord(
    transfer: IWindowTabIncomingTransfer,
    nonce: string,
    sourceInstanceNonce: string,
    targetInstanceNonce: string,
    deadlineAt: number,
): IBrowserTransferAuthorityRecord {
    const refs = new Set<string>();
    const add = (ref: string | null | undefined) => { if (ref) refs.add(ref); };
    add(transfer.tab.originalPath);
    add(transfer.session?.documentRef);
    if (transfer.payload.kind === 'djvu') add(transfer.payload.sourcePath);
    if (transfer.payload.kind === 'pdfSnapshot') {
        add(transfer.payload.originalPath);
        add(transfer.payload.snapshotPath);
    }
    const expired = Date.now() >= deadlineAt;
    return {
        id: transferAuthorityId(transfer.transferId),
        transferId: transfer.transferId,
        nonce,
        sourceWindowId: transfer.sourceWindowId,
        sourceInstanceNonce,
        targetWindowId: transfer.targetWindowId,
        targetInstanceNonce,
        generation: expired ? 2 : 1,
        state: expired ? 'aborted' : 'pending',
        targetReady: false,
        deadlineAt,
        payload: transfer,
        backingRefs: Array.from(refs, ref => ({ref})),
        createdAt: Date.now(),
        ...(expired ? {decidedAt: Date.now()} : {}),
    };
}
async function createTransferAuthority(
    transfer: IWindowTabIncomingTransfer,
    nonce: string,
    sourceInstanceNonce: string,
    targetInstanceNonce: string,
    deadlineAt: number,
) {
    return mutateBrowserTransferAuthority(transfer.transferId, (current, store) => {
        if (current) {
            return current;
        }
        const record = buildTransferAuthorityRecord(
            transfer,
            nonce,
            sourceInstanceNonce,
            targetInstanceNonce,
            deadlineAt,
        );
        store.put(record);
        return record;
    });
}
async function commitTransferAuthority(
    transferId: string,
    nonce: string,
    sourceWindowId: number,
    targetWindowId: number,
) {
    return mutateBrowserTransferAuthority(transferId, (current) => {
        if (!current || current.nonce !== nonce || current.sourceWindowId !== sourceWindowId
            || current.targetWindowId !== targetWindowId || current.state !== 'pending') {
            return current;
        }
        if (Date.now() >= current.deadlineAt) {
            return current;
        }
        return {
            ...current,
            targetReady: true,
            state: 'committed',
            generation: current.generation + 1,
            decidedAt: Date.now(),
        };
    });
}
type TIncomingTransferListener = (
    transfer: IWindowTabIncomingTransfer,
) => void;
interface IKnownBrowserWindow {
    label: string;
    lastSeenAt: number;
    ready: boolean;
    instanceNonce?: string;
}
interface IBrowserWindowTabsState {
    cleanupInstance?: () => void;
    instanceId?: symbol;
    recoveryInstanceNonce?: string;
    windowId?: number;
}
interface IPendingBrowserTransfer {
    transferId: string;
    targetWindowId: number;
    nonce: string;
    payload: TBrowserTransferEnvelope;
    resolve: (result: IWindowTabTransferResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}
interface IIncomingBrowserTransferNonce {
    nonce: string;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

const positiveWindowIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
function parsePositiveWindowId(value: unknown) {
    const result = v.safeParse(positiveWindowIdSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

const transferEnvelopeMetadataSchema = v.object({
    schemaVersion: v.literal(TRANSFER_MESSAGE_SCHEMA_VERSION),
    nonce: v.string(),
});
const transferAckEnvelopeMetadataSchema = v.object({
    schemaVersion: v.literal(TRANSFER_MESSAGE_SCHEMA_VERSION),
    nonce: v.string(),
    instanceNonce: v.optional(v.unknown()),
});
type TBrowserTransferEnvelope = v.InferOutput<typeof windowTabIncomingTransferSchema>
    & v.InferOutput<typeof transferEnvelopeMetadataSchema>;
type TBrowserTransferAckEnvelope = v.InferOutput<typeof windowTabTransferAckSchema>
    & v.InferOutput<typeof transferAckEnvelopeMetadataSchema>;
const transferEnvelopeSchema = v.pipe(
    v.intersect([
        windowTabIncomingTransferSchema,
        transferEnvelopeMetadataSchema,
    ]),
    v.transform(value => value as TBrowserTransferEnvelope),
);
const transferAckEnvelopeSchema = v.pipe(
    v.intersect([
        windowTabTransferAckSchema,
        transferAckEnvelopeMetadataSchema,
    ]),
    v.transform(value => value as TBrowserTransferAckEnvelope),
);

const discoverMessageSchema = v.pipe(
    v.object({
        type: v.literal('discover'),
        windowId: positiveWindowIdSchema,
        instanceNonce: v.optional(v.unknown()),
    }),
    v.transform(value => ({
        type: value.type,
        windowId: value.windowId,
        instanceNonce: typeof value.instanceNonce === 'string' ? value.instanceNonce : '',
    })),
);
const announceMessageSchema = v.pipe(
    v.object({
        type: v.literal('announce'),
        windowId: positiveWindowIdSchema,
        instanceNonce: v.optional(v.unknown()),
        label: v.string(),
        ready: v.boolean(),
    }),
    v.transform(value => ({
        type: value.type,
        windowId: value.windowId,
        instanceNonce: typeof value.instanceNonce === 'string' ? value.instanceNonce : '',
        label: value.label,
        ready: value.ready,
    })),
);
const unregisterMessageSchema = v.pipe(
    v.object({
        type: v.literal('unregister'),
        windowId: positiveWindowIdSchema,
        instanceNonce: v.optional(v.unknown()),
    }),
    v.transform(value => ({
        type: value.type,
        windowId: value.windowId,
        instanceNonce: typeof value.instanceNonce === 'string' ? value.instanceNonce : '',
    })),
);
const browserWindowTabsMessageSchema = v.union([
    discoverMessageSchema,
    announceMessageSchema,
    unregisterMessageSchema,
    v.object({
        type: v.literal('transfer'),
        transfer: transferEnvelopeSchema,
    }),
    v.object({
        type: v.literal('ack'),
        windowId: positiveWindowIdSchema,
        ack: transferAckEnvelopeSchema,
    }),
]);
type TBrowserWindowTabsMessage = v.InferOutput<typeof browserWindowTabsMessageSchema>;

const incomingTransferListeners = new Set<TIncomingTransferListener>();
const knownWindows = new Map<number, IKnownBrowserWindow>();
const pendingTransfers = new Map<string, IPendingBrowserTransfer>();
const incomingTransferNonces = new Map<string, IIncomingBrowserTransferNonce>();
const queuedTransfersByWindow = new Map<number, string[]>();

const browserWindowTabsInstanceId = Symbol('browserWindowTabsInstance');

let channel: BroadcastChannel | null = null;
let initialized = false;
let currentWindowId = -1;
let currentRecoveryInstanceNonce = '';
let isCurrentWindowReady = false;
let cleanupRegistered = false;

type TBrowserWindowTabsMessageHandlers = {
    [TType in TBrowserWindowTabsMessage['type']]: (
        message: Extract<
            TBrowserWindowTabsMessage,
            { type: TType }
        >,
    ) => void;
};

function parseBrowserWindowTabsMessage(data: unknown): TBrowserWindowTabsMessage | null {
    const result = v.safeParse(browserWindowTabsMessageSchema, data, {abortEarly: true});
    return result.success ? result.output : null;
}

function noopUnsubscribe(): TMenuEventUnsubscribe {
    return () => {};
}
function hasBrowserWindowContext() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}
function getBrowserWindowTabsState() {
    if (!hasBrowserWindowContext()) {
        return null;
    }

    const browserWindow = window as Window & {[WINDOW_TABS_STATE_KEY]?: IBrowserWindowTabsState;};
    browserWindow[WINDOW_TABS_STATE_KEY] ??= {};
    return browserWindow[WINDOW_TABS_STATE_KEY];
}
function getCurrentWindowLabel() {
    if (!hasBrowserWindowContext()) {
        return FALLBACK_WINDOW_TITLE;
    }

    const title = document.title.trim();
    return title.length > 0 ? title : FALLBACK_WINDOW_TITLE;
}

function normalizeTimeout(timeoutMs: number | undefined) {
    if (
        typeof timeoutMs !== 'number'
        || !Number.isFinite(timeoutMs)
        || timeoutMs <= 0
    ) {
        return DEFAULT_TRANSFER_TIMEOUT_MS;
    }

    return Math.max(1, Math.floor(timeoutMs));
}

function createWindowId() {
    return Math.max(
        1,
        Math.floor(Date.now() + Math.random() * 1_000_000),
    );
}

function readNamedWindowId() {
    const value = typeof window.name === 'string' ? window.name : '';
    if (!value.startsWith(WINDOW_NAME_PREFIX)) {
        return null;
    }
    const windowId = Number(value.slice(WINDOW_NAME_PREFIX.length));
    return parsePositiveWindowId(windowId);
}

function rememberNamedWindowId(windowId: number) {
    try {
        window.name = `${WINDOW_NAME_PREFIX}${String(windowId)}`;
    } catch (error) {
        BrowserLogger.warn('browserWindowTabs', 'Failed to retain browser window identity', error);
    }
}

function createTransferNonce() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function resolveRecoveryInstanceNonce() {
    const state = getBrowserWindowTabsState();
    if (state?.recoveryInstanceNonce) {
        return state.recoveryInstanceNonce;
    }
    const nonce = createTransferNonce();
    if (state) state.recoveryInstanceNonce = nonce;
    return nonce;
}

function resolveCurrentWindowId() {
    if (!hasBrowserWindowContext()) {
        return -1;
    }

    try {
        const url = new URL(window.location.href);
        const fromQuery = Number(url.searchParams.get(WINDOW_ID_QUERY_PARAM));
        if (Number.isSafeInteger(fromQuery) && fromQuery > 0) {
            url.searchParams.delete(WINDOW_ID_QUERY_PARAM);
            window.history.replaceState(
                window.history.state,
                '',
                url.toString(),
            );
            const state = getBrowserWindowTabsState();
            if (state) {
                state.windowId = fromQuery;
            }
            rememberNamedWindowId(fromQuery);
            return fromQuery;
        }
    } catch (error) {
        BrowserLogger.warn(
            'browserWindowTabs',
            'Failed to resolve browser window ID from URL',
            error,
        );
    }

    const state = getBrowserWindowTabsState();
    const stateWindowId = parsePositiveWindowId(state?.windowId);
    if (stateWindowId !== null) {
        rememberNamedWindowId(stateWindowId);
        return stateWindowId;
    }

    const namedWindowId = readNamedWindowId();
    if (namedWindowId) {
        if (state) state.windowId = namedWindowId;
        return namedWindowId;
    }

    const windowId = createWindowId();
    if (state) {
        state.windowId = windowId;
    }
    rememberNamedWindowId(windowId);
    return windowId;
}

function recoveryOwnerId(windowId: number) {
    return `window:${String(windowId)}`;
}

export function getBrowserWindowRecoveryOwnerId() {
    initializeBrowserWindowTabs();
    return currentWindowId > 0 ? recoveryOwnerId(currentWindowId) : null;
}

function ensureChannel() {
    if (channel || !hasBrowserWindowContext()) {
        return channel;
    }

    if (typeof BroadcastChannel === 'undefined') {
        return null;
    }

    channel = new BroadcastChannel(WINDOW_TABS_CHANNEL);
    channel.addEventListener('message', handleChannelMessage);
    return channel;
}

function handleChannelMessage(event: MessageEvent<unknown>) {
    handleMessage(event.data);
}

function cleanupChannel() {
    if (!channel) {
        return;
    }

    channel.removeEventListener('message', handleChannelMessage);
    channel.close();
    channel = null;
}

function cleanupBrowserWindowTabsInstance(unregister: boolean) {
    if (unregister && currentWindowId > 0) {
        postMessage({
            type: 'unregister',
            windowId: currentWindowId,
            instanceNonce: currentRecoveryInstanceNonce,
        });
    }

    if (hasBrowserWindowContext() && cleanupRegistered) {
        window.removeEventListener('pagehide', handleWindowPageHide);
        window.removeEventListener('pageshow', handleWindowPageShow);
        window.removeEventListener('focus', handleWindowFocus);
    }
    initialized = false;
    cleanupRegistered = false;
    cleanupChannel();
    clearIncomingTransferNonces();

    const state = getBrowserWindowTabsState();
    if (state?.instanceId === browserWindowTabsInstanceId) {
        delete state.cleanupInstance;
    }
}

function claimBrowserWindowTabsInstance() {
    const state = getBrowserWindowTabsState();
    if (!state || state.instanceId === browserWindowTabsInstanceId) {
        return;
    }

    state.cleanupInstance?.();
    state.instanceId = browserWindowTabsInstanceId;
    delete state.cleanupInstance;
}

function rememberBrowserWindowTabsInstance() {
    const state = getBrowserWindowTabsState();
    if (!state || state.instanceId !== browserWindowTabsInstanceId) {
        return;
    }

    state.cleanupInstance = () => cleanupBrowserWindowTabsInstance(true);
}

function postMessage(message: TBrowserWindowTabsMessage) {
    ensureChannel()?.postMessage(message);
}

function waitForBrowserWindowCloseAttempt() {
    if (!hasBrowserWindowContext()) {
        return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
        let settled = false;
        let timeoutId = 0;

        const cleanup = () => {
            window.removeEventListener('pagehide', handleWindowClosed);
            if (timeoutId) {
                window.clearTimeout(timeoutId);
            }
        };

        const finish = (closed: boolean) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(closed);
        };

        const handleWindowClosed = (event: PageTransitionEvent) => {
            if (event.persisted) {
                return;
            }
            finish(true);
        };

        window.addEventListener('pagehide', handleWindowClosed);

        timeoutId = window.setTimeout(() => {
            finish(false);
        }, CLOSE_CURRENT_WINDOW_TIMEOUT_MS);
    });
}

function queueTransferForWindow(windowId: number, transferId: string) {
    const queued = queuedTransfersByWindow.get(windowId) ?? [];
    queued.push(transferId);
    queuedTransfersByWindow.set(windowId, queued);
}

function removeQueuedTransferReference(windowId: number, transferId: string) {
    const queued = queuedTransfersByWindow.get(windowId);
    if (!queued) {
        return;
    }

    const nextQueued = queued.filter((candidate) => candidate !== transferId);
    if (nextQueued.length === 0) {
        queuedTransfersByWindow.delete(windowId);
        return;
    }

    queuedTransfersByWindow.set(windowId, nextQueued);
}

function finishTransfer(
    transferId: string,
    result: {
        success: boolean;
        error?: string;
    },
) {
    const pending = pendingTransfers.get(transferId);
    if (!pending) {
        return;
    }
    if (!result.success) void abortBrowserTransferAuthority(transferId, pending.nonce);
    pendingTransfers.delete(transferId);
    removeQueuedTransferReference(pending.targetWindowId, transferId);
    clearTimeout(pending.timeoutHandle);
    pending.resolve({
        transferId,
        success: result.success,
        targetWindowId: pending.targetWindowId,
        ...(result.error ? { error: result.error } : {}),
    });
}

function forgetIncomingTransferNonce(transferId: string) {
    const entry = incomingTransferNonces.get(transferId);
    if (!entry) {
        return;
    }

    clearTimeout(entry.timeoutHandle);
    incomingTransferNonces.delete(transferId);
}

function rememberIncomingTransferNonce(transferId: string, nonce: string) {
    forgetIncomingTransferNonce(transferId);
    const timeoutHandle = setTimeout(() => {
        const currentEntry = incomingTransferNonces.get(transferId);
        if (currentEntry?.timeoutHandle === timeoutHandle) {
            incomingTransferNonces.delete(transferId);
        }
    }, INCOMING_TRANSFER_NONCE_TTL_MS);
    incomingTransferNonces.set(transferId, {
        nonce,
        timeoutHandle,
    });
}

function clearIncomingTransferNonces() {
    incomingTransferNonces.forEach((entry) => {
        clearTimeout(entry.timeoutHandle);
    });
    incomingTransferNonces.clear();
}

function dispatchQueuedTransfers(windowId: number) {
    const queued = queuedTransfersByWindow.get(windowId) ?? [];
    if (queued.length === 0) {
        return;
    }

    queuedTransfersByWindow.delete(windowId);
    for (const transferId of queued) {
        dispatchTransfer(transferId);
    }
}

function markWindowUnavailable(windowId: number, error: string) {
    knownWindows.delete(windowId);
    queuedTransfersByWindow.delete(windowId);

    const pendingForWindow = Array.from(pendingTransfers.values())
        .filter((transfer) => transfer.targetWindowId === windowId)
        .map((transfer) => transfer.transferId);

    for (const transferId of pendingForWindow) {
        finishTransfer(transferId, {
            success: false,
            error,
        });
    }
}

function announceCurrentWindow() {
    if (currentWindowId <= 0) {
        return;
    }

    postMessage({
        type: 'announce',
        windowId: currentWindowId,
        instanceNonce: currentRecoveryInstanceNonce,
        label: getCurrentWindowLabel(),
        ready: isCurrentWindowReady,
    });
}

function dispatchTransfer(transferId: string) {
    const pending = pendingTransfers.get(transferId);
    if (!pending) {
        return;
    }

    const targetWindow = knownWindows.get(pending.targetWindowId);
    if (!targetWindow?.ready) {
        queueTransferForWindow(pending.targetWindowId, transferId);
        return;
    }

    postMessage({
        type: 'transfer',
        transfer: pending.payload,
    });
}

function shouldIgnoreBrowserWindowTabsMessage(message: TBrowserWindowTabsMessage) {
    return 'windowId' in message
        && 'instanceNonce' in message
        && message.windowId === currentWindowId
        && message.instanceNonce === currentRecoveryInstanceNonce;
}

function rekeyCurrentWindow() {
    const retainedWindowId = currentWindowId;
    const nextWindowId = createWindowId();
    void holdLeaseOwnerLock(recoveryOwnerId(nextWindowId), true);
    knownWindows.delete(currentWindowId);
    currentWindowId = nextWindowId;
    const state = getBrowserWindowTabsState();
    if (state) state.windowId = currentWindowId;
    rememberNamedWindowId(currentWindowId);
    updateKnownCurrentWindow();
    announceCurrentWindow();
    postMessage({
        type: 'discover',
        windowId: currentWindowId,
        instanceNonce: currentRecoveryInstanceNonce,
    });
    return retainedWindowId;
}

function handleWindowAnnouncement(message: Extract<TBrowserWindowTabsMessage, { type: 'announce' }>) {
    if (
        message.windowId === currentWindowId
        && message.instanceNonce !== currentRecoveryInstanceNonce
    ) {
        // A duplicated/restored tab can clone window.name. The context that
        // holds the owner's lease lock keeps the owner with its leases and
        // records; a context that does not takes a new id and that id's lock.
        // Without a lock manager the instance nonces decide which one keeps it.
        const retainsOwner = holdsLeaseOwnerLock(recoveryOwnerId(currentWindowId))
            ?? currentRecoveryInstanceNonce < message.instanceNonce;
        if (!retainsOwner) {
            const retainedWindowId = rekeyCurrentWindow();
            knownWindows.set(retainedWindowId, {
                label: message.label,
                lastSeenAt: Date.now(),
                ready: message.ready,
                instanceNonce: message.instanceNonce,
            });
        } else {
            announceCurrentWindow();
        }
        return;
    }
    knownWindows.set(message.windowId, {
        label: message.label,
        lastSeenAt: Date.now(),
        ready: message.ready,
        instanceNonce: message.instanceNonce,
    });
    if (message.ready) {
        dispatchQueuedTransfers(message.windowId);
    }
}

function handleIncomingTransferMessage(message: Extract<TBrowserWindowTabsMessage, { type: 'transfer' }>) {
    if (
        !message.transfer.nonce
        || message.transfer.targetWindowId !== currentWindowId
        || !isCurrentWindowReady
    ) {
        return;
    }

    rememberIncomingTransferNonce(
        message.transfer.transferId,
        message.transfer.nonce,
    );
    incomingTransferListeners.forEach((listener) => {
        listener(message.transfer);
    });
}

async function handleTransferAckMessage(message: Extract<TBrowserWindowTabsMessage, { type: 'ack' }>) {
    const pending = pendingTransfers.get(message.ack.transferId);
    if (
        !pending
        || message.windowId !== pending.targetWindowId
        || message.ack.nonce !== pending.nonce
        || (message.ack.instanceNonce !== undefined
            && message.ack.instanceNonce !== knownWindows.get(pending.targetWindowId)?.instanceNonce)
    ) {
        return;
    }

    if (!message.ack.success) {
        void abortBrowserTransferAuthority(message.ack.transferId, pending.nonce);
        finishTransfer(message.ack.transferId, {
            success: false,
            error: message.ack.error ?? 'Target rejected browser transfer.',
        });
        return;
    }
    const authority = await commitTransferAuthority(
        message.ack.transferId,
        pending.nonce,
        currentWindowId,
        pending.targetWindowId,
    );
    if (authority?.state === 'committed') {
        finishTransfer(message.ack.transferId, {success: true});
    }
}

const browserWindowTabsMessageHandlers: TBrowserWindowTabsMessageHandlers = {
    discover: () => {
        announceCurrentWindow();
    },
    announce: handleWindowAnnouncement,
    unregister: (message) => {
        if (message.windowId === currentWindowId) {
            return;
        }
        markWindowUnavailable(
            message.windowId,
            'Target browser window closed before transfer completed.',
        );
    },
    transfer: handleIncomingTransferMessage,
    ack: message => { void handleTransferAckMessage(message); },
};

function handleMessage(data: unknown) {
    const message = parseBrowserWindowTabsMessage(data);
    if (!message) {
        return;
    }
    if (shouldIgnoreBrowserWindowTabsMessage(message)) {
        return;
    }

    switch (message.type) {
        case 'discover':
            browserWindowTabsMessageHandlers.discover(message);
            break;
        case 'announce':
            browserWindowTabsMessageHandlers.announce(message);
            break;
        case 'unregister':
            browserWindowTabsMessageHandlers.unregister(message);
            break;
        case 'transfer':
            browserWindowTabsMessageHandlers.transfer(message);
            break;
        case 'ack':
            browserWindowTabsMessageHandlers.ack(message);
            break;
    }
}

function registerCleanupHandlers() {
    if (cleanupRegistered || !hasBrowserWindowContext()) {
        return;
    }

    cleanupRegistered = true;
    window.addEventListener('pagehide', handleWindowPageHide);
    window.addEventListener('pageshow', handleWindowPageShow);
    window.addEventListener('focus', handleWindowFocus);
}

function handleWindowPageHide(event: PageTransitionEvent) {
    if (event.persisted) {
        postMessage({
            type: 'unregister',
            windowId: currentWindowId,
            instanceNonce: currentRecoveryInstanceNonce,
        });
        return;
    }
    cleanupBrowserWindowTabsInstance(true);
}

function handleWindowPageShow(event: PageTransitionEvent) {
    if (!event.persisted) {
        return;
    }
    announceCurrentWindow();
    postMessage({
        type: 'discover',
        windowId: currentWindowId,
        instanceNonce: currentRecoveryInstanceNonce,
    });
}

function handleWindowFocus() {
    announceCurrentWindow();
}

function initializeBrowserWindowTabs() {
    if (initialized || !hasBrowserWindowContext()) {
        return;
    }

    claimBrowserWindowTabsInstance();
    initialized = true;
    currentWindowId = resolveCurrentWindowId();
    currentRecoveryInstanceNonce = resolveRecoveryInstanceNonce();
    knownWindows.set(currentWindowId, {
        label: getCurrentWindowLabel(),
        lastSeenAt: Date.now(),
        ready: isCurrentWindowReady,
    });
    rememberBrowserWindowTabsInstance();
    ensureChannel();
    registerCleanupHandlers();
    announceCurrentWindow();
    postMessage({
        type: 'discover',
        windowId: currentWindowId,
        instanceNonce: currentRecoveryInstanceNonce,
    });
}

function updateKnownCurrentWindow() {
    if (currentWindowId <= 0) {
        return;
    }

    knownWindows.set(currentWindowId, {
        label: getCurrentWindowLabel(),
        lastSeenAt: Date.now(),
        ready: isCurrentWindowReady,
    });
}

function buildTransferWindowUrl(targetWindowId: number) {
    if (!hasBrowserWindowContext()) {
        return null;
    }

    const url = new URL(window.location.href);
    url.searchParams.set(WINDOW_ID_QUERY_PARAM, String(targetWindowId));
    return url.toString();
}

function openTargetWindow(targetWindowId: number) {
    if (!hasBrowserWindowContext()) {
        return false;
    }

    const url = buildTransferWindowUrl(targetWindowId);
    if (!url) {
        return false;
    }

    const opened = window.open(url, '_blank');
    return opened !== null;
}

function waitForDiscoverySettling() {
    return new Promise<void>((resolve) => {
        if (!hasBrowserWindowContext()) {
            resolve();
            return;
        }

        window.setTimeout(resolve, DISCOVERY_SETTLE_DELAY_MS);
    });
}

function pruneStaleTargetWindows(discoveryStartedAt: number) {
    for (const [
        windowId,
        windowInfo,
    ] of knownWindows) {
        if (windowId !== currentWindowId && windowInfo.lastSeenAt < discoveryStartedAt) {
            knownWindows.delete(windowId);
        }
    }
}

export function syncBrowserWindowTitle() {
    initializeBrowserWindowTabs();
    updateKnownCurrentWindow();
    announceCurrentWindow();
}
async function waitForTransferDecision(transferId: string, nonce: string) {
    const deadline = Date.now() + INCOMING_TRANSFER_NONCE_TTL_MS;
    while (Date.now() < deadline) {
        try {
            const authority = await loadBrowserTransferAuthority(transferId);
            if (authority?.nonce === nonce) {
                if (authority.state === 'committed') {
                    const barrier = Reflect.get(globalThis, '__evbTransferAuthorityCommittedReadBarrier') as
                        (() => void | Promise<void>) | undefined;
                    if (typeof barrier === 'function') {
                        await Promise.resolve(barrier());
                    }
                    return true;
                }
                if (authority.state === 'aborted') {
                    return false;
                }
            }
        } catch {
            // Storage refusal is not an abort. Keep the provisional bytes and retry.
        }
        await new Promise<void>(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Durable transfer decision remained unavailable.');
}
// Hold the owner lock before restoration can expose its record as an orphan.
// A silent duplicate cannot announce a collision; its held lock forces rekeying.
async function holdRecoveryOwnerLock() {
    for (;;) {
        const ownerId = getBrowserWindowRecoveryOwnerId();
        if (!ownerId) {
            return null;
        }
        const held = await holdLeaseOwnerLock(ownerId, true);
        if (ownerId !== getBrowserWindowRecoveryOwnerId()) continue;
        if (held) return ownerId;
        rekeyCurrentWindow();
    }
}
// Recovery records and their live document leases share this platform owner.
let recoveryLiveLease: {
    ownerId: string;
    generation: number
} | null = null;

async function releaseRecoveryLiveLease() {
    if (!recoveryLiveLease) return;
    const lease = recoveryLiveLease;
    try {
        await releaseBrowserDocumentLiveLease(lease.ownerId, lease.generation);
        recoveryLiveLease = null;
    } catch {
        // Retain the generation so the next clean checkpoint retries release.
    }
}

async function publishRecoveryLiveLease(ownerId: string, refs: TDocumentRef[]) {
    try {
        const dependencies = refs.map(ref => ({ref}));
        const lease = recoveryLiveLease
            ? await saveBrowserDocumentLiveLease(ownerId, recoveryLiveLease.generation, 'active', dependencies)
            : await createBrowserDocumentLiveLease(ownerId, dependencies);
        recoveryLiveLease = {
            ownerId,
            generation: lease.generation,
        };
    } catch (error) {
        // A later successful record write or heartbeat reacquires the lease.
        recoveryLiveLease = null;
        BrowserLogger.warn('workspace-recovery', 'Failed to publish browser document live lease', error);
    }
}

export const browserWindowTabsCapability: IWindowTabsCapability = {
    browserRecovery: {
        getOwnerId: getBrowserWindowRecoveryOwnerId,
        async load(ownerId) {
            if (recoveryLiveLease && recoveryLiveLease.ownerId !== ownerId) {
                await releaseRecoveryLiveLease();
                recoveryLiveLease = null;
            }
            return loadBrowserWorkspaceRecovery(ownerId);
        },
        async save(ownerId, expectedGeneration, checkpoint, snapshotRefs, liveDocumentRefs) {
            const outcome = await saveBrowserWorkspaceRecovery(ownerId, expectedGeneration, checkpoint, snapshotRefs);
            if (outcome.saved) await publishRecoveryLiveLease(ownerId, liveDocumentRefs);
            return outcome;
        },
        async touch(ownerId, expectedGeneration, liveDocumentRefs) {
            const outcome = await touchBrowserWorkspaceRecovery(ownerId, expectedGeneration);
            if (outcome.saved && (recoveryLiveLease || liveDocumentRefs.length > 0)) {
                await publishRecoveryLiveLease(ownerId, liveDocumentRefs);
            }
            return outcome;
        },
        async clear(ownerId, expectedGeneration) {
            const outcome = await clearBrowserWorkspaceRecovery(ownerId, expectedGeneration);
            if (outcome.saved) await releaseRecoveryLiveLease();
            return outcome;
        },
    },
    async saveWorkspaceCheckpoint() {},
    // Restore acknowledgement cannot delete the browser's only dirty bytes.
    // The browser writer retires them after a replacement or clean checkpoint.
    async acknowledgeWorkspaceCheckpoint() {},
    discardWorkspaceCheckpoint: () => Promise.resolve('1'),
    async resumeWorkspaceCheckpoint() {},
    claimWorkspaceCheckpoint: async () => {
        if (!await holdRecoveryOwnerLock()) {
            return null;
        }
        const canDiscoverLivePeers = Boolean(ensureChannel());
        if (canDiscoverLivePeers) {
            const discoveryStartedAt = Date.now();
            postMessage({
                type: 'discover',
                windowId: currentWindowId,
                instanceNonce: currentRecoveryInstanceNonce,
            });
            await waitForDiscoverySettling();
            pruneStaleTargetWindows(discoveryStartedAt);
        }

        const ownerId = await holdRecoveryOwnerLock();
        if (!ownerId) {
            return null;
        }
        const exact = await loadBrowserWorkspaceRecovery(ownerId);
        if (exact && ownerId === getBrowserWindowRecoveryOwnerId()) {
            return exact.checkpoint;
        }

        const activeOwnerIds = new Set(Array.from(knownWindows.keys(), recoveryOwnerId));
        const liveOwnerIds = await loadLiveLeaseOwnerIds();
        const now = Date.now();
        const orphaned = (await loadBrowserWorkspaceRecoveries())
            .filter(record => (
                record.ownerId !== ownerId
                && !activeOwnerIds.has(record.ownerId)
                // A channel response proves liveness, but a missed 60ms
                // response does not prove death: background tabs are heavily
                // throttled and frozen ones do not answer. A held lease lock
                // proves the owner alive. Without a lock manager, never steal
                // a fresh durable owner heartbeat.
                && (liveOwnerIds
                    ? !liveOwnerIds.has(record.ownerId)
                    : now - record.updatedAt >= RECOVERY_OWNER_LEASE_TIMEOUT_MS)
            ))
            .sort((first, second) => (
                second.updatedAt - first.updatedAt
                || first.ownerId.localeCompare(second.ownerId)
            ));
        if (orphaned.length === 0) {
            return null;
        }
        const orphan = orphaned[0];
        if (!orphan) {
            return null;
        }
        const outcome = await claimBrowserWorkspaceRecoveryOwner(
            orphan.ownerId,
            ownerId,
            orphan.generation,
            orphan.leaseRevision,
        );
        return outcome.claimed ? orphan.checkpoint : null;
    },
    async transfer(request: IWindowTabTransferRequest) {
        initializeBrowserWindowTabs();
        if (!ensureChannel()) {
            return {
                transferId: '',
                success: false,
                targetWindowId:
                    request.target.kind === 'window'
                        ? request.target.windowId
                        : -1,
                error: 'Browser window transfer is unavailable in this runtime',
            };
        }

        const targetWindowId =
            request.target.kind === 'window'
                ? request.target.windowId
                : createWindowId();

        if (
            request.target.kind === 'new-window'
            && !openTargetWindow(targetWindowId)
        ) {
            return {
                transferId: '',
                success: false,
                targetWindowId,
                error: 'Browser blocked opening a new window for tab transfer.',
            };
        }

        const transferId = createTransferNonce();
        const nonce = createTransferNonce();
        const payload: TBrowserTransferEnvelope = {
            transferId,
            sourceWindowId: currentWindowId,
            targetWindowId,
            tab: request.tab,
            payload: request.payload,
            ...(request.session === undefined ? {} : {session: request.session}),
            schemaVersion: TRANSFER_MESSAGE_SCHEMA_VERSION,
            nonce,
        };

        return new Promise<IWindowTabTransferResult>((resolve) => {
            const timeoutMs = normalizeTimeout(request.timeoutMs);
            const timeoutHandle = setTimeout(() => finishTransfer(transferId, {
                success: false,
                error: 'Transfer timed out while waiting for durable source acknowledgement.',
            }), timeoutMs);
            pendingTransfers.set(transferId, {
                transferId,
                targetWindowId,
                nonce,
                payload,
                resolve,
                timeoutHandle,
            });
            void createTransferAuthority(
                payload,
                nonce,
                currentRecoveryInstanceNonce,
                knownWindows.get(targetWindowId)?.instanceNonce ?? '',
                Date.now() + timeoutMs,
            ).then(record => {
                if (!record || record.state === 'aborted') {
                    finishTransfer(transferId, {
                        success: false,
                        error: 'Transfer authority was unavailable.',
                    });
                    return;
                }
                const targetWindow = knownWindows.get(targetWindowId);
                if (targetWindow?.ready) {
                    dispatchTransfer(transferId);
                    return;
                }
                queueTransferForWindow(targetWindowId, transferId);
                postMessage({
                    type: 'discover',
                    windowId: currentWindowId,
                    instanceNonce: currentRecoveryInstanceNonce,
                });
            }).catch(() => finishTransfer(transferId, {
                success: false,
                error: 'Transfer authority was unavailable.',
            }));
        });
    },
    transferAck(ack: IWindowTabTransferAck) {
        initializeBrowserWindowTabs();
        const nonceEntry = incomingTransferNonces.get(ack.transferId);
        if (!nonceEntry) {
            return Promise.resolve(false);
        }

        const nonce = nonceEntry.nonce;
        forgetIncomingTransferNonce(ack.transferId);
        postMessage({
            type: 'ack',
            windowId: currentWindowId,
            ack: {
                ...ack,
                schemaVersion: TRANSFER_MESSAGE_SCHEMA_VERSION,
                nonce,
                instanceNonce: currentRecoveryInstanceNonce,
            },
        });
        return waitForTransferDecision(ack.transferId, nonce);
    },
    async listTargetWindows() {
        initializeBrowserWindowTabs();
        const discoveryStartedAt = Date.now();
        postMessage({
            type: 'discover',
            windowId: currentWindowId,
            instanceNonce: currentRecoveryInstanceNonce,
        });
        await waitForDiscoverySettling();
        pruneStaleTargetWindows(discoveryStartedAt);

        return Array.from(knownWindows.entries())
            .filter(([
                windowId,
                windowInfo,
            ]) => (
                windowId !== currentWindowId && windowInfo.ready
            ))
            .map(([
                windowId,
                windowInfo,
            ]) => ({
                windowId,
                label: windowInfo.label,
            } satisfies IWindowTabTargetWindow))
            .sort((left, right) => left.label.localeCompare(right.label));
    },
    onIncomingTransfer(callback) {
        initializeBrowserWindowTabs();
        incomingTransferListeners.add(callback);
        return () => {
            incomingTransferListeners.delete(callback);
        };
    },
    onWindowAction: noopUnsubscribe,
    async closeCurrentWindow() {
        if (!hasBrowserWindowContext()) {
            return false;
        }

        const closeAttempt = waitForBrowserWindowCloseAttempt();
        window.close();
        return closeAttempt;
    },
    notifyRendererReady() {
        initializeBrowserWindowTabs();
        isCurrentWindowReady = true;
        updateKnownCurrentWindow();
        announceCurrentWindow();
    },
    claimPendingExternalOpenPaths() {
        return Promise.resolve([]);
    },
    acknowledgePendingExternalOpenPaths() {
        return Promise.resolve();
    },
    onMenuNewTab: noopUnsubscribe,
    onMenuCloseTab: noopUnsubscribe,
    onMenuSplitEditor: noopUnsubscribe,
};
