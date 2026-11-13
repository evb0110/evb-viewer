import type * as TBrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';

vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof TBrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        output: null,
    }),
}));

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

// The stubbed browser has no lock manager (Node provides one).
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
    vi.stubGlobal('document', {
        title: 'EVB Viewer Web',
        cookie: '',
    });
    vi.stubGlobal('navigator', {});
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

// Warm the complete handoff graph at collection; each case still reloads it.
await import('@app/platform/browser-api/browserWorkingCopyService');

describe('browserWindowTabsCapability', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useFakeTimers();
        MockBroadcastChannel.reset();
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

        await vi.advanceTimersByTimeAsync(70);
        expect(module.getBrowserWindowId()).not.toBe('321');
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

});
