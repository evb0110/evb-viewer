import { setImmediate as nextTask } from 'node:timers/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
    shallowRef,
    watch,
    type Ref,
} from 'vue';
import {
    requirePaneId,
    type IEditorPaneState,
} from '@contracts/editorPanes';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireTabId } from '@contracts/windowTabs';
import type { ITab } from '@app/types/tabs';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type * as TRecentReadingViewModule from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import { useAppShellDirectionalTabs } from '@app/modules/workspace-shell/composables/useAppShellDirectionalTabs';
import { cast } from '@tests/helpers/cast';
import { createWorkspaceLayoutChange } from '@app/modules/workspace-shell/composables/workspaceLayoutChange';
import {
    createDocumentViews,
    createViewLayoutReceipt,
    type IDocumentViewPort,
} from '@app/modules/workspace-shell/document-sessions/createDocumentViews';
import { createDocumentOpenSurfaceSession } from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import {
    createWorkspaceExposeFixture,
    setTestDocumentDirty,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));
const readingView = vi.hoisted(() => ({remember: vi.fn(async () => undefined)}));
vi.mock('@app/modules/workspace-shell/document-sessions/recentReadingView', async importOriginal => ({
    ...await importOriginal<typeof TRecentReadingViewModule>(),
    rememberReadingView: readingView.remember,
}));

const toastAdd = vi.hoisted(() => vi.fn(() => ({id: 'busy-toast'})));
const toastRemove = vi.hoisted(() => vi.fn());
vi.stubGlobal('useToast', () => ({
    add: toastAdd,
    remove: toastRemove,
}));
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));

function createPane(id: string, activeTabId: string | null, tabIds: string[]): IEditorPaneState {
    return {
        paneId: requirePaneId(id),
        activeTabId: activeTabId === null ? null : requireTabId(activeTabId),
        tabIds: tabIds.map(tabId => requireTabId(tabId)),
    };
}

function createDocumentSession(tabId: string, options: {dirty?: boolean} = {}) {
    return createWorkspaceDocumentController({
        tabId,
        assignment: {
            fileName: 'sample.pdf',
            originalPath: requireDocumentRef('/tmp/sample.pdf'),
            isDirty: options.dirty ?? false,
            isDjvu: false,
        },
    });
}

// A mounted workspace that holds a closeable document until it is closed.
function attachDocumentWorkspace(session: IWorkspaceDocumentController, expectedPersist: boolean) {
    const [tabId] = session.views.value.keys();
    session.getView(tabId!)?.publishToolbarSnapshot({
        ...createDefaultWorkspaceToolbarSnapshot(),
        hasPdf: true,
        viewerCapabilities: {
            ...createDefaultWorkspaceViewerCapabilities(),
            closeableDocument: true,
        },
    });
    const workspace = createWorkspaceExposeFixture({
        hasPdf: true,
        handleCloseFileFromUi: vi.fn(async (options?: Parameters<IWorkspaceExpose['handleCloseFileFromUi']>[0]) => {
            expect(options?.persist).toBe(expectedPersist);
            // The file session releases the document before the close commits.
            session.commitFile({
                originalPath: null,
                workingCopyPath: null,
                revisionInfo: null,
                revisionToken: null,
            });
            await options?.onCloseCommit?.();
            return true;
        }),
    });
    session.attachWorkspace(tabId!, workspace);
    return workspace;
}

function createLifecycle(options: {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    sessions: Record<string, IWorkspaceDocumentController>;
    activePaneId?: Ref<string | null>;
    activeTabId?: Ref<string | null>;
    decision?: TDirtyCloseDecision;
    closeTab?: (paneId: string, tabId: string) => void;
    closePane?: (paneId: string) => void;
    activateTab?: (paneId: string, tabId: string) => void;
}) {
    const getPaneById = (paneId: string | null | undefined) => (
        options.panes.value.find(pane => pane.paneId === paneId) ?? null
    );
    const requestDirtyTabCloseConfirmation = vi.fn(async () => options.decision ?? 'discard');
    const closeTab = vi.fn(options.closeTab ?? (() => {}));
    const documentSessionsByTabId = shallowRef(options.sessions);
    const layoutResizing = ref(false);
    const lifecycle = useAppShellTabLifecycle({
        panes: options.panes,
        tabs: options.tabs,
        activePaneId: options.activePaneId ?? ref(options.panes.value[0]?.paneId ?? null),
        activeTabId: options.activeTabId ?? ref(options.tabs.value[0]?.id ?? null),
        documentSessionsByTabId,
        workspaceRestoreTracker: {
            start: vi.fn(),
            finish: vi.fn(),
            has: vi.fn(() => false),
        },
        getPaneById,
        getTabById: (tabId: string | null | undefined) => options.tabs.value.find(tab => tab.id === tabId) ?? null,
        getPaneByTabId: (tabId: string | null | undefined) => (
            options.panes.value.find(pane => (tabId ? pane.tabIds.some(candidate => candidate === tabId) : false)) ?? null
        ),
        activatePane: vi.fn(),
        activateTab: vi.fn(options.activateTab ?? (() => {})),
        closeTab,
        closePane: vi.fn(options.closePane ?? (() => {})),
        requestDirtyTabCloseConfirmation,
        changeWorkspaceLayout: createWorkspaceLayoutChange({
            setWorkspaceLayoutResizing: (value) => { layoutResizing.value = value; },
            documentSessionsByTabId,
        }),
    });
    return {
        closeTab,
        layoutResizing,
        lifecycle,
        requestDirtyTabCloseConfirmation,
    };
}

describe('useAppShellTabLifecycle', () => {
    it('waits for page work before asking, deduplicates close clicks, and discards only after settlement', async () => {
        toastAdd.mockClear();
        toastRemove.mockClear();
        const session = createDocumentSession('tab-1');
        const workspace = attachDocumentWorkspace(session, false);
        const releaseMutation = Promise.withResolvers<undefined>();
        const mutationStarted = Promise.withResolvers<undefined>();
        const mutation = session.operationLease.runExclusive('page-operation', async () => {
            mutationStarted.resolve(undefined);
            await releaseMutation.promise;
            setTestDocumentDirty(session, true);
        });
        await mutationStarted.promise;
        const {
            lifecycle,
            requestDirtyTabCloseConfirmation,
        } = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
        });

        const firstClose = lifecycle.handleCloseTab('pane-1', 'tab-1');
        const repeatedClose = lifecycle.handleCloseTab('pane-1', 'tab-1');
        await Promise.resolve();

        expect(requestDirtyTabCloseConfirmation).not.toHaveBeenCalled();
        expect(workspace.handleCloseFileFromUi).not.toHaveBeenCalled();
        expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
            color: 'info',
            description: 'notifications.closingAfterPageProcessing',
        }));

        releaseMutation.resolve(undefined);
        await Promise.all([
            mutation,
            firstClose,
            repeatedClose,
        ]);

        expect(requestDirtyTabCloseConfirmation).toHaveBeenCalledOnce();
        expect(toastRemove).toHaveBeenCalledOnce();
        expect(workspace.handleCloseFileFromUi).toHaveBeenCalledOnce();
        expect(session.snapshot.value).toMatchObject({
            phase: 'empty',
            dirty: false,
        });
        expect(session.snapshot.value.identity.fileName).toBeNull();
    });

    it('closes a clean idle document immediately without asking or persisting', async () => {
        const session = createDocumentSession('tab-1');
        const workspace = attachDocumentWorkspace(session, false);
        const {
            lifecycle,
            requestDirtyTabCloseConfirmation,
        } = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
            decision: 'save',
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(requestDirtyTabCloseConfirmation).not.toHaveBeenCalled();
        expect(workspace.handleCloseFileFromUi).toHaveBeenCalledOnce();
    });

    it('saves a dirty document before closing when the user chooses Save', async () => {
        const session = createDocumentSession('tab-1', {dirty: true});
        const workspace = attachDocumentWorkspace(session, true);
        const {
            lifecycle,
            requestDirtyTabCloseConfirmation,
        } = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
            decision: 'save',
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(requestDirtyTabCloseConfirmation).toHaveBeenCalledWith('tab-1');
        expect(workspace.handleCloseFileFromUi).toHaveBeenCalledOnce();
    });

    it('keeps a dirty document open when the user cancels', async () => {
        const session = createDocumentSession('tab-1', {dirty: true});
        const workspace = attachDocumentWorkspace(session, false);
        const {lifecycle} = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
            decision: 'cancel',
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(workspace.handleCloseFileFromUi).not.toHaveBeenCalled();
        expect(session.snapshot.value).toMatchObject({
            phase: 'presented',
            dirty: true,
        });
    });

    it('collapses a split under the resize fence and ends once the remaining view is placed', async () => {
        // No frame is waited for: the close waits for the view's placement.
        const requestAnimationFrame = vi.fn();
        Object.assign(globalThis, {requestAnimationFrame});
        onTestFinished(() => {
            Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
        });
        const panes = ref<IEditorPaneState[]>([
            createPane('pane-left', 'tab-document', ['tab-document']),
            createPane('pane-right', 'tab-empty', ['tab-empty']),
        ]);
        const tabs = ref<ITab[]>([
            {id: 'tab-document'},
            {id: 'tab-empty'},
        ]);
        const activePaneId = ref<string | null>('pane-right');
        const activeTabId = ref<string | null>('tab-empty');
        const transitionStates = {
            closeTab: [false, false],
            closePane: [false, false],
            activateRetainedTab: [false, false],
        };
        const documentSession = createDocumentSession('tab-document');
        // The remaining view places its point in the box the collapse gives it,
        // and records whether its viewer still saw a resize then: the fence or a
        // tab transition, as DocumentWorkspace passes it to the viewer.
        const placements: PromiseWithResolvers<void>[] = [];
        const viewerResizingAtPlacement: boolean[] = [];
        documentSession.attachWorkspace('tab-document', createWorkspaceExposeFixture({
            whenLayoutPlaced: () => {
                viewerResizingAtPlacement.push(layoutResizing.value || lifecycle.isTabTransitionBusy.value);
                const placement = Promise.withResolvers<void>();
                placements.push(placement);
                return placement.promise;
            },
        }));
        const {
            layoutResizing, lifecycle,
        } = createLifecycle({
            panes,
            tabs,
            sessions: {
                'tab-document': documentSession,
                'tab-empty': createWorkspaceDocumentController({tabId: 'tab-empty'}),
            },
            activePaneId,
            activeTabId,
            activateTab: (paneId, tabId) => {
                transitionStates.activateRetainedTab = [lifecycle.isTabTransitionBusy.value, layoutResizing.value];
                activePaneId.value = paneId;
                activeTabId.value = tabId;
            },
            closeTab: (paneId, tabId) => {
                transitionStates.closeTab = [lifecycle.isTabTransitionBusy.value, layoutResizing.value];
                const pane = panes.value.find(candidate => candidate.paneId === paneId);
                if (pane) {
                    pane.tabIds = pane.tabIds.filter(candidate => candidate !== tabId);
                    pane.activeTabId = pane.tabIds[0] ?? null;
                }
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            },
            closePane: (paneId) => {
                transitionStates.closePane = [lifecycle.isTabTransitionBusy.value, layoutResizing.value];
                panes.value = panes.value.filter(pane => pane.paneId !== paneId);
            },
        });
        let publishedBusyState = false;
        const stopWatchingBusyState = watch(lifecycle.isTabTransitionBusy, (isBusy) => {
            publishedBusyState = isBusy;
        }, {flush: 'post'});

        await lifecycle.enqueueTabTransition(async () => {
            expect(publishedBusyState).toBe(true);
        });
        stopWatchingBusyState();

        let closed = false;
        const closing = lifecycle.handleCloseTab('pane-right', 'tab-empty').then(() => { closed = true; });
        await vi.waitFor(() => expect(placements).toHaveLength(1));
        // The close, the collapse and the handoff commit together, inside the
        // tab transition and the resize fence, which holds until the placement.
        expect(transitionStates).toEqual({
            closeTab: [true, true],
            closePane: [true, true],
            activateRetainedTab: [true, true],
        });
        expect(layoutResizing.value).toBe(true);
        placements[0]!.resolve();
        // Releasing the fence places the point once more before the close ends,
        // once the viewer no longer sees a resize: its tab transition has ended.
        await vi.waitFor(() => expect(placements).toHaveLength(2));
        expect(viewerResizingAtPlacement).toEqual([true, false]);
        expect(closed).toBe(false);
        placements[1]!.resolve();
        await closing;

        expect(activePaneId.value).toBe('pane-left');
        expect(activeTabId.value).toBe('tab-document');
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('closes a tab that leaves its pane with other tabs without a layout change', async () => {
        const panes = ref<IEditorPaneState[]>([
            createPane('pane-left', 'tab-document', ['tab-document']),
            createPane('pane-right', 'tab-empty', ['tab-empty', 'tab-other']),
        ]);
        const tabs = ref<ITab[]>([{id: 'tab-document'}, {id: 'tab-empty'}, {id: 'tab-other'}]);
        const fenceWhenClosed: boolean[] = [];
        const {
            layoutResizing, lifecycle,
        } = createLifecycle({
            panes,
            tabs,
            sessions: {
                'tab-document': createDocumentSession('tab-document'),
                'tab-empty': createWorkspaceDocumentController({tabId: 'tab-empty'}),
                'tab-other': createWorkspaceDocumentController({tabId: 'tab-other'}),
            },
            activePaneId: ref('pane-right'),
            activeTabId: ref('tab-empty'),
            closeTab: (paneId, tabId) => {
                fenceWhenClosed.push(layoutResizing.value);
                const pane = panes.value.find(candidate => candidate.paneId === paneId);
                if (pane) {pane.tabIds = pane.tabIds.filter(candidate => candidate !== tabId);}
            },
        });

        await lifecycle.handleCloseTab('pane-right', 'tab-empty');

        expect(fenceWhenClosed).toEqual([false]);
        expect(panes.value).toHaveLength(2);
    });

    it('keeps closing available when the user leaves the replacement before its view mounts', async () => {
        const panes = ref<IEditorPaneState[]>([createPane('pane-1', 'tab-3', ['tab-1', 'tab-2', 'tab-3'])]);
        const tabs = ref<ITab[]>([{id: 'tab-1'}, {id: 'tab-2'}, {id: 'tab-3'}]);
        const activeTabId = ref<string | null>('tab-3');
        const sessions = Object.fromEntries(['tab-1', 'tab-2', 'tab-3'].map(tabId => [
            tabId,
            createWorkspaceDocumentController({tabId}),
        ]));
        let replacementShown: () => void = () => {};
        const replacementShownPromise = new Promise<void>((resolve) => {
            replacementShown = resolve;
        });
        const {lifecycle} = createLifecycle({
            panes,
            tabs,
            sessions,
            activeTabId,
            activateTab: (_paneId, tabId) => {
                activeTabId.value = tabId;
                panes.value[0]!.activeTabId = requireTabId(tabId);
                if (tabId === 'tab-2') {replacementShown();}
            },
            closeTab: (_paneId, tabId) => {
                panes.value[0]!.tabIds = panes.value[0]!.tabIds.filter(candidate => candidate !== tabId);
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            },
        });

        const closing = lifecycle.handleCloseTab('pane-1', 'tab-3');
        await replacementShownPromise;
        // The user selects the first tab; the replacement's view never mounts.
        activeTabId.value = 'tab-1';
        panes.value[0]!.activeTabId = requireTabId('tab-1');
        await closing;

        expect(sessions['tab-2']!.getView('tab-2')?.mountedWorkspace.value).toBeNull();
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
        expect(tabs.value.map(tab => tab.id)).toEqual(['tab-1', 'tab-2']);

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(tabs.value.map(tab => tab.id)).toEqual(['tab-2']);
    });

    it('asks about unsaved work when the other view lets go of the document while this view closes', async () => {
        const session = createDocumentSession('tab-a', {dirty: true});
        session.addView('tab-b');
        const workspace = attachDocumentWorkspace(session, false);
        const panes = ref<IEditorPaneState[]>([createPane('pane-1', 'tab-b', [
            'tab-a',
            'tab-b',
        ])]);
        const tabs = ref<ITab[]>([
            {id: 'tab-a'},
            {id: 'tab-b'},
        ]);
        const {
            lifecycle,
            requestDirtyTabCloseConfirmation,
        } = createLifecycle({
            panes,
            tabs,
            sessions: {
                'tab-a': session,
                'tab-b': session,
            },
        });
        const remembered = Promise.withResolvers<undefined>();
        readingView.remember.mockReturnValueOnce(remembered.promise);

        const closing = lifecycle.handleCloseTab('pane-1', 'tab-a');
        await vi.waitFor(() => expect(readingView.remember).toHaveBeenCalled());
        // Tab B opens another file meanwhile and leaves this document.
        session.removeView('tab-b');
        remembered.resolve(undefined);
        await closing;

        expect(requestDirtyTabCloseConfirmation).toHaveBeenCalledWith('tab-a');
        expect(workspace.handleCloseFileFromUi).toHaveBeenCalled();
    });

    it('keeps the last tab as the empty tab after its document closes', async () => {
        const session = createDocumentSession('tab-1');
        attachDocumentWorkspace(session, false);
        const {
            closeTab,
            lifecycle,
        } = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(closeTab).not.toHaveBeenCalled();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(lifecycle.isSingletonPlaceholderCloseBlocked('pane-1', 'tab-1')).toBe(true);
    });

    it('closes a tab whose document is still opening and ends the open', async () => {
        const session = createWorkspaceDocumentController({tabId: 'tab-1'});
        const workspace = createWorkspaceExposeFixture({handleCloseFileFromUi: vi.fn(async (options?: Parameters<IWorkspaceExpose['handleCloseFileFromUi']>[0]) => {
            await options?.onCloseCommit?.();
            return true;
        })});
        session.attachWorkspace('tab-1', workspace as IWorkspaceExpose);
        const shape = Promise.withResolvers<null>();
        const open = session.runOpen({
            pageShape: {
                path: requireDocumentRef('/docs/dictionary.pdf'),
                answer: shape.promise,
            },
            kind: 'open',
            target: {
                fileName: 'dictionary.pdf',
                originalPath: requireDocumentRef('/docs/dictionary.pdf'),
            },
        }, () => new Promise<null>(() => {}));
        const {lifecycle} = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        shape.resolve(null);
        await expect(open.finished).resolves.toEqual({status: 'superseded'});
        expect(session.snapshot.value.activeTransaction).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
    });
});

/** A viewer whose placements the test settles, recording the fence each one saw. */
function createPlacingViewer(layoutResizing: {value: boolean}) {
    const placements: {fence: boolean; placement: PromiseWithResolvers<void>}[] = [];
    return {
        placements,
        whenLayoutPlaced: () => {
            const placement = Promise.withResolvers<void>();
            placements.push({
                fence: layoutResizing.value,
                placement,
            });
            return placement.promise;
        },
    };
}

const placedReport = (page: number) => ({
    kind: 'placed' as const,
    page,
    left: 0,
    top: 900,
    geometryRevision: 1,
    interactionEpoch: 0,
});

describe('workspace layout change', () => {
    it('ends a split once the unfocused source view and the new view are placed, with no frame waits', async () => {
        const requestAnimationFrame = vi.fn();
        Object.assign(globalThis, {requestAnimationFrame});
        onTestFinished(() => {
            Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
        });
        const scope = effectScope();
        onTestFinished(() => scope.stop());
        const layoutResizing = ref(false);
        const document = createWorkspaceDocumentController({
            tabId: 'tab-source',
            assignment: {
                fileName: 'sample.pdf',
                originalPath: requireDocumentRef('/tmp/sample.pdf'),
                isDirty: false,
                isDjvu: false,
            },
        });
        const presented = cast<IWorkspaceDocumentController>({snapshot: ref({phase: 'presented'})});
        const activePaneId = ref('pane-source');
        // A view is shown while it is its pane's active tab, focused or not
        // (DocumentWorkspace's isActive || isRenderActive).
        const createView = (paneId: string, surface: ReturnType<typeof createDocumentOpenSurfaceSession>) => {
            const viewer = createPlacingViewer(layoutResizing);
            const focused = computed(() => activePaneId.value === paneId);
            const whenLayoutPlaced = scope.run(() => createViewLayoutReceipt({
                controller: presented,
                openSurface: surface,
                isShown: computed(() => focused.value || true),
                viewer: () => viewer,
            }))!;
            return {
                focused,
                viewer,
                workspace: createWorkspaceExposeFixture({whenLayoutPlaced}),
            };
        };
        const source = createView('pane-source', createDocumentOpenSurfaceSession());
        document.attachWorkspace('tab-source', source.workspace);
        // The new view mounts and begins its opening at the source's place.
        const linkedSurface = createDocumentOpenSurfaceSession();
        const linked = createView('pane-new', linkedSurface);
        const sessions = shallowRef<Record<string, IWorkspaceDocumentController>>({'tab-source': document});
        const panes = ref<IEditorPaneState[]>([createPane('pane-source', 'tab-source', ['tab-source'])]);
        const tabs = ref<ITab[]>([{id: 'tab-source'}]);
        const fenceAtSplit: boolean[] = [];
        const directionalTabs = useAppShellDirectionalTabs(cast<Parameters<typeof useAppShellDirectionalTabs>[0]>({
            activePaneId,
            panes,
            tabs,
            documentSessionsByTabId: sessions,
            isTabTransitionBusy: computed(() => false),
            getPaneById: (paneId: string | null) => panes.value.find(pane => pane.paneId === paneId) ?? null,
            splitPane: () => {
                fenceAtSplit.push(layoutResizing.value);
                panes.value = [...panes.value, createPane('pane-new', null, [])];
                return 'pane-new';
            },
            createTab: () => {
                tabs.value = [...tabs.value, {id: 'tab-new'}];
                return {id: 'tab-new'};
            },
            linkDocumentView: (sourceTabId: string, targetTabId: string) => {
                document.addView(targetTabId);
                document.attachWorkspace(targetTabId, linked.workspace);
                linkedSurface.begin({
                    documentId: 'sample.pdf',
                    documentRevision: 'open-intent:view:tab-new',
                    provisional: true,
                }, null, 4);
                sessions.value = {
                    ...sessions.value,
                    [targetTabId]: document,
                };
                return sourceTabId === 'tab-source';
            },
            // Split Right moves focus to the new pane; the source pane stays shown.
            activatePane: (paneId: string) => {
                activePaneId.value = paneId;
            },
            enqueueTabTransition: <T>(task: () => Promise<T>) => task(),
            changeWorkspaceLayout: createWorkspaceLayoutChange({
                setWorkspaceLayoutResizing: (value) => { layoutResizing.value = value; },
                documentSessionsByTabId: sessions,
            }),
        }));

        let split = false;
        const splitting = directionalTabs.splitEditor('right').then(() => { split = true; });
        await vi.waitFor(() => expect(source.viewer.placements).toHaveLength(1));
        // The views took their point under the fence before the split moved the pane.
        expect(fenceAtSplit).toEqual([true]);
        expect(source.focused.value).toBe(false);
        expect(source.viewer.placements[0]!.fence).toBe(true);
        // The new view places its opening's point before its viewer relays out.
        expect(linked.viewer.placements).toHaveLength(0);
        expect(linkedSurface.reportNavigation(linkedSurface.navigationTicket.value!, placedReport(4))).toBe(true);
        await vi.waitFor(() => expect(linked.viewer.placements).toHaveLength(1));
        source.viewer.placements[0]!.placement.resolve();
        await Promise.resolve();
        expect(layoutResizing.value).toBe(true);
        linked.viewer.placements[0]!.placement.resolve();

        // Releasing the fence places each point once more before the split ends.
        await vi.waitFor(() => expect(source.viewer.placements).toHaveLength(2));
        await vi.waitFor(() => expect(linked.viewer.placements).toHaveLength(2));
        expect(layoutResizing.value).toBe(false);
        expect(split).toBe(false);
        source.viewer.placements[1]!.placement.resolve();
        linked.viewer.placements[1]!.placement.resolve();
        await splitting;
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it('holds the fence until the last of overlapping layout changes ends', async () => {
        const fence = ref(false);
        const change = createWorkspaceLayoutChange({
            setWorkspaceLayoutResizing: (value) => { fence.value = value; },
            documentSessionsByTabId: shallowRef({}),
        });
        const longer = Promise.withResolvers<void>();
        let longerEnded = false;
        const longerChange = change(async (enter) => {
            await enter();
            await longer.promise;
        }).then(() => { longerEnded = true; });

        await change(async (enter) => {
            await enter();
            expect(fence.value).toBe(true);
        });

        // The shorter change ends without waiting for the longer one, whose views still need the fence.
        expect(fence.value).toBe(true);
        expect(longerEnded).toBe(false);
        longer.resolve();
        await longerChange;
        expect(fence.value).toBe(false);
    });

    it('raises no fence for a change that moves no pane, and releases it when a change fails', async () => {
        const fence = ref(false);
        const fences: boolean[] = [];
        const change = createWorkspaceLayoutChange({
            setWorkspaceLayoutResizing: (value) => {
                fence.value = value;
                fences.push(value);
            },
            documentSessionsByTabId: shallowRef({}),
        });

        await change(() => undefined);
        expect(fences).toEqual([]);

        await expect(change(async (enter) => {
            await enter();
            throw new Error('split failed');
        })).rejects.toThrow('split failed');
        expect(fences).toEqual([true, false]);
    });
});

describe('document views', () => {
    it.each([
        'view',
        'document host',
    ])('lets a cold tab\'s unmounted viewer be collected when its %s goes first', async (first) => {
        setFlagsFromString('--expose_gc');
        const collectGarbage = runInNewContext('gc') as () => void;
        const scope = effectScope();
        onTestFinished(() => scope.stop());
        // The document's controller outlives a cold tab's host and keeps reading this context.
        const views = scope.run(() => createDocumentViews(createWorkspaceDocumentController({tabId: 'tab-a'})))!;
        const pdfViewerRef = shallowRef<object | null>({unmountedViewer: true});
        const viewerRef = new WeakRef(pdfViewerRef.value!);
        let detach: (() => void) | null = views.attachView(cast<IDocumentViewPort>({
            tabId: 'tab-a',
            view: {
                pdfViewerRef,
                pdfDocument: shallowRef(null),
                totalPages: ref(1),
            },
        }));
        expect(views.pdfViewer.value === viewerRef.deref()).toBe(true);

        if (first === 'document host') {scope.stop();}
        // Unmounting clears the view's template ref, then the view gives its port back.
        pdfViewerRef.value = null;
        detach();
        detach = null;
        // A WeakRef keeps its target until the task that read it ends.
        await nextTask();
        collectGarbage();

        expect(viewerRef.deref()).toBeUndefined();
        expect(views.soleView.value).toBeNull();
    });
});

describe('view layout receipt', () => {
    function createReceipt(phase: 'presented' | 'opening', surface = createDocumentOpenSurfaceSession()) {
        const scope = effectScope();
        const isShown = ref(true);
        const viewerPlaced = vi.fn(async () => undefined);
        const whenLayoutPlaced = scope.run(() => createViewLayoutReceipt({
            controller: cast<IWorkspaceDocumentController>({snapshot: ref({phase})}),
            openSurface: surface,
            isShown,
            viewer: () => ({whenLayoutPlaced: viewerPlaced}),
        }))!;
        onTestFinished(() => scope.stop());
        return {
            isShown,
            scope,
            surface,
            viewerPlaced,
            whenLayoutPlaced,
        };
    }

    it('does not hold a layout change on an open that is still reading its file', async () => {
        const view = createReceipt('opening');
        // The source view's surface opens while the file read is held.
        view.surface.begin({
            documentId: 'held.pdf',
            documentRevision: 'open-intent:held',
            provisional: true,
        });
        expect(view.surface.navigationTicket.value).not.toBeNull();

        await view.whenLayoutPlaced();

        expect(view.viewerPlaced).toHaveBeenCalledOnce();
    });

    it.each([
        'unmounted',
        'hidden',
    ] as const)('settles at once and stops watching when the opening view is %s', async (end) => {
        const view = createReceipt('presented');
        view.surface.begin({
            documentId: 'sample.pdf',
            documentRevision: 'open-intent:view',
            provisional: true,
        }, null, 3);
        const ticket = view.surface.navigationTicket.value!;
        let settled = false;
        const receipt = view.whenLayoutPlaced().then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        if (end === 'unmounted') {view.scope.stop();}
        else {view.isShown.value = false;}
        await receipt;

        expect(settled).toBe(true);
        expect(view.viewerPlaced).not.toHaveBeenCalled();
        expect(ticket.signal.aborted).toBe(false);
    });
});
