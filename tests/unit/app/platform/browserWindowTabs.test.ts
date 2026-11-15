import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {createDocument} from '@document-store/documentDirectory';
import type {IDocumentStore} from '@document-store/documentDirectory';
import {createBrowserDocumentRef} from '@app/platform/browser/browserDocumentRefs';
import type {IWorkspaceCheckpointAnnotationRecovery} from '@contracts/workspaceCheckpoint';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

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

    it('keeps the recovery owner across hot reload in the same browser tab', async () => {
        const firstModule = await import('@app/platform/browserWindowTabs');
        firstModule.browserWindowTabsCapability.notifyRendererReady();
        const firstWindowId = firstModule.getBrowserWindowId();

        vi.resetModules();

        const secondModule = await import('@app/platform/browserWindowTabs');
        secondModule.browserWindowTabsCapability.notifyRendererReady();

        expect(secondModule.getBrowserWindowId()).toBe(firstWindowId);
        expect(MockBroadcastChannel.channels).toHaveLength(1);
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

});


describe('browser recovery diagnostics', () => {
    let root = '';
    beforeEach(async () => {
        vi.resetModules();
        // The browser's cross-window locks and IndexedDB are host boundaries, unavailable in this Node lane.
        vi.doMock('@app/platform/browser/runBrowserLock', () => ({
            heldBrowserLockNames: async () => new Set<string>(),
            holdBrowserLock: async () => () => undefined,
            runBrowserLock: async (_name: string, task: () => Promise<unknown>) => task(),
        }));
        vi.doMock('@app/platform/browser/browserFileHandleStore', () => ({fileHandleStore: {
            keys: async () => [], get: async () => undefined, delete: async () => undefined,
        }}));
        vi.doMock('@app/platform/browser/browserRecentFilesStore', async importOriginal => ({
            ...await importOriginal<typeof import('@app/platform/browser/browserRecentFilesStore')>(),
            tryReadRecentFilesFromStorage: () => [],
        }));


        root = await mkdtemp(join(tmpdir(), 'browser-recovery-1609-'));
    });
    afterEach(async () => {
        const {browserDocumentStore} = await import('@app/platform/browser/browserDocumentRepository');
        await Promise.all(browserDocumentStore.openEntries().map(entry => entry.doc?.close()));
        vi.restoreAllMocks();
        await rm(root, {recursive: true, force: true});
        vi.doUnmock('@app/platform/browser/runBrowserLock');
        vi.doUnmock('@app/platform/browser/browserFileHandleStore');
        vi.doUnmock('@app/platform/browser/browserRecentFilesStore');
        vi.resetModules();
    });

    async function recovery() {
        const {browserPublication} = await import('@app/platform/browser/browserPublication');
        const {browserDocumentStore} = await import('@app/platform/browser/browserDocumentRepository');
        const {BrowserLogger} = await import('@app/utils/browserLogger');
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(BrowserLogger, 'error');
        const info = vi.spyOn(BrowserLogger, 'info').mockImplementation(() => undefined);
        const debug = vi.spyOn(BrowserLogger, 'debug').mockImplementation(() => undefined);
        const store: IDocumentStore = {port: createNodeStorePort(root), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({durable: store, memory: store});
        const api = await import('@app/platform/browser/browserWorkspaceRecovery');
        const diagnostics = () => [...warn.mock.calls, ...error.mock.calls].map(args => JSON.stringify(args, (_key, value: unknown) => value instanceof Error ? value.message : value)).join('\n');
        return {store, repo: browserDocumentStore, api, diagnostics, warn, error, info, debug};
    }

    it('#1609 reports an unreadable browser manifest through diagnostics and the existing recovery notice data', async () => {
        const {store, api, diagnostics} = await recovery();
        const target = 'documents/broken/manifest.json';
        const {fileHandleStore} = await import('@app/platform/browser/browserFileHandleStore');
        const handles = new Set(['retained-recovery-binding']);
        vi.spyOn(fileHandleStore, 'keys').mockImplementation(async () => [...handles]);
        vi.spyOn(fileHandleStore, 'delete').mockImplementation(async key => { handles.delete(key); });
        await store.port.writeAtomic(target, new TextEncoder().encode('{corrupt'));
        const claimed = await api.claimBrowserWorkspaceCheckpoint('recovery-window');
        expect.soft(await fileHandleStore.keys()).toContain('retained-recovery-binding');
        expect.soft(new TextDecoder().decode(await store.port.read(target))).toBe('{corrupt');
        expect.soft(diagnostics()).toContain(target);
        expect.soft(diagnostics()).toMatch(/(?:SyntaxError|Expected property name|Unexpected token|not valid JSON|Unreadable document manifest|parsing|parse error)/iu);
        expect(claimed?.tabs.some(tab => tab.workingCopyLost)).toBe(true);
    });

    it('#1609 reports an orphan manifest read failure after browser collection', async () => {
        const {store, api, diagnostics} = await recovery();
        const doc = await createDocument(store, {id: 'orphan', ext: 'pdf', source: new Blob(['base'])});
        await doc.setDrafts(1, {note: 'unsaved'});
        await doc.close();
        // Startup inspection completed while the manifest was readable; it fails before the subsequent claim.
        await api.hasBrowserWorkspaceCheckpoint('orphan-window');
        const read = store.port.read.bind(store.port);
        vi.spyOn(store.port, 'read').mockImplementation(target => target === 'documents/orphan/manifest.json'
            ? Promise.reject(new Error('NotAllowedError injected orphan manifest')) : read(target));
        const claimed = await api.claimBrowserWorkspaceCheckpoint('orphan-window');
        expect.soft(diagnostics()).toContain('documents/orphan/manifest.json');
        expect.soft(diagnostics()).toContain('NotAllowedError injected orphan manifest');
        expect(claimed?.tabs.some(tab => tab.workingCopyLost)).toBe(true);
    });

    it('#1609 logs a failed browser startup collection with its key and error', async () => {
        const {store, api, diagnostics} = await recovery();
        const list = store.port.list.bind(store.port);
        vi.spyOn(store.port, 'list').mockImplementation(key => key === 'documents'
            ? Promise.reject(new Error('NotAllowedError injected startup list documents')) : list(key));
        await api.claimBrowserWorkspaceCheckpoint('collection-window');
        expect.soft(diagnostics()).toContain('documents');
        expect(diagnostics()).toContain('NotAllowedError injected startup list documents');
    });

    it.each(['rejects', 'finds no entry'])('#1609 never acknowledges unwritten drafts after a durable-entry lookup %s', async mode => {
        const {store, api, diagnostics} = await recovery();
        const ref = createBrowserDocumentRef('paper.pdf', 'draft-document');
        const list = store.port.list.bind(store.port);
        if (mode === 'rejects') vi.spyOn(store.port, 'list').mockImplementation(key => key === 'documents'
            ? Promise.reject(new Error('NotReadableError injected durable-entry lookup')) : list(key));
        const drafts: IWorkspaceCheckpointAnnotationRecovery = {artifactId: 'draft-1609', documentInstanceId: 'instance-1609', workingCopyRef: ref, workingByteRevision: '1', annotationMutationGeneration: 1, payload: {entities: []}};
        const outcome = await api.setBrowserDocumentDrafts(drafts).then(value => value, () => false);
        expect.soft(outcome, 'true acknowledges a checkpoint whose drafts were never written').toBe(false);
        if (mode === 'rejects') {
            expect.soft(diagnostics()).toContain(ref);
            expect(diagnostics()).toContain('NotReadableError injected durable-entry lookup');
        }
    });

    it('#1609 keeps an absent browser store silent without a recovery notice', async () => {
        const {api, warn, error, info, debug} = await recovery();
        expect(await api.claimBrowserWorkspaceCheckpoint('empty-window')).toBeNull();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
        expect(debug).not.toHaveBeenCalled();
    });


    it('#1609 logs an unreadable manifest during browser handle collection while another window holds its directory', async () => {
        const {store, api, diagnostics} = await recovery();
        const locks = await import('@app/platform/browser/runBrowserLock');
        vi.spyOn(locks, 'holdBrowserLock').mockResolvedValue(null);
        const target = 'documents/held-document/manifest.json';
        await store.port.writeAtomic(target, new TextEncoder().encode('{corrupt'));
        const read = store.port.read.bind(store.port);
        vi.spyOn(store.port, 'read').mockImplementation(name => name === target
            ? Promise.reject(new Error('NotReadableError injected handle-collection manifest')) : read(name));
        await api.claimBrowserWorkspaceCheckpoint('held-window');
        expect.soft(diagnostics()).toContain(target);
        expect(diagnostics()).toContain('NotReadableError injected handle-collection manifest');
        expect(new TextDecoder().decode(await read(target))).toBe('{corrupt');
    });
});
