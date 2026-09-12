import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';
import {requireEpochMs} from '@contracts/timestamps';
import {requirePaneId} from '@contracts/editorPanes';
import {requireTabId} from '@contracts/windowTabs';

function deferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    persisted: null as string | null,
    syncReadError: null as Error | null,
    remove: vi.fn(),
    staged: new Map<string, string>(),
    tempIndex: 0,
}));

vi.mock('electron', () => ({app: {getPath: () => '/profile'}}));
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(async () => {
        if (mocks.persisted === null) {
            const error = new Error('missing');
            Object.assign(error, {code: 'ENOENT'});
            throw error;
        }
        return mocks.persisted;
    }),
    rm: mocks.remove,
    writeFile: vi.fn(async (path: string, value: string) => {
        mocks.staged.set(path, value);
    }),
}));
vi.mock('node:fs', () => ({readFileSync: vi.fn(() => {
    if (mocks.syncReadError) {
        throw mocks.syncReadError;
    }
    if (mocks.persisted === null) {
        const error = new Error('missing');
        Object.assign(error, {code: 'ENOENT'});
        throw error;
    }
    return mocks.persisted;
})}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: () => `/profile/checkpoint-${mocks.tempIndex += 1}.tmp`,
}));
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    claimWorkingCopyOwnership: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(() => null),
    getWorkingCopyOwnerWebContentsId: vi.fn(() => undefined),
    setWorkingCopyOriginalPath: vi.fn(),
}));

function createCheckpoint(capturedAt: number): IWorkspaceCheckpoint {
    return {
        version: 1,
        capturedAt: requireEpochMs(capturedAt),
        activePaneId: requirePaneId('pane-1'),
        activeTabId: null,
        layout: {
            type: 'leaf',
            paneId: requirePaneId('pane-1'),
        },
        panes: [{
            paneId: requirePaneId('pane-1'),
            tabIds: [],
            activeTabId: null,
        }],
        tabs: [],
    };
}

describe('workspace checkpoint latest-only writer', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.persisted = null;
        mocks.syncReadError = null;
        mocks.remove.mockImplementation(async (path: string) => {
            if (path === '/profile/workspace-checkpoint.json') {
                mocks.persisted = null;
            }
        });
        mocks.staged.clear();
        mocks.tempIndex = 0;
    });

    it('commits the active save and only the latest pending checkpoint', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        const committed: number[] = [];
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
                committed.push(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt);
            })
            .mockImplementationOnce(async (source: string) => {
                await secondGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
                committed.push(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt);
            });
        const {saveWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const second = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const third = saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        let secondSettled = false;
        void second.finally(() => {
            secondSettled = true;
        });

        firstGate.resolve();
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(2));
        expect(secondSettled).toBe(false);
        secondGate.resolve();
        await Promise.all([
            first,
            second,
            third,
        ]);

        expect(committed).toEqual([
            1,
            3,
        ]);
    });

    it('keeps interleaved trailing saves in separate owner records', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await saveWorkspaceCheckpoint(createCheckpoint(2), 20);
        const saves = [
            saveWorkspaceCheckpoint(createCheckpoint(3), 10),
            saveWorkspaceCheckpoint(createCheckpoint(4), 20),
        ];
        await flushPendingWorkspaceCheckpointSave();
        await Promise.all(saves);

        const journal = JSON.parse(mocks.persisted ?? '{}') as {
            version: number;
            records: Array<{
                ownerWebContentsId: number;
                checkpoint: IWorkspaceCheckpoint
            }>;
        };
        expect(journal.version).toBe(2);
        expect(new Map(journal.records.map(record => [
            record.ownerWebContentsId,
            record.checkpoint.capturedAt,
        ]))).toEqual(
            new Map([
                [
                    10,
                    3,
                ],
                [
                    20,
                    4,
                ],
            ]),
        );
    });

    it('claims the newest eligible owner record first', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            claimWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(100), 10);
        await saveWorkspaceCheckpoint(createCheckpoint(200), 20);
        await flushPendingWorkspaceCheckpointSave();

        await expect(claimWorkspaceCheckpoint(30)).resolves.toMatchObject({capturedAt: 200});
    });

    it('discards one owner without deleting another owner record', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            discardWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await saveWorkspaceCheckpoint(createCheckpoint(2), 20);
        await flushPendingWorkspaceCheckpointSave();
        await discardWorkspaceCheckpoint(10);

        const journal = JSON.parse(mocks.persisted ?? '{}') as {
            version: number;
            records?: Array<{
                ownerWebContentsId: number;
                checkpoint: IWorkspaceCheckpoint
            }>;
            ownerWebContentsId?: number;
            checkpoint?: IWorkspaceCheckpoint;
        };
        expect(journal.version).toBe(1);
        expect(journal.records).toBeUndefined();
        expect(journal.ownerWebContentsId).toBe(20);
        expect(journal.checkpoint?.capturedAt).toBe(2);
    });

    it('discards a checkpoint through its adopted renderer owner', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            discardWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await flushPendingWorkspaceCheckpointSave();
        const stored = JSON.parse(mocks.persisted ?? '{}') as {claimedByWebContentsId?: number;};
        stored.claimedByWebContentsId = 20;
        mocks.persisted = JSON.stringify(stored);

        await discardWorkspaceCheckpoint(20);

        expect(mocks.persisted).toBeNull();
    });

    it('keeps a checkpoint durable when recovery artifact retirement fails', async () => {
        const recoveryCheckpoint: IWorkspaceCheckpoint = {
            ...createCheckpoint(1),
            tabs: [{
                tabId: requireTabId('tab-1'),
                paneId: requirePaneId('pane-1'),
                fileName: 'draft.pdf',
                sourceRef: null,
                workingCopyRef: null,
                isDirty: false,
                isDjvu: false,
                currentPage: null,
                zoom: null,
                zoomMode: null,
                annotationRecovery: {
                    artifactId: 'capture-tab-1',
                    documentInstanceId: 'document-1',
                    workingCopyRef: null,
                    workingByteRevision: 'revision-1',
                    annotationMutationGeneration: 1,
                },
            }],
        };
        mocks.persisted = JSON.stringify({
            ownerWebContentsId: 10,
            checkpoint: recoveryCheckpoint,
            version: 1,
        });
        mocks.remove.mockImplementation(async (path: string) => {
            if (path.includes('/workspace-annotation-recovery/')) {
                throw new Error('recovery artifact retirement failed');
            }
            if (path === '/profile/workspace-checkpoint.json') {
                mocks.persisted = null;
                return;
            }
        });
        const {discardWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        await expect(discardWorkspaceCheckpoint(10)).rejects.toThrow('recovery artifact retirement failed');
        expect(mocks.persisted).not.toBeNull();

        mocks.remove.mockImplementation(async (path: string) => {
            if (path === '/profile/workspace-checkpoint.json') {
                mocks.persisted = null;
            }
        });
        await expect(discardWorkspaceCheckpoint(10)).resolves.toBeTruthy();
        expect(mocks.persisted).toBeNull();
    });

    it('continues with the latest pending checkpoint after an active save fails', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async () => {
                await firstGate.promise;
                throw new Error('replace failed');
            })
            .mockImplementationOnce(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {saveWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        const firstResult = first.then(
            () => null,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const second = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const third = saveWorkspaceCheckpoint(createCheckpoint(3), 10);

        firstGate.resolve();
        await Promise.all([
            second,
            third,
        ]);

        await expect(firstResult).resolves.toEqual(new Error('replace failed'));
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(3);
    });

    it('drains pending saves before claim retains the checkpoint for acknowledgement', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementationOnce(async (source: string) => {
                await secondGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            acknowledgeWorkspaceCheckpoint,
            claimWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const latest = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const claim = claimWorkspaceCheckpoint(20);

        firstGate.resolve();
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(2));
        secondGate.resolve();

        await Promise.all([
            first,
            latest,
        ]);
        await expect(claim).resolves.toMatchObject({capturedAt: 2});
        await expect(acknowledgeWorkspaceCheckpoint(20)).resolves.toBe(true);
        expect(mocks.persisted).toBeNull();
    });

    it('drains pending saves before clear removes the checkpoint', async () => {
        const firstGate = deferred();
        mocks.atomicReplace.mockImplementationOnce(async (source: string) => {
            await firstGate.promise;
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            clearWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const save = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const clear = clearWorkspaceCheckpoint();
        firstGate.resolve();

        await save;
        await clear;
        expect(mocks.persisted).toBeNull();
    });

    it('suppresses late saves from a discarded renderer until its token-bound resume', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementation(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const activeSave = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const discard = discardWorkspaceCheckpoint(10);
        const lateSave = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        firstGate.resolve();

        const [
            ,
            discardToken,
        ] = await Promise.all([
            activeSave,
            discard,
            lateSave,
        ]);
        expect(mocks.persisted).toBeNull();
        expect(mocks.atomicReplace).toHaveBeenCalledOnce();

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(3);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);
    });

    it('does not let a claim already behind the write barrier resume a later discard', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementation(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            claimWorkspaceCheckpoint,
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const activeSave = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const staleClaim = claimWorkspaceCheckpoint(10);
        const discard = discardWorkspaceCheckpoint(10);
        const retiringRendererSave = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        firstGate.resolve();

        await activeSave;
        await expect(staleClaim).resolves.toMatchObject({capturedAt: 1});
        const discardToken = await discard;
        await retiringRendererSave;
        await saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        expect(mocks.persisted).toBeNull();
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(4), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(4);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(3);
    });

    it('rejects a stale resume token after a newer discard', async () => {
        const {
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const staleToken = await discardWorkspaceCheckpoint(10);
        const currentToken = await discardWorkspaceCheckpoint(10);
        expect(() => resumeWorkspaceCheckpoint(10, staleToken)).toThrow('stale or invalid');
        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        resumeWorkspaceCheckpoint(10, currentToken);
        await saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(2);
    });

    it('coalesces steady checkpoint drips and flushes the debounced save on shutdown', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(1);

        const debounced = [
            saveWorkspaceCheckpoint(createCheckpoint(2), 10),
            saveWorkspaceCheckpoint(createCheckpoint(3), 10),
        ];
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(1);

        await flushPendingWorkspaceCheckpointSave();
        await Promise.all(debounced);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(3);
    });

    it('rolls back suppression when checkpoint deletion fails', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            discardWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(0), 10);
        mocks.remove.mockImplementation(async (path: string) => {
            if (path === '/profile/workspace-checkpoint.json') {
                throw new Error('checkpoint delete failed');
            }
        });
        await expect(discardWorkspaceCheckpoint(10)).rejects.toThrow('checkpoint delete failed');
        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        const persisted = JSON.parse(mocks.persisted ?? '{}') as {records?: Array<{
            ownerWebContentsId: number;
            checkpoint: IWorkspaceCheckpoint;
        }>;};
        expect(persisted.records).toHaveLength(1);
        expect(persisted.records?.[0]).toMatchObject({
            ownerWebContentsId: 10,
            checkpoint: {capturedAt: 1},
        });
    });

    it('does not replace unread durable evidence with an empty autosave', async () => {
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const firstStore = await import('@electron/workspaceCheckpointStore');
        await firstStore.saveWorkspaceCheckpoint(createCheckpoint(1), 10);

        vi.resetModules();
        const readError = new Error('checkpoint read EIO');
        Object.assign(readError, {code: 'EIO'});
        mocks.syncReadError = readError;
        const restartedStore = await import('@electron/workspaceCheckpointStore');

        await expect(restartedStore.saveWorkspaceCheckpoint(createCheckpoint(2), 10))
            .rejects.toMatchObject({code: 'WORKSPACE_CHECKPOINT_READ_FAILED'});
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(1);
    });
});
