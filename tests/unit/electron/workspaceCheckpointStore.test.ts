import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePaneId} from '@contracts/editorPanes';
import {requireEpochMs} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import type {IWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';

import {
    acknowledgeWorkspaceCheckpoint,
    claimWorkspaceCheckpoint,
    flushPendingWorkspaceCheckpointSave,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';

const state = vi.hoisted(() => ({
    backingEntries: new Map<string, {
        admissionSnapshot?: {
            mtimeNs: bigint;
            size: bigint;
        };
        backingState: 'eager' | 'lazy-original' | 'materializing';
        originalFileExpectation?: {
            contentFingerprint?: string;
            mtimeMs: number;
            size: number;
        };
        originalPath: string;
        ownerWebContentsId?: number;
        registrationId: number;
        role: 'current' | 'snapshot';
        sourceBackingErrorCode?: 'SOURCE_BACKING_CHANGED';
    }>(),
    userDataPath: '',
    owners: new Map<string, number>(),
    originalPaths: new Map<string, string>(),
    restoredOptions: new Map<string, unknown>(),
    blockCleanup: vi.fn(),
}));

vi.mock('electron', () => ({app: {getPath: () => state.userDataPath}}));

vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOwnerWebContentsId: (path: string) => state.owners.get(path),
    getWorkingCopyOriginalPath: (path: string, owner: number) => state.owners.get(path) === owner
        ? {originalPath: state.originalPaths.get(path)}
        : null,
    getWorkingCopyBackingEntry: (path: string, owner: number) => state.owners.get(path) === owner
        ? state.backingEntries.get(path) ?? null
        : null,
    claimWorkingCopyOwnership: (path: string, expectedOwner: number, nextOwner: number) => {
        if (state.owners.get(path) !== expectedOwner) {
            return false;
        }
        state.owners.set(path, nextOwner);
        const entry = state.backingEntries.get(path);
        if (entry) {
            entry.ownerWebContentsId = nextOwner;
        }
        return true;
    },
    setWorkingCopyOriginalPath: (
        path: string,
        originalPath: string,
        owner: number,
        options?: {
            admissionSnapshot?: {
                mtimeNs: bigint;
                size: bigint;
            };
            backingState?: 'eager' | 'lazy-original';
            originalFileExpectation?: {
                contentFingerprint?: string;
                mtimeMs: number;
                size: number;
            };
            role?: 'current' | 'snapshot';
        },
    ) => {
        state.owners.set(path, owner);
        state.originalPaths.set(path, originalPath);
        state.restoredOptions.set(path, options);
        state.backingEntries.set(path, {
            ...(options?.admissionSnapshot ? {admissionSnapshot: options.admissionSnapshot} : {}),
            backingState: options?.backingState ?? 'eager',
            originalPath,
            ownerWebContentsId: owner,
            ...(options?.originalFileExpectation
                ? {originalFileExpectation: options.originalFileExpectation}
                : {}),
            registrationId: 999,
            role: options?.role ?? 'current',
        });
        return Promise.resolve();
    },
    transitionWorkingCopyBackingState: (
        path: string,
        registrationId: number,
        backingState: 'lazy-original',
        options: {sourceBackingErrorCode?: 'SOURCE_BACKING_CHANGED'},
    ) => {
        const entry = state.backingEntries.get(path);
        if (!entry || entry.registrationId !== registrationId) {
            return false;
        }
        entry.backingState = backingState;
        if (options.sourceBackingErrorCode) {
            entry.sourceBackingErrorCode = options.sourceBackingErrorCode;
        } else {
            delete entry.sourceBackingErrorCode;
        }
        return true;
    },
}));
vi.mock('@electron/file-access/workingCopyCleanup', () => ({blockStaleWorkingCopyDirectoryCleanup: state.blockCleanup}));

const workingCopyRef = '/tmp/evb-working/draft.pdf';
const checkpoint: IWorkspaceCheckpoint = {
    version: 1 as const,
    capturedAt: requireEpochMs(123),
    activePaneId: requirePaneId('pane-1'),
    activeTabId: requireTabId('tab-1'),
    layout: {
        type: 'leaf' as const,
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
        fileName: 'draft.pdf',
        sourceRef: requireDocumentRef('/documents/draft.pdf'),
        workingCopyRef: requireDocumentRef(workingCopyRef),
        isDirty: true,
        isDjvu: false,
        currentPage: 2,
        zoom: 1,
        zoomMode: 'fit-width' as const,
    }],
};

describe('workspace checkpoint store', () => {
    beforeEach(async () => {
        state.userDataPath = await mkdtemp(join(tmpdir(), 'evb-workspace-checkpoint-'));
        state.backingEntries.clear();
        state.owners.clear();
        state.originalPaths.clear();
        state.restoredOptions.clear();
        state.blockCleanup.mockReset();
    });

    afterEach(async () => {
        await rm(state.userDataPath, {
            force: true,
            recursive: true,
        });
    });

    it('atomically persists, claims once, and transfers working-copy ownership', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        await saveWorkspaceCheckpoint(checkpoint, 11);

        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored).toMatchObject({
            version: 1,
            ownerWebContentsId: 11,
        });

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(checkpoint);
        expect(state.owners.get(workingCopyRef)).toBe(22);
        await expect(readdir(state.userDataPath)).resolves.toContain('workspace-checkpoint.json');
        await expect(acknowledgeWorkspaceCheckpoint(22)).resolves.toBe(true);
        await expect(claimWorkspaceCheckpoint(33)).resolves.toBeNull();
    });

    it('persists the working-copy mapping as canonical source instead of a renderer temp-path hint', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/canonical-draft.pdf');

        await saveWorkspaceCheckpoint({
            ...checkpoint,
            tabs: [{
                ...checkpoint.tabs[0]!,
                sourceRef: requireDocumentRef(workingCopyRef),
            }],
        }, 11);

        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored.checkpoint.tabs[0]).toMatchObject({
            sourceRef: '/documents/canonical-draft.pdf',
            workingCopyRef,
        });
    });

    it('retains a prior working copy when a failed recovery tab has no live ref', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        await saveWorkspaceCheckpoint(checkpoint, 11);

        await saveWorkspaceCheckpoint({
            ...checkpoint,
            capturedAt: requireEpochMs(456),
            tabs: [{
                ...checkpoint.tabs[0]!,
                sourceRef: requireDocumentRef('/documents/draft.pdf'),
                workingCopyRef: null,
                isDirty: true,
            }],
        }, 11);
        await flushPendingWorkspaceCheckpointSave();

        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored.checkpoint).toMatchObject({
            capturedAt: 456,
            tabs: [{
                sourceRef: '/documents/draft.pdf',
                workingCopyRef,
                isDirty: true,
            }],
        });
    });

    it('canonicalizes a legacy temp-path source while claiming a checkpoint', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/canonical-draft.pdf');
        await writeFile(join(state.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint: {
                ...checkpoint,
                tabs: [{
                    ...checkpoint.tabs[0]!,
                    sourceRef: requireDocumentRef(workingCopyRef),
                }],
            },
        }));

        await expect(claimWorkspaceCheckpoint(22)).resolves.toMatchObject({tabs: [{
            sourceRef: '/documents/canonical-draft.pdf',
            workingCopyRef,
        }]});
    });

    it('rejects persistence when an owned working copy has no canonical source mapping', async () => {
        state.owners.set(workingCopyRef, 11);
        await expect(saveWorkspaceCheckpoint({
            ...checkpoint,
            tabs: [{
                ...checkpoint.tabs[0]!,
                sourceRef: requireDocumentRef(workingCopyRef),
            }],
        }, 11)).rejects.toThrow('no canonical source mapping');
    });

    it('rejects checkpoints that reference another renderer working copy', async () => {
        state.owners.set(workingCopyRef, 99);
        await expect(saveWorkspaceCheckpoint(checkpoint, 11)).rejects.toThrow('unowned working copy');
    });

    it('fails closed and preserves the checkpoint when its file cannot be read', async () => {
        const checkpointPath = join(state.userDataPath, 'workspace-checkpoint.json');
        await mkdir(checkpointPath);

        await expect(claimWorkspaceCheckpoint(22)).rejects.toMatchObject({
            name: 'WorkspaceCheckpointReadError',
            code: 'WORKSPACE_CHECKPOINT_READ_FAILED',
            checkpointPath,
        });
        expect(state.blockCleanup).toHaveBeenCalledWith(
            `workspace checkpoint read failed at ${checkpointPath}`,
        );
        await expect(readdir(state.userDataPath)).resolves.toContain('workspace-checkpoint.json');
    });

    it('roundtrips a clean lazy working copy across a full main-process restart', async () => {
        const cleanCheckpoint = {
            ...checkpoint,
            tabs: [{
                ...checkpoint.tabs[0]!,
                isDirty: false,
            }],
        };
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.backingEntries.set(workingCopyRef, {
            admissionSnapshot: {
                mtimeNs: 123_456_789n,
                size: 987_654n,
            },
            backingState: 'lazy-original',
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:abc',
                mtimeMs: 123.456789,
                size: 987_654,
            },
            originalPath: '/documents/draft.pdf',
            ownerWebContentsId: 11,
            registrationId: 41,
            role: 'current',
        });

        await saveWorkspaceCheckpoint(cleanCheckpoint, 11);
        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored.lazyWorkingCopies).toEqual([expect.objectContaining({
            admissionSnapshot: {
                mtimeNs: '123456789',
                size: '987654',
            },
            originalPath: '/documents/draft.pdf',
            registrationId: 41,
            workingCopyRef,
        })]);

        state.backingEntries.clear();
        state.owners.clear();
        state.originalPaths.clear();

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(cleanCheckpoint);
        expect(state.originalPaths.get(workingCopyRef)).toBe('/documents/draft.pdf');
        expect(state.restoredOptions.get(workingCopyRef)).toMatchObject({
            admissionSnapshot: {
                mtimeNs: 123_456_789n,
                size: 987_654n,
            },
            backingState: 'lazy-original',
            deferOriginalFileExpectation: true,
            role: 'current',
        });
        expect(state.backingEntries.get(workingCopyRef)).toMatchObject({
            admissionSnapshot: {
                mtimeNs: 123_456_789n,
                size: 987_654n,
            },
            backingState: 'lazy-original',
            ownerWebContentsId: 22,
        });
    });

    it('rejects dirty lazy persistence and quarantines it on recovery', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.backingEntries.set(workingCopyRef, {
            admissionSnapshot: {
                mtimeNs: 10n,
                size: 20n,
            },
            backingState: 'lazy-original',
            originalPath: '/documents/draft.pdf',
            ownerWebContentsId: 11,
            registrationId: 42,
            role: 'current',
        });

        await expect(saveWorkspaceCheckpoint(checkpoint, 11))
            .rejects.toThrow('cannot persist a dirty lazy working copy');

        await writeFile(join(state.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint,
            lazyWorkingCopies: [{
                admissionSnapshot: {
                    mtimeNs: '10',
                    size: '20',
                },
                originalPath: '/documents/draft.pdf',
                registrationId: 42,
                role: 'current',
                workingCopyRef,
            }],
        }));
        // The save path throws on dirty-lazy state, so a persisted checkpoint
        // can never legitimately contain it: encountering it on recovery means
        // the file is corrupt. Claim quarantines the bad file and returns null
        // rather than throwing, which would otherwise crash-loop recovery on
        // every startup because nothing clears the file. Ownership is untouched
        // because the guard runs before any transfer.
        await expect(claimWorkspaceCheckpoint(22)).resolves.toBeNull();
        expect(state.owners.get(workingCopyRef)).toBe(11);
        const entries = await readdir(state.userDataPath);
        expect(entries).not.toContain('workspace-checkpoint.json');
        expect(entries.some(name => name.endsWith('.corrupt'))).toBe(true);
    });
});
