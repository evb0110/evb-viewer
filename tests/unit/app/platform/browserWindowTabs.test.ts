import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';
import type {IBrowserTransferAuthorityRecord} from '@app/platform/browser/browserDocumentIdb';
import {
    createFileSystemFileHandle, FakeLockManager, FakeIndexedDbFactory, MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import type * as TDocumentIdb from '@app/platform/browser/browserDocumentIdb';

const recoveryMocks = vi.hoisted(() => ({
    clearBrowserWorkspaceRecovery: vi.fn(),
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
vi.mock('@app/platform/browser/browserDocumentIdb', async importOriginal => ({
    ...await importOriginal<typeof TDocumentIdb>(),
    ...transferAuthorityMocks,
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

function requireBrowserTransferAuthority(
    value: IBrowserTransferAuthorityRecord | null,
): IBrowserTransferAuthorityRecord {
    if (value === null) {
        throw new Error('Transfer authority was not created before the deadline boundary');
    }
    return value;
}

// Without `locks`, the browser has no lock manager (Node provides one).
function stubBrowserGlobals(href = 'http://localhost:3235/', locks?: FakeLockManager) {
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
    vi.stubGlobal('navigator', locks ? {locks} : {});
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
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    });

    afterEach(() => {
        MockBroadcastChannel.reset();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([
        'adopted',
        'pending-combine',
        'stale',
        'recent-failed',
    ])(
        'keeps Save As bytes through deferred Recent completion and %s cleanup',
        async (outcome) => {
            vi.useRealTimers();
            stubBrowserGlobals();
            const storage = new MemoryStorage();
            Object.assign(window, {localStorage: storage});
            const bytes = Uint8Array.of(37, 80, 68, 70, 1, 2);
            const handle = createFileSystemFileHandle({
                name: 'saved.pdf',
                getFile: async () => new File([bytes], 'saved.pdf', {type: 'application/pdf'}),
            });
            Object.assign(window, {showSaveFilePicker: async () => handle});
            const owner = await import('@app/platform/browserWindowTabs');
            const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
            const {savePdfAsFromWorkingCopy} = await import('@app/platform/browser-api/browserSaveTargets');
            const previousSource = await store.createStoredDocument('pending.pdf', bytes, {
                kind: 'source',
                mimeType: 'application/pdf',
            });
            const working = await owner.reserveBrowserDocumentWorkingCopy('pending.pdf', previousSource);
            await store.cloneAsWorkingCopy(previousSource, 'pending.pdf', working);
            const recent = Promise.withResolvers<undefined>();
            const touch = store.touchRecentFile.bind(store);
            vi.spyOn(store, 'touchRecentFile').mockImplementation(async (ref) => {
                await recent.promise;
                if (outcome === 'recent-failed') throw new Error('Recent storage unavailable');
                await touch(ref);
            });
            let savedRef: string | null = null;
            const revision = await store.getDocumentRevision(working);
            const save = savePdfAsFromWorkingCopy(working, {expectedDocumentRevisionToken: revision.token}).then(ref => { savedRef = ref; });
            let next: ReturnType<typeof requireDocumentRef> | null = null;
            try {
                await vi.waitFor(() => expect(savedRef).not.toBeNull());
                const source = requireDocumentRef(savedRef ?? '');
                await expect(store.getDocumentRevision(working)).resolves.toEqual(revision);
                await expect(store.read(working)).resolves.toEqual(bytes);
                if (outcome !== 'pending-combine') {
                    next = await owner.reserveBrowserDocumentWorkingCopy('adopted.pdf', outcome === 'stale' ? undefined : source);
                    if (outcome === 'stale') {
                        await store.createStoredDocument('replacement.pdf', Uint8Array.of(9), {
                            ref: next,
                            kind: 'working',
                            mimeType: 'application/pdf',
                        });
                    } else {
                        await store.cloneAsWorkingCopy(source, 'adopted.pdf', next);
                    }
                }
                const retirement = owner.retireBrowserDocumentWorkingCopy(working).catch((error: unknown) => error);
                await store.clearRecentFiles();
                await expect(store.read(source)).resolves.toEqual(bytes);
                recent.resolve(undefined);
                const retired = await retirement;
                if (outcome === 'recent-failed') expect(retired).toEqual(new Error('Recent storage unavailable'));
                else expect(retired).toBeUndefined();
                if (next) await expect(store.read(next)).resolves.toEqual(outcome === 'stale' ? Uint8Array.of(9) : bytes);
                await expect(store.exists(working)).resolves.toBe(false);
                await store.clearRecentFiles();
                if (next) await owner.retireBrowserDocumentWorkingCopy(next);
                await expect(store.exists(source)).resolves.toBe(false);
            } finally {
                recent.resolve(undefined);
                await save;
                await owner.retireBrowserDocumentWorkingCopy(working);
                if (next) await owner.retireBrowserDocumentWorkingCopy(next);
                await store.clearRecentFiles();
            }
        },
    );

    it.each([
        'read',
        'failed-read',
        'failed-earlier-cleanup',
    ])('keeps conformance bytes readable until %s finishes during working-copy retirement', async (outcome) => {
        vi.useRealTimers();
        stubBrowserGlobals();
        Object.assign(window, {localStorage: new MemoryStorage()});
        const owner = await import('@app/platform/browserWindowTabs');
        const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
        const {createBrowserDocumentsFileCapability} = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
        const capability = createBrowserDocumentsFileCapability({clearSearchCaches: () => {}});
        const bytes = new TextEncoder().encode('%PDF-1.7\n/Type /Catalog\n%%EOF');
        const working = await owner.reserveBrowserDocumentWorkingCopy('pending-save.pdf');
        await store.createStoredDocument('pending-save.pdf', bytes, {
            ref: working,
            kind: 'working',
            mimeType: 'application/pdf',
        });
        if (outcome === 'failed-earlier-cleanup') {
            owner.handoffBrowserDocumentWorkingCopy(working, working, () => Promise.reject(new Error('Recent storage unavailable')));
        }
        const reading = Promise.withResolvers<undefined>();
        const resume = Promise.withResolvers<undefined>();
        const readRange = store.readRange.bind(store);
        vi.spyOn(store, 'readRange').mockImplementation(async (...args) => {
            reading.resolve(undefined);
            await resume.promise;
            if (outcome === 'failed-read') throw new Error('Conformance storage unavailable');
            return readRange(...args);
        });
        const analysis = capability.analyzePdfConformance(working);
        // Observe the result after releasing the paused read, including on failure.
        const analyzed = analysis.catch((error: unknown) => error);
        await reading.promise;
        const retirement = capability.cleanupFile(working).catch((error: unknown) => error);
        try {
            await store.clearRecentFiles();
            await expect(store.read(working)).resolves.toEqual(bytes);
            resume.resolve(undefined);
            if (outcome === 'failed-read') await expect(analyzed).resolves.toEqual(new Error('Conformance storage unavailable'));
            else await expect(analyzed).resolves.toMatchObject({canIncrementalSave: false});
            if (outcome === 'failed-earlier-cleanup') await expect(retirement).resolves.toEqual(new Error('Recent storage unavailable'));
            else await expect(retirement).resolves.toBeUndefined();
            await expect(store.exists(working)).resolves.toBe(false);
        } finally {
            resume.resolve(undefined);
            await analyzed;
            await retirement;
        }
    });

    it('collects the creator copy after durable handoff and the receiver final close', async () => {
        vi.useRealTimers();
        stubBrowserGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        const storage = new MemoryStorage();
        vi.stubGlobal('localStorage', storage);
        Object.assign(window, {localStorage: storage});
        let authority: IBrowserTransferAuthorityRecord | null = null;
        transferAuthorityMocks.mutateBrowserTransferAuthority.mockImplementation(async (_id: string, mutate: TAuthorityMutation) => {
            authority = mutate(authority, {put: value => { authority = value as IBrowserTransferAuthorityRecord; }}) as IBrowserTransferAuthorityRecord;
            return authority;
        });
        const owner = await import('@app/platform/browserWindowTabs');
        const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
        const {createBrowserWorkingCopyFromBytes} = await import('@app/platform/browser-api/browserWorkingCopyService');
        const source = await store.createStoredDocument('handoff.pdf', Uint8Array.of(10, 11, 12), {
            mimeType: 'application/pdf',
            kind: 'source',
        });
        const successor = await createBrowserWorkingCopyFromBytes({
            fileName: 'handoff-copy.pdf',
            data: Uint8Array.of(23, 24, 25),
            sourceRef: source,
        });
        const receiver = await store.createLiveLease('window:receiver', [
            {ref: successor},
            {ref: source},
        ]);
        const channel = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        channel.addEventListener('message', event => {
            if (typeof event.data !== 'object' || event.data === null || Reflect.get(event.data, 'type') !== 'transfer') return;
            const committed = requireBrowserTransferAuthority(authority);
            channel.postMessage({
                type: 'ack',
                windowId: 200,
                ack: {
                    transferId: committed.transferId,
                    schemaVersion: 1,
                    nonce: committed.nonce,
                    instanceNonce: 'receiver',
                    success: true,
                },
            });
        });
        owner.browserWindowTabsCapability.notifyRendererReady();
        channel.postMessage({
            type: 'announce',
            windowId: 200,
            instanceNonce: 'receiver',
            label: 'Receiver',
            ready: true,
        });
        let resumeCollection!: () => void;
        const collection = new Promise<void>(resolve => { resumeCollection = resolve; });
        const releaseLease = store.releaseLiveLease.bind(store);
        vi.spyOn(store, 'releaseLiveLease').mockImplementationOnce(async (...args) => {
            await collection;
            return releaseLease(...args);
        });
        let transferred = false;
        const transfer = owner.browserWindowTabsCapability.transfer({
            target: {
                kind: 'window',
                windowId: 200,
            },
            tab: {
                fileName: 'handoff.pdf',
                originalPath: source,
                isDirty: true,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'handoff.pdf',
                originalPath: source,
                snapshotPath: successor,
                isDirty: true,
            },
        }).then(result => { transferred = result.success; });
        try {
            await vi.waitFor(() => expect(transferred, 'Durable transfer success is independent of collection').toBe(true));
        } finally {
            resumeCollection();
            await transfer;
        }
        store.unload(successor);
        await expect(store.read(successor)).resolves.toEqual(Uint8Array.of(23, 24, 25));
        await store.releaseLiveLease(receiver.ownerId, receiver.generation);
        await store.clearRecentFiles();
        await owner.publishBrowserDocumentLiveLeases();
        store.unload(successor);
        await expect(store.read(successor)).rejects.toThrow('Browser document not found');
        await expect(store.exists(source)).resolves.toBe(false);
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

    it('recovers its stable per-window owner across reload initialization without Web Locks', async () => {
        const browserWindow = stubBrowserGlobals('http://localhost:3235/?evbWindowId=321');
        vi.stubGlobal('performance', {getEntriesByType: () => [{type: 'reload'}]});
        const checkpoint = {
            version: 1,
            tabs: [],
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: 'window:321',
            checkpoint,
            updatedAt: Date.now(),
            leaseRevision: 1,
            generation: 1,
        }]);
        const firstModule = await import('@app/platform/browserWindowTabs');
        const firstClaim = firstModule.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(firstClaim).resolves.toBe(checkpoint);
        expect(firstModule.getBrowserWindowRecoveryOwnerId()).toBe('window:321');
        expect(browserWindow.location.href).not.toContain('evbWindowId');

        vi.resetModules();
        const secondModule = await import('@app/platform/browserWindowTabs');
        const secondClaim = secondModule.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(secondClaim).resolves.toBe(checkpoint);
        expect(secondModule.getBrowserWindowRecoveryOwnerId()).toBe('window:321');
    });

    it('leaves startup unclaimed when IndexedDB is unavailable', async () => {
        vi.useRealTimers();
        stubBrowserGlobals();
        vi.stubGlobal('indexedDB', undefined);
        const owner = await import('@app/platform/browserWindowTabs');
        await expect(owner.browserWindowTabsCapability.claimWorkspaceCheckpoint()).resolves.toBeNull();
        await expect(owner.publishBrowserDocumentLiveLeases()).resolves.toBeNull();
    });

    it.each([
        {
            initial: 'publication',
            fault: 'discovery',
        },
        {
            initial: 'checkpoint',
            fault: 'discovery',
        },
        {
            initial: 'publication',
            fault: 'lock',
        },
        {
            initial: 'checkpoint',
            fault: 'lock',
        },
    ])('opens a new working copy after initial $initial claim refuses $fault', async ({
        initial, fault,
    }) => {
        vi.useRealTimers();
        const locks = new FakeLockManager();
        stubBrowserGlobals('http://localhost:3235/', locks);
        Object.assign(window, {localStorage: new MemoryStorage()});
        const owner = await import('@app/platform/browserWindowTabs');
        const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
        owner.browserWindowTabsCapability.browserRecovery!.getOwnerId();
        if (fault === 'discovery') {
            vi.spyOn(MockBroadcastChannel.prototype, 'postMessage').mockImplementationOnce(() => {
                throw new Error('Injected initial lease claim refusal');
            });
        } else {
            vi.spyOn(locks, 'request').mockRejectedValueOnce(new Error('Injected initial lease claim refusal'));
        }
        await expect(initial === 'checkpoint'
            ? owner.browserWindowTabsCapability.claimWorkspaceCheckpoint()
            : owner.reserveBrowserDocumentWorkingCopy('refused.pdf')).rejects.toThrow('Injected initial lease claim refusal');
        const bytes = Uint8Array.of(37, 80, 68, 70, 10);
        const source = await store.createStoredDocument('accepted.pdf', bytes, {
            kind: 'source',
            mimeType: 'application/pdf',
        });
        const ref = await owner.reserveBrowserDocumentWorkingCopy('accepted.pdf', source);
        await store.cloneAsWorkingCopy(source, 'accepted.pdf', ref);
        await store.clearRecentFiles();
        await expect(store.read(ref)).resolves.toEqual(bytes);
        await expect(owner.browserWindowTabsCapability.claimWorkspaceCheckpoint()).resolves.toBeNull();
    });

    it('keeps the committed lease after a later publication refuses storage', async () => {
        vi.useRealTimers();
        stubBrowserGlobals();
        Object.assign(window, {localStorage: new MemoryStorage()});
        const owner = await import('@app/platform/browserWindowTabs');
        const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
        const bytes = Uint8Array.of(37, 80, 68, 70, 12);
        const source = await store.createStoredDocument('kept.pdf', bytes, {
            kind: 'source',
            mimeType: 'application/pdf',
        });
        const working = await owner.reserveBrowserDocumentWorkingCopy('kept.pdf', source);
        await store.cloneAsWorkingCopy(source, 'kept.pdf', working);
        vi.spyOn(store, 'heartbeatLiveLease').mockRejectedValueOnce(new Error('Injected later publication refusal'));
        await expect(owner.reserveBrowserDocumentWorkingCopy('refused.pdf')).rejects.toThrow('Injected later publication refusal');
        const successor = await owner.reserveBrowserDocumentWorkingCopy('kept.pdf', source);
        await store.cloneAsWorkingCopy(source, 'kept.pdf', successor);
        await owner.retireBrowserDocumentWorkingCopy(working);
        await store.clearRecentFiles();
        await expect(store.read(successor)).resolves.toEqual(bytes);
    });

    it('adopts the proven reload lease before an eager publication without Web Locks', async () => {
        vi.useRealTimers();
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=321');
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        Object.assign(window, {localStorage: new MemoryStorage()});
        const owner = await import('@app/platform/browserWindowTabs');
        const {browserDocumentStore: store} = await import('@app/platform/browser/browserDocumentRepository');
        const source = await store.createStoredDocument('reload.pdf', Uint8Array.of(10, 11), {
            mimeType: 'application/pdf',
            kind: 'source',
        });
        const previous = await store.createLiveLease('window:321', [{ref: source}]);
        const checkpoint = {
            version: 1,
            tabs: [],
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: previous.ownerId,
            checkpoint,
            updatedAt: Date.now(),
            leaseRevision: 1,
            generation: 1,
        }]);
        const publication = expect(owner.publishBrowserDocumentLiveLeases(undefined, [source])).resolves.toMatchObject({
            ownerId: previous.ownerId,
            generation: previous.generation,
        });
        await expect(owner.browserWindowTabsCapability.claimWorkspaceCheckpoint()).resolves.toBe(checkpoint);
        await publication;
        await expect(owner.publishBrowserDocumentLiveLeases(undefined, [
            source,
            source,
        ])).resolves.toMatchObject({generation: previous.generation});
        const working = await store.cloneAsWorkingCopy(source);
        await expect(owner.publishBrowserDocumentLiveLeases(undefined, [
            source,
            working,
        ])).resolves.toMatchObject({generation: previous.generation + 1});
        await store.clearRecentFiles();
        await expect(store.read(working)).resolves.toEqual(Uint8Array.of(10, 11));
        await owner.publishBrowserDocumentLiveLeases(undefined, []);
        await expect(store.exists(working)).resolves.toBe(false);
        await expect(store.exists(source)).resolves.toBe(false);
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
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: 'window:321',
            checkpoint: {
                version: 1,
                tabs: [],
            },
            generation: 1,
            leaseRevision: 1,
            updatedAt: Date.now(),
        }]);
        const claim = module.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(claim).resolves.toBeNull();
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

    it('does not steal a fresh heartbeat without Web Locks when a live tab misses the discovery window', async () => {
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

    it('does not claim a silent owner that still holds its lease lock, however old its heartbeat', async () => {
        vi.setSystemTime(100_000);
        const locks = new FakeLockManager();
        locks.holdElsewhere('evb-viewer:browser-lease-owner:window:321');
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444', locks);
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 0,
        }]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');

        const claim = browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);

        await expect(claim).resolves.toBeNull();
    });

    it('claims a fresh silent owner whose lease lock is free, passing over one that holds it', async () => {
        vi.setSystemTime(100_000);
        const locks = new FakeLockManager();
        locks.holdElsewhere('evb-viewer:browser-lease-owner:window:321');
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=444', locks);
        const frozen = {
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 99_999,
        };
        const closed = {
            ...frozen,
            ownerId: 'window:111',
            checkpoint: {
                version: 1,
                tabs: [],
            },
            updatedAt: 99_000,
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([
            frozen,
            closed,
        ]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        const {browserWindowTabsCapability} = await import('@app/platform/browserWindowTabs');

        const claim = browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);

        await expect(claim).resolves.toBe(closed.checkpoint);
    });

    it('does not adopt a record another window has just claimed and not yet checkpointed', async () => {
        vi.setSystemTime(100_000);
        const locks = new FakeLockManager();
        const orphan = {
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: 0,
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([orphan]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        // After a crash the first restored window claims the orphan and is
        // still restoring it, so it has saved no lease yet.
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=111', locks);
        const firstWindow = await import('@app/platform/browserWindowTabs');
        const firstClaim = firstWindow.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(firstClaim).resolves.toBe(orphan.checkpoint);

        // The second window hears no answer to its discovery in time and
        // finds the record under the first window's owner, freshly written.
        MockBroadcastChannel.reset();
        vi.resetModules();
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=222', locks);
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([{
            ...orphan,
            ownerId: 'window:111',
            generation: 8,
            leaseRevision: 8,
            updatedAt: Date.now(),
        }]);
        const secondWindow = await import('@app/platform/browserWindowTabs');
        const secondClaim = secondWindow.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);

        await expect(secondClaim).resolves.toBeNull();
    });

    it('starts a duplicate of a frozen owner without waiting or claiming its recovery', async () => {
        vi.setSystemTime(100_000);
        const ownerLockName = 'evb-viewer:browser-lease-owner:window:321';
        const locks = new FakeLockManager();
        locks.holdElsewhere(ownerLockName);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=321', locks);
        const originalRecord = {
            ownerId: 'window:321',
            generation: 7,
            checkpoint: {
                version: 1,
                tabs: [],
            },
            snapshotRefs: [],
            leaseRevision: 7,
            updatedAt: Date.now(),
        };
        recoveryMocks.loadBrowserWorkspaceRecoveries.mockResolvedValue([originalRecord]);
        recoveryMocks.claimBrowserWorkspaceRecoveryOwner.mockResolvedValue({
            claimed: true,
            generation: 8,
        });
        const module = await import('@app/platform/browserWindowTabs');
        let completed = false;
        const claim = module.browserWindowTabsCapability.claimWorkspaceCheckpoint().then(checkpoint => {
            completed = true;
            return checkpoint;
        });
        await vi.advanceTimersByTimeAsync(70);
        try {
            expect(completed, 'Startup waits for the frozen original to resume').toBe(true);
            await expect(claim).resolves.toBeNull();
            const ownerId = module.getBrowserWindowRecoveryOwnerId();
            expect(ownerId).not.toBe(originalRecord.ownerId);
            expect((await locks.query()).held.map(lock => lock.name).sort()).toEqual([
                ownerLockName,
                `evb-viewer:browser-lease-owner:${ownerId}`,
            ].sort());
            // Releasing the original must not grant a stale duplicate request.
            locks.releaseElsewhere(ownerLockName);
            await vi.advanceTimersByTimeAsync(0);
            expect((await locks.query()).held).toEqual([{
                mode: 'exclusive',
                name: `evb-viewer:browser-lease-owner:${ownerId}`,
            }]);
        } finally {
            locks.releaseElsewhere(ownerLockName);
            await vi.advanceTimersByTimeAsync(70);
            await claim;
        }
    });

    it('gives up an owner whose lease lock another window holds, with its wait for that lock', async () => {
        const ownerLockName = 'evb-viewer:browser-lease-owner:window:321';
        const locks = new FakeLockManager();
        locks.holdElsewhere(ownerLockName);
        stubBrowserGlobals('http://localhost:3235/?evbWindowId=321', locks);
        const originalWindow = new MockBroadcastChannel(WINDOW_TABS_CHANNEL);
        const module = await import('@app/platform/browserWindowTabs');
        const leases = await import('@app/platform/browser/browserDocumentLeaseStore');
        expect(module.getBrowserWindowRecoveryOwnerId()).toBe('window:321');

        // A copy of a frozen window hears no answer, keeps the id and waits
        // for the original's lock at its first lease save.
        const firstSave = leases.saveBrowserDocumentLiveLease('window:321', 0, 'active', []);
        // The original resumes. Its nonce sorts last, so the nonces alone
        // would keep the copy on the id.
        originalWindow.postMessage({
            type: 'announce',
            windowId: 321,
            instanceNonce: '~',
            label: 'Original tab',
            ready: true,
        });

        await expect(firstSave).rejects.toThrow('aborted');
        const ownerId = module.getBrowserWindowRecoveryOwnerId();
        expect(ownerId).not.toBe('window:321');
        // When the original closes, its lock does not pass to the copy.
        locks.releaseElsewhere(ownerLockName);
        expect((await locks.query()).held).toEqual([{
            mode: 'exclusive',
            name: `evb-viewer:browser-lease-owner:${ownerId}`,
        }]);
        await expect(leases.saveBrowserDocumentLiveLease('window:321', 0, 'active', [])).rejects.toThrow('does not own');
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
                originalPath: requireDocumentRef('/source.pdf'),
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

        const authorityAtBoundary = requireBrowserTransferAuthority(authority);
        expect(authorityAtBoundary.state).toBe('pending');
        await vi.advanceTimersByTimeAsync(10);
        await expect(transfer).resolves.toMatchObject({success: false});
        expect(transferAuthorityMocks.abortBrowserTransferAuthority).toHaveBeenCalledWith(
            transferMessage.transfer.transferId,
            transferMessage.transfer.nonce,
        );
    });
});
