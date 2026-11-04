// @vitest-environment happy-dom
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createApp,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import { requirePaneId } from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import {usePdfViewerSaveTransaction} from '@app/modules/pdf-viewer/runtime/save/usePdfViewerSaveTransaction';
import {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {requirePageIndex} from '@contracts/pageNumbers';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';
import type {TOpenFileResult} from '@contracts/electronApiDocuments';
import type {TDocumentOpenOutcome} from '@app/types/documentOpenOutcome';
import {useWorkspaceSplitPayload} from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { requireTabId } from '@contracts/windowTabs';
import type { IWindowTabIncomingTransfer } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import { collectLayoutPaneOrder } from '@app/modules/workspace-shell/window-tabs/collectLayoutPaneOrder';
import { collectMergeTabOrder } from '@app/modules/workspace-shell/window-tabs/collectMergeTabOrder';
import { shouldCloseSourceWindowAfterTransfer } from '@app/modules/workspace-shell/window-tabs/shouldCloseSourceWindowAfterTransfer';
import { useWindowTabTransfers } from '@app/modules/workspace-shell/composables/useWindowTabTransfers';
import { useWorkspaceRestoreTracker } from '@app/modules/workspace-shell/composables/useWorkspaceRestoreTracker';
import { useAppShellToolPages } from '@app/modules/workspace-shell/composables/useAppShellToolPages';
import {
    createWorkspaceDocumentController,
    snapshotOccupiesTab,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TWorkspaceDocumentSessions } from '@app/modules/workspace-shell/document-sessions/useWorkspaceDocumentSessions';
import { createDocumentContext } from '@app/modules/workspace-shell/documentContext';
import type { IDocumentViewPort } from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type * as PlatformDocuments from '@app/utils/platformDocuments';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import { cast } from '@tests/helpers/cast';
import {createPdfReloadWaiter} from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import * as pageOpsHandlers from '@app/modules/workspace-shell/composables/usePageOpsHandlers';
import {useWorkspaceViewerShellState} from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';

const transferAckMock = vi.hoisted(() => vi.fn(async (_ack: {
    transferId: string;
    success: boolean;
    error?: string
}) => true));
const transferMock = vi.hoisted(() => vi.fn(async (_request: {payload: unknown}) => ({
    success: true,
    transferId: 'transfer-source',
    targetWindowId: 7,
})));
const closeTransferredWindowMock = vi.hoisted(() => vi.fn(async () => true));
// A clean document's split capture clones its working copy; the clone is the
// only platform call a merge capture makes.
const createWorkingCopyFromPathMock = vi.hoisted(() => vi.fn(async (path: string) => `${path}.snapshot.pdf`));
// Where the clone fails, the capture stages the view's bytes instead.
const createWorkingCopyFromDataMock = vi.hoisted(() => vi.fn(async (_fileName: string, _data: Uint8Array) => 'browser://documents/staged.pdf'));
vi.mock('@app/utils/platformDocuments', async importOriginal => ({
    ...await importOriginal<typeof PlatformDocuments>(),
    getDocumentWorkingCopyCapability: () => ({
        createWorkingCopyFromPath: createWorkingCopyFromPathMock,
        createWorkingCopyFromData: createWorkingCopyFromDataMock,
    }),
}));
vi.mock('@app/utils/platformWindowTabs', () => ({
    canUseNativeWindowTabTransfers: () => true,
    getWindowTabsCapability: () => ({
        transferAck: transferAckMock,
        transfer: transferMock,
        closeCurrentWindow: closeTransferredWindowMock,
    }),
}));

function createTab(id: string): ITab {
    return {id};
}

describe('window tab transfer orchestration helpers', () => {
    it.each([
        'left',
        'right',
    ])('invalidates thumbnail state in every linked view when %s is active', async activeTab => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useToast', () => ({
            add: vi.fn(),
            remove: vi.fn(),
            update: vi.fn(),
        }));
        const nuxtState = new Map<string, unknown>();
        vi.stubGlobal('useState', (key: string, initialValue?: () => unknown) => {
            if (!nuxtState.has(key)) {
                nuxtState.set(key, shallowRef(initialValue?.()));
            }
            return nuxtState.get(key);
        });
        vi.stubGlobal('useCookie', (_key: string, options?: {default?: () => unknown}) => shallowRef(options?.default?.() ?? null));
        vi.stubGlobal('useRuntimeConfig', () => ({public: {
            analyticsEnabled: false,
            landingUrl: '',
            siteUrl: '',
        }}));
        vi.stubGlobal('useRoute', () => ({path: '/'}));
        onTestFinished(() => {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        });

        // Exercise the document's page-operation boundary and observe the real
        // per-view state consumed by thumbnail rails, without mocking the views.
        let invalidate!: pageOpsHandlers.IPageOpsHandlersDeps['invalidateThumbnailPages'];
        const createPageOpsHandlers = pageOpsHandlers.usePageOpsHandlers;
        vi.spyOn(pageOpsHandlers, 'usePageOpsHandlers').mockImplementation(deps => {
            invalidate = deps.invalidateThumbnailPages;
            return createPageOpsHandlers(deps);
        });
        const controller = createWorkspaceDocumentController({tabId: 'left'});
        controller.addView('right');
        let context!: ReturnType<typeof createDocumentContext>;
        const states: Array<ReturnType<typeof useWorkspaceViewerShellState>> = [];
        let detachPeer!: () => void;
        const app = createApp({setup() {
            context = createDocumentContext({controller});
            for (const tabId of [
                'left',
                'right',
            ]) {
                const view = useWorkspaceViewerShellState();
                view.totalPages.value = 5;
                view.setSelectedThumbnailPages([tabId === 'left' ? 1 : 5]);
                states.push(view);
                const detach = context.views.attachView(cast<IDocumentViewPort>({
                    tabId,
                    isActive: ref(tabId === activeTab),
                    openSurface: createDocumentOpenSurfaceSession(),
                    view,
                    search: {
                        resetSearchCache: vi.fn(),
                        closeSearch: vi.fn(),
                    },
                    navigation: {
                        canUndo: ref(false),
                        canRedo: ref(false),
                    },
                    pageContextMenu: {closePageContextMenu: vi.fn()},
                    closeAnnotationContextMenu: vi.fn(),
                    annotationTool: ref('none'),
                }));
                if (tabId !== activeTab) detachPeer = detach;
            }
            return () => null;
        }});
        const host = document.createElement('div');
        document.body.append(host);
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        await nextTick();

        for (const rotationOnly of [
            false,
            true,
        ]) {
            invalidate([
                2,
                4,
            ], 'revision-after-crop', {rotationOnly});
            for (const view of states) {
                expect(view.thumbnailInvalidationRequest.value).toEqual({
                    id: rotationOnly ? 2 : 1,
                    pages: [
                        2,
                        4,
                    ],
                    expectedDocumentRevision: 'revision-after-crop',
                    ...(rotationOnly ? {rotationOnly: true} : {}),
                });
            }
        }
        expect(states.map(view => view.selectedThumbnailPages.value)).toEqual([
            [1],
            [5],
        ]);
        detachPeer();
        invalidate([3]);
        expect(states.find((_view, index) => [
            'left',
            'right',
        ][index] === activeTab)?.thumbnailInvalidationRequest.value)
            .toEqual({
                id: 3,
                pages: [3],
            });
        expect(states.find((_view, index) => [
            'left',
            'right',
        ][index] !== activeTab)?.thumbnailInvalidationRequest.value?.id)
            .toBe(2);
    });

    it('collects pane order by stable layout traversal', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.6,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-left'),
            },
            second: {
                type: 'split',
                id: 'nested',
                orientation: 'vertical',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-top-right'),
                },
                second: {
                    type: 'leaf',
                    paneId: requirePaneId('pane-bottom-right'),
                },
            },
        };

        expect(collectLayoutPaneOrder(layout)).toEqual([
            'pane-left',
            'pane-top-right',
            'pane-bottom-right',
        ]);
    });

    it('collects merge tab order by layout order and tab order inside each pane', () => {
        const layout: TEditorLayoutNode = {
            type: 'split',
            id: 'root',
            orientation: 'horizontal',
            ratio: 0.5,
            first: {
                type: 'leaf',
                paneId: requirePaneId('pane-a'),
            },
            second: {
                type: 'leaf',
                paneId: requirePaneId('pane-b'),
            },
        };

        const panes: IEditorPaneState[] = [
            {
                paneId: requirePaneId('pane-a'),
                tabIds: [
                    requireTabId('tab-1'),
                    requireTabId('tab-2'),
                ],
                activeTabId: requireTabId('tab-1'),
            },
            {
                paneId: requirePaneId('pane-b'),
                tabIds: [requireTabId('tab-3')],
                activeTabId: requireTabId('tab-3'),
            },
        ];

        const tabs: ITab[] = [
            createTab('tab-1'),
            createTab('tab-2'),
            createTab('tab-3'),
            createTab('tab-detached'),
        ];

        expect(collectMergeTabOrder(layout, panes, tabs)).toEqual([
            'tab-1',
            'tab-2',
            'tab-3',
            'tab-detached',
        ]);
    });

    it('requires electron bridge and empty-source state before closing source window', () => {
        expect(shouldCloseSourceWindowAfterTransfer(1, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(0, true)).toBe(true);
        expect(shouldCloseSourceWindowAfterTransfer(2, true)).toBe(false);
        expect(shouldCloseSourceWindowAfterTransfer(1, false)).toBe(false);
    });

    it('keeps Settings on a surviving tab when it opens during source transfer finalization', async () => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useState', () => ref({}));
        onTestFinished(() => {vi.unstubAllGlobals();});
        const source = createWorkspaceDocumentController({tabId: 'source'});
        const survivor = createWorkspaceDocumentController({tabId: 'survivor'});
        const path = requireDocumentRef('/docs/source.djvu');
        source.commitDocument({
            fileName: 'source.djvu',
            originalPath: path,
            isDjvu: true,
            revisionInfo: null,
        });
        source.claimOpen({
            kind: 'restore',
            target: {
                fileName: 'source.djvu',
                originalPath: path,
                isDjvu: true,
            },
        });
        // The source's first paint may arrive after the destination's ACK.
        // Both show the same document; the source must still be removed.
        transferMock.mockImplementationOnce(async () => {
            source.markPresented();
            return {
                success: true,
                transferId: 'transfer-source',
                targetWindowId: 7,
            };
        });
        source.attachWorkspace('source', createWorkspaceExposeFixture({
            waitForDocumentOpenSettled: async () => {source.markPresented();},
            captureSplitPayload: async () => ({
                kind: 'djvu',
                sourcePath: path,
            }),
            handleCloseFileFromUi: async options => {
                await options?.onCloseCommit?.();
                return true;
            },
        }));
        const tabs = ref<ITab[]>([
            {id: 'source'},
            {id: 'survivor'},
        ]);
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'source',
            tabIds: [
                'source',
                'survivor',
            ],
        };
        const activeTabId = ref('source');
        const activePaneId = ref<string | null>(pane.paneId);
        const tracker = useWorkspaceRestoreTracker();
        const sessions = new Map([
            [
                'source',
                source,
            ],
            [
                'survivor',
                survivor,
            ],
        ]);
        const sections = new Map<string, string>();
        const handoffStarted = Promise.withResolvers<undefined>();
        const finishHandoff = Promise.withResolvers<undefined>();
        const settings = useAppShellToolPages({
            activePaneId,
            activeToolPage: ref(null),
            activateTabById: id => {activeTabId.value = id;},
            createTab: () => {throw new Error('The surviving empty tab should receive Settings');},
            findEmptyTab: () => tabs.value.find(tab => !tracker.has(tab.id)
                && !snapshotOccupiesTab(sessions.get(tab.id)!.snapshot.value)) ?? null,
            openResultInAppropriateTab: async () => undefined,
            setTabStartSection: (id, section) => {sections.set(id, section);},
        });
        const transfers = useWindowTabTransfers({
            activePaneId,
            panes: ref([pane]),
            tabs,
            layout: ref(null),
            createTab: () => {throw new Error('No incoming tab');},
            getPaneById: () => pane,
            getTabById: id => tabs.value.find(tab => tab.id === id) ?? null,
            getPaneByTabId: () => pane,
            activatePane: () => undefined,
            activateTab: (_pane, id) => {activeTabId.value = id;},
            removeTabFromState: () => undefined,
            cleanupEmptyPanes: () => undefined,
            closeTabInState: (_pane, id) => {
                tabs.value = tabs.value.filter(tab => tab.id !== id);
                sections.delete(id);
            },
            documentSessions: cast({getSession: (id: string) => sessions.get(id) ?? null}),
            workspaceRestoreTracker: tracker,
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => {
                handoffStarted.resolve(undefined);
                await finishHandoff.promise;
            },
        });

        const moving = transfers.moveTabToNewWindow('source');
        await Promise.race([
            handoffStarted.promise,
            moving,
        ]);
        settings.openSettingsPage();
        finishHandoff.resolve(undefined);
        await moving;

        expect(tabs.value.map(tab => tab.id)).toEqual(['survivor']);
        expect(sections.get(activeTabId.value)).toBe('settings');
        expect(tracker.has('source')).toBe(false);
    });

    it.each([
        'waits for its source to open',
        'completes its accepted text',
    ] as const)('writes no notes once a move times out while it %s', async (stage) => {
        vi.useFakeTimers();
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        onTestFinished(() => {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        });
        const failures: string[] = [];
        const source = createWorkspaceDocumentController({
            tabId: 'source',
            reportFailure: failure => failures.push(failure.message),
        });
        const path = requireDocumentRef('/docs/source.pdf');
        source.commitDocument({
            fileName: 'source.pdf',
            originalPath: path,
            isDjvu: false,
            revisionInfo: null,
        });
        if (stage === 'waits for its source to open') {
            source.claimOpen({
                kind: 'restore',
                target: {
                    fileName: 'source.pdf',
                    originalPath: path,
                    isDjvu: false,
                },
            });
        }
        const held = Promise.withResolvers<undefined>();
        // Preparing a move completes accepted text, then writes the document's
        // notes, which makes it dirty.
        source.bindMutationFrontier(() => 'frontier', async (assertCurrent) => {
            if (stage === 'completes its accepted text') {
                await held.promise.then(assertCurrent);
            }
            source.setDirty(true);
        }, async () => {});
        source.attachWorkspace('source', createWorkspaceExposeFixture({waitForDocumentOpenSettled: () => held.promise}));
        const pane = {
            paneId: 'pane-1',
            activeTabId: 'source',
            tabIds: ['source'],
        };
        const tabs = ref<ITab[]>([{id: 'source'}]);
        const transfers = useWindowTabTransfers({
            activePaneId: ref<string | null>(pane.paneId),
            panes: ref([pane]),
            tabs,
            layout: ref(null),
            createTab: () => {throw new Error('No incoming tab');},
            getPaneById: () => pane,
            getTabById: id => tabs.value.find(tab => tab.id === id) ?? null,
            getPaneByTabId: () => pane,
            activatePane: () => undefined,
            activateTab: () => undefined,
            removeTabFromState: () => undefined,
            cleanupEmptyPanes: () => undefined,
            closeTabInState: () => undefined,
            documentSessions: cast({getSession: (id: string) => (id === 'source' ? source : null)}),
            workspaceRestoreTracker: {
                start: () => undefined,
                finish: () => undefined,
            },
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => undefined,
        });

        const moving = transfers.moveTabToNewWindow('source');
        await vi.advanceTimersByTimeAsync(4_000);
        await moving;
        expect(failures).toEqual(['tabs.transferErrors.rolledBack']);
        expect(source.operationLease.isBusy.value).toBe(false);

        held.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(source.snapshot.value.dirty).toBe(false);
    });

    it('rejects each failed target without making another transfer wait for its mount', async () => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        transferAckMock.mockClear();
        const pane = {
            paneId: requirePaneId('pane-target'),
            activeTabId: null as string | null,
            tabIds: [] as string[],
        };
        const panes = ref([pane]);
        const tabs = ref<ITab[]>([]);
        const activePaneId = ref<string | null>(pane.paneId);
        const sessions = new Map<string, IWorkspaceDocumentController>();
        const mountWaiterStarted = Promise.withResolvers<undefined>();
        let createdTabs = 0;
        const transfers = useWindowTabTransfers({
            activePaneId,
            panes,
            tabs,
            layout: ref<TEditorLayoutNode | null>({
                type: 'leaf',
                paneId: pane.paneId,
            }),
            createTab: () => {
                createdTabs += 1;
                const tab = {id: `incoming-${createdTabs}`};
                tabs.value = [
                    ...tabs.value,
                    tab,
                ];
                pane.tabIds.push(tab.id);
                pane.activeTabId = tab.id;
                const session = createWorkspaceDocumentController({tabId: tab.id});
                sessions.set(tab.id, session);
                if (createdTabs === 1) {
                    const view = session.getView(tab.id)!;
                    const whenMounted = view.whenMounted.bind(view);
                    view.whenMounted = () => {
                        const pending = whenMounted();
                        mountWaiterStarted.resolve(undefined);
                        return pending;
                    };
                } else {
                    session.attachWorkspace(tab.id, createWorkspaceExposeFixture({restoreSplitPayload: async () => ({status: 'cancelled'})}));
                }
                return tab;
            },
            getPaneById: paneId => panes.value.find(candidate => candidate.paneId === paneId) ?? null,
            getTabById: tabId => tabs.value.find(tab => tab.id === tabId) ?? null,
            getPaneByTabId: tabId => panes.value.find(candidate => candidate.tabIds.includes(tabId)) ?? null,
            activatePane: paneId => {
                activePaneId.value = paneId;
            },
            activateTab: (paneId, tabId) => {
                const targetPane = panes.value.find(candidate => candidate.paneId === paneId);
                if (targetPane) targetPane.activeTabId = tabId;
            },
            removeTabFromState: tabId => {
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
                pane.tabIds = pane.tabIds.filter(id => id !== tabId);
                pane.activeTabId = pane.tabIds[0] ?? null;
            },
            cleanupEmptyPanes: () => undefined,
            closeTabInState: () => undefined,
            documentSessions: cast<TWorkspaceDocumentSessions>({getSession: (tabId: string | null | undefined) => tabId ? sessions.get(tabId) ?? null : null}),
            workspaceRestoreTracker: {
                start: () => undefined,
                finish: () => undefined,
            },
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => undefined,
        });

        const sourcePath = requireDocumentRef('/source/transfer.djvu');
        const makeTransfer = (transferId: string): IWindowTabIncomingTransfer => ({
            transferId,
            sourceWindowId: 2,
            targetWindowId: 1,
            tab: {
                fileName: 'transfer.djvu',
                originalPath: sourcePath,
                isDirty: false,
                isDjvu: true,
            },
            payload: {
                kind: 'djvu',
                sourcePath,
            },
        });
        const firstTransfer = transfers.handleIncomingTabTransfer(makeTransfer('transfer-failed-mount'));
        await mountWaiterStarted.promise;
        const secondTransfer = transfers.handleIncomingTabTransfer(makeTransfer('transfer-next'));
        await secondTransfer;
        expect(transferAckMock.mock.calls.map(([ack]) => ack.transferId)).toEqual(['transfer-next']);
        expect(tabs.value.map(tab => tab.id)).toEqual(['incoming-1']);
        sessions.get('incoming-1')?.markFailed({
            message: 'Workspace chunk failed',
            failure: null,
        });

        await Promise.all([
            firstTransfer,
            secondTransfer,
        ]);

        expect(transferAckMock).toHaveBeenCalledTimes(2);
        expect(transferAckMock.mock.calls.map(([ack]) => [
            ack.transferId,
            ack.success,
        ])).toEqual([
            [
                'transfer-next',
                false,
            ],
            [
                'transfer-failed-mount',
                false,
            ],
        ]);
        expect(createdTabs).toBe(2);
    });

    it.each([
        'another document',
        'the same file reopened',
        'a new revision',
        'no replacement',
        'another document before presentation',
        'the same file reopened before presentation',
    ])(
        'keeps view restoration and acknowledgement on the opened document with %s', async (replacement) => {
            vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
            onTestFinished(() => {vi.unstubAllGlobals();});
            transferAckMock.mockClear();
            const pane = {
                paneId: 'pane-1',
                tabIds: ['tab-1'],
                activeTabId: 'tab-1',
            };
            const controller = createWorkspaceDocumentController({tabId: 'tab-1'});
            const a = requireDocumentRef('/docs/a.pdf');
            const beforePresentation = replacement.endsWith('before presentation');
            const b = replacement.startsWith('the same file reopened') ? a : requireDocumentRef('/docs/b.pdf');
            const originalPath = ref(a);
            const zoom = ref(0.8);
            const aPresented = Promise.withResolvers<undefined>();
            const page = ref(1);
            const viewer = ref({scrollToPage: (value: number) => {page.value = value;}});
            const surface = shallowRef(cast({
                generation: 0,
                identity: null,
                phase: 'idle',
                presentation: 'pending',
            }));
            const viewport = shallowRef(cast({lifecycle: 'empty'}));
            let reload: Promise<void> | null = null;
            const preparePdfReloadWaiter = (pageToRestore: number) => {
                const waiter = createPdfReloadWaiter({
                    pdfDocument: shallowRef(null),
                    pdfViewerRef: viewer,
                    openSurface: cast({
                        snapshot: surface,
                        viewportSession: viewport,
                    }),
                    resetSearchCache: () => undefined,
                    pageToRestore,
                });
                reload = waiter.promise;
                return waiter;
            };
            const document = {
                fileName: 'a.pdf',
                originalPath: a,
                isDjvu: false,
                revisionInfo: {
                    version: 1 as const,
                    documentRef: a,
                    authority: 'electron-working-copy' as const,
                    token: requireDocumentRevisionToken('revision-1'),
                    contentRevision: 1,
                    mintedAt: requireEpochMs(1),
                },
            };
            const split = useWorkspaceSplitPayload(cast({
                originalPath,
                totalPages: ref(12),
                currentPage: page,
                preparePdfReloadWaiter,
                openFileWithViewerLifecycle: async (_result: TOpenFileResult, transactionId?: string) => {
                    const opened = await controller.runOpen({
                        kind: 'open',
                        target: {originalPath: a},
                        transactionId,
                    }, async () => {
                        if (beforePresentation) {
                            aPresented.resolve(undefined);
                        } else {
                            surface.value = cast({
                                generation: 1,
                                identity: {
                                    documentId: a,
                                    documentRevision: 'a-ready',
                                },
                                phase: 'canvas-committed',
                                presentation: 'committed',
                            });
                            controller.commitDocument(document);
                            controller.markPresented();
                        }
                        return true;
                    });
                    aPresented.resolve(undefined);
                    return {status: opened ? 'opened' : 'cancelled'};
                },
            }));
            let outcome: TDocumentOpenOutcome | null = null;
            controller.attachWorkspace('tab-1', createWorkspaceExposeFixture({
                restoreViewState: state => {zoom.value = state.zoom ?? zoom.value;},
                restoreSplitPayload: async (...args) => {
                    outcome = await split.restoreSplitPayload(...args);
                    return outcome;
                },
            }));
            const transfers = useWindowTabTransfers({
                activePaneId: ref('pane-1'),
                panes: ref([pane]),
                tabs: ref([{id: 'tab-1'}]),
                layout: ref(null),
                createTab: () => {throw new Error('The incoming transfer must use the empty tab');},
                getPaneById: () => pane,
                getTabById: () => ({id: 'tab-1'}),
                getPaneByTabId: () => pane,
                activatePane: () => undefined,
                activateTab: () => undefined,
                removeTabFromState: () => undefined,
                cleanupEmptyPanes: () => undefined,
                closeTabInState: () => undefined,
                documentSessions: cast({getSession: () => controller}),
                workspaceRestoreTracker: {
                    start: () => undefined,
                    finish: () => undefined,
                },
                handleCloseTab: async () => undefined,
                handoffActiveTabBeforeClose: async () => undefined,
            });
            const incoming = transfers.handleIncomingTabTransfer(cast({
                transferId: 'transfer-a',
                sourceWindowId: 2,
                targetWindowId: 1,
                tab: {
                    fileName: 'a.pdf',
                    originalPath: a,
                    isDirty: true,
                    isDjvu: false,
                },
                payload: {
                    kind: 'pdfSnapshot',
                    snapshotPath: a,
                    originalPath: a,
                    isDirty: true,
                    currentPage: 6,
                    viewState: {
                        zoom: 2,
                        zoomMode: 'custom',
                        viewMode: 'single',
                        viewRotation: 0,
                        showSidebar: false,
                        continuousScroll: true,
                    },
                },
            }));
            // B can claim its open before A's open wrapper has even returned,
            // or replace its revision while A is waiting for page placement.
            await aPresented.promise;
            if (replacement === 'a new revision') {
                controller.commitDocument({
                    ...document,
                    revisionInfo: {
                        ...document.revisionInfo,
                        token: requireDocumentRevisionToken('revision-2'),
                        contentRevision: 2,
                    },
                });
            } else if (replacement !== 'no replacement') {
                await controller.runOpen({
                    kind: 'open',
                    target: {originalPath: b},
                }, async () => {
                    originalPath.value = b;
                    controller.commitDocument({
                        ...document,
                        originalPath: b,
                        revisionInfo: null,
                    });
                    controller.markPresented();
                    return true;
                });
            }
            if (beforePresentation) await incoming;
            surface.value = cast({
                generation: replacement === 'no replacement' ? 1 : 2,
                identity: {
                    documentId: originalPath.value,
                    documentRevision: replacement === 'no replacement' ? 'a-ready' : 'b-ready',
                },
                phase: 'ready',
                presentation: 'committed',
                committedViewport: {pageNumber: 1},
            });
            viewport.value = cast({lifecycle: 'ready'});
            await incoming;
            await reload;
            expect(page.value).toBe(replacement === 'no replacement' ? 6 : 1);
            const superseded = replacement !== 'no replacement';
            expect(zoom.value).toBe(superseded ? 0.8 : 2);
            expect(outcome).toMatchObject({status: superseded ? 'cancelled' : 'opened'});
            expect(controller.snapshot.value.identity.originalPath).toBe(
                replacement.startsWith('another document') ? b : a,
            );
            expect(originalPath.value).toBe(replacement.startsWith('another document') ? b : a);
            expect(transferAckMock.mock.calls.map(([ack]) => ({
                transferId: ack.transferId,
                success: ack.success,
            })))
                .toEqual([{
                    transferId: 'transfer-a',
                    success: !superseded,
                }]);
        },
    );

    it.each([
        'browser://documents/work.pdf',
        '/tmp/work.pdf',
    ])('refuses to move a dirty view whose edits could not be staged (%s)', async (path) => {
        const application = new AnnotationApplication('split-refusal');
        application.store.replaceFromDocument([], []);
        application.store.createNote(cast({
            kind: 'note',
            identity: {id: asAnnotationId('unsaved-note')},
            pageIndex: requirePageIndex(0),
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: null,
            modifiedAt: null,
            author: null,
            contents: 'Accepted unsaved note',
            color: '#ffff00',
            open: false,
            position: {
                left: 0.1,
                top: 0.1,
                width: 0.03,
                height: 0.03,
            },
        }));
        const transaction = usePdfViewerSaveTransaction({annotationApplication: shallowRef(application)});
        const original = new TextEncoder().encode('%PDF-original-without-the-note');
        const split = useWorkspaceSplitPayload(cast({
            pdfSrc: shallowRef(new Blob([original])),
            pdfData: shallowRef(original),
            workingCopyPath: ref(requireDocumentRef(path)),
            originalPath: ref(requireDocumentRef('/source.pdf')),
            documentRevisionToken: ref('revision-1'),
            hasPendingTabChanges: ref(true),
            requiresSaveAsOnFirstSave: ref(false),
            isDjvuMode: ref(false),
            djvuSourcePath: ref(null),
            currentPage: ref(1),
            totalPages: ref(1),
            fileName: ref('source.pdf'),
            pdfViewerRef: shallowRef({runSaveTransaction: transaction.runSaveTransaction}),
            documentViewerRef: ref(null),
            // No native writer: the transaction refuses to materialize the note.
            getNativeSaveTransactionOptions: () => ({
                nativeCapabilities: {
                    hasNativePdfMutationCapability: false,
                    canPersistNativeMetadataMutations: false,
                },
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    shapeStateDirty: false,
                },
                documentStructure: {
                    pageLabelsDirty: false,
                    pageLabelRanges: [],
                    bookmarksDirty: false,
                    bookmarkItems: [],
                    untitledBookmarkLabel: 'Untitled',
                    totalPages: 1,
                },
            }),
        }));

        await expect(split.captureSplitPayload()).rejects.toMatchObject({name: 'NativePdfSaveRequiredError'});
        expect(application.store.hasChangesSinceSavedBaseline()).toBe(true);
    });

    it.each([
        'clean view without a native writer',
        'dirty view without a mounted viewer',
    ] as const)('moves the bytes of a %s only when it has no edits', async (scenario) => {
        const dirty = scenario === 'dirty view without a mounted viewer';
        const application = new AnnotationApplication('split-clean');
        application.store.replaceFromDocument([], []);
        const transaction = usePdfViewerSaveTransaction({annotationApplication: shallowRef(application)});
        const original = new TextEncoder().encode('%PDF-original');
        // A clean view's working copy cannot be cloned, so only its bytes remain.
        if (!dirty) createWorkingCopyFromPathMock.mockRejectedValueOnce(new Error('clone failed'));
        createWorkingCopyFromDataMock.mockClear();
        const split = useWorkspaceSplitPayload(cast({
            pdfSrc: shallowRef(new Blob([original])),
            pdfData: shallowRef(original),
            workingCopyPath: ref(requireDocumentRef('browser://documents/work.pdf')),
            originalPath: ref(requireDocumentRef('/source.pdf')),
            documentRevisionToken: ref('revision-1'),
            hasPendingTabChanges: ref(dirty),
            requiresSaveAsOnFirstSave: ref(false),
            isDjvuMode: ref(false),
            djvuSourcePath: ref(null),
            currentPage: ref(1),
            totalPages: ref(1),
            fileName: ref('source.pdf'),
            pdfViewerRef: shallowRef(dirty ? null : {runSaveTransaction: transaction.runSaveTransaction}),
            documentViewerRef: ref(null),
            getNativeSaveTransactionOptions: () => ({
                nativeCapabilities: {
                    hasNativePdfMutationCapability: false,
                    canPersistNativeMetadataMutations: false,
                },
                dirtyState: {
                    annotationDirty: false,
                    hasAnnotationChanges: false,
                    shapeStateDirty: false,
                },
                documentStructure: {
                    pageLabelsDirty: false,
                    pageLabelRanges: [],
                    bookmarksDirty: false,
                    bookmarkItems: [],
                    untitledBookmarkLabel: 'Untitled',
                    totalPages: 1,
                },
            }),
        }));

        if (dirty) {
            // Nothing can stand for its edits: the old bytes do not move.
            await expect(split.captureSplitPayload()).rejects.toMatchObject({name: 'NativePdfSaveRequiredError'});
            expect(createWorkingCopyFromDataMock).not.toHaveBeenCalled();
            return;
        }
        await expect(split.captureSplitPayload()).resolves.toMatchObject({
            kind: 'pdfSnapshot',
            isDirty: false,
        });
        expect(createWorkingCopyFromDataMock.mock.lastCall?.[1]).toEqual(original);
    });

    // Sweep #845 item 9: Merge This Window Into captures every tab without
    // activating it. Two linked views of one document each go at their own page.
    it('merges two linked views of one document at each view page', async () => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        vi.stubGlobal('useToast', () => ({
            add: vi.fn(),
            remove: vi.fn(),
            update: vi.fn(),
        }));
        const nuxtState = new Map<string, unknown>();
        vi.stubGlobal('useState', (key: string, initialValue?: () => unknown) => {
            if (!nuxtState.has(key)) {
                nuxtState.set(key, shallowRef(initialValue?.()));
            }
            return nuxtState.get(key);
        });
        vi.stubGlobal('useCookie', (_key: string, options?: {default?: () => unknown}) => shallowRef(options?.default?.() ?? null));
        // The earlier case's unstubAllGlobals also removed tests/setupApp.ts's stubs.
        vi.stubGlobal('useRuntimeConfig', () => ({public: {
            analyticsEnabled: false,
            landingUrl: '',
            siteUrl: '',
        }}));
        vi.stubGlobal('useRoute', () => ({path: '/'}));
        onTestFinished(() => {
            vi.unstubAllGlobals();
        });
        transferMock.mockClear();
        const leftTab = 'tab-linked-left';
        const rightTab = 'tab-linked-right';
        const controller = createWorkspaceDocumentController({tabId: leftTab});
        controller.addView(rightTab);
        // The document context runs where DocumentSessionHost creates it: in a
        // component's setup.
        let document!: ReturnType<typeof createDocumentContext>;
        const app = createApp({setup() {
            document = createDocumentContext({controller});
            return () => null;
        }});
        const host = globalThis.document.createElement('div');
        globalThis.document.body.append(host);
        app.mount(host);
        onTestFinished(() => {
            app.unmount();
            host.remove();
        });
        document.file.workingCopyPath.value = requireDocumentRef('/docs/linked.pdf');
        document.file.pdfSrc.value = new Blob(['%PDF-1.7'], {type: 'application/pdf'});
        await nextTick();

        const pages = new Map<string, ReturnType<typeof ref<number>>>();
        const attach = (tabId: string, active: boolean) => document.views.attachView(cast<IDocumentViewPort>({
            tabId,
            isActive: ref(active),
            openSurface: createDocumentOpenSurfaceSession(),
            view: {
                pdfViewerRef: ref(null),
                documentViewerRef: ref(null),
                pdfDocument: ref(null),
                totalPages: ref(12),
                currentPage: pages.set(tabId, ref(1)).get(tabId),
                dragMode: ref(false),
                showSidebar: ref(false),
                sidebarTab: ref('thumbnails'),
                selectedThumbnailPages: ref([]),
                setSelectedThumbnailPages: vi.fn(),
                selectedPageSelection: ref(null),
                setSelectedPageSelection: vi.fn(),
                requestThumbnailInvalidation: vi.fn(),
                closeAllDropdowns: vi.fn(),
                openDropdown: vi.fn(),
            },
            search: {
                resetSearchCache: vi.fn(),
                closeSearch: vi.fn(),
            },
            navigation: {
                canUndo: ref(false),
                canRedo: ref(false),
            },
            pageContextMenu: {closePageContextMenu: vi.fn()},
            closeAnnotationContextMenu: vi.fn(),
            annotationTool: ref('none'),
        }));
        attach(leftTab, false);
        attach(rightTab, true);
        await nextTick();
        // The left view reads page 2; the right view, in use, reads page 4.
        pages.get(leftTab)!.value = 2;
        pages.get(rightTab)!.value = 4;
        await nextTick();
        expect([
            pages.get(leftTab)!.value,
            pages.get(rightTab)!.value,
        ]).toEqual([
            2,
            4,
        ]);
        for (const tabId of [
            leftTab,
            rightTab,
        ]) {
            // Each view's DocumentWorkspace captures the document at its own page.
            controller.attachWorkspace(tabId, createWorkspaceExposeFixture({
                // These loaded views need no open, even if their pixels have
                // been evicted. An inactive view cannot repaint for a merge.
                waitForDocumentOpenSettled: () => Promise.withResolvers<undefined>().promise,
                captureSplitPayload: (_page, ownership) => document.splitPayload.captureSplitPayload(pages.get(tabId)!.value, ownership),
            }));
        }

        const leftPane = {
            paneId: requirePaneId('pane-left'),
            activeTabId: leftTab as string | null,
            tabIds: [leftTab],
        };
        const rightPane = {
            paneId: requirePaneId('pane-right'),
            activeTabId: rightTab as string | null,
            tabIds: [rightTab],
        };
        const panes = ref([
            leftPane,
            rightPane,
        ]);
        const tabs = ref<ITab[]>([
            createTab(leftTab),
            createTab(rightTab),
        ]);
        const transfers = useWindowTabTransfers({
            activePaneId: ref<string | null>(rightPane.paneId),
            panes,
            tabs,
            layout: ref<TEditorLayoutNode | null>({
                type: 'split',
                id: 'split-linked',
                orientation: 'horizontal',
                ratio: 0.5,
                first: {
                    type: 'leaf',
                    paneId: leftPane.paneId,
                },
                second: {
                    type: 'leaf',
                    paneId: rightPane.paneId,
                },
            }),
            createTab: () => createTab('unused'),
            getPaneById: paneId => panes.value.find(candidate => candidate.paneId === paneId) ?? null,
            getTabById: tabId => tabs.value.find(tab => tab.id === tabId) ?? null,
            getPaneByTabId: tabId => panes.value.find(candidate => candidate.tabIds.includes(tabId)) ?? null,
            activatePane: () => undefined,
            activateTab: () => undefined,
            removeTabFromState: () => undefined,
            cleanupEmptyPanes: () => undefined,
            closeTabInState: () => undefined,
            documentSessions: cast<TWorkspaceDocumentSessions>({getSession: (tabId: string | null | undefined) => (
                tabId === leftTab || tabId === rightTab ? controller : null
            )}),
            workspaceRestoreTracker: {
                start: () => undefined,
                finish: () => undefined,
            },
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => undefined,
        });

        await transfers.mergeWindowInto(7);

        expect(transferMock.mock.calls.map(([request]) => (request.payload as {currentPage?: number}).currentPage)).toEqual([
            2,
            4,
        ]);
    });

    it.each([
        'merge',
        'rejected',
        'user-selection',
        'superseded',
    ] as const)('captures a cold tab through residency and preserves source selection: %s', async scenario => {
        vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
        onTestFinished(() => {vi.unstubAllGlobals();});
        transferMock.mockClear();
        closeTransferredWindowMock.mockClear();
        const controllers = new Map<string, IWorkspaceDocumentController>();
        for (const id of [
            'cold',
            'hot',
            'survivor',
        ]) {
            const controller = createWorkspaceDocumentController({tabId: id});
            controller.commitDocument({
                fileName: `${id}.pdf`,
                originalPath: requireDocumentRef(`/docs/${id}.pdf`),
                isDjvu: false,
                revisionInfo: null,
            });
            controllers.set(id, controller);
        }
        const cold = controllers.get('cold')!;
        cold.getView('cold')!.applyViewState({
            ...cold.getView('cold')!.viewState.value,
            currentPage: 6,
            zoom: 1.5,
            zoomMode: 'custom',
        });
        const mount = (id: string) => controllers.get(id)!.attachWorkspace(id, createWorkspaceExposeFixture({
            waitForDocumentOpenSettled: () => Promise.withResolvers<undefined>().promise,
            captureSplitPayload: async () => ({
                kind: 'pdfSnapshot',
                fileName: `${id}.pdf`,
                originalPath: requireDocumentRef(`/docs/${id}.pdf`),
                snapshotPath: requireDocumentRef(`/docs/${id}.snapshot.pdf`),
                isDirty: false,
                currentPage: id === 'cold' ? cold.getView('cold')!.viewState.value.currentPage! : 4,
            }),
            handleCloseFileFromUi: async options => {
                await options?.onCloseCommit?.();
                return true;
            },
        }));
        mount('hot');
        mount('survivor');
        const pane = {
            paneId: 'pane-source',
            activeTabId: 'hot',
            tabIds: [
                'cold',
                'hot',
                'survivor',
            ],
        };
        const tabs = ref<ITab[]>(pane.tabIds.map(createTab));
        const activePaneId = ref<string | null>(pane.paneId);
        const activated = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const transfers = useWindowTabTransfers({
            activePaneId,
            panes: ref([pane]),
            tabs,
            layout: ref(null),
            createTab: () => {throw new Error('No incoming tab');},
            getPaneById: id => id === pane.paneId ? pane : null,
            getTabById: id => tabs.value.find(tab => tab.id === id) ?? null,
            getPaneByTabId: id => pane.tabIds.includes(id) ? pane : null,
            activatePane: id => {activePaneId.value = id;},
            activateTab: (_pane, id) => {
                pane.activeTabId = id;
                if (id === 'cold' && !cold.getView(id)!.mountedWorkspace.value) {
                    void nextTick(async () => {
                        activated.resolve(undefined);
                        if (scenario === 'superseded') await release.promise;
                        mount('cold');
                    });
                }
            },
            removeTabFromState: () => undefined,
            cleanupEmptyPanes: () => undefined,
            closeTabInState: (_pane, id) => {
                tabs.value = tabs.value.filter(tab => tab.id !== id);
                pane.tabIds = pane.tabIds.filter(tabId => tabId !== id);
                controllers.get(id)?.removeView(id);
            },
            documentSessions: cast<TWorkspaceDocumentSessions>({getSession: (id: string) => controllers.get(id) ?? null}),
            workspaceRestoreTracker: {
                start: () => undefined,
                finish: () => undefined,
            },
            handleCloseTab: async () => undefined,
            handoffActiveTabBeforeClose: async () => undefined,
        });
        if (scenario === 'rejected' || scenario === 'user-selection') {
            transferMock.mockImplementationOnce(async () => {
                if (scenario === 'user-selection') pane.activeTabId = 'survivor';
                throw new Error('target refused');
            });
        }
        expect(cold.getView('cold')!.mountedWorkspace.value).toBeNull();
        const moving = scenario === 'merge' ? transfers.mergeWindowInto(7) : transfers.moveTabToWindow(7, 'cold');
        if (scenario === 'superseded') {
            // Observe activation without a sleep. The baseline never activates,
            // so settle its existing capture deadline before this assertion.
            await Promise.race([
                activated.promise,
                moving,
            ]);
            expect(pane.activeTabId).toBe('cold');
            const replacement = createWorkspaceDocumentController({tabId: 'cold'});
            controllers.set('cold', replacement);
            // Satisfy the original view, whose controller no longer owns the tab.
            cold.attachWorkspace('cold', createWorkspaceExposeFixture());
            release.resolve(undefined);
        }
        await moving;
        if (scenario === 'merge') {
            expect(transferMock.mock.calls.map(([request]) => request.payload)).toEqual([
                expect.objectContaining({
                    fileName: 'cold.pdf',
                    currentPage: 6,
                }),
                expect.objectContaining({
                    fileName: 'hot.pdf',
                    currentPage: 4,
                }),
                expect.objectContaining({
                    fileName: 'survivor.pdf',
                    currentPage: 4,
                }),
            ]);
            expect(tabs.value).toEqual([]);
            expect(closeTransferredWindowMock).toHaveBeenCalledOnce();
        } else {
            expect(cold.getView('cold')!.mountedWorkspace.value).not.toBeNull();
            expect(pane.activeTabId).toBe(scenario === 'user-selection' ? 'survivor' : 'hot');
            expect(tabs.value.map(tab => tab.id)).toEqual([
                'cold',
                'hot',
                'survivor',
            ]);
            if (scenario === 'superseded') expect(transferMock).not.toHaveBeenCalled();
        }
    });
});
