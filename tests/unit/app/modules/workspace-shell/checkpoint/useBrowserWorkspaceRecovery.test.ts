import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as Vue from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type {IWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';

const mocks = vi.hoisted(() => ({
    buildCheckpoint: vi.fn(),
    cleanupDetachedDocument: vi.fn(async () => true),
    clearRecovery: vi.fn(async () => undefined),
    createStoredDocument: vi.fn(async () => 'browser://documents/new-recovery.pdf'),
    loadRecovery: vi.fn(async (): Promise<unknown> => null),
    onBeforeUnmount: vi.fn(),
    eventListeners: new Map<string, Array<() => void>>(),
    saveRecovery: vi.fn(async (
        _ownerId: string,
        _generation: number,
        _checkpoint: unknown,
        _snapshotRefs: string[],
    ) => ({
        saved: true,
        generation: 4,
    })),
    touchRecovery: vi.fn(async (_ownerId: string, generation: number) => ({
        saved: true,
        generation,
    })),
}));

vi.mock('vue', async (importOriginal) => {
    const actual = await importOriginal<typeof Vue>();
    return {
        ...actual,
        onBeforeUnmount: (callback: () => void) => mocks.onBeforeUnmount.mockImplementation(callback),
        watch: (_source: unknown, callback: () => void) => {
            callback();
            return vi.fn();
        },
    };
});
vi.mock('@vueuse/core', () => ({useEventListener: vi.fn((_target: unknown, eventName: string, callback: () => void) => {
    const callbacks = mocks.eventListeners.get(eventName) ?? [];
    callbacks.push(callback);
    mocks.eventListeners.set(eventName, callbacks);
})}));
vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: {
    cleanupDetachedDocument: mocks.cleanupDetachedDocument,
    createStoredDocument: mocks.createStoredDocument,
}}));
vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => ({
    clearBrowserWorkspaceRecovery: mocks.clearRecovery,
    loadBrowserWorkspaceRecovery: mocks.loadRecovery,
    saveBrowserWorkspaceRecovery: mocks.saveRecovery,
    touchBrowserWorkspaceRecovery: mocks.touchRecovery,
}));
vi.mock('@app/platform/browserWindowTabs', () => ({getBrowserWindowRecoveryOwnerId: () => 'window:1'}));
vi.mock('@app/modules/workspace-shell/checkpoint/buildWorkspaceCheckpoint', () => ({buildWorkspaceCheckpoint: mocks.buildCheckpoint}));

function makeCheckpoint(): IWorkspaceCheckpoint {
    return {
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
            fileName: 'report.pdf',
            sourceRef: requireDocumentRef('browser://documents/source.pdf'),
            workingCopyRef: requireDocumentRef('browser://documents/live-working.pdf'),
            requiresSaveAsOnFirstSave: false,
            isDirty: true,
            isDjvu: false,
            currentPage: 1,
            zoom: 1,
            zoomMode: 'custom',
        }],
    };
}

describe('useBrowserWorkspaceRecovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.eventListeners.clear();
        vi.useFakeTimers();
        mocks.buildCheckpoint.mockReturnValue(makeCheckpoint());
        mocks.createStoredDocument.mockResolvedValue('browser://documents/new-recovery.pdf');
        mocks.saveRecovery.mockResolvedValue({
            saved: true,
            generation: 4,
        });
        mocks.touchRecovery.mockResolvedValue({
            saved: true,
            generation: 4,
        });
        mocks.loadRecovery.mockResolvedValue({
            ownerId: 'window:1',
            generation: 3,
            checkpoint: {},
            snapshotRefs: ['browser://documents/old-recovery.pdf'],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('publishes a detached dirty snapshot before releasing the previous lease', async () => {
        const createRecoverySnapshotBytes = vi.fn(async () => Uint8Array.of(4, 5, 6));
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [{
                id: 'tab-1',
                isDirty: true,
            }]},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes},
            ]])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);

        expect(mocks.createStoredDocument).toHaveBeenCalledWith(
            'report.pdf.recovery.pdf',
            Uint8Array.of(4, 5, 6),
            expect.objectContaining({
                kind: 'working',
                retention: 'durable',
            }),
        );
        expect(mocks.saveRecovery).toHaveBeenCalledWith(
            'window:1',
            3,
            expect.objectContaining({tabs: [expect.objectContaining({
                workingCopyRef: 'browser://documents/new-recovery.pdf',
                requiresSaveAsOnFirstSave: true,
                isDirty: true,
            })]}),
            ['browser://documents/new-recovery.pdf'],
        );
        expect(mocks.cleanupDetachedDocument).toHaveBeenCalledWith(
            'browser://documents/old-recovery.pdf',
        );
        expect(mocks.saveRecovery.mock.invocationCallOrder[0]!)
            .toBeLessThan(mocks.cleanupDetachedDocument.mock.invocationCallOrder[0]!);
    });

    it('permanently fences the stale instance when two live contexts share an owner ID', async () => {
        let generation = 3;
        mocks.saveRecovery.mockImplementation(async (_ownerId, expectedGeneration) => {
            if (expectedGeneration !== generation) {
                return {
                    saved: false,
                    generation,
                };
            }
            generation += 1;
            return {
                saved: true,
                generation,
            };
        });
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        const options = {
            enabled: {value: true},
            tabs: {value: [{
                id: 'tab-1',
                isDirty: true,
            }]},
            activeTabId: {value: 'tab-1'},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes: vi.fn(async () => Uint8Array.of(1))},
            ]])},
        } as never;
        useBrowserWorkspaceRecovery(options);
        useBrowserWorkspaceRecovery(options);

        await vi.advanceTimersByTimeAsync(750);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(2);

        for (const listener of mocks.eventListeners.get('input') ?? []) listener();
        await vi.advanceTimersByTimeAsync(750);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(3);
    });

    it('refreshes successful tabs while retaining a failed restored tab and its lease', async () => {
        const checkpoint = makeCheckpoint();
        const current = {
            ...checkpoint,
            tabs: [...checkpoint.tabs],
        };
        current.tabs.push({
            ...current.tabs[0]!,
            tabId: requireTabId('tab-2'),
            fileName: 'failed.pdf',
            sourceRef: requireDocumentRef('browser://documents/failed-source.pdf'),
            workingCopyRef: null,
        });
        mocks.buildCheckpoint.mockReturnValue(current);
        mocks.loadRecovery.mockResolvedValue({
            ownerId: 'window:1',
            generation: 3,
            checkpoint: {
                ...current,
                tabs: current.tabs.map(tab => tab.tabId === 'tab-2'
                    ? {
                        ...tab,
                        workingCopyRef: 'browser://documents/failed-recovery.pdf',
                    }
                    : {
                        ...tab,
                        workingCopyRef: 'browser://documents/old-success.pdf',
                    }),
            },
            snapshotRefs: [
                'browser://documents/old-success.pdf',
                'browser://documents/failed-recovery.pdf',
            ],
        });
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [
                {
                    id: 'tab-1',
                    isDirty: true,
                },
                {
                    id: 'tab-2',
                    isDirty: true,
                },
            ]},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes: vi.fn(async () => Uint8Array.of(9))},
            ]])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);

        expect(mocks.saveRecovery).toHaveBeenCalledWith(
            'window:1',
            3,
            expect.objectContaining({tabs: expect.arrayContaining([
                expect.objectContaining({
                    tabId: 'tab-1',
                    workingCopyRef: 'browser://documents/new-recovery.pdf',
                    isDirty: true,
                }),
                expect.objectContaining({
                    tabId: 'tab-2',
                    workingCopyRef: 'browser://documents/failed-recovery.pdf',
                    isDirty: true,
                }),
            ])}),
            expect.arrayContaining([
                'browser://documents/new-recovery.pdf',
                'browser://documents/failed-recovery.pdf',
            ]),
        );
        expect(mocks.cleanupDetachedDocument)
            .not.toHaveBeenCalledWith('browser://documents/failed-recovery.pdf');
    });

    it('publishes recoverable tabs while retrying a dirty tab without snapshot bytes', async () => {
        const checkpoint = makeCheckpoint();
        const current = {
            ...checkpoint,
            tabs: [...checkpoint.tabs],
        };
        current.tabs.push({
            ...current.tabs[0]!,
            tabId: requireTabId('tab-2'),
            fileName: 'pending.pdf',
            workingCopyRef: requireDocumentRef('browser://documents/pending-live.pdf'),
        });
        mocks.buildCheckpoint.mockReturnValue(current);
        mocks.loadRecovery.mockResolvedValue(null);
        const {useBrowserWorkspaceRecovery} = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [
                {
                    id: 'tab-1',
                    isDirty: true,
                },
                {
                    id: 'tab-2',
                    isDirty: true,
                },
            ]},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes: vi.fn(async () => Uint8Array.of(9))},
            ]])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);

        expect(mocks.saveRecovery).toHaveBeenCalledWith(
            'window:1',
            0,
            expect.objectContaining({
                activeTabId: 'tab-1',
                panes: [expect.objectContaining({
                    activeTabId: 'tab-1',
                    tabIds: ['tab-1'],
                })],
                tabs: [expect.objectContaining({tabId: 'tab-1'})],
            }),
            ['browser://documents/new-recovery.pdf'],
        );
        expect(mocks.saveRecovery.mock.calls[0]?.[2]).not.toEqual(
            expect.objectContaining({tabs: expect.arrayContaining([expect.objectContaining({tabId: 'tab-2'})])}),
        );
    });

    it('keeps an all-failed recovery checkpoint retryable without deleting its bytes', async () => {
        const checkpoint = makeCheckpoint();
        const current = {
            ...checkpoint,
            tabs: checkpoint.tabs.map(tab => ({...tab})),
        };
        current.tabs[0]!.workingCopyRef = null;
        mocks.buildCheckpoint.mockReturnValue(current);
        mocks.loadRecovery.mockResolvedValue({
            ownerId: 'window:1',
            generation: 3,
            checkpoint: {
                ...current,
                tabs: [{
                    ...current.tabs[0]!,
                    workingCopyRef: 'browser://documents/only-recovery.pdf',
                }],
            },
            snapshotRefs: ['browser://documents/only-recovery.pdf'],
        });
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [{
                id: 'tab-1',
                isDirty: true,
            }]},
            workspaceRefs: {value: new Map()},
        } as never);

        await vi.advanceTimersByTimeAsync(750);

        expect(mocks.saveRecovery).toHaveBeenCalledWith(
            'window:1',
            3,
            expect.objectContaining({tabs: [expect.objectContaining({
                workingCopyRef: 'browser://documents/only-recovery.pdf',
                isDirty: true,
            })]}),
            ['browser://documents/only-recovery.pdf'],
        );
        expect(mocks.cleanupDetachedDocument).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_999);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(2);
    });

    it('does not reserialize an unchanged dirty tab on a periodic cadence', async () => {
        const createRecoverySnapshotBytes = vi.fn(async () => Uint8Array.of(1, 2, 3));
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [{
                id: 'tab-1',
                isDirty: true,
            }]},
            activeTabId: {value: 'tab-1'},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes},
            ]])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);
        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(9_999);
        expect(mocks.touchRecovery).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.touchRecovery).toHaveBeenCalledWith('window:1', 4);

        await vi.advanceTimersByTimeAsync(20_000);

        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(1);
        expect(mocks.saveRecovery).toHaveBeenCalledTimes(1);
    });

    it('coalesces edits during a slow capture into one follow-up without saturating the lease', async () => {
        let releaseFirstCapture!: (bytes: Uint8Array) => void;
        const firstCapture = new Promise<Uint8Array>((resolve) => {
            releaseFirstCapture = resolve;
        });
        const createRecoverySnapshotBytes = vi.fn()
            .mockReturnValueOnce(firstCapture)
            .mockResolvedValue(Uint8Array.of(8));
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [{
                id: 'tab-1',
                isDirty: true,
            }]},
            activeTabId: {value: 'tab-1'},
            workspaceRefs: {value: new Map([[
                'tab-1',
                {createRecoverySnapshotBytes},
            ]])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);
        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(1);

        for (let index = 0; index < 20; index += 1) {
            expect(mocks.eventListeners.get('input')?.[0]).toBeTypeOf('function');
            mocks.eventListeners.get('input')?.[0]?.();
        }
        await vi.advanceTimersByTimeAsync(750);
        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(1);

        releaseFirstCapture(Uint8Array.of(7));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(createRecoverySnapshotBytes).toHaveBeenCalledTimes(2);
    });

    it('refreshes only the mutated dirty tab and retains other dirty snapshots', async () => {
        const checkpoint = makeCheckpoint();
        const current = {
            ...checkpoint,
            tabs: [...checkpoint.tabs],
        };
        current.tabs.push({
            ...current.tabs[0]!,
            tabId: requireTabId('tab-2'),
            fileName: 'other.pdf',
            sourceRef: requireDocumentRef('browser://documents/other-source.pdf'),
            workingCopyRef: requireDocumentRef('browser://documents/other-live.pdf'),
        });
        mocks.buildCheckpoint.mockReturnValue(current);
        mocks.loadRecovery.mockResolvedValue({
            ownerId: 'window:1',
            generation: 3,
            checkpoint: {
                ...current,
                tabs: current.tabs.map(tab => ({
                    ...tab,
                    workingCopyRef: `browser://documents/${tab.tabId}-recovery.pdf`,
                })),
            },
            snapshotRefs: [
                'browser://documents/tab-1-recovery.pdf',
                'browser://documents/tab-2-recovery.pdf',
            ],
        });
        const tabOneSnapshot = vi.fn(async () => Uint8Array.of(1));
        const tabTwoSnapshot = vi.fn(async () => Uint8Array.of(2));
        const { useBrowserWorkspaceRecovery } = await import(
            '@app/modules/workspace-shell/checkpoint/useBrowserWorkspaceRecovery'
        );
        useBrowserWorkspaceRecovery({
            enabled: {value: true},
            tabs: {value: [
                {
                    id: 'tab-1',
                    isDirty: true,
                },
                {
                    id: 'tab-2',
                    isDirty: true,
                },
            ]},
            activeTabId: {value: 'tab-1'},
            workspaceRefs: {value: new Map([
                [
                    'tab-1',
                    {createRecoverySnapshotBytes: tabOneSnapshot},
                ],
                [
                    'tab-2',
                    {createRecoverySnapshotBytes: tabTwoSnapshot},
                ],
            ])},
        } as never);

        await vi.advanceTimersByTimeAsync(750);
        expect(tabOneSnapshot).toHaveBeenCalledTimes(1);
        expect(tabTwoSnapshot).toHaveBeenCalledTimes(1);

        expect(mocks.eventListeners.get('input')?.[0]).toBeTypeOf('function');
        mocks.eventListeners.get('input')?.[0]?.();
        await vi.advanceTimersByTimeAsync(750);

        expect(tabOneSnapshot).toHaveBeenCalledTimes(2);
        expect(tabTwoSnapshot).toHaveBeenCalledTimes(1);
        expect(mocks.saveRecovery).toHaveBeenLastCalledWith(
            'window:1',
            4,
            expect.anything(),
            expect.arrayContaining(['browser://documents/tab-2-recovery.pdf']),
        );
    });
});
