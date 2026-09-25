import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';
import type * as TFsPromises from 'node:fs/promises';
import type * as TFs from 'node:fs';
import type * as TAtomicReplace from '@electron/utils/atomicReplace';

import {
    afterEach,
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
import { join } from 'node:path';
import {
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';

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
    realReplace: null as null | ((source: string, target: string) => Promise<void>),
    beforeRemove: vi.fn(async (_path: string) => {}),
    syncReadError: null as Error | null,
    userDataPath: '',
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof TFsPromises>();
    return {
        ...actual,
        rm: async (...args: Parameters<typeof actual.rm>) => {
            await mocks.beforeRemove(String(args[0]));
            return actual.rm(...args);
        },
    };
});
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof TFs>();
    return {
        ...actual,
        readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
            if (mocks.syncReadError) {
                throw mocks.syncReadError;
            }
            return actual.readFileSync(...args);
        },
    };
});
vi.mock('@electron/utils/atomicReplace', async (importOriginal) => {
    const actual = await importOriginal<typeof TAtomicReplace>();
    mocks.realReplace = actual.atomicReplace;
    return {
        ...actual,
        atomicReplace: mocks.atomicReplace,
    };
});
vi.mock('@electron/file-access/workingCopyStore', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    claimWorkingCopyOwnership: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(() => null),
    getWorkingCopyOwnerWebContentsId: vi.fn(() => undefined),
    setWorkingCopyOriginalPath: vi.fn(),
}));

function replace(source: string, target: string) {
    return mocks.realReplace!(source, target);
}

function gatedReplace(gate: Promise<void>) {
    return async (source: string, target: string) => {
        await gate;
        await replace(source, target);
    };
}

function recordPath(ownerWebContentsId: number) {
    return join(mocks.userDataPath, 'workspace-recovery', `legacy%3AwebContents%3A${ownerWebContentsId}.json`);
}

async function readRecords() {
    const directory = join(mocks.userDataPath, 'workspace-recovery');
    const names = await readdir(directory).catch(() => []);
    return Promise.all(names.filter(name => name.endsWith('.json')).map(async name => JSON.parse(
        await readFile(join(directory, name), 'utf8'),
    ) as {
        ownerWebContentsId: number;
        checkpoint: IWorkspaceCheckpoint;
    }));
}

async function capturedAtOf(ownerWebContentsId: number) {
    const raw = await readFile(recordPath(ownerWebContentsId), 'utf8').catch(() => null);
    return raw === null ? null : (JSON.parse(raw) as {checkpoint: IWorkspaceCheckpoint}).checkpoint.capturedAt;
}

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
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.userDataPath = await mkdtemp(join(tmpdir(), 'evb-checkpoint-latest-'));
        mocks.syncReadError = null;
        mocks.beforeRemove.mockReset();
        mocks.beforeRemove.mockImplementation(async () => {});
        mocks.atomicReplace.mockReset();
        mocks.atomicReplace.mockImplementation(replace);
    });

    afterEach(async () => {
        await rm(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
    });

    it('commits the active save and only the latest pending checkpoint', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        const committed: number[] = [];
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string, target: string) => {
                await gatedReplace(firstGate.promise)(source, target);
                committed.push((await capturedAtOf(10))!);
            })
            .mockImplementationOnce(async (source: string, target: string) => {
                await gatedReplace(secondGate.promise)(source, target);
                committed.push((await capturedAtOf(10))!);
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

        expect(await capturedAtOf(10)).toBe(3);
        expect(await capturedAtOf(20)).toBe(4);
    });

    it('claims the newest eligible owner record first', async () => {
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
        const {
            discardWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await saveWorkspaceCheckpoint(createCheckpoint(2), 20);
        await flushPendingWorkspaceCheckpointSave();
        await discardWorkspaceCheckpoint(10);

        expect(await capturedAtOf(10)).toBeNull();
        expect(await capturedAtOf(20)).toBe(2);
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
        await writeFile(join(mocks.userDataPath, 'workspace-checkpoint.json'), JSON.stringify({
            ownerWebContentsId: 10,
            checkpoint: recoveryCheckpoint,
            version: 1,
        }));
        mocks.beforeRemove.mockImplementation(async (path: string) => {
            if (path.startsWith(join(mocks.userDataPath, 'workspace-annotation-recovery'))) {
                throw new Error('recovery artifact retirement failed');
            }
        });
        const {discardWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        await expect(discardWorkspaceCheckpoint(10)).rejects.toThrow('recovery artifact retirement failed');
        expect(await readRecords()).toHaveLength(1);

        mocks.beforeRemove.mockImplementation(async () => {});
        await expect(discardWorkspaceCheckpoint(10)).resolves.toBeTruthy();
        expect(await readRecords()).toEqual([]);
    });

    it('continues with the latest pending checkpoint after an active save fails', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async () => {
                await firstGate.promise;
                throw new Error('replace failed');
            })
            .mockImplementationOnce(replace);
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
        expect(await capturedAtOf(10)).toBe(3);
    });

    it('drains pending saves before claim retains the checkpoint for acknowledgement', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(gatedReplace(firstGate.promise))
            .mockImplementationOnce(gatedReplace(secondGate.promise));
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
        expect(await readRecords()).toEqual([]);
    });

    it('drains pending saves before clear removes the checkpoint', async () => {
        const firstGate = deferred();
        mocks.atomicReplace.mockImplementationOnce(gatedReplace(firstGate.promise));
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
        expect(await readRecords()).toEqual([]);
    });

    it('suppresses late saves from a discarded renderer until its token-bound resume', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(gatedReplace(firstGate.promise))
            .mockImplementation(replace);
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
        expect(await readRecords()).toEqual([]);
        expect(mocks.atomicReplace).toHaveBeenCalledOnce();

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        expect(await capturedAtOf(10)).toBe(3);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);
    });

    it('does not let a claim already behind the write barrier resume a later discard', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(gatedReplace(firstGate.promise))
            .mockImplementation(replace);
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
        expect(await readRecords()).toEqual([]);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(4), 10);
        expect(await capturedAtOf(10)).toBe(4);
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
        expect(await capturedAtOf(10)).toBe(2);
    });

    it('coalesces steady checkpoint drips and flushes the debounced save on shutdown', async () => {
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
        expect(await capturedAtOf(10)).toBe(3);
    });

    it('does not let a failed checkpoint write block the shutdown flush barrier', async () => {
        mocks.atomicReplace.mockRejectedValueOnce(new Error('checkpoint write failed'));
        const {
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const saveError = saveWorkspaceCheckpoint(createCheckpoint(1), 10).catch(error => error);

        await expect(flushPendingWorkspaceCheckpointSave()).resolves.toBeUndefined();
        await expect(saveError).resolves.toMatchObject({message: 'checkpoint write failed'});
    });

    it('rolls back suppression when checkpoint deletion fails', async () => {
        const {
            discardWorkspaceCheckpoint,
            flushPendingWorkspaceCheckpointSave,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await saveWorkspaceCheckpoint(createCheckpoint(0), 10);
        mocks.beforeRemove.mockImplementation(async (path: string) => {
            if (path === recordPath(10)) {
                throw new Error('checkpoint delete failed');
            }
        });
        await expect(discardWorkspaceCheckpoint(10)).rejects.toThrow('checkpoint delete failed');
        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        mocks.beforeRemove.mockImplementation(async () => {});
        await flushPendingWorkspaceCheckpointSave();
        expect(await readRecords()).toMatchObject([{
            ownerWebContentsId: 10,
            checkpoint: {capturedAt: 1},
        }]);
    });

    it('does not replace unread durable evidence with an empty autosave', async () => {
        const firstStore = await import('@electron/workspaceCheckpointStore');
        await firstStore.saveWorkspaceCheckpoint(createCheckpoint(1), 10);

        vi.resetModules();
        const readError = new Error('checkpoint read EIO');
        Object.assign(readError, {code: 'EIO'});
        mocks.syncReadError = readError;
        const restartedStore = await import('@electron/workspaceCheckpointStore');

        await expect(restartedStore.saveWorkspaceCheckpoint(createCheckpoint(2), 10))
            .rejects.toMatchObject({code: 'WORKSPACE_CHECKPOINT_READ_FAILED'});
        expect(await capturedAtOf(10)).toBe(1);
    });
});
