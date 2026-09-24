import type { Ref } from 'vue';
import type { ITab } from '@app/types/tabs';
import {
    createWorkspaceDocumentController,
    type IWorkspaceDocumentController,
    type TWorkspaceDocumentAssignment,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

/** One document controller per tab, created with the tab and disposed with it. */
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
                session.dispose();
                sessionsByTabId.value.delete(tabId);
                triggerRef(sessionsByTabId);
            }
        }
    }, {immediate: true});

    const documentSessionsByTabId = computed(() => Object.fromEntries(sessionsByTabId.value));
    const workspaceRefs = computed(() => new Map([...sessionsByTabId.value].flatMap(([
        tabId,
        session,
    ]) => session.mountedWorkspace.value ? [[
        tabId,
        session.mountedWorkspace.value,
    ] as const] : [])));
    const activeDocumentSession = computed(() => getSession(options.activeTabId.value));
    const activeWorkspace = computed(() => activeDocumentSession.value?.mountedWorkspace.value ?? null);

    return {
        activeDocumentSession,
        activeWorkspace,
        assignDocument,
        documentSessionsByTabId,
        getSession,
        workspaceRefs,
    };
};

export type TWorkspaceDocumentSessions = ReturnType<typeof useWorkspaceDocumentSessions>;
