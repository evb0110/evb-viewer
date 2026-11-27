import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {createDocument} from '@document-store/documentDirectory';
import type {IDocumentStore} from '@document-store/documentDirectory';
import {
    readWorkspaceCheckpoints,
    removeWorkspaceCheckpoint,
    writeWorkspaceCheckpoint,
} from '@document-store/workspaceCheckpoint';
import {createBrowserDocumentRef} from '@app/platform/browser/browserDocumentRefs';
import type {IWorkspaceCheckpointAnnotationRecovery} from '@contracts/workspaceCheckpoint';
import {createFileSystemFileHandle} from '@tests/unit/app/platform/browserPlatformTestDoubles';

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
        firstModule.browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});
        const firstWindowId = firstModule.getBrowserWindowId();

        vi.resetModules();

        const secondModule = await import('@app/platform/browserWindowTabs');
        secondModule.browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});

        expect(secondModule.getBrowserWindowId()).toBe(firstWindowId);
        expect(MockBroadcastChannel.channels).toHaveLength(1);
    });

    it('can initialize again after a non-persisted page hide tears down the instance', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});

        browserWindow.dispatch('pagehide');
        expect(MockBroadcastChannel.channels.size).toBe(1);

        browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});
        messages.length = 0;
        browserWindow.dispatch('focus');
        expect(messages).toEqual([expect.objectContaining({
            type: 'announce',
            windowId: 100,
            ready: true,
        })]);
    });

    it('re-announces a window restored from the browser back-forward cache', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const { browserWindowTabsCapability } = await import('@app/platform/browserWindowTabs');
        browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});
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

    it('announces readiness to other windows only after the shell becomes interactive', async () => {
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=100');
        const externalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const messages: unknown[] = [];
        externalWindow.addEventListener('message', event => messages.push(event.data));
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');
        const readyAnnouncement = expect.objectContaining({
            type: 'announce',
            windowId: 100,
            ready: true,
        });

        browserWindowTabsCapability.notifyRendererReady({phase: 'failed', reason: 'renderer-error'});
        expect(messages).not.toContainEqual(readyAnnouncement);

        browserWindowTabsCapability.notifyRendererReady({phase: 'shell-interactive'});
        expect(messages).toContainEqual(readyAnnouncement);
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
            keys: async () => [], get: async () => undefined, put: async () => undefined, delete: async () => undefined,
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
        const {createMemoryStorePort} = await import('@app/platform/browser/browserStorePort');
        const {browserDocumentStore} = await import('@app/platform/browser/browserDocumentRepository');
        const {BrowserLogger} = await import('@app/utils/browserLogger');
        const warn = vi.spyOn(BrowserLogger, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(BrowserLogger, 'error');
        const info = vi.spyOn(BrowserLogger, 'info').mockImplementation(() => undefined);
        const debug = vi.spyOn(BrowserLogger, 'debug').mockImplementation(() => undefined);
        const store: IDocumentStore = {port: createNodeStorePort(root), publication: browserPublication};
        const memory: IDocumentStore = {port: createMemoryStorePort(), publication: browserPublication};
        vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({durable: store, memory});
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

    async function closedWindowDraft(store: IDocumentStore) {
        const ref = createBrowserDocumentRef('copy.pdf', 'copy-directory');
        const drafts: IWorkspaceCheckpointAnnotationRecovery = {artifactId: 'copy-note', documentInstanceId: 'copy-instance', workingCopyRef: ref, workingByteRevision: 'drt1:browser:copy-directory:1', annotationMutationGeneration: 1, payload: {entities: [{contents: 'Copy note'}]}};
        const doc = await createDocument(store, {id: 'copy-directory', ext: 'pdf', source: new Blob(['%PDF-1.7'])});
        await doc.setDrafts(1, drafts);
        await doc.close();
        await writeWorkspaceCheckpoint(store.port, 'closed-window', {tabs: {'copy-directory': {directory: 'copy-directory', view: null}}, layout: null});
        return ref;
    }

    it('keeps a closed window\'s checkpoint while another window holds a directory it names', async () => {
        const {store, api} = await recovery();
        const ref = await closedWindowDraft(store);
        const {browserDocumentLockName} = await import('@app/platform/browser/browserDocumentRepository');
        const locks = await import('@app/platform/browser/runBrowserLock');
        // A window starting alongside this one holds the copy's directory while this one collects.
        const otherWindow = vi.spyOn(locks, 'holdBrowserLock').mockImplementation(async name => (name === browserDocumentLockName('copy-directory') ? null : () => undefined));
        expect(await api.claimBrowserWorkspaceCheckpoint('starting-window')).toBeNull();
        expect([...(await readWorkspaceCheckpoints(store.port)).keys()]).toContain('closed-window');

        // The other window lets go; the next window to start finds the directory free and the checkpoint that names it.
        otherWindow.mockRestore();
        vi.resetModules();
        const later = await recovery();
        const claimed = await later.api.claimBrowserWorkspaceCheckpoint('later-window');
        expect(claimed?.tabs[0]?.annotationRecovery?.workingCopyRef).toBe(ref);
    });

    it('reopens unsaved work no window shows under the reference its drafts were captured with', async () => {
        const {store, api} = await recovery();
        const ref = await closedWindowDraft(store);
        await removeWorkspaceCheckpoint(store.port, 'closed-window');
        const claimed = await api.claimBrowserWorkspaceCheckpoint('later-window');
        expect(claimed?.tabs).toHaveLength(1);
        expect(claimed?.tabs[0]).toMatchObject({fileName: 'copy.pdf', workingCopyRef: ref, annotationRecovery: {workingCopyRef: ref, payload: {entities: [{contents: 'Copy note'}]}}});
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

    it('rejects stale drafts when the document advances to a newer revision while nameEdited awaits', async () => {
        const {repo, api} = await recovery();
        const ref = await repo.createStoredDocument('race.pdf', new TextEncoder().encode('%PDF-1.7 rev1'), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const entry = await repo.requireEntry(ref);
        const rev1Token = repo.tokenOf(entry);
        const rev1Drafts: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-race',
            workingCopyRef: ref,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Stale rev 1 draft'}]},
        };

        const nameEditedStarted = Promise.withResolvers<void>();
        const releaseNameEdited = Promise.withResolvers<void>();
        let pauseFirstNameEdited = true;
        repo.onDirectoryEdited = async () => {
            if (!pauseFirstNameEdited) return;
            pauseFirstNameEdited = false;
            nameEditedStarted.resolve();
            await releaseNameEdited.promise;
        };

        const staleWrite = api.setBrowserDocumentDrafts(rev1Drafts);
        await nameEditedStarted.promise;

        await repo.write(ref, new TextEncoder().encode('%PDF-1.7 rev2'), {expectedDocumentRevisionToken: rev1Token});
        const rev2Token = repo.tokenOf(entry);
        expect(rev2Token).not.toBe(rev1Token);

        const rev2Drafts: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-race',
            workingCopyRef: ref,
            workingByteRevision: rev2Token,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Current rev 2 draft'}]},
        };
        expect(await api.setBrowserDocumentDrafts(rev2Drafts)).toBe(true);

        releaseNameEdited.resolve();
        expect(await staleWrite).toBe(false);
        expect(entry.doc?.state().current?.id).toBe(2);
        expect(entry.doc?.state().drafts).toEqual(rev2Drafts);
    });

    it('passes the pre-await expected revision into setDrafts so a queued revision commit rejects stale drafts', async () => {
        const {repo, api} = await recovery();
        const ref = await repo.createStoredDocument('queued-race.pdf', new TextEncoder().encode('%PDF-1.7 rev1'), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const entry = await repo.requireEntry(ref);
        const doc = entry.doc!;
        const rev1Token = repo.tokenOf(entry);
        const rev1Drafts: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-queued-race',
            workingCopyRef: ref,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Stale rev 1 draft'}]},
        };
        const rev2Drafts = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-queued-race',
            workingCopyRef: ref,
            workingByteRevision: `drt1:browser:${doc.id}:2`,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Committed rev 2 draft'}]},
        };

        const nameEditedStarted = Promise.withResolvers<void>();
        const releaseNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            nameEditedStarted.resolve();
            await releaseNameEdited.promise;
        };

        const staleWrite = api.setBrowserDocumentDrafts(rev1Drafts);
        await nameEditedStarted.promise;

        // Start a revision-2 mutation that is still in-flight when nameEdited resumes, so tokenOf(entry) is still rev 1.
        const mutationStarted = Promise.withResolvers<void>();
        const releaseMutation = Promise.withResolvers<void>();
        const mutation = doc.mutate(1, {
            kind: 'rewrite',
            source: async (file) => {
                mutationStarted.resolve();
                await releaseMutation.promise;
                await file.writeAt(0, new TextEncoder().encode('%PDF-1.7 rev2'));
            },
            drafts: {replace: rev2Drafts},
        });
        await mutationStarted.promise;

        const setDraftsQueued = Promise.withResolvers<void>();
        const originalSetDrafts = doc.setDrafts.bind(doc);
        vi.spyOn(doc, 'setDrafts').mockImplementation((expected, drafts) => {
            setDraftsQueued.resolve();
            return originalSetDrafts(expected, drafts);
        });
        releaseNameEdited.resolve();
        await setDraftsQueued.promise;

        releaseMutation.resolve();
        expect(await mutation).toMatchObject({status: 'committed', revision: {id: 2}});
        expect(await staleWrite).toBe(false);
        expect(doc.state().current?.id).toBe(2);
        expect(doc.state().drafts).toEqual(rev2Drafts);
    });

    it('rejects a stale draft clear and rejects drafts when the document closes during nameEdited', async () => {
        const {repo, api, store} = await recovery();
        const ref = await repo.createStoredDocument('stale-clear.pdf', new TextEncoder().encode('%PDF-1.7 rev1'), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const entry = await repo.requireEntry(ref);
        const rev1Token = repo.tokenOf(entry);
        await repo.write(ref, new TextEncoder().encode('%PDF-1.7 rev2'), {expectedDocumentRevisionToken: rev1Token});

        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-stale-clear',
            workingCopyRef: ref,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 0,
        })).toBe(false);

        const rev2Token = repo.tokenOf(entry);
        const nameEditedStarted = Promise.withResolvers<void>();
        const releaseNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            nameEditedStarted.resolve();
            await releaseNameEdited.promise;
        };

        const closedWrite = api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-stale-clear',
            workingCopyRef: ref,
            workingByteRevision: rev2Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Closed during nameEdited'}]},
        });
        await nameEditedStarted.promise;

        const docId = entry.doc!.id;
        await repo.release(ref);
        releaseNameEdited.resolve();

        expect(await closedWrite).toBe(false);
        const manifest = JSON.parse(new TextDecoder().decode(await store.port.read(`documents/${docId}/manifest.json`))) as {drafts?: string};
        expect(manifest.drafts).toBeUndefined();
    });

    it('stores drafts when materialize copies an unchanged picked PDF while nameEdited awaits, and rejects foreign bytes', async () => {
        const {repo, api, store} = await recovery();
        let diskBytes = new TextEncoder().encode('%PDF-1.7 picked');
        let lastModified = 1_000;
        const handle = createFileSystemFileHandle({
            name: 'picked.pdf',
            getFile: async () => new File([diskBytes], 'picked.pdf', {lastModified}),
        });
        const sourceRef = await repo.registerFile(new File([diskBytes], 'picked.pdf', {lastModified}), {saveHandle: handle});
        const workingRef = await repo.cloneAsWorkingCopy(sourceRef);
        const entry = await repo.requireEntry(workingRef);
        const doc = entry.doc!;
        expect(doc.state().current).toBeNull();
        const rev1Token = repo.tokenOf(entry);

        const rev1Drafts: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-materialize-unchanged',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Valid draft across unchanged materialize'}]},
        };

        const nameEditedStarted = Promise.withResolvers<void>();
        const releaseNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            nameEditedStarted.resolve();
            await releaseNameEdited.promise;
        };

        const draftWrite = api.setBrowserDocumentDrafts(rev1Drafts);
        await nameEditedStarted.promise;

        // Materializing unchanged baseline bytes transitions current: null -> {id: 1} while keeping token :1.
        expect(await doc.materialize()).toMatchObject({id: 1, witness: doc.state().baseline});
        expect(repo.tokenOf(entry)).toBe(rev1Token);

        releaseNameEdited.resolve();
        expect(await draftWrite).toBe(true);
        expect(doc.state().drafts).toEqual(rev1Drafts);
        const storedManifest = JSON.parse(new TextDecoder().decode(await store.port.read(`documents/${doc.id}/manifest.json`))) as {drafts?: string};
        expect(storedManifest.drafts).toBeDefined();

        // Control: an externally modified picked file materialized with asItIs (witness: undefined) must reject drafts captured on the old baseline.
        let changedBytes = new TextEncoder().encode('%PDF-1.7 original');
        let changedModified = 2_000;
        const changedHandle = createFileSystemFileHandle({
            name: 'changed.pdf',
            getFile: async () => new File([changedBytes], 'changed.pdf', {lastModified: changedModified}),
        });
        const changedSourceRef = await repo.registerFile(new File([changedBytes], 'changed.pdf', {lastModified: changedModified}), {saveHandle: changedHandle});
        const changedWorkingRef = await repo.cloneAsWorkingCopy(changedSourceRef);
        const changedEntry = await repo.requireEntry(changedWorkingRef);
        const changedDoc = changedEntry.doc!;
        const changedToken = repo.tokenOf(changedEntry);

        const changedNameEditedStarted = Promise.withResolvers<void>();
        const releaseChangedNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            changedNameEditedStarted.resolve();
            await releaseChangedNameEdited.promise;
        };

        const staleForeignWrite = api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-materialize-foreign',
            workingCopyRef: changedWorkingRef,
            workingByteRevision: changedToken,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Stale draft against externally changed file'}]},
        });
        await changedNameEditedStarted.promise;

        changedBytes = new TextEncoder().encode('%PDF-1.7 foreign replacement');
        changedModified = 3_000;
        expect(await changedDoc.materialize(true)).toMatchObject({id: 1, witness: undefined});

        releaseChangedNameEdited.resolve();
        expect(await staleForeignWrite).toBe(false);
        expect(changedDoc.state().drafts).toBeUndefined();
    });

    it('rejects stale drafts across rewrite + undo during nameEdited, and stores post-undo drafts across unchanged materialize', async () => {
        const {repo, api, store} = await recovery();
        const diskBytes = new TextEncoder().encode('%PDF-1.7 picked');
        const lastModified = 1_000;
        const handle = createFileSystemFileHandle({
            name: 'undo-race.pdf',
            getFile: async () => new File([diskBytes], 'undo-race.pdf', {lastModified}),
        });
        const sourceRef = await repo.registerFile(new File([diskBytes], 'undo-race.pdf', {lastModified}), {saveHandle: handle});
        const workingRef = await repo.cloneAsWorkingCopy(sourceRef);
        const entry = await repo.requireEntry(workingRef);
        const doc = entry.doc!;
        expect(doc.state().current).toBeNull();
        const rev1Token = repo.tokenOf(entry);

        // 1. Rewrite + undo returns current to null (and token to :1) while nameEdited awaits: stale draft must be rejected.
        const firstNameEditedStarted = Promise.withResolvers<void>();
        const releaseFirstNameEdited = Promise.withResolvers<void>();
        let pauseFirst = true;
        repo.onDirectoryEdited = async () => {
            if (!pauseFirst) return;
            pauseFirst = false;
            firstNameEditedStarted.resolve();
            await releaseFirstNameEdited.promise;
        };

        const staleAcrossUndo = api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-undo-race',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Stale draft before rewrite + undo'}]},
        });
        await firstNameEditedStarted.promise;

        await repo.write(workingRef, new TextEncoder().encode('%PDF-1.7 rev2'), {expectedDocumentRevisionToken: rev1Token});
        const rev2Token = repo.tokenOf(entry);
        await repo.restoreRevision(workingRef, rev1Token, rev2Token);
        expect(doc.state().current).toBeNull();
        expect(doc.state().byteRevision).toBeGreaterThan(0);
        expect(repo.tokenOf(entry)).toBe(rev1Token);

        releaseFirstNameEdited.resolve();
        expect(await staleAcrossUndo).toBe(false);
        expect(doc.state().drafts).toBeUndefined();
        const manifestAfterUndo = JSON.parse(new TextDecoder().decode(await store.port.read(`documents/${doc.id}/manifest.json`))) as {drafts?: string};
        expect(manifestAfterUndo.drafts).toBeUndefined();

        // 2. Fresh draft captured after the earlier undo (next > 2, current === null) must succeed when unchanged baseline materializes (null -> 1).
        const secondNameEditedStarted = Promise.withResolvers<void>();
        const releaseSecondNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            secondNameEditedStarted.resolve();
            await releaseSecondNameEdited.promise;
        };

        const postUndoDrafts: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-undo-race',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Valid post-undo draft across materialize'}]},
        };
        const postUndoWrite = api.setBrowserDocumentDrafts(postUndoDrafts);
        await secondNameEditedStarted.promise;

        expect(await doc.materialize()).toMatchObject({id: 1, witness: doc.state().baseline});
        releaseSecondNameEdited.resolve();

        expect(await postUndoWrite).toBe(true);
        expect(doc.state().drafts).toEqual(postUndoDrafts);
        const manifestAfterPostUndo = JSON.parse(new TextDecoder().decode(await store.port.read(`documents/${doc.id}/manifest.json`))) as {drafts?: string};
        expect(manifestAfterPostUndo.drafts).toBeDefined();
    });

    it('stores drafts across ownCurrentFile moves, rejects drafts across foreign Save As staging/publication, preserves stageAppend rescue, and accepts drafts on undone untitled r1', async () => {
        const {repo, api} = await recovery();
        const {browserPublication, rememberFileHandle} = await import('@app/platform/browser/browserPublication');

        // 1. S4: ownCurrentFile() moving a retained redo revision must not reject a concurrent draft write.
        const moveRef = await repo.createStoredDocument('move-copy.pdf', new TextEncoder().encode('%PDF-1.7 base'), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const moveEntry = await repo.requireEntry(moveRef);
        const moveDoc = moveEntry.doc!;
        expect(await moveDoc.mutate(1, {kind: 'append', bytes: new TextEncoder().encode('+redo'), drafts: 'clear'})).toMatchObject({status: 'committed', revision: {id: 2}});
        await moveDoc.retain([1, 2]);
        expect(await moveDoc.restore(2, 1)).toMatchObject({status: 'committed', revision: {id: 1}});
        const moveToken = repo.tokenOf(moveEntry);
        const moveDraft: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-move',
            workingCopyRef: moveRef,
            workingByteRevision: moveToken,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Draft across ownCurrentFile'}]},
        };
        const moveNameEditedStarted = Promise.withResolvers<void>();
        const releaseMoveNameEdited = Promise.withResolvers<void>();
        repo.onDirectoryEdited = async () => {
            moveNameEditedStarted.resolve();
            await releaseMoveNameEdited.promise;
        };
        const moveWrite = api.setBrowserDocumentDrafts(moveDraft);
        await moveNameEditedStarted.promise;
        await moveDoc.ownCurrentFile();
        releaseMoveNameEdited.resolve();
        expect(await moveWrite).toBe(true);
        expect(moveDoc.state().drafts).toEqual(moveDraft);

        // Reset onDirectoryEdited for subsequent assertions.
        repo.onDirectoryEdited = async () => {};

        // 2. S5: Foreign Save As staging, pendingPublish, conflict/failure rollback, and publication token change.
        const makeWritableHandle = (name: string, initialText: string, initialModified: number) => {
            const disk = {bytes: new TextEncoder().encode(initialText), lastModified: initialModified};
            const handle: FileSystemFileHandle = {
                ...createFileSystemFileHandle({
                    name,
                    getFile: async () => new File([disk.bytes], name, {lastModified: disk.lastModified}),
                }),
                createWritable: async () => {
                    const chunks: Uint8Array<ArrayBuffer>[] = [];
                    return Object.assign(new WritableStream(), {
                        write: async (chunk: FileSystemWriteChunkType) => {
                            if (!(chunk instanceof ArrayBuffer)) throw new TypeError('Expected ArrayBuffer chunk');
                            chunks.push(new Uint8Array(chunk));
                        },
                        close: async () => {
                            disk.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
                            disk.lastModified += 1;
                        },
                        abort: async () => {},
                        seek: async () => {},
                        truncate: async () => {},
                    }) satisfies FileSystemWritableFileStream;
                },
            };
            return {disk, handle};
        };

        const picked = makeWritableHandle('foreign-browser.pdf', '%PDF-1.7 orig', 1_000);
        const copy = makeWritableHandle('foreign-browser-copy.pdf', '', 2_000);
        rememberFileHandle('foreign-browser-copy', copy.handle);
        const sourceRef = await repo.registerFile(new File([picked.disk.bytes], 'foreign-browser.pdf', {lastModified: picked.disk.lastModified}), {saveHandle: picked.handle});
        const workingRef = await repo.cloneAsWorkingCopy(sourceRef);
        const entry = await repo.requireEntry(workingRef);
        const doc = entry.doc!;
        const rev1Token = repo.tokenOf(entry);

        // External replacement on disk.
        picked.disk.bytes = new TextEncoder().encode('%PDF-1.7 foreign replacement');
        picked.disk.lastModified = 3_000;

        // Pause Save As after publish() stages witness into pendingPublish.
        const stagedStarted = Promise.withResolvers<void>();
        const releaseStaged = Promise.withResolvers<void>();
        const realPublish = browserPublication.publish.bind(browserPublication);
        const publishSpy = vi.spyOn(browserPublication, 'publish').mockImplementationOnce(async (dest, src, expected, stage, reserve) => realPublish(dest, src, expected, async (witness) => {
            await stage(witness);
            stagedStarted.resolve();
            await releaseStaged.promise;
        }, reserve));

        const revisionEvents: string[] = [];
        const stopListening = repo.onDocumentRevisionChanged(event => revisionEvents.push(`${event.reason}:${event.token}`));

        const saveAsPromise = repo.save(workingRef, rev1Token, {saveAs: 'handle:foreign-browser-copy'});
        await stagedStarted.promise;

        // While foreign-staged (including with staged pendingPublish), old `:1` draft is rejected.
        expect(doc.state().current?.foreign).toBe('staged');
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-foreign-browser',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Rejected during foreign pendingPublish'}]},
        })).toBe(false);

        releaseStaged.resolve();
        expect(await saveAsPromise).toMatchObject({status: 'saved', revision: {id: 1, foreign: 'committed'}});
        publishSpy.mockRestore();
        stopListening();

        const publishedToken = repo.tokenOf(entry);
        expect(publishedToken).toBe(`drt1:browser:${doc.id}:1:f`);
        expect(revisionEvents).toEqual([`save-sync:${publishedToken}`]);

        // Stale pre-Save-As `:1` draft arriving after publication is rejected.
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-foreign-browser',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Rejected stale pre-Save-As draft'}]},
        })).toBe(false);

        // Fresh post-publication draft using the new save-sync token succeeds and survives close & reopen.
        const postPublishDraft: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-foreign-browser',
            workingCopyRef: workingRef,
            workingByteRevision: publishedToken,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Valid post-Save-As draft'}]},
        };
        expect(await api.setBrowserDocumentDrafts(postPublishDraft)).toBe(true);
        expect(doc.state().drafts).toEqual(postPublishDraft);

        // S5 reopen persistence: published `:1:f` draft survives close & reopen, still rejects `:1`, and matches checkpoint replay.
        await repo.release(workingRef);
        const reopenedEntry = await repo.requireEntry(workingRef);
        expect(repo.tokenOf(reopenedEntry)).toBe(publishedToken);
        expect(reopenedEntry.doc?.state().drafts).toEqual(postPublishDraft);
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-foreign-browser',
            workingCopyRef: workingRef,
            workingByteRevision: rev1Token,
            annotationMutationGeneration: 3,
            payload: {entities: [{contents: 'Rejected stale :1 after reopen'}]},
        })).toBe(false);
        expect(await api.setBrowserDocumentDrafts({
            ...postPublishDraft,
            annotationMutationGeneration: 4,
            payload: {entities: [{contents: 'Accepted :1:f after reopen'}]},
        })).toBe(true);

        // Mutating to rev 2 and restoring back to publishedToken (:1:f) still parses cleanly.
        await repo.write(workingRef, new TextEncoder().encode('%PDF-1.7 rev2 after foreign saveAs'), {expectedDocumentRevisionToken: publishedToken});
        const rev2AfterForeign = repo.tokenOf(reopenedEntry);
        await repo.restoreRevision(workingRef, publishedToken, rev2AfterForeign);
        expect(repo.tokenOf(reopenedEntry)).toBe(publishedToken);

        // S5 reopen persistence (pre-publish): staged foreign bytes survive close & reopen rejecting `:1` drafts (no pendingPublish, un-adopted pendingPublish, and adopted pendingPublish -> `:1:f`).
        const prePublishPicked = makeWritableHandle('pre-publish-foreign.pdf', '%PDF-1.7 pre-orig', 1_000);
        const prePublishCopy = makeWritableHandle('pre-publish-copy.pdf', '', 2_000);
        rememberFileHandle('pre-publish-copy', prePublishCopy.handle);
        const prePublishSource = await repo.registerFile(new File([prePublishPicked.disk.bytes], 'pre-publish-foreign.pdf', {lastModified: prePublishPicked.disk.lastModified}), {saveHandle: prePublishPicked.handle});
        const prePublishWorking = await repo.cloneAsWorkingCopy(prePublishSource);
        const prePublishEntry = await repo.requireEntry(prePublishWorking);
        const prePublishToken = repo.tokenOf(prePublishEntry);
        prePublishPicked.disk.bytes = new TextEncoder().encode('%PDF-1.7 pre-foreign');
        prePublishPicked.disk.lastModified = 5_000;

        // (a) No pendingPublish across close & reopen.
        expect(await prePublishEntry.doc!.materialize(true)).toMatchObject({id: 1, foreign: 'staged'});
        await repo.release(prePublishWorking);
        const reopenedPrePublish = await repo.requireEntry(prePublishWorking);
        expect(reopenedPrePublish.doc?.state().current?.foreign).toBe('staged');
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-pre-publish',
            workingCopyRef: prePublishWorking,
            workingByteRevision: prePublishToken,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Rejected after pre-publish reopen'}]},
        })).toBe(false);

        // (b) Un-adopted pendingPublish across close & reopen keeps foreign: 'staged' and rejects `:1`.
        const unadoptedSpy = vi.spyOn(browserPublication, 'publish').mockImplementationOnce(async (_dest, _src, _expected, stage) => {
            await stage('unmatched-staged-witness');
            throw new Error('crash before write');
        });
        await expect(repo.save(prePublishWorking, prePublishToken, {saveAs: 'handle:pre-publish-copy'})).rejects.toThrow('crash before write');
        unadoptedSpy.mockRestore();
        await repo.release(prePublishWorking);
        const reopenedUnadopted = await repo.requireEntry(prePublishWorking);
        expect(reopenedUnadopted.doc?.state().current?.foreign).toBe('staged');
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-pre-publish',
            workingCopyRef: prePublishWorking,
            workingByteRevision: prePublishToken,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Rejected after unadopted reopen'}]},
        })).toBe(false);

        // (c) Adopted pendingPublish on reopen transitions foreign: 'staged' -> 'committed' and token to `:1:f`.
        const adoptedSpy = vi.spyOn(browserPublication, 'publish').mockImplementationOnce(async (dest, src, expected, stage, reserve) => {
            await realPublish(dest, src, expected, stage, reserve);
            throw new Error('crash after write before ack');
        });
        await expect(repo.save(prePublishWorking, prePublishToken, {saveAs: 'handle:pre-publish-copy'})).rejects.toThrow('crash after write before ack');
        adoptedSpy.mockRestore();
        await repo.release(prePublishWorking);
        const reopenedAdopted = await repo.requireEntry(prePublishWorking);
        const adoptedToken = repo.tokenOf(reopenedAdopted);
        expect(reopenedAdopted.doc?.state().current?.foreign).toBe('committed');
        expect(adoptedToken).toBe(`drt1:browser:${reopenedAdopted.doc!.id}:1:f`);
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-pre-publish',
            workingCopyRef: prePublishWorking,
            workingByteRevision: prePublishToken,
            annotationMutationGeneration: 3,
            payload: {entities: [{contents: 'Rejected old :1 after adopted reopen'}]},
        })).toBe(false);
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-pre-publish',
            workingCopyRef: prePublishWorking,
            workingByteRevision: adoptedToken,
            annotationMutationGeneration: 4,
            payload: {entities: [{contents: 'Accepted :1:f after adopted reopen'}]},
        })).toBe(true);

        // 3. ADR 0010 rescue + S6 undo after append rescue: stageAppend -> save (conflict) -> Save As of r2 -> undo to r1 restores `:1:f`, rejects `:1`, and accepts `:1:f` across reopen.
        const rescuePicked = makeWritableHandle('rescue.pdf', '%PDF-1.7 rescue-orig', 1_000);
        const rescueCopy = makeWritableHandle('rescue-copy.pdf', '', 2_000);
        rememberFileHandle('rescue-copy', rescueCopy.handle);
        const rescueSource = await repo.registerFile(new File([rescuePicked.disk.bytes], 'rescue.pdf', {lastModified: rescuePicked.disk.lastModified}), {saveHandle: rescuePicked.handle});
        const rescueWorking = await repo.cloneAsWorkingCopy(rescueSource);
        const rescueEntry = await repo.requireEntry(rescueWorking);
        const rescueToken = repo.tokenOf(rescueEntry);
        rescuePicked.disk.bytes = new TextEncoder().encode('%PDF-1.7 rescue-foreign');
        rescuePicked.disk.lastModified = 4_000;

        const lease = await repo.stageAppend(rescueWorking, rescueToken, async (file, base) => {
            const extra = new TextEncoder().encode(' +edit');
            await file.writeAt(base, extra);
            return base + extra.byteLength;
        }, {allowForeignBase: true});
        expect(lease).not.toBeNull();
        expect(rescueEntry.doc?.state().current?.foreign).toBe('staged');
        // Drafts remain rejected while foreign bytes are staged for rescue.
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-rescue',
            workingCopyRef: rescueWorking,
            workingByteRevision: rescueToken,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Rejected during stageAppend foreign staging'}]},
        })).toBe(false);
        expect(await repo.save(rescueWorking, rescueToken, {commit: lease!})).toEqual({status: 'conflict'});
        const committedRescueToken = repo.tokenOf(rescueEntry);
        expect(committedRescueToken).not.toBe(rescueToken);
        await repo.retainRevisions(rescueWorking, [rescueToken, committedRescueToken]);
        expect(await repo.save(rescueWorking, committedRescueToken, {saveAs: 'handle:rescue-copy'})).toMatchObject({status: 'saved'});
        expect(new TextDecoder().decode(rescueCopy.disk.bytes)).toBe('%PDF-1.7 rescue-foreign +edit');

        // S6: Undo to r1 restores foreign bytes with token `:1:f`, rejects original `:1` drafts, and accepts `:1:f` drafts (including after reopen).
        await repo.restoreRevision(rescueWorking, rescueToken, committedRescueToken);
        const restoredForeignToken = repo.tokenOf(rescueEntry);
        expect(rescueEntry.doc?.state().current?.foreign).toBe('committed');
        expect(restoredForeignToken).toBe(`drt1:browser:${rescueEntry.doc!.id}:1:f`);
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-rescue',
            workingCopyRef: rescueWorking,
            workingByteRevision: rescueToken,
            annotationMutationGeneration: 2,
            payload: {entities: [{contents: 'Rejected stale :1 after undo to foreign r1'}]},
        })).toBe(false);
        const restoredForeignDraft: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-rescue',
            workingCopyRef: rescueWorking,
            workingByteRevision: restoredForeignToken,
            annotationMutationGeneration: 3,
            payload: {entities: [{contents: 'Accepted :1:f after undo to foreign r1'}]},
        };
        expect(await api.setBrowserDocumentDrafts(restoredForeignDraft)).toBe(true);
        await repo.release(rescueWorking);
        const reopenedRescue = await repo.requireEntry(rescueWorking);
        expect(repo.tokenOf(reopenedRescue)).toBe(restoredForeignToken);
        expect(reopenedRescue.doc?.state().drafts).toEqual(restoredForeignDraft);
        expect(await api.setBrowserDocumentDrafts({
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-rescue',
            workingCopyRef: rescueWorking,
            workingByteRevision: rescueToken,
            annotationMutationGeneration: 4,
            payload: {entities: [{contents: 'Rejected stale :1 after reopen of undone foreign r1'}]},
        })).toBe(false);
        expect(await api.setBrowserDocumentDrafts({
            ...restoredForeignDraft,
            annotationMutationGeneration: 5,
            payload: {entities: [{contents: 'Accepted :1:f after reopen of undone foreign r1'}]},
        })).toBe(true);

        // 4. Untitled working copy -> mutate to r2 -> Save As -> undo to r1 still accepts drafts.
        const untitledCopy = makeWritableHandle('untitled-copy.pdf', '', 1_000);
        rememberFileHandle('untitled-copy', untitledCopy.handle);
        const untitledRef = await repo.createStoredDocument('untitled.pdf', new TextEncoder().encode('%PDF-1.7 untitled r1'), {
            mimeType: 'application/pdf',
            kind: 'working',
            saveKind: 'pdf',
        });
        const untitledEntry = await repo.requireEntry(untitledRef);
        const untitledR1Token = repo.tokenOf(untitledEntry);
        await repo.write(untitledRef, new TextEncoder().encode('%PDF-1.7 untitled r2'), {expectedDocumentRevisionToken: untitledR1Token});
        const untitledR2Token = repo.tokenOf(untitledEntry);
        await repo.retainRevisions(untitledRef, [untitledR1Token, untitledR2Token]);
        expect(await repo.save(untitledRef, untitledR2Token, {saveAs: 'handle:untitled-copy'})).toMatchObject({status: 'saved'});
        await repo.restoreRevision(untitledRef, untitledR1Token, untitledR2Token);
        expect(untitledEntry.doc?.state().current?.foreign).toBeUndefined();
        const untitledDraft: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-untitled',
            workingCopyRef: untitledRef,
            workingByteRevision: untitledR1Token,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Valid draft on undone untitled r1'}]},
        };
        expect(await api.setBrowserDocumentDrafts(untitledDraft)).toBe(true);
        expect(untitledEntry.doc?.state().drafts).toEqual(untitledDraft);
    });

    it('withholds a pre-stageAppend :1 draft during workspace recovery when foreign bytes are staged (:1:s) while keeping ADR 0010 rescue working', async () => {
        const {repo, api, store} = await recovery();
        const {rememberFileHandle} = await import('@app/platform/browser/browserPublication');
        const {nextTick, ref} = await import('vue');
        const {useWorkspaceDocumentSessions} = await import('@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions');
        const {restoreWorkspaceCheckpoint} = await import('@app/modules/workspace-shell/checkpoint/restoreWorkspaceCheckpoint');
        const {createWorkspaceExposeFixture} = await import('@tests/unit/app/modules/workspace-shell/workspaceTestFixtures');
        vi.stubGlobal('useToast', () => ({add: vi.fn()}));

        const disk = {bytes: new TextEncoder().encode('%PDF-1.7 original'), lastModified: 1_000};
        const handle: FileSystemFileHandle = {
            ...createFileSystemFileHandle({
                name: 'staged-recovery.pdf',
                getFile: async () => new File([disk.bytes], 'staged-recovery.pdf', {lastModified: disk.lastModified}),
            }),
            createWritable: async () => {
                const chunks: Uint8Array<ArrayBuffer>[] = [];
                return Object.assign(new WritableStream(), {
                    write: async (chunk: FileSystemWriteChunkType) => {
                        if (!(chunk instanceof ArrayBuffer)) throw new TypeError('Expected ArrayBuffer chunk');
                        chunks.push(new Uint8Array(chunk));
                    },
                    close: async () => {
                        disk.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
                        disk.lastModified += 1;
                    },
                    abort: async () => {},
                    seek: async () => {},
                    truncate: async () => {},
                }) satisfies FileSystemWritableFileStream;
            },
        };
        const sourceRef = await repo.registerFile(new File([disk.bytes], 'staged-recovery.pdf', {lastModified: disk.lastModified}), {saveHandle: handle});
        const workingRef = await repo.cloneAsWorkingCopy(sourceRef);
        const entry = await repo.requireEntry(workingRef);
        const docId = entry.doc!.id;
        const originalToken = repo.tokenOf(entry);
        expect(originalToken).toBe(`drt1:browser:${docId}:1`);

        // 1. Store a valid `:1` draft against the original PDF before external replacement + stageAppend.
        const originalDraft: IWorkspaceCheckpointAnnotationRecovery = {
            artifactId: 'document-drafts',
            documentInstanceId: 'instance-staged-recovery',
            workingCopyRef: workingRef,
            workingByteRevision: originalToken,
            annotationMutationGeneration: 1,
            payload: {entities: [{contents: 'Draft from original PDF before external replacement'}]},
        };
        expect(await api.setBrowserDocumentDrafts(originalDraft)).toBe(true);

        // 2. External program replaces the source PDF; stageAppend stages foreign bytes (`foreign: 'staged'`, token `:1:s`).
        disk.bytes = new TextEncoder().encode('%PDF-1.7 externally replaced');
        disk.lastModified = 2_000;
        const lease = await repo.stageAppend(workingRef, originalToken, async (file, base) => {
            const extra = new TextEncoder().encode(' +staged');
            await file.writeAt(base, extra);
            return base + extra.byteLength;
        }, {allowForeignBase: true});
        expect(lease).not.toBeNull();
        expect(entry.doc?.state().current?.foreign).toBe('staged');
        expect(repo.tokenOf(entry)).toBe(`drt1:browser:${docId}:1:s`);
        // ADR 0010 callers using pre-staging `:1` token still pass assertDocumentRevisionCurrent and discardAppend.
        await expect(repo.assertDocumentRevisionCurrent(workingRef, originalToken)).resolves.toBeUndefined();
        await repo.discardAppend(workingRef, lease!);

        // 3. Simulate crash/unload and reclaim workspace checkpoint in a fresh recovery pass.
        await repo.release(workingRef);
        const claimed = await api.claimBrowserWorkspaceCheckpoint('recovery-window');
        expect(claimed).not.toBeNull();
        const recoveredTab = claimed!.tabs.find(tab => tab.workingCopyRef === workingRef);
        expect(recoveredTab?.annotationRecovery).toEqual(originalDraft);

        const reopenedRevision = await repo.getDocumentRevision(workingRef);
        expect(reopenedRevision.token).toBe(`drt1:browser:${docId}:1:s`);
        expect(reopenedRevision.token).not.toBe(originalDraft.workingByteRevision);

        // 4. Exercise restoreWorkspaceCheckpoint (applyAnnotationRecovery): must reject `:1` onto `:1:s`, hold drafts on disk, and not replay.
        const tabs = ref<Array<{id: string}>>([]);
        const documentSessions = useWorkspaceDocumentSessions({activeTabId: ref(null), tabs});
        const settleDrafts = vi.fn();
        const restoreCanonicalAnnotationRecovery = vi.fn();
        const restoring = restoreWorkspaceCheckpoint(claimed!, {
            activeTabId: ref(null),
            documentSessions,
            restoreGraph: checkpoint => {
                tabs.value = checkpoint.tabs.map(tab => ({id: tab.tabId}));
            },
            activateTab: () => {},
        });
        await nextTick();
        const session = documentSessions.getSession(recoveredTab!.tabId)!;
        session.attachWorkspace(recoveredTab!.tabId, createWorkspaceExposeFixture({
            holdDocumentDrafts: () => settleDrafts,
            restoreCanonicalAnnotationRecovery,
            handleOpenFileWithResult: async () => {
                await session.runOpen({
                    kind: 'restore',
                    target: {fileName: 'staged-recovery.pdf', originalPath: recoveredTab!.sourceRef!},
                }, async () => {
                    session.commitFile({
                        originalPath: recoveredTab!.sourceRef!,
                        workingCopyPath: workingRef,
                        isDjvu: false,
                        revisionInfo: reopenedRevision,
                    });
                    return {presentation: Promise.resolve({status: 'presented' as const})};
                }).finished;
                return true;
            },
            getAutomationStateSnapshot: () => ({
                ...createWorkspaceExposeFixture().getAutomationStateSnapshot(),
                workingCopyPath: workingRef,
                documentIdentity: reopenedRevision,
            }),
        }));

        const failedPaths = await restoring;
        expect(failedPaths).toEqual([recoveredTab!.sourceRef ?? workingRef]);
        expect(restoreCanonicalAnnotationRecovery).not.toHaveBeenCalled();
        expect(settleDrafts).toHaveBeenCalledWith(false);

        // Stored `:1` draft stays preserved on disk intact and is not overwritten.
        const reopenedEntry = await repo.requireEntry(workingRef);
        expect(reopenedEntry.doc?.state().drafts).toEqual(originalDraft);
        const manifest = JSON.parse(new TextDecoder().decode(await store.port.read(`documents/${docId}/manifest.json`))) as {drafts?: string};
        expect(manifest.drafts).toBeDefined();

        // 5. Confirm ADR 0010 stageAppend -> save conflict -> Save As rescue still succeeds using pre-staging `:1` token.
        const copyDisk = {bytes: new Uint8Array(), lastModified: 3_000};
        const copyHandle: FileSystemFileHandle = {
            ...createFileSystemFileHandle({
                name: 'staged-recovery-copy.pdf',
                getFile: async () => new File([copyDisk.bytes], 'staged-recovery-copy.pdf', {lastModified: copyDisk.lastModified}),
            }),
            createWritable: async () => {
                const chunks: Uint8Array<ArrayBuffer>[] = [];
                return Object.assign(new WritableStream(), {
                    write: async (chunk: FileSystemWriteChunkType) => {
                        if (!(chunk instanceof ArrayBuffer)) throw new TypeError('Expected ArrayBuffer chunk');
                        chunks.push(new Uint8Array(chunk));
                    },
                    close: async () => {
                        copyDisk.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
                        copyDisk.lastModified += 1;
                    },
                    abort: async () => {},
                    seek: async () => {},
                    truncate: async () => {},
                }) satisfies FileSystemWritableFileStream;
            },
        };
        rememberFileHandle('staged-recovery-copy', copyHandle);
        const rescueLease = await repo.stageAppend(workingRef, originalToken, async (file, base) => {
            const extra = new TextEncoder().encode(' +rescued');
            await file.writeAt(base, extra);
            return base + extra.byteLength;
        }, {allowForeignBase: true});
        expect(rescueLease).not.toBeNull();
        expect(await repo.save(workingRef, originalToken, {commit: rescueLease!})).toEqual({status: 'conflict'});
        const rev2Token = repo.tokenOf(reopenedEntry);
        expect(rev2Token).toBe(`drt1:browser:${docId}:2`);
        expect(await repo.save(workingRef, rev2Token, {saveAs: 'handle:staged-recovery-copy'})).toMatchObject({status: 'saved'});
        expect(new TextDecoder().decode(copyDisk.bytes)).toBe('%PDF-1.7 externally replaced +rescued');
    });
});
