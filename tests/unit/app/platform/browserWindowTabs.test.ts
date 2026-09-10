import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import type {IBrowserTransferAuthorityRecord} from '@app/platform/browser/browserDocumentIdb';

const recoveryMocks = vi.hoisted(() => ({
    claimBrowserWorkspaceRecoveryOwner: vi.fn(),
    loadBrowserWorkspaceRecoveries: vi.fn(),
    loadBrowserWorkspaceRecovery: vi.fn(),
    RECOVERY_OWNER_LEASE_TIMEOUT_MS: 30_000,
}));

const transferAuthorityMocks = vi.hoisted(() => ({
    abortBrowserTransferAuthority: vi.fn(),
    loadBrowserTransferAuthority: vi.fn(),
    mutateBrowserTransferAuthority: vi.fn(),
}));

type TAuthorityMutation = (
    current: IBrowserTransferAuthorityRecord | null,
    store: {put: (value: unknown) => void},
) => unknown;

vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => recoveryMocks);
vi.mock('@app/platform/browser/browserDocumentIdb', () => transferAuthorityMocks);

const WINDOW_TABS_CHANNEL = 'evb-viewer:browserWindowTabs';

type TChannelListener = (event: MessageEvent<unknown>) => void;

class MockBroadcastChannel {
    public static readonly channels = new Set<MockBroadcastChannel>();

    private readonly listeners = new Set<TChannelListener>();
    private closed = false;

    public constructor(public readonly name: string) {
        MockBroadcastChannel.channels.add(this);
    }

    public addEventListener(type: string, listener: TChannelListener) {
        if (type === 'message') {
            this.listeners.add(listener);
        }
    }

    public removeEventListener(type: string, listener: TChannelListener) {
        if (type === 'message') {
            this.listeners.delete(listener);
        }
    }

    public postMessage(data: unknown) {
        for (const channel of MockBroadcastChannel.channels) {
            if (channel === this || channel.name !== this.name || channel.closed) {
                continue;
            }

            channel.dispatch(data);
        }
    }

    public close() {
        this.closed = true;
        this.listeners.clear();
        MockBroadcastChannel.channels.delete(this);
    }

    public static reset() {
        for (const channel of Array.from(MockBroadcastChannel.channels)) {
            channel.close();
        }
        MockBroadcastChannel.channels.clear();
    }

    private dispatch(data: unknown) {
        const event = new MessageEvent<unknown>('message', {data});
        for (const listener of Array.from(this.listeners)) {
            listener(event);
        }
    }
}

function createPageTransitionEvent(type: 'pagehide' | 'pageshow', persisted: boolean) {
    return Object.assign(new Event(type), {persisted});
}

function stubBrowserGlobals(href = 'http://localhost:3235/') {
    const windowListeners = new Map<string, Set<EventListener>>();
    const windowStub = {
        location: { href },
        history: {
            state: null,
            replaceState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => {
                if (!url) {
                    return;
                }

                windowStub.location.href = url.toString();
            }),
        },
        setTimeout,
        clearTimeout,
        addEventListener: vi.fn((type: string, listener: EventListener) => {
            const listeners = windowListeners.get(type) ?? new Set<EventListener>();
            listeners.add(listener);
            windowListeners.set(type, listeners);
        }),
        removeEventListener: vi.fn((type: string, listener: EventListener) => {
            windowListeners.get(type)?.delete(listener);
        }),
        open: vi.fn(() => null),
        close: vi.fn(),
    };

    vi.stubGlobal('window', windowStub);
    vi.stubGlobal('document', { title: 'EVB Viewer Web' });
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    return {
        ...windowStub,
        dispatch(type: string, event: Event = new Event(type)) {
            for (const listener of Array.from(windowListeners.get(type) ?? [])) {
                listener(event);
            }
        },
    };
}

async function resolveTargetWindows(
    capability: IWindowTabsCapability,
) {
    const targets = capability.listTargetWindows();
    await vi.advanceTimersByTimeAsync(70);
    return targets;
}

describe('browserWindowTabsCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useFakeTimers();
        MockBroadcastChannel.reset();
        recoveryMocks.loadBrowserWorkspaceRecovery.mockResolvedValue(null);
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: false,
            generation: 0,
        });
        transferAuthorityMocks.abortBrowserTransferAuthority.mockResolvedValue(null);
        transferAuthorityMocks.loadBrowserTransferAuthority.mockResolvedValue(null);
        transferAuthorityMocks.mutateBrowserTransferAuthority.mockImplementation(
            async (_transferId: string, mutate: (current: null, store: {put: () => void}) => unknown) => (
                mutate(null, {put: vi.fn()})
            ),
        );
        stubBrowserGlobals();
    });

    afterEach(() => {
        MockBroadcastChannel.reset();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('lists live target windows that answer discovery', async () => {
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        externalWindow.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'discover') {
                return;
            }

            externalWindow.postMessage({
                type: 'announce',
                windowId: 200,
                label: 'Other PDF',
                ready: true,
            });
        });

        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([{
            windowId: 200,
            label: 'Other PDF',
        }]);
    });

    it('claims only its stable per-window recovery owner across a module reload', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=321');
        recoveryMocks.loadBrowserWorkspaceRecovery.mockResolvedValue({checkpoint: {
            version: 1,
            tabs: [],
        }});
        const firstModule = await import('@app/platform/browserWindowTabs');

        const firstClaim = firstModule.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await firstClaim;
        expect(recoveryMocks.loadBrowserWorkspaceRecovery).toHaveBeenLastCalledWith('window:321');
        expect(browserWindow.location.href).not.toContain('evbWindowId');

        vi.resetModules();
        const secondModule = await import('@app/platform/browserWindowTabs');
        const secondClaim = secondModule.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await secondClaim;

        expect(recoveryMocks.loadBrowserWorkspaceRecovery).toHaveBeenLastCalledWith('window:321');
    });

    it('rekeys a duplicated live context before it can share a recovery owner', async () => {
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=321');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        externalWindow.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'discover') {
                return;
            }
            externalWindow.postMessage({
                type: 'announce',
                windowId: 321,
                instanceNonce: '!',
                label: 'Original tab',
                ready: true,
            });
        });

        const module = await import('@app/platform/browserWindowTabs');

        expect(module.getBrowserWindowRecoveryOwnerId()).not.toBe('window:321');
        recoveryMocks.loadBrowserWorkspaceRecovery.mockResolvedValue(null);
        recoveryMocks.loadBrowserWorkspaceRecovery.mockClear();
        const claim = module.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await claim;
        expect(recoveryMocks.loadBrowserWorkspaceRecovery).not.toHaveBeenCalledWith('window:321');
    });

    it('claims the newest inactive recovery journal without touching the remaining queue', async () => {
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444');
        const orphan = {
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 1,
        };
        const olderOrphan = {
            ...orphan,
            ownerId: 'window:111',
            generation: 2,
            updatedAt: 0,
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([
            olderOrphan,
            orphan,
        ]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');

        const claimed = browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);

        await expect(claimed).resolves.toBe(orphan.checkpoint);
        expect(recoveryMocks.claimBrowserWorkspaceRecoveryOwner).toHaveBeenCalledWith(
            'window:321',
            'window:444',
            7,
            7,
        );
        expect(recoveryMocks.claimBrowserWorkspaceRecoveryOwner).not.toHaveBeenCalledWith(
            'window:111',
            expect.anything(),
            expect.anything(),
        );
    });

    it('does not claim a fresh recovery heartbeat when live-peer discovery is unavailable', async () => {
        vi.setSystemTime(100_000);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444');
        vi.stubGlobal('BroadcastChannel', undefined);
        expect(globalThis.BroadcastChannel).toBeUndefined();
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: Number.MAX_SAFE_INTEGER,
        }]);
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockClear();

        await expect(browserWindowTabsCapability.claimWorkspaceCheckpoint()).resolves.toBeNull();
        expect(recoveryMocks.claimBrowserWorkspaceRecoveryOwner).not.toHaveBeenCalled();
    });

    it('does not steal a fresh heartbeat when a live tab misses the discovery window', async () => {
        vi.setSystemTime(100_000);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444');
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 99_999,
        }]);
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockClear();

        const claim = browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);

        await expect(claim).resolves.toBeNull();
        expect(recoveryMocks.claimBrowserWorkspaceRecoveryOwner).not.toHaveBeenCalled();
    });

    it('claims an expired recovery owner when live-peer discovery is unavailable', async () => {
        vi.setSystemTime(100_000);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444');
        vi.stubGlobal('BroadcastChannel', undefined);
        const orphan = {
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 69_999,
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([orphan]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockClear();

        await expect(browserWindowTabsCapability.claimWorkspaceCheckpoint())
            .resolves.toBe(orphan.checkpoint);
        expect(recoveryMocks.claimBrowserWorkspaceRecoveryOwner).toHaveBeenCalledWith(
            'window:321',
            'window:444',
            7,
            7,
        );
    });

    it('prunes target windows that no longer answer discovery', async () => {
        let shouldRespond = true;
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        externalWindow.addEventListener('message', (event) => {
            const data = event.data;
            if (
                !shouldRespond
                || !data
                || typeof data !== 'object'
                || !('type' in data)
                || data.type !== 'discover'
            ) {
                return;
            }

            externalWindow.postMessage({
                type: 'announce',
                windowId: 201,
                label: 'Closing PDF',
                ready: true,
            });
        });

        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([{
            windowId: 201,
            label: 'Closing PDF',
        }]);

        shouldRespond = false;

        await expect(resolveTargetWindows(browserWindowTabsCapability)).resolves.toEqual([]);
    });

    it('does not list a previous hot-reloaded instance from the same browser tab', async () => {
        const firstModule = await import('@app/platform/browserWindowTabs');
        firstModule.browserWindowTabsCapability.notifyRendererReady();

        vi.resetModules();

        const secondModule = await import('@app/platform/browserWindowTabs');
        secondModule.browserWindowTabsCapability.notifyRendererReady();

        await expect(resolveTargetWindows(secondModule.browserWindowTabsCapability)).resolves.toEqual([]);
        expect(MockBroadcastChannel.channels).toHaveLength(1);
    });

    it('does not unregister a window when a browser close is cancelled', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        messages.length = 0;

        const closed = browserWindowTabsCapability.closeCurrentWindow();
        await vi.advanceTimersByTimeAsync(160);

        await expect(closed).resolves.toBe(false);
        expect(browserWindow.close).toHaveBeenCalledOnce();
        expect(messages).not.toContainEqual(expect.objectContaining({type: 'unregister'}));
    });

    it('unregisters a window only after the browser confirms it is leaving', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        messages.length = 0;
        browserWindow.close.mockImplementation(() => browserWindow.dispatch('pagehide'));

        await expect(browserWindowTabsCapability.closeCurrentWindow()).resolves.toBe(true);
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'unregister',
            windowId: 100,
        }));
    });

    it('can initialize again after a non-persisted page hide tears down the instance', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        expect(MockBroadcastChannel.channels.size).toBe(1);

        browserWindow.dispatch('pagehide');
        expect(MockBroadcastChannel.channels.size).toBe(0);

        browserWindowTabsCapability.notifyRendererReady();
        expect(MockBroadcastChannel.channels.size).toBe(1);
        for (const type of [
            'pagehide',
            'pageshow',
            'focus',
        ]) {
            expect(browserWindow.addEventListener.mock.calls.filter(([registered]) => registered === type))
                .toHaveLength(2);
        }
    });

    it('keeps waiting for a real close after a persisted page hide', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        browserWindow.close.mockImplementation(() => {
            browserWindow.dispatch('pagehide', createPageTransitionEvent('pagehide', true));
            window.setTimeout(() => browserWindow.dispatch(
                'pagehide',
                createPageTransitionEvent('pagehide', false),
            ), 10);
        });

        const closed = browserWindowTabsCapability.closeCurrentWindow();
        await vi.advanceTimersByTimeAsync(10);

        await expect(closed).resolves.toBe(true);
    });

    it('re-announces a window restored from the browser back-forward cache', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        messages.length = 0;

        browserWindow.dispatch('pagehide', createPageTransitionEvent('pagehide', true));
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'unregister',
            windowId: 100,
        }));

        messages.length = 0;
        browserWindow.dispatch('pageshow', createPageTransitionEvent('pageshow', true));
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'announce',
            windowId: 100,
            ready: true,
        }));
        expect(messages).toContainEqual(expect.objectContaining({
            type: 'discover',
            windowId: 100,
        }));
    });

    it('delegates incoming transfer decoding to the canonical contract decoder', async () => {
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        const callback = vi.fn();
        browserWindowTabsCapability.onIncomingTransfer(callback);
        browserWindowTabsCapability.notifyRendererReady();

        const baseTransfer = {
            schemaVersion: 1,
            nonce: 'nonce-1',
            transferId: 'transfer-1',
            sourceWindowId: 200,
            targetWindowId: 100,
            tab: {
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                isDirty: false,
                isDjvu: false,
                ignored: 'drop-me',
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                snapshotPath: '/tmp/snapshot.pdf',
                snapshotBackend: 'electron',
                isDirty: false,
                currentPage: 2,
                totalPages: 3,
                ignored: 'drop-me',
            },
            ignored: 'drop-me',
        };

        externalWindow.postMessage({
            type: 'transfer',
            transfer: baseTransfer,
        });

        expect(callback).toHaveBeenCalledWith({
            schemaVersion: 1,
            nonce: 'nonce-1',
            transferId: 'transfer-1',
            sourceWindowId: 200,
            targetWindowId: 100,
            tab: {
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'source.pdf',
                originalPath: '/tmp/source.pdf',
                originalBackend: 'browser',
                snapshotPath: '/tmp/snapshot.pdf',
                snapshotBackend: 'electron',
                isDirty: false,
                currentPage: 2,
                totalPages: 3,
            },
        });

        callback.mockClear();
        externalWindow.postMessage({
            type: 'transfer',
            transfer: {
                ...baseTransfer,
                transferId: 'transfer-2',
                tab: {
                    ...baseTransfer.tab,
                    originalBackend: 'bogus',
                },
            },
        });
        expect(callback).not.toHaveBeenCalled();
    });

    it('does not resurrect a transfer when authority creation finishes after the source deadline', async () => {
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        externalWindow.postMessage({
            type: 'announce',
            windowId: 200,
            instanceNonce: 'target-instance',
            label: 'Target',
            ready: true,
        });
        messages.length = 0;

        let finishMutation: (() => void) | undefined;
        let authorityMutation: TAuthorityMutation | undefined;
        let createdAuthority: unknown;
        transferAuthorityMocks.mutateBrowserTransferAuthority.mockImplementationOnce(
            (_transferId: string, mutate: TAuthorityMutation) => new Promise(resolve => {
                authorityMutation = mutate;
                finishMutation = () => {
                    createdAuthority = mutate(null, {put: vi.fn()});
                    resolve(createdAuthority);
                };
            }),
        );

        const transfer = browserWindowTabsCapability.transfer({
            target: {
                kind: 'window',
                windowId: 200,
            },
            tab: {
                fileName: 'source.pdf',
                originalPath: '/source.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {kind: 'empty'},
            timeoutMs: 1,
        });
        await vi.advanceTimersByTimeAsync(1);
        expect(transferAuthorityMocks.abortBrowserTransferAuthority).toHaveBeenCalledOnce();
        expect(authorityMutation).toEqual(expect.any(Function));
        expect(finishMutation).toEqual(expect.any(Function));

        finishMutation?.();

        await expect(transfer).resolves.toMatchObject({success: false});
        expect(createdAuthority).toMatchObject({state: 'aborted'});
        expect(messages).not.toContainEqual(expect.objectContaining({type: 'transfer'}));
    });

    it('does not commit a transfer at the source deadline boundary', async () => {
        vi.setSystemTime(100_000);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady();
        externalWindow.postMessage({
            type: 'announce',
            windowId: 200,
            instanceNonce: 'target-instance',
            label: 'Target',
            ready: true,
        });

        let authority: IBrowserTransferAuthorityRecord | null = null;
        transferAuthorityMocks.mutateBrowserTransferAuthority.mockImplementation(
            async (_transferId: string, mutate: TAuthorityMutation) => {
                const next = mutate(
                    authority,
                    {put: value => { authority = value as IBrowserTransferAuthorityRecord; }},
                ) as IBrowserTransferAuthorityRecord | null;
                authority = next;
                return next;
            },
        );

        const transfer = browserWindowTabsCapability.transfer({
            target: {
                kind: 'window',
                windowId: 200,
            },
            tab: {
                fileName: null,
                originalPath: null,
                isDirty: false,
                isDjvu: false,
            },
            payload: {kind: 'empty'},
            timeoutMs: 10,
        });
        await vi.advanceTimersByTimeAsync(0);
        const transferMessage = messages.find((message): message is {
            type: 'transfer';
            transfer: {
                nonce: string;
                transferId: string;
            };
        } => (
            typeof message === 'object'
            && message !== null
            && 'type' in message
            && message.type === 'transfer'
        ));
        if (!transferMessage) {
            throw new Error('Transfer message was not dispatched before the deadline');
        }

        vi.setSystemTime(100_010);
        externalWindow.postMessage({
            type: 'ack',
            windowId: 200,
            ack: {
                schemaVersion: 1,
                nonce: transferMessage.transfer.nonce,
                transferId: transferMessage.transfer.transferId,
                success: true,
            },
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(authority?.state).toBe('pending');
        await vi.advanceTimersByTimeAsync(10);
        await expect(transfer).resolves.toMatchObject({success: false});
        expect(transferAuthorityMocks.abortBrowserTransferAuthority).toHaveBeenCalledWith(
            transferMessage.transfer.transferId,
            transferMessage.transfer.nonce,
        );
    });
});
