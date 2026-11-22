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
import type * as TRecentReadingViewModule from '@app/modules/workspace-shell/document-sessions/recentReadingView';
import { useAppShellTabLifecycle } from '@app/modules/workspace-shell/composables/useAppShellTabLifecycle';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { TDirtyCloseDecision } from '@app/modules/workspace-shell/composables/useDirtyTabCloseDialog';
import {
    bindTestDocumentFrontier,
    createWorkspaceExposeFixture,
    setTestDocumentDirty,
} from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

vi.mock('@app/composables/useRuntimeErrorReports', () => ({useRuntimeErrorReports: () => ({reportRuntimeError: vi.fn()})}));
const readingView = vi.hoisted(() => ({remember: vi.fn(async () => undefined)}));
vi.mock('@app/modules/workspace-shell/document-sessions/recentReadingView', async importOriginal => ({
    ...await importOriginal<typeof TRecentReadingViewModule>(),
    rememberReadingView: readingView.remember,
}));

const asyncHelpersMock = vi.hoisted(() => ({waitForVisualFrames: vi.fn(async () => {})}));
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

// A loaded document whose host closes it: its Save settles the edits, its teardown removes the file.
function bindClosingDocument(session: IWorkspaceDocumentController) {
    const document = {
        release: vi.fn(() => false),
        save: vi.fn(async () => {
            setTestDocumentDirty(session, false);
            return true;
        }),
        teardown: vi.fn(async () => {}),
    };
    bindTestDocumentFrontier(session, document);
    setTestDocumentDirty(session, session.snapshot.value.dirty);
    return document;
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
    const lifecycle = useAppShellTabLifecycle({
        panes: options.panes,
        tabs: options.tabs,
        activePaneId: options.activePaneId ?? ref(options.panes.value[0]?.paneId ?? null),
        activeTabId: options.activeTabId ?? ref(options.tabs.value[0]?.id ?? null),
        documentSessionsByTabId: shallowRef(options.sessions),
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
    };
}

describe('useAppShellTabLifecycle', () => {
    it('waits for page work before asking, deduplicates close clicks, and discards only after settlement', async () => {
        toastAdd.mockClear();
        toastRemove.mockClear();
        const session = createDocumentSession('tab-1');
        const document = bindClosingDocument(session);
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
        expect(document.teardown).not.toHaveBeenCalled();
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
        expect(document.teardown).toHaveBeenCalledOnce();
        expect(session.snapshot.value).toMatchObject({
            phase: 'empty',
            dirty: false,
        });
        expect(session.snapshot.value.identity.fileName).toBeNull();
    });

    it('closes a clean idle document immediately without asking or persisting', async () => {
        const session = createDocumentSession('tab-1');
        const document = bindClosingDocument(session);
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
        expect(document.teardown).toHaveBeenCalledOnce();
    });

    it('saves a dirty document before closing when the user chooses Save', async () => {
        const session = createDocumentSession('tab-1', {dirty: true});
        const document = bindClosingDocument(session);
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
        expect(document.save).toHaveBeenCalledOnce();
        expect(document.teardown).toHaveBeenCalledOnce();
    });

    it('keeps a dirty document open when the user cancels', async () => {
        const session = createDocumentSession('tab-1', {dirty: true});
        const document = bindClosingDocument(session);
        const {lifecycle} = createLifecycle({
            panes: ref([createPane('pane-1', 'tab-1', ['tab-1'])]),
            tabs: ref([{id: 'tab-1'}]),
            sessions: {'tab-1': session},
            decision: 'cancel',
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-1');

        expect(document.teardown).not.toHaveBeenCalled();
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
                if (tabId === 'tab-2') replacementShown();
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

    // STOP 3: a transfer's rollback closes the document under its own lease
    // while the user's Close of that tab waits for the lease to drain.
    it('drains a closing tab before its transition, so a transfer closing it under its lease is not held', async () => {
        const session = createDocumentSession('tab-1');
        const document = bindClosingDocument(session);
        const tabs = ref<ITab[]>([
            {id: 'tab-1'},
            {id: 'tab-2'},
        ]);
        const panes = ref<IEditorPaneState[]>([createPane('pane-1', 'tab-1', [
            'tab-1',
            'tab-2',
        ])]);
        const {lifecycle} = createLifecycle({
            panes,
            tabs,
            sessions: {
                'tab-1': session,
                'tab-2': createDocumentSession('tab-2'),
            },
            closeTab: (_paneId, tabId) => {
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            },
        });
        const rollback = Promise.withResolvers<undefined>();
        const transfer = session.operationLease.runExclusive('tab-transfer', async (ownership) => {
            await rollback.promise;
            return session.close({ownership}).closed;
        });

        const userClose = lifecycle.handleCloseTab('pane-1', 'tab-1');
        await Promise.resolve();
        rollback.resolve(undefined);

        await expect(transfer).resolves.toBe(true);
        await userClose;
        expect(document.teardown).not.toHaveBeenCalled();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(tabs.value.map(tab => tab.id)).toEqual(['tab-2']);
    });

    it('closes one of several linked views alone, asking nothing and releasing nothing', async () => {
        const session = createDocumentSession('tab-a', {dirty: true});
        session.addView('tab-b');
        const document = bindClosingDocument(session);
        const tabs = ref<ITab[]>([
            {id: 'tab-a'},
            {id: 'tab-b'},
        ]);
        const panes = ref<IEditorPaneState[]>([createPane('pane-1', 'tab-b', [
            'tab-a',
            'tab-b',
        ])]);
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
            closeTab: (_paneId, tabId) => {
                session.removeView(tabId);
                tabs.value = tabs.value.filter(tab => tab.id !== tabId);
            },
        });

        await lifecycle.handleCloseTab('pane-1', 'tab-a');

        expect(requestDirtyTabCloseConfirmation).not.toHaveBeenCalled();
        expect(document.release).not.toHaveBeenCalled();
        expect(document.teardown).not.toHaveBeenCalled();
        expect(tabs.value.map(tab => tab.id)).toEqual(['tab-b']);
        expect(session.snapshot.value).toMatchObject({phase: 'presented', dirty: true});
    });

    it('asks about unsaved work when the other view lets go of the document while this view closes', async () => {
        const session = createDocumentSession('tab-a', {dirty: true});
        session.addView('tab-b');
        const document = bindClosingDocument(session);
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
        expect(document.teardown).toHaveBeenCalled();
    });

    it('keeps the last tab as the empty tab after its document closes', async () => {
        const session = createDocumentSession('tab-1');
        bindClosingDocument(session);
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
        session.attachWorkspace('tab-1', createWorkspaceExposeFixture() as IWorkspaceExpose);
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
