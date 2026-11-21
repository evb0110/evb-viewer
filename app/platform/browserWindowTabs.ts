import * as functionUtils from 'es-toolkit/function';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import { BrowserLogger } from '@app/utils/browserLogger';
import { subscribeBrowserMenuEvent } from '@app/platform/browserMenuBar';
import {
    acknowledgeBrowserWorkspaceCheckpoint,
    browserWindowLockName,
    claimBrowserWorkspaceCheckpoint,
    nameBrowserWorkspaceDirectory,
    saveBrowserWorkspaceCheckpoint,
    setBrowserDocumentDrafts,
} from '@app/platform/browser/browserWorkspaceRecovery';
import {browserDocumentStore} from '@app/platform/browser/browserDocumentRepository';
import {holdBrowserLock} from '@app/platform/browser/runBrowserLock';
import * as v from 'valibot';
const WINDOW_TABS_CHANNEL = 'evb-viewer:browserWindowTabs';
const WINDOW_ID_QUERY_PARAM = 'evbWindowId';
const WINDOW_NAME_PREFIX = 'evb-viewer-window:';
const WINDOW_TABS_STATE_KEY = '__evbBrowserWindowTabsState';
const FALLBACK_WINDOW_TITLE = 'EVB Viewer';

interface IBrowserWindowTabsState {
    cleanupInstance?: () => void;
    instanceId?: symbol;
    recoveryInstanceNonce?: string;
    windowId?: number;
}
const positiveWindowIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
function parsePositiveWindowId(value: unknown) {
    const result = v.safeParse(positiveWindowIdSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

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
]);
type TBrowserWindowTabsMessage = v.InferOutput<typeof browserWindowTabsMessageSchema>;


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

function createInstanceNonce() {
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
    const nonce = createInstanceNonce();
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

function shouldIgnoreBrowserWindowTabsMessage(message: TBrowserWindowTabsMessage) {
    return 'windowId' in message
        && 'instanceNonce' in message
        && message.windowId === currentWindowId
        && message.instanceNonce === currentRecoveryInstanceNonce;
}

export function rekeyCurrentWindow() {
    const nextWindowId = createWindowId();
    void holdWindowLock(nextWindowId);
    currentWindowId = nextWindowId;
    const state = getBrowserWindowTabsState();
    if (state) state.windowId = currentWindowId;
    rememberNamedWindowId(currentWindowId);
    announceCurrentWindow();
    postMessage({
        type: 'discover',
        windowId: currentWindowId,
        instanceNonce: currentRecoveryInstanceNonce,
    });
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
            rekeyCurrentWindow();
        } else {
            announceCurrentWindow();
        }
        return;
    }
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

export function syncBrowserWindowTitle() {
    initializeBrowserWindowTabs();
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

async function nameInWindowCheckpoint(directory: string) {
    const windowId = await holdCurrentWindowLock();
    if (windowId) await nameBrowserWorkspaceDirectory(windowId, directory);
}

// The window's checkpoint names a document directory before its first edit, as desktop's does.
browserDocumentStore.onDirectoryEdited = directory => nameInWindowCheckpoint(directory)
    .catch(error => BrowserLogger.warn('workspace-recovery', 'Failed to name a document in the window checkpoint', error));

export const browserWindowTabsCapability: IWindowTabsCapability = {
    browserRecovery: {
        async save(checkpoint) {
            const windowId = await holdCurrentWindowLock();
            if (windowId) await saveBrowserWorkspaceCheckpoint(windowId, checkpoint);
        },
    },
    setDocumentDrafts: setBrowserDocumentDrafts,
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
    async transfer(request) {
        return {
            transferId: '',
            success: false,
            targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
            error: 'Browser window transfer is unavailable in this runtime',
        };
    },
    transferAck: () => Promise.resolve(false),
    listTargetWindows: () => Promise.resolve([]),
    onIncomingTransfer: () => functionUtils.noop,
    onWindowAction: () => functionUtils.noop,
    closeCurrentWindow: () => Promise.resolve(false),
    notifyRendererReady(phase) {
        // A failed startup is not announced to the other windows.
        if (phase.phase !== 'shell-interactive') {
            return;
        }
        initializeBrowserWindowTabs();
        isCurrentWindowReady = true;
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
