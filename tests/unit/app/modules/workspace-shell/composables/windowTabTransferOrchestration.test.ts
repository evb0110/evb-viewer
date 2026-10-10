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
import {
    createWorkspaceDocumentController,
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

const transferAckMock = vi.hoisted(() => vi.fn(async (_ack: {
    transferId: string;
    success: boolean;
    error?: string
}) => true));
const transferMock = vi.hoisted(() => vi.fn(async (_request: {payload: unknown}) => ({success: true})));
// A clean document's split capture clones its working copy; the clone is the
// only platform call a merge capture makes.
const createWorkingCopyFromPathMock = vi.hoisted(() => vi.fn(async (path: string) => `${path}.snapshot.pdf`));
vi.mock('@app/utils/platformDocuments', async importOriginal => ({
    ...await importOriginal<typeof PlatformDocuments>(),
    getDocumentWorkingCopyCapability: () => ({createWorkingCopyFromPath: createWorkingCopyFromPathMock}),
}));
vi.mock('@app/utils/platformWindowTabs', () => ({
    canUseNativeWindowTabTransfers: () => true,
    getWindowTabsCapability: () => ({
        transferAck: transferAckMock,
        transfer: transferMock,
    }),
}));

function createTab(id: string): ITab {
    return {id};
}

describe('window tab transfer orchestration helpers', () => {
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
                        effectiveZoom: 2,
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
            controller.attachWorkspace(tabId, createWorkspaceExposeFixture({captureSplitPayload: () => document.splitPayload.captureSplitPayload(pages.get(tabId)!.value)}));
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
});
