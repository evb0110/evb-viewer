import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    claimBrowserWorkspaceRecoveryOwner,
    clearBrowserWorkspaceRecovery,
    loadBrowserWorkspaceRecoveries,
    loadBrowserWorkspaceRecovery,
    saveBrowserWorkspaceRecovery,
    touchBrowserWorkspaceRecovery,
} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import {
    FakeIndexedDbFactory,
    FakeLockManager,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {
    DB_NAME,
    WORKSPACE_RECOVERY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import { browserWindowTabsCapability } from '@app/platform/browserWindowTabs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requirePaneId} from '@contracts/editorPanes';
import {requireTabId} from '@contracts/windowTabs';
import {requireEpochMs} from '@contracts/timestamps';

const checkpoint: IWorkspaceCheckpoint = {
    version: 1,
    capturedAt: requireEpochMs(1),
    activePaneId: requirePaneId('pane-1'),
    activeTabId: requireTabId('tab-1'),
    layout: {
        type: 'leaf',
        paneId: requirePaneId('pane-1'),
    },
    panes: [{
        paneId: requirePaneId('pane-1'),
        tabIds: [requireTabId('tab-1')],
        activeTabId: requireTabId('tab-1'),
    }],
    tabs: [{
        tabId: requireTabId('tab-1'),
        paneId: requirePaneId('pane-1'),
        fileName: 'recovered.pdf',
        sourceRef: requireDocumentRef('browser://documents/source.pdf'),
        workingCopyRef: requireDocumentRef('browser://documents/recovery.pdf'),
        requiresSaveAsOnFirstSave: true,
        isDirty: true,
        isDjvu: false,
        currentPage: requirePageNumber(1),
        zoom: 1,
        zoomMode: 'custom',
    }],
};

describe('browserWorkspaceRecoveryStore', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        // Node provides Web Locks; these cases are a browser without them,
        // where the owner's heartbeat age decides a claim.
        vi.stubGlobal('navigator', {});
    });

    it('publishes and clears only committed recovery checkpoints', async () => {
        const recovery = browserWindowTabsCapability.browserRecovery;
        if (!recovery) throw new Error('Browser recovery capability is unavailable');
        await expect(recovery.save('window:1', 0, checkpoint, [
            requireDocumentRef('browser://documents/recovery.pdf'),
            requireDocumentRef('browser://documents/not-in-checkpoint.pdf'),
        ], [requireDocumentRef('browser://documents/source.pdf')])).resolves.toEqual({
            saved: true,
            generation: 1,
        });

        await expect(loadBrowserWorkspaceRecovery('window:1')).resolves.toEqual({
            ownerId: 'window:1',
            generation: 1,
            leaseRevision: 1,
            checkpoint,
            snapshotRefs: ['browser://documents/recovery.pdf'],
            updatedAt: expect.any(Number),
        });

        await browserWindowTabsCapability.acknowledgeWorkspaceCheckpoint();
        await expect(recovery.load('window:1')).resolves.toEqual(expect.objectContaining({
            checkpoint,
            snapshotRefs: ['browser://documents/recovery.pdf'],
        }));

        await expect(recovery.clear('window:1', 1))
            .resolves.toEqual({
                saved: true,
                generation: 0,
            });
        await expect(loadBrowserWorkspaceRecovery('window:1')).resolves.toBeNull();
    });

    it('isolates concurrent window owners and rejects stale owner generations', async () => {
        await Promise.all([
            saveBrowserWorkspaceRecovery('window:10', 0, checkpoint, [requireDocumentRef('browser://documents/recovery.pdf')]),
            saveBrowserWorkspaceRecovery('window:20', 0, {
                ...checkpoint,
                capturedAt: requireEpochMs(2),
            }, [requireDocumentRef('browser://documents/recovery.pdf')]),
        ]);

        await expect(loadBrowserWorkspaceRecoveries()).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({
                ownerId: 'window:10',
                generation: 1,
            }),
            expect.objectContaining({
                ownerId: 'window:20',
                generation: 1,
            }),
        ]));
        await expect(saveBrowserWorkspaceRecovery(
            'window:10',
            0,
            {
                ...checkpoint,
                capturedAt: requireEpochMs(3),
            },
            [requireDocumentRef('browser://documents/recovery.pdf')],
        )).resolves.toEqual({
            saved: false,
            generation: 1,
        });
        await expect(clearBrowserWorkspaceRecovery('window:10', 0))
            .resolves.toEqual({
                saved: false,
                generation: 1,
            });
        await expect(loadBrowserWorkspaceRecovery('window:20'))
            .resolves.toEqual(expect.objectContaining({
                ownerId: 'window:20',
                generation: 1,
            }));
    });

    it('heartbeats an existing owner without advancing its generation', async () => {
        await saveBrowserWorkspaceRecovery(
            'window:heartbeat',
            0,
            checkpoint,
            [requireDocumentRef('browser://documents/recovery.pdf')],
        );
        const before = await loadBrowserWorkspaceRecovery('window:heartbeat');
        expect(before).not.toBeNull();

        await expect(touchBrowserWorkspaceRecovery('window:heartbeat', 1)).resolves.toEqual({
            saved: true,
            generation: 1,
        });
        await expect(loadBrowserWorkspaceRecovery('window:heartbeat')).resolves.toEqual(expect.objectContaining({
            generation: 1,
            leaseRevision: 2,
            updatedAt: expect.any(Number),
        }));
        await expect(touchBrowserWorkspaceRecovery('window:heartbeat', 2)).resolves.toEqual({
            saved: false,
            generation: 1,
        });
    });

    it('moves an orphan journal to a fresh owner in one compare-and-swap transaction', async () => {
        const now = vi.spyOn(Date, 'now');
        try {
            now.mockReturnValue(0);
            await saveBrowserWorkspaceRecovery(
                'window:closed',
                0,
                checkpoint,
                [requireDocumentRef('browser://documents/recovery.pdf')],
            );

            now.mockReturnValue(30_000);

            await expect(claimBrowserWorkspaceRecoveryOwner(
                'window:closed',
                'window:new',
                1,
                1,
            )).resolves.toEqual({
                claimed: true,
                generation: 2,
            });
            await expect(loadBrowserWorkspaceRecovery('window:closed')).resolves.toBeNull();
            await expect(loadBrowserWorkspaceRecovery('window:new')).resolves.toEqual(
                expect.objectContaining({
                    ownerId: 'window:new',
                    generation: 2,
                    leaseRevision: 2,
                    snapshotRefs: ['browser://documents/recovery.pdf'],
                }),
            );
        } finally {
            now.mockRestore();
        }
    });

    it('rejects an equal-generation claim when a heartbeat changes the selected lease revision', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(0);
        try {
            await saveBrowserWorkspaceRecovery(
                'window:live',
                0,
                checkpoint,
                [requireDocumentRef('browser://documents/recovery.pdf')],
            );
            const selected = await loadBrowserWorkspaceRecovery('window:live');
            expect(selected).toEqual(expect.objectContaining({
                generation: 1,
                leaseRevision: 1,
            }));

            await expect(touchBrowserWorkspaceRecovery('window:live', 1)).resolves.toEqual({
                saved: true,
                generation: 1,
            });

            now.mockReturnValue(30_000);
            await expect(claimBrowserWorkspaceRecoveryOwner(
                'window:live',
                'window:stale',
                selected!.generation,
                selected!.leaseRevision,
            )).resolves.toEqual({
                claimed: false,
                generation: 1,
            });
            await expect(loadBrowserWorkspaceRecovery('window:live')).resolves.toEqual(expect.objectContaining({
                ownerId: 'window:live',
                generation: 1,
                leaseRevision: 2,
                checkpoint,
            }));
            await expect(loadBrowserWorkspaceRecovery('window:stale')).resolves.toBeNull();
        } finally {
            now.mockRestore();
        }
    });

    it('does not steal a journal whose heartbeat is ahead of the claimant clock', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(2_000);
        try {
            await saveBrowserWorkspaceRecovery(
                'window:clock-ahead',
                0,
                checkpoint,
                [requireDocumentRef('browser://documents/recovery.pdf')],
            );

            now.mockReturnValue(1_000);
            await expect(claimBrowserWorkspaceRecoveryOwner(
                'window:clock-ahead',
                'window:clock-skewed',
                1,
                1,
            )).resolves.toEqual({
                claimed: false,
                generation: 1,
            });
            await expect(loadBrowserWorkspaceRecovery('window:clock-ahead'))
                .resolves.toEqual(expect.objectContaining({ownerId: 'window:clock-ahead'}));
            await expect(loadBrowserWorkspaceRecovery('window:clock-skewed')).resolves.toBeNull();
        } finally {
            now.mockRestore();
        }
    });

    it('decodes a legacy recovery record with updatedAt as its initial lease revision', async () => {
        await saveBrowserWorkspaceRecovery(
            'window:legacy',
            0,
            checkpoint,
            [requireDocumentRef('browser://documents/recovery.pdf')],
        );
        const indexedDb = globalThis.indexedDB;
        if (!(indexedDb instanceof FakeIndexedDbFactory)) {
            throw new Error('The fake IndexedDB factory was not installed.');
        }
        // The browser global is typed as IDBFactory, while this test installs the richer fake.
        // eslint-disable-next-line no-restricted-syntax
        const factory = indexedDb as unknown as FakeIndexedDbFactory;
        const database = factory.getDatabase(DB_NAME);
        const record = database?.getStoreRecords(WORKSPACE_RECOVERY_STORE).get('owner:window:legacy');
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            throw new Error('The fake recovery record was not persisted.');
        }
        const legacyRecord = record as Record<string, unknown>;
        delete legacyRecord.leaseRevision;
        legacyRecord.updatedAt = 42;

        await expect(loadBrowserWorkspaceRecovery('window:legacy')).resolves.toEqual(expect.objectContaining({
            ownerId: 'window:legacy',
            generation: 1,
            leaseRevision: 42,
            updatedAt: 42,
        }));
    });

    describe('with Web Locks', () => {
        let locks: FakeLockManager;

        beforeEach(() => {
            locks = new FakeLockManager();
            vi.stubGlobal('navigator', {locks});
        });

        it('does not take over a journal whose owner still holds its lease lock, however old', async () => {
            const now = vi.spyOn(Date, 'now').mockReturnValue(0);
            try {
                await saveBrowserWorkspaceRecovery(
                    'window:frozen',
                    0,
                    checkpoint,
                    [requireDocumentRef('browser://documents/recovery.pdf')],
                );
                locks.holdElsewhere('evb-viewer:browser-lease-owner:window:frozen');

                now.mockReturnValue(10 * 60_000);
                await expect(claimBrowserWorkspaceRecoveryOwner(
                    'window:frozen',
                    'window:new',
                    1,
                    1,
                )).resolves.toEqual({
                    claimed: false,
                    generation: 1,
                });
                await expect(loadBrowserWorkspaceRecovery('window:frozen')).resolves.toEqual(expect.objectContaining({
                    ownerId: 'window:frozen',
                    generation: 1,
                    leaseRevision: 1,
                    checkpoint,
                }));
                await expect(loadBrowserWorkspaceRecovery('window:new')).resolves.toBeNull();
            } finally {
                now.mockRestore();
            }
        });

        it('takes over a fresh journal once its owner context has released the lock', async () => {
            await saveBrowserWorkspaceRecovery(
                'window:closed',
                0,
                checkpoint,
                [requireDocumentRef('browser://documents/recovery.pdf')],
            );

            await expect(claimBrowserWorkspaceRecoveryOwner(
                'window:closed',
                'window:new',
                1,
                1,
            )).resolves.toEqual({
                claimed: true,
                generation: 2,
            });
            await expect(loadBrowserWorkspaceRecovery('window:closed')).resolves.toBeNull();
            await expect(loadBrowserWorkspaceRecovery('window:new')).resolves.toEqual(expect.objectContaining({
                ownerId: 'window:new',
                generation: 2,
                checkpoint,
                snapshotRefs: ['browser://documents/recovery.pdf'],
            }));
        });

        it('gives a released journal to exactly one of two racing claimants', async () => {
            await saveBrowserWorkspaceRecovery(
                'window:closed',
                0,
                checkpoint,
                [requireDocumentRef('browser://documents/recovery.pdf')],
            );

            const outcomes = await Promise.all([
                claimBrowserWorkspaceRecoveryOwner('window:closed', 'window:b', 1, 1),
                claimBrowserWorkspaceRecoveryOwner('window:closed', 'window:c', 1, 1),
            ]);

            expect(outcomes.filter(outcome => outcome.claimed)).toHaveLength(1);
            const records = await loadBrowserWorkspaceRecoveries();
            expect(records).toHaveLength(1);
            expect([
                'window:b',
                'window:c',
            ]).toContain(records[0]?.ownerId);
        });
    });
});

// T2: an inherited window.name does not authorize clearing another tab's journal.
describe('browser recovery without Web Locks', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(100_000);
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        vi.stubGlobal('navigator', {});
        vi.stubGlobal('window', {
            name: 'evb-viewer-window:321',
            location: {href: 'http://localhost:3235/'},
            history: {
                state: null,
                replaceState: vi.fn(),
            },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            setTimeout,
            clearTimeout,
        });
        vi.stubGlobal('document', {title: 'EVB Viewer'});
        vi.stubGlobal('BroadcastChannel', class {
            addEventListener() {}
            removeEventListener() {}
            postMessage() {}
            close() {}
        });
        vi.stubGlobal('performance', {getEntriesByType: () => [{type: 'navigate'}]});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([
        true,
        false,
    ])('preserves a silent original journal and its next save (channel: %s)', async (hasChannel) => {
        if (!hasChannel) vi.stubGlobal('BroadcastChannel', undefined);
        const store = await import('@app/platform/browser/browserWorkspaceRecoveryStore');
        const refs = [requireDocumentRef('browser://documents/recovery.pdf')];
        await store.saveBrowserWorkspaceRecovery('window:321', 0, checkpoint, refs);
        const before = await store.loadBrowserWorkspaceRecovery('window:321');
        const tabs = await import('@app/platform/browserWindowTabs');
        const claim = tabs.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        const recovered = await claim;
        const ownerId = tabs.getBrowserWindowRecoveryOwnerId();
        if (!ownerId) throw new Error('The duplicate has no recovery owner');
        // Closing a clean duplicate must only clear its own empty journal.
        await store.clearBrowserWorkspaceRecovery(ownerId, recovered ? before!.generation : 0);
        await expect(store.loadBrowserWorkspaceRecovery('window:321')).resolves.toEqual(before);
        await expect(store.saveBrowserWorkspaceRecovery('window:321', before!.generation, checkpoint, refs))
            .resolves.toEqual({
                saved: true,
                generation: 2,
            });
        expect(recovered).toBeNull();
        expect(ownerId).not.toBe('window:321');
    });

    it('recovers a fresh journal on an ordinary same-tab reload', async () => {
        vi.stubGlobal('performance', {getEntriesByType: () => [{type: 'reload'}]});
        const store = await import('@app/platform/browser/browserWorkspaceRecoveryStore');
        const refs = [requireDocumentRef('browser://documents/recovery.pdf')];
        await store.saveBrowserWorkspaceRecovery('window:321', 0, checkpoint, refs);
        const tabs = await import('@app/platform/browserWindowTabs');
        const claim = tabs.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(claim).resolves.toEqual(checkpoint);
        expect(tabs.getBrowserWindowRecoveryOwnerId()).toBe('window:321');
        await expect(store.saveBrowserWorkspaceRecovery('window:321', 1, checkpoint, refs))
            .resolves.toEqual({
                saved: true,
                generation: 2,
            });
    });

    it('recovers an expired inherited owner through the orphan claim transaction', async () => {
        const store = await import('@app/platform/browser/browserWorkspaceRecoveryStore');
        await store.saveBrowserWorkspaceRecovery('window:321', 0, checkpoint, [requireDocumentRef('browser://documents/recovery.pdf')]);
        vi.setSystemTime(130_000);
        const tabs = await import('@app/platform/browserWindowTabs');
        const claim = tabs.browserWindowTabsCapability.claimWorkspaceCheckpoint();
        await vi.advanceTimersByTimeAsync(70);
        await expect(claim).resolves.toEqual(checkpoint);
        const ownerId = tabs.getBrowserWindowRecoveryOwnerId();
        expect(ownerId).not.toBe('window:321');
        await expect(store.loadBrowserWorkspaceRecovery('window:321')).resolves.toBeNull();
        await expect(store.loadBrowserWorkspaceRecovery(ownerId!)).resolves.toMatchObject({
            checkpoint,
            generation: 2,
            leaseRevision: 2,
        });
    });
});
