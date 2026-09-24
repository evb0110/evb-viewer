import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
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
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));

const asyncHelpersMock = vi.hoisted(() => ({
    waitForVisualFrames: vi.fn(async () => {}),
    waitUntilIdle: vi.fn(async (isBusy: () => boolean) => {
        while (isBusy()) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        return true;
    }),
}));
vi.mock('@app/utils/asyncHelpers', () => asyncHelpersMock);

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
    session.publishToolbarSnapshot({
        ...createDefaultWorkspaceToolbarSnapshot(),
        hasPdf: true,
        viewerCapabilities: {
            ...createDefaultWorkspaceViewerCapabilities(),
            closeableDocument: true,
        },
    });
    const workspace = createWorkspaceExposeFixture({
        hasPdf: true,
        handleCloseFileFromUi: vi.fn(async (options?: {
            persist?: boolean;
            onCloseCommit?: () => void;
        }) => {
            expect(options?.persist).toBe(expectedPersist);
            options?.onCloseCommit?.();
            return true;
        }),
    });
    session.attachWorkspace(workspace);
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
    const workspaceSplitCache = {
        set: vi.fn(),
        peek: vi.fn(),
        consume: vi.fn(),
        has: vi.fn(() => false),
        clear: vi.fn(),
    };
    const requestDirtyTabCloseConfirmation = vi.fn(async () => options.decision ?? 'discard');
    const closeTab = vi.fn(options.closeTab ?? (() => {}));
    const lifecycle = useAppShellTabLifecycle({
        panes: options.panes,
        tabs: options.tabs,
        activePaneId: options.activePaneId ?? ref(options.panes.value[0]?.paneId ?? null),
        activeTabId: options.activeTabId ?? ref(options.tabs.value[0]?.id ?? null),
        documentSessionsByTabId: shallowRef(options.sessions),
        workspaceSplitCache,
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
    });
    return {
        closeTab,
        lifecycle,
        requestDirtyTabCloseConfirmation,
        workspaceSplitCache,
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
            session.setDirty(true);
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

    it('keeps split close and retained-pane handoff inside the tab transition', async () => {
        asyncHelpersMock.waitForVisualFrames.mockClear();
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
            closeTab: false,
            closePane: false,
            activateRetainedTab: false,
        };
        const {lifecycle} = createLifecycle({
            panes,
            tabs,
            sessions: {
                'tab-document': createDocumentSession('tab-document'),
                'tab-empty': createWorkspaceDocumentController({tabId: 'tab-empty'}),
            },
            activePaneId,
            activeTabId,
            activateTab: (paneId, tabId) => {
                transitionStates.activateRetainedTab = lifecycle.isTabTransitionBusy.value;
                activePaneId.value = paneId;
                activeTabId.value = tabId;
            },
            closeTab: (paneId, tabId) => {
                transitionStates.closeTab = lifecycle.isTabTransitionBusy.value;
                const pane = panes.value.find(candidate => candidate.paneId === paneId);
                if (pane) {
                    pane.tabIds = pane.tabIds.filter(candidate => candidate !== tabId);
                    pane.activeTabId = pane.tabIds[0] ?? null;
                }
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            },
            closePane: (paneId) => {
                transitionStates.closePane = lifecycle.isTabTransitionBusy.value;
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

        await lifecycle.handleCloseTab('pane-right', 'tab-empty');

        expect(transitionStates).toEqual({
            closeTab: true,
            closePane: true,
            activateRetainedTab: true,
        });
        expect(activePaneId.value).toBe('pane-left');
        expect(activeTabId.value).toBe('tab-document');
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
        expect(asyncHelpersMock.waitForVisualFrames).toHaveBeenCalledWith({frames: 2});
    });

    it('keeps the last tab as the empty tab after its document closes', async () => {
        const session = createDocumentSession('tab-1');
        attachDocumentWorkspace(session, false);
        const {
            closeTab,
            lifecycle,
            workspaceSplitCache,
        } = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(closeTab).not.toHaveBeenCalled();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(workspaceSplitCache.clear).toHaveBeenCalledWith('tab-1');
        expect(lifecycle.isSingletonPlaceholderCloseBlocked('pane-1', 'tab-1')).toBe(true);
    });

    it('closes a tab whose document is still opening and ends the open', async () => {
        const session = createWorkspaceDocumentController({tabId: 'tab-1'});
        const workspace = createWorkspaceExposeFixture({handleCloseFileFromUi: vi.fn(async (options?: {onCloseCommit?: () => void}) => {
            options?.onCloseCommit?.();
            return true;
        })});
        session.attachWorkspace(workspace as IWorkspaceExpose);
        const open = session.runOpen({
            kind: 'open',
            target: {
                fileName: 'dictionary.pdf',
                originalPath: requireDocumentRef('/docs/dictionary.pdf'),
            },
        }, () => new Promise<boolean>(() => {}));
        const {lifecycle} = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        await expect(open).resolves.toBe(false);
        expect(session.snapshot.value.activeTransaction).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(lifecycle.isTabTransitionBusy.value).toBe(false);
    });
});
