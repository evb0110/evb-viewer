import * as functionUtils from 'es-toolkit/function';
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
import { subscribeBrowserMenuEvent } from '@app/platform/browserMenuBar';
import {
    acknowledgeBrowserWorkspaceCheckpoint,
    browserWindowLockName,
    claimBrowserWorkspaceCheckpoint,
    nameBrowserWorkspaceDirectory,
    saveBrowserWorkspaceCheckpoint,
} from '@app/platform/browser/browserWorkspaceRecovery';
import {browserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {holdBrowserLock} from '@app/platform/browser/runBrowserLock';
import { removeBrowserExtensionDocumentUrl } from '@contracts/browserExtensionLaunch';
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
const inheritedWindowId = hasBrowserWindowContext() ? readNamedWindowId() : null;

let channel: BroadcastChannel | null = null;
let initialized = false;
let currentWindowId = -1;
let currentRecoveryInstanceNonce = '';
let isCurrentWindowReady = false;
let cleanupRegistered = false;
// The lock that says this window is alive; a checkpoint whose window lock is free belongs to a window that is gone.
let windowLock: {windowId: number; held: boolean; granted: Promise<boolean>} | null = null;

function holdWindowLock(windowId: number) {
    if (windowLock?.windowId === windowId) return windowLock.granted;
    const lock = {windowId, held: false, granted: Promise.resolve(false)};
    // A lock manager that refuses the request leaves the id unproven, as another holder would.
    lock.granted = holdBrowserLock(browserWindowLockName(String(windowId))).then((release) => {
        lock.held = release !== null;
        return lock.held;
    }, () => false);
    windowLock = lock;
    return lock.granted;
}

/** Whether this context holds `windowId`'s lock; `null` without Web Locks, when only instance nonces can decide. */
function holdsWindowLock(windowId: number) {
    return typeof navigator === 'undefined' || !navigator.locks ? null : windowLock?.windowId === windowId && windowLock.held;
}

function parseBrowserWindowTabsMessage(data: unknown): TBrowserWindowTabsMessage | null {
    const result = v.safeParse(browserWindowTabsMessageSchema, data, {abortEarly: true});
    return result.success ? result.output : null;
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

    const state = getBrowserWindowTabsState();
    const stateWindowId = parsePositiveWindowId(state?.windowId);
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
            window.sessionStorage?.removeItem(WINDOW_TABS_STATE_KEY);
            if (state) state.windowId = fromQuery;
            rememberNamedWindowId(fromQuery);
            return fromQuery;
        }
        if (stateWindowId !== null) {
            rememberNamedWindowId(stateWindowId);
            return stateWindowId;
        }

        const namedWindowId = readNamedWindowId();
        const reloadingWindowId = parsePositiveWindowId(Number(window.sessionStorage?.getItem(WINDOW_TABS_STATE_KEY)));
        window.sessionStorage?.removeItem(WINDOW_TABS_STATE_KEY);
        if (namedWindowId && (holdsWindowLock(namedWindowId) === true
            || (namedWindowId === reloadingWindowId
                && performance.getEntriesByType('navigation').some(entry => 'type' in entry && entry.type === 'reload')))) {
            if (state) state.windowId = namedWindowId;
            rememberNamedWindowId(namedWindowId);
            return namedWindowId;
        }
    } catch (error) {
        BrowserLogger.warn('browserWindowTabs', 'Failed to resolve retained browser window identity', error);
    }

    const windowId = createWindowId();
    if (state) state.windowId = windowId;
    rememberNamedWindowId(windowId);
    return windowId;
}

/** This window's id, which names its workspace checkpoint; `null` outside a window. */
export function getBrowserWindowId() {
    initializeBrowserWindowTabs();
    return currentWindowId > 0 ? String(currentWindowId) : null;
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

export function rekeyCurrentWindow() {
    const retainedWindowId = currentWindowId;
    const nextWindowId = createWindowId();
    void holdWindowLock(nextWindowId);
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
        const retainsOwner = holdsWindowLock(currentWindowId)
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
    const {payload} = message.transfer;
    if (payload.kind === 'pdfSnapshot' && payload.snapshotPath && payload.originalPath) {
        browserDocumentStore.nameSource(payload.snapshotPath, payload.originalPath);
    }
    incomingTransferListeners.forEach((listener) => {
        listener(message.transfer);
    });
}

function handleTransferAckMessage(message: Extract<TBrowserWindowTabsMessage, { type: 'ack' }>) {
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
        finishTransfer(message.ack.transferId, {
            success: false,
            error: message.ack.error ?? 'Target rejected browser transfer.',
        });
        return;
    }
    finishTransfer(message.ack.transferId, {success: true});
}

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
            announceCurrentWindow();
            break;
        case 'announce':
            handleWindowAnnouncement(message);
            break;
        case 'unregister':
            if (message.windowId !== currentWindowId) markWindowUnavailable(message.windowId, 'Target browser window closed before transfer completed.');
            break;
        case 'transfer':
            handleIncomingTransferMessage(message);
            break;
        case 'ack':
            handleTransferAckMessage(message);
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
    // Only a departing established context hands its owner to a reload.
    window.sessionStorage?.setItem(WINDOW_TABS_STATE_KEY, String(currentWindowId));
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
    void holdWindowLock(currentWindowId);
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

    // A launched document stays with the window that opened it.
    const url = new URL(removeBrowserExtensionDocumentUrl(window.location.href));
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
    return hasBrowserWindowContext()
        ? new Promise<void>(resolve => window.setTimeout(resolve, DISCOVERY_SETTLE_DELAY_MS))
        : Promise.resolve();
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
// A silent duplicate cannot announce a collision; its held lock forces rekeying.
async function holdCurrentWindowLock() {
    for (;;) {
        const windowId = getBrowserWindowId();
        if (!windowId) return null;
        const held = await holdWindowLock(Number(windowId));
        if (windowId !== getBrowserWindowId()) continue;
        if (held) return windowId;
        rekeyCurrentWindow();
    }
}

/** The documents a transfer hands over leave this window first, so the target can lock and open them. */
async function releaseTransferredDocuments(payload: IWindowTabTransferRequest['payload']) {
    if (payload.kind === 'pdfSnapshot' && payload.snapshotPath) await browserDocumentStore.release(payload.snapshotPath);
}

// The window's checkpoint names each document directory as soon as the window holds it.
browserDocumentStore.onDirectoryHeld = async (directory) => {
    try {
        const windowId = await holdCurrentWindowLock();
        if (windowId) await nameBrowserWorkspaceDirectory(windowId, directory);
    } catch (error) {
        BrowserLogger.warn('workspace-recovery', 'Failed to name a document in the window checkpoint', error);
    }
};

export const browserWindowTabsCapability: IWindowTabsCapability = {
    browserRecovery: {
        async save(checkpoint) {
            const windowId = await holdCurrentWindowLock();
            if (windowId) await saveBrowserWorkspaceCheckpoint(windowId, checkpoint);
        },
    },
    async acknowledgeWorkspaceCheckpoint() {
        const windowId = getBrowserWindowId();
        if (windowId) await acknowledgeBrowserWorkspaceCheckpoint(windowId);
    },
    discardWorkspaceCheckpoint: () => Promise.resolve('1'),
    async resumeWorkspaceCheckpoint() {},
    claimWorkspaceCheckpoint: async () => {
        const windowId = await holdCurrentWindowLock();
        if (!windowId) return null;
        // A page that replaced another in this tab inherits its window's unsaved work first.
        return claimBrowserWorkspaceCheckpoint(windowId, inheritedWindowId === null ? null : String(inheritedWindowId));
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
                error: 'Transfer timed out while waiting for the target window.',
            }), timeoutMs);
            pendingTransfers.set(transferId, {
                transferId,
                targetWindowId,
                nonce,
                payload,
                resolve,
                timeoutHandle,
            });
            void releaseTransferredDocuments(request.payload).then(() => {
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
                error: 'The transferred document could not be handed over.',
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
        return Promise.resolve(true);
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
    onWindowAction: () => functionUtils.noop,
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
    onMenuNewTab: subscribeBrowserMenuEvent('onMenuNewTab'),
    onMenuCloseTab: subscribeBrowserMenuEvent('onMenuCloseTab'),
    onMenuSplitEditor: subscribeBrowserMenuEvent('onMenuSplitEditor'),
};
