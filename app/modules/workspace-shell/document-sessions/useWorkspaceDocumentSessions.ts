import type { Ref } from 'vue';
import type { ITab } from '@app/types/tabs';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
    type TWorkspaceDocumentAssignment,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

/**
 * The document controller of every tab, created with the tab. A controller
 * is disposed when the last tab viewing it goes; each tab reads and writes
 * its own view record on it.
 */
export const useWorkspaceDocumentSessions = (options: {
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}) => {
    const sessionsByTabId = shallowRef(new Map<string, IWorkspaceDocumentController>());
    const pendingAssignments = new Map<string, TWorkspaceDocumentAssignment>();

    function ensureSession(tabId: string) {
        const existing = sessionsByTabId.value.get(tabId);
        if (existing) {
            return existing;
        }
        const session = createWorkspaceDocumentController({
            tabId,
            assignment: pendingAssignments.get(tabId),
        });
        pendingAssignments.delete(tabId);
        sessionsByTabId.value.set(tabId, session);
        triggerRef(sessionsByTabId);
        return session;
    }

    function getSession(tabId: string | null | undefined) {
        return tabId && options.tabs.value.some(tab => tab.id === tabId)
            ? ensureSession(tabId)
            : null;
    }

    /** Assigns a document to a tab that may not exist yet in the pane graph. */
    function assignDocument(tabId: string, assignment: TWorkspaceDocumentAssignment) {
        const session = sessionsByTabId.value.get(tabId);
        if (session) {
            session.assign(assignment);
            return;
        }
        pendingAssignments.set(tabId, assignment);
    }

    watch(options.tabs, (tabs) => {
        const liveTabIds = new Set(tabs.map(tab => tab.id));
        for (const tab of tabs) {
            ensureSession(tab.id);
        }
        for (const [
            tabId,
            session,
        ] of [...sessionsByTabId.value]) {
            if (!liveTabIds.has(tabId)) {
                if (session.removeView(tabId) === 0) {
                    session.dispose();
                }
                sessionsByTabId.value.delete(tabId);
                triggerRef(sessionsByTabId);
            }
        }
    }, {immediate: true});

    function getView(tabId: string | null | undefined) {
        return tabId ? getSession(tabId)?.getView(tabId) ?? null : null;
    }

    const documentSessionsByTabId = computed(() => Object.fromEntries(sessionsByTabId.value));
    const documentViewsByTabId = computed(() => Object.fromEntries([...sessionsByTabId.value].flatMap(([
        tabId,
        session,
    ]) => {
        const view = session.views.value.get(tabId);
        return view ? [[
            tabId,
            view,
        ] as const] : [];
    })));
    const workspaceRefs = computed(() => new Map(Object.entries(documentViewsByTabId.value).flatMap(([
        tabId,
        view,
    ]) => view.mountedWorkspace.value ? [[
        tabId,
        view.mountedWorkspace.value,
    ] as const] : [])));
    const activeDocumentSession = computed(() => getSession(options.activeTabId.value));
    const activeDocumentView = computed(() => getView(options.activeTabId.value));
    const activeWorkspace = computed(() => activeDocumentView.value?.mountedWorkspace.value ?? null);

    return {
        activeDocumentSession,
        activeDocumentView,
        activeWorkspace,
        assignDocument,
        documentSessionsByTabId,
        documentViewsByTabId,
        getSession,
        getView,
        workspaceRefs,
    };
};

export type TWorkspaceDocumentSessions = ReturnType<typeof useWorkspaceDocumentSessions>;
