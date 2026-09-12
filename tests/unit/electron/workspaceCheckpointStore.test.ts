import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import type * as NodeFs from 'node:fs';
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
    allowOpenPath,
    requireOpenPath,
} from '@electron/file-access/openPathCapabilities';

import {
    acknowledgeWorkspaceCheckpoint,
    claimWorkspaceCheckpoint,
    clearWorkspaceCheckpoint,
    flushPendingWorkspaceCheckpointSave,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';

const state = vi.hoisted(() => ({
    backingEntries: new Map<string, {
        admissionSnapshot?: {
            mtimeNs: bigint;
            size: bigint;
        };
        backingState: 'cloned' | 'eager' | 'lazy-original' | 'materializing' | 'materialized';
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
    liveOwners: new Set<number>(),
    webContentsById: new Map<number, {
        id: number;
        isDestroyed: () => boolean;
    }>(),
    originalPaths: new Map<string, string>(),
    restoredOptions: new Map<string, unknown>(),
    recoveryClaims: new Set<string>(),
    blockCleanup: vi.fn(),
    failNextCheckpointRead: false,
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof NodeFs>();
    return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
            if (state.failNextCheckpointRead) {
                state.failNextCheckpointRead = false;
                throw Object.assign(new Error('injected checkpoint read failure'), {code: 'EIO'});
            }
            return actual.readFileSync(...args);
        },
    };
});

vi.mock('electron', () => ({
    app: {getPath: () => state.userDataPath},
    webContents: {fromId: (id: number) => state.liveOwners.has(id)
        ? state.webContentsById.get(id) ?? {
            id,
            isDestroyed: () => false,
        }
        : undefined},
}));

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
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
    claimWorkingCopyRecovery: vi.fn((path: string) => {
        state.recoveryClaims.add(path);
        return state.recoveryClaims.size;
    }),
    releaseWorkingCopyRecovery: vi.fn((path: string) => state.recoveryClaims.delete(path)),
    setWorkingCopyOriginalPath: (
        path: string,
        originalPath: string,
        owner: number,
        options?: {
            admissionSnapshot?: {
                mtimeNs: bigint;
                size: bigint;
            };
            backingState?: 'cloned' | 'eager' | 'lazy-original' | 'materializing' | 'materialized';
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
        state.liveOwners.clear();
        state.webContentsById.clear();
        state.originalPaths.clear();
        state.restoredOptions.clear();
        state.recoveryClaims.clear();
        state.blockCleanup.mockReset();
        state.failNextCheckpointRead = false;
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
        expect(state.recoveryClaims.has(workingCopyRef)).toBe(true);
        await expect(readdir(state.userDataPath)).resolves.toContain('workspace-checkpoint.json');
        await expect(acknowledgeWorkspaceCheckpoint(22)).resolves.toBe(true);
        expect(state.recoveryClaims.has(workingCopyRef)).toBe(false);
        await expect(claimWorkspaceCheckpoint(33)).resolves.toBeNull();
    });

    it('refuses a live owner claim without changing recovery mappings', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.liveOwners.add(11);

        await saveWorkspaceCheckpoint(checkpoint, 11);
        await expect(claimWorkspaceCheckpoint(22)).resolves.toBeNull();
        expect(state.owners.get(workingCopyRef)).toBe(11);
        expect(state.recoveryClaims.has(workingCopyRef)).toBe(false);
    });

    it('does not treat a reused webContents id as the saved owner', async () => {
        const ownerA = {
            id: 11,
            isDestroyed: () => false,
        } as Electron.WebContents;
        const ownerB = {
            id: 11,
            isDestroyed: () => false,
        } as Electron.WebContents;
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.liveOwners.add(11);
        state.webContentsById.set(11, ownerA);

        await saveWorkspaceCheckpoint(checkpoint, 11, ownerA);
        const saved = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        state.webContentsById.set(11, ownerB);

        await expect(claimWorkspaceCheckpoint(11, ownerB)).resolves.toEqual(checkpoint);
        expect(saved.ownerRecoveryId).toEqual(expect.any(String));
        const claimed = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        const claimedRecord = claimed.records?.[0] ?? claimed;
        expect(claimedRecord.ownerRecoveryId).toEqual(expect.any(String));
        expect(claimedRecord.ownerRecoveryId).not.toBe(saved.ownerRecoveryId);
        expect(state.owners.get(workingCopyRef)).toBe(11);

        await saveWorkspaceCheckpoint({
            ...checkpoint,
            capturedAt: requireEpochMs(124),
        }, 11, ownerB);
        await flushPendingWorkspaceCheckpointSave();
        const updated = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        const updatedRecord = updated.records?.[0] ?? updated;
        expect(updated.records ?? [updatedRecord]).toHaveLength(1);
        expect(updatedRecord).toMatchObject({
            ownerRecoveryId: claimedRecord.ownerRecoveryId,
            checkpoint: {capturedAt: 124},
        });
    });

    it('publishes annotation recovery as a fenced artifact and retires it after acknowledgement', async () => {
        const recoveryCheckpoint: IWorkspaceCheckpoint = {
            ...checkpoint,
            tabs: checkpoint.tabs.map(tab => ({
                ...tab,
                annotationRecovery: {
                    artifactId: 'capture-tab-1',
                    documentInstanceId: 'document-1',
                    workingCopyRef: tab.workingCopyRef,
                    workingByteRevision: 'revision-1',
                    annotationMutationGeneration: 7,
                    payload: {
                        version: 1,
                        annotationMutationGeneration: 7,
                        entities: [],
                        foreign: [],
                        drafts: [],
                    },
                },
            })),
        };
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');

        await saveWorkspaceCheckpoint(recoveryCheckpoint, 11);
        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        const storedRecovery = stored.checkpoint.tabs[0].annotationRecovery;
        expect(storedRecovery).toMatchObject({
            documentInstanceId: 'document-1',
            workingByteRevision: 'revision-1',
            annotationMutationGeneration: 7,
        });
        expect(storedRecovery.payload).toBeUndefined();
        await expect(readdir(join(state.userDataPath, 'workspace-annotation-recovery'))).resolves.toHaveLength(1);

        await expect(claimWorkspaceCheckpoint(22)).resolves.toMatchObject({tabs: [{annotationRecovery: {payload: recoveryCheckpoint.tabs[0]?.annotationRecovery?.payload}}]});
        await acknowledgeWorkspaceCheckpoint(22);
        await expect(readdir(join(state.userDataPath, 'workspace-annotation-recovery'))).resolves.toHaveLength(0);
    });

    it('does not retain artifacts from superseded trailing saves', async () => {
        const recoveryPayload = {
            version: 1,
            annotationMutationGeneration: 7,
            entities: [],
            foreign: [],
            drafts: [],
        };
        const recoveryCheckpoint = (capturedAt: number): IWorkspaceCheckpoint => ({
            ...checkpoint,
            capturedAt: requireEpochMs(capturedAt),
            tabs: checkpoint.tabs.map(tab => ({
                ...tab,
                annotationRecovery: {
                    artifactId: `capture-${capturedAt}`,
                    documentInstanceId: 'document-1',
                    workingCopyRef: tab.workingCopyRef,
                    workingByteRevision: `revision-${capturedAt}`,
                    annotationMutationGeneration: capturedAt,
                    payload: recoveryPayload,
                },
            })),
        });
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');

        await saveWorkspaceCheckpoint(recoveryCheckpoint(1), 11);
        const second = saveWorkspaceCheckpoint(recoveryCheckpoint(2), 11);
        const third = saveWorkspaceCheckpoint(recoveryCheckpoint(3), 11);
        await flushPendingWorkspaceCheckpointSave();
        await Promise.all([
            second,
            third,
        ]);

        await expect(readdir(join(state.userDataPath, 'workspace-annotation-recovery'))).resolves.toHaveLength(1);
    });

    it.each([
        [
            'missing',
            async (artifactPath: string) => {
                await rm(artifactPath, {force: true});
            },
        ],
        [
            'malformed',
            async (artifactPath: string) => {
                await writeFile(artifactPath, '');
            },
        ],
    ])('keeps other tabs recoverable when one annotation artifact is %s', async (_failure, corruptArtifact) => {
        const secondWorkingCopyRef = '/tmp/evb-working/second-draft.pdf';
        const firstPayload = {
            version: 1,
            annotationMutationGeneration: 7,
            entities: [],
            foreign: [],
            drafts: [],
        };
        const secondPayload = {
            version: 1,
            annotationMutationGeneration: 8,
            entities: [],
            foreign: [],
            drafts: [],
        };
        const recoveryCheckpoint: IWorkspaceCheckpoint = {
            ...checkpoint,
            panes: [{
                ...checkpoint.panes[0]!,
                tabIds: [
                    requireTabId('tab-1'),
                    requireTabId('tab-2'),
                ],
            }],
            tabs: [
                {
                    ...checkpoint.tabs[0]!,
                    annotationRecovery: {
                        artifactId: 'capture-tab-1',
                        documentInstanceId: 'document-1',
                        workingCopyRef: checkpoint.tabs[0]!.workingCopyRef,
                        workingByteRevision: 'revision-1',
                        annotationMutationGeneration: 7,
                        payload: firstPayload,
                    },
                },
                {
                    ...checkpoint.tabs[0]!,
                    tabId: requireTabId('tab-2'),
                    fileName: 'second-draft.pdf',
                    workingCopyRef: requireDocumentRef(secondWorkingCopyRef),
                    annotationRecovery: {
                        artifactId: 'capture-tab-2',
                        documentInstanceId: 'document-2',
                        workingCopyRef: requireDocumentRef(secondWorkingCopyRef),
                        workingByteRevision: 'revision-2',
                        annotationMutationGeneration: 8,
                        payload: secondPayload,
                    },
                },
            ],
        };
        state.owners.set(workingCopyRef, 11);
        state.owners.set(secondWorkingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.originalPaths.set(secondWorkingCopyRef, '/documents/second-draft.pdf');

        await saveWorkspaceCheckpoint(recoveryCheckpoint, 11);
        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8')) as {checkpoint: IWorkspaceCheckpoint};
        await corruptArtifact(join(
            state.userDataPath,
            'workspace-annotation-recovery',
            `${stored.checkpoint.tabs[0]!.annotationRecovery!.artifactId}.json`,
        ));

        const claimed = await claimWorkspaceCheckpoint(22);
        expect(claimed).not.toBeNull();
        expect(claimed?.tabs[0]).not.toHaveProperty('annotationRecovery');
        expect(claimed?.tabs[1]).toMatchObject({annotationRecovery: {payload: secondPayload}});
        expect(state.owners.get(workingCopyRef)).toBe(22);
        expect(state.owners.get(secondWorkingCopyRef)).toBe(22);
    });

    it('restores a materialized working-copy witness after the process registry is cleared', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.backingEntries.set(workingCopyRef, {
            backingState: 'materialized',
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:original-a',
                mtimeMs: 123.456789,
                size: 987_654,
            },
            originalPath: '/documents/draft.pdf',
            ownerWebContentsId: 11,
            registrationId: 41,
            role: 'current',
        });

        await saveWorkspaceCheckpoint(checkpoint, 11);
        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored.workingCopies).toEqual([expect.objectContaining({
            backingState: 'materialized',
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:original-a',
                mtimeMs: 123.456789,
                size: 987_654,
            },
            originalPath: '/documents/draft.pdf',
            registrationId: 41,
            workingCopyRef,
        })]);

        state.backingEntries.clear();
        state.owners.clear();
        state.originalPaths.clear();

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(checkpoint);
        expect(state.restoredOptions.get(workingCopyRef)).toMatchObject({
            backingState: 'materialized',
            deferOriginalFileExpectation: true,
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:original-a',
                mtimeMs: 123.456789,
                size: 987_654,
            },
        });
    });

    it('restores the durable materialized witness when a live registration drifted', async () => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.backingEntries.set(workingCopyRef, {
            backingState: 'materialized',
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:original-a',
                mtimeMs: 123.456789,
                size: 987_654,
            },
            originalPath: '/documents/draft.pdf',
            ownerWebContentsId: 11,
            registrationId: 41,
            role: 'current',
        });

        await saveWorkspaceCheckpoint(checkpoint, 11);
        const liveEntry = state.backingEntries.get(workingCopyRef)!;
        liveEntry.originalFileExpectation = {
            contentFingerprint: 'sha256-full-v1:drifted',
            mtimeMs: 999.5,
            size: 12,
        };

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(checkpoint);
        expect(state.restoredOptions.get(workingCopyRef)).toMatchObject({
            backingState: 'materialized',
            deferOriginalFileExpectation: true,
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:original-a',
                mtimeMs: 123.456789,
                size: 987_654,
            },
        });
    });

    it.each([
        [
            'checkpoint metadata is absent',
            false,
        ],
        [
            'checkpoint metadata has no witness',
            true,
        ],
    ])('does not transfer a legacy dirty registration when $0', async (_description, hasWorkingCopyMetadata) => {
        state.owners.set(workingCopyRef, 11);
        state.originalPaths.set(workingCopyRef, '/documents/draft.pdf');
        state.backingEntries.set(workingCopyRef, {
            backingState: 'materialized',
            originalFileExpectation: {
                contentFingerprint: 'sha256-full-v1:sampled-current-source',
                mtimeMs: 999.5,
                size: 12,
            },
            originalPath: '/documents/draft.pdf',
            ownerWebContentsId: 11,
            registrationId: 41,
            role: 'current',
        });
        await writeFile(join(state.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint,
            ...(hasWorkingCopyMetadata ? {workingCopies: [{
                backingState: 'materialized',
                originalPath: '/documents/draft.pdf',
                registrationId: 41,
                role: 'current',
                workingCopyRef,
            }]} : {}),
        }));

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(checkpoint);
        expect(state.restoredOptions.get(workingCopyRef)).toMatchObject({deferOriginalFileExpectation: true});
        if (hasWorkingCopyMetadata) {
            expect(state.restoredOptions.get(workingCopyRef)).toMatchObject({backingState: 'materialized'});
        }
        expect(state.restoredOptions.get(workingCopyRef)).not.toHaveProperty('originalFileExpectation');
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

    it('validates forwarded source-only saves against the sender grant and preserves the last record', async () => {
        const grantedPdfPath = join(state.userDataPath, 'granted.pdf');
        const ungrantedJsonPath = join(state.userDataPath, 'ungranted.json');
        await writeFile(grantedPdfPath, '%PDF-1.7 synthetic checkpoint fixture');
        await writeFile(ungrantedJsonPath, '{"synthetic":true}');
        const grantedCheckpoint = {
            ...checkpoint,
            tabs: [{
                ...checkpoint.tabs[0]!,
                sourceRef: requireDocumentRef(grantedPdfPath),
                workingCopyRef: null,
                isDirty: false,
            }],
        };
        const forgedCheckpoint = {
            ...grantedCheckpoint,
            tabs: [{
                ...grantedCheckpoint.tabs[0]!,
                sourceRef: requireDocumentRef(ungrantedJsonPath),
            }],
        };
        allowOpenPath(grantedPdfPath, 11);

        await saveWorkspaceCheckpoint(grantedCheckpoint, 11, 11);
        await expect(saveWorkspaceCheckpoint(forgedCheckpoint, 11, 11))
            .rejects.toThrow('Path not allowed');
        expect(() => requireOpenPath(ungrantedJsonPath, 11)).toThrow('Path not allowed');
        expect(JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8')).checkpoint)
            .toEqual(grantedCheckpoint);
    });

    it('rejects an unproven source-only save without replacing the last valid record', async () => {
        const grantedPdfPath = join(state.userDataPath, 'granted.pdf');
        await writeFile(grantedPdfPath, '%PDF-1.7 synthetic checkpoint fixture');
        const grantedCheckpoint = {
            ...checkpoint,
            tabs: [{
                ...checkpoint.tabs[0]!,
                sourceRef: requireDocumentRef(grantedPdfPath),
                workingCopyRef: null,
                isDirty: false,
            }],
        };
        allowOpenPath(grantedPdfPath, 11);

        await saveWorkspaceCheckpoint(grantedCheckpoint, 11, 11);
        await expect(saveWorkspaceCheckpoint(grantedCheckpoint, 11))
            .rejects.toThrow('no sender-bound authorization');
        expect(JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8')).checkpoint)
            .toEqual(grantedCheckpoint);
    });

    it('keeps legacy source-only evidence but refuses to authorize it on claim', async () => {
        const legacyPath = join(state.userDataPath, 'legacy.txt');
        await writeFile(legacyPath, 'legacy checkpoint fixture');
        await writeFile(join(state.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint: {
                ...checkpoint,
                tabs: [{
                    ...checkpoint.tabs[0]!,
                    sourceRef: requireDocumentRef(legacyPath),
                    workingCopyRef: null,
                }],
            },
        }));

        await expect(claimWorkspaceCheckpoint(22))
            .rejects.toThrow('no durable authorization provenance');
        expect(() => requireOpenPath(legacyPath, 22)).toThrow('Path not allowed');
        expect(await readdir(state.userDataPath)).toContain('workspace-checkpoint.json');
    });

    it('does not reuse source-only provenance for a forged working-copy ref', async () => {
        const sourcePath = join(state.userDataPath, 'source.pdf');
        const forgedWorkingCopyPath = '/tmp/evb-working/forged.pdf';
        await writeFile(sourcePath, '%PDF-1.7 synthetic checkpoint fixture');
        await writeFile(join(state.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint: {
                ...checkpoint,
                tabs: [{
                    ...checkpoint.tabs[0]!,
                    sourceRef: requireDocumentRef(sourcePath),
                    workingCopyRef: requireDocumentRef(forgedWorkingCopyPath),
                }],
            },
            sourceProvenance: [{
                kind: 'open-grant',
                ownerWebContentsId: 11,
                sourceRef: sourcePath,
            }],
        }));

        await expect(claimWorkspaceCheckpoint(22))
            .rejects.toThrow('no durable authorization provenance');
        expect(state.owners.has(forgedWorkingCopyPath)).toBe(false);
        expect(await readdir(state.userDataPath)).toContain('workspace-checkpoint.json');
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

    it('does not replace unread evidence during empty autosave, then retries after the read recovers', async () => {
        await clearWorkspaceCheckpoint();
        const checkpointPath = join(state.userDataPath, 'workspace-checkpoint.json');
        await writeFile(checkpointPath, JSON.stringify({
            version: 1,
            ownerWebContentsId: 11,
            checkpoint,
        }));
        state.failNextCheckpointRead = true;
        await expect(saveWorkspaceCheckpoint({
            ...checkpoint,
            tabs: [],
            panes: [],
            activePaneId: null,
            activeTabId: null,
            layout: null,
        }, 11)).rejects.toMatchObject({
            name: 'WorkspaceCheckpointReadError',
            code: 'WORKSPACE_CHECKPOINT_READ_FAILED',
        });
        expect(JSON.parse(await readFile(checkpointPath, 'utf8')).checkpoint.tabs).toHaveLength(1);

        await saveWorkspaceCheckpoint({
            ...checkpoint,
            tabs: [],
            panes: [],
            activePaneId: null,
            activeTabId: null,
            layout: null,
        }, 11);
        await flushPendingWorkspaceCheckpointSave();
        const persisted = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
            checkpoint?: IWorkspaceCheckpoint;
            records?: Array<{checkpoint: IWorkspaceCheckpoint}>;
        };
        expect((persisted.records?.[0]?.checkpoint ?? persisted.checkpoint)?.tabs).toEqual([]);
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
