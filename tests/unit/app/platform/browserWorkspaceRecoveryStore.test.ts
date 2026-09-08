import {
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
import { FakeIndexedDbFactory } from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {
    DB_NAME,
    WORKSPACE_RECOVERY_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
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
    });

    it('publishes and clears only committed recovery checkpoints', async () => {
        await expect(saveBrowserWorkspaceRecovery('window:1', 0, checkpoint, [
            requireDocumentRef('browser://documents/recovery.pdf'),
            requireDocumentRef('browser://documents/not-in-checkpoint.pdf'),
        ])).resolves.toEqual({
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

        await expect(clearBrowserWorkspaceRecovery('window:1', 1))
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
});
