import type { Ref } from 'vue';
import type { ITab } from '@app/types/tabs';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/public';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useFailureToast } from '@app/composables/useFailureToast';
import type {
    IWorkspaceDocumentView,
    IWorkspaceDocumentViewSeed,
} from '@app/modules/workspace-shell/document-sessions/createWorkspaceDocumentView';
import {
    createWorkspaceDocumentController,
    identityHasDocument,
    snapshotOccupiesTab,
    type IWorkspaceDocumentController,
    type TWorkspaceDocumentAssignment,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { IWorkspaceRecordedFailure } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentSnapshot';
import { createTabViewSessionState } from '@app/modules/workspace-shell/tabs/createTabViewSessionState';

/**
 * The document controller of every tab, created with the tab. A split can
 * link a second tab to a PDF, so several tabs view one controller; it is
 * disposed when the last tab viewing it goes. Each tab reads and writes its
 * own view record on it.
 */
export const useWorkspaceDocumentSessions = (options: {
    activeTabId: Ref<string | null>;
    tabs: Ref<ITab[]>;
}) => {
    const sessionsByTabId = shallowRef(new Map<string, IWorkspaceDocumentController>());
    const pendingAssignments = new Map<string, TWorkspaceDocumentAssignment>();
    const { t } = useTypedI18n();
    const {
        presentFailureToast,
        presentNoticeToast,
    } = useFailureToast();

    // Every tab's failed open is told here, once, whether the tab then shows
    // Start, keeps its document or is removed. A failure without a receipt is
    // an expected outcome, such as a file that is not a PDF.
    function reportFailure(recorded: IWorkspaceRecordedFailure) {
        const title = recorded.title ?? t('errors.file.open');
        const description = recorded.fileName && !recorded.message.includes(recorded.fileName)
            ? `${recorded.fileName}: ${recorded.message}`
            : recorded.message;
        if (recorded.failure) {
            presentFailureToast({
                failure: recorded.failure,
                title,
                description,
                ...(recorded.technicalDetails ? {technicalDetails: recorded.technicalDetails} : {}),
                ...(recorded.actions ? {actions: recorded.actions} : {}),
            });
            return;
        }
        presentNoticeToast({
            tone: 'warning',
            title,
            description,
        });
    }

    function createController(tabId: string, assignment?: TWorkspaceDocumentAssignment) {
        return createWorkspaceDocumentController({
            tabId,
            assignment,
            reportFailure,
        });
    }

    function ensureSession(tabId: string) {
        const existing = sessionsByTabId.value.get(tabId);
        if (existing) {
            return existing;
        }
        const session = createController(tabId, pendingAssignments.get(tabId));
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

    function replaceSession(tabId: string, next: IWorkspaceDocumentController) {
        const current = sessionsByTabId.value.get(tabId);
        if (current && current !== next && current.removeView(tabId) === 0) {
            current.dispose();
        }
        pendingAssignments.delete(tabId);
        sessionsByTabId.value.set(tabId, next);
        triggerRef(sessionsByTabId);
    }

    // The new view opens at the source's page, then takes the source's place on it.
    async function placeAtReadingAnchor(view: IWorkspaceDocumentView, anchor: IPdfSemanticAnchor) {
        const workspace = await view.whenMounted();
        await workspace?.placeReadingAnchorAfterOpen?.(anchor);
    }

    /**
     * Shows the source tab's PDF in the target tab too: a second view of one
     * document that starts where the source view is (behavior contract T4),
     * or where `seed` says, as a restored view does. The target must not
     * hold a document of its own.
     */
    function linkView(sourceTabId: string, targetTabId: string, seed?: IWorkspaceDocumentViewSeed) {
        const source = sessionsByTabId.value.get(sourceTabId);
        const current = sessionsByTabId.value.get(targetTabId);
        const snapshot = source?.snapshot.value;
        // A PDF still opening links too; the view presents it when the open does.
        const opening = snapshot?.phase === 'opening' ? snapshot.activeTransaction?.target ?? null : null;
        const isPdf = snapshot?.phase === 'presented'
            ? !snapshot.identity.isDjvu && identityHasDocument(snapshot.identity)
            : Boolean(opening?.originalPath && !opening.isDjvu);
        if (
            !source
            || !snapshot
            || source === current
            || !isPdf
            || (current && (snapshotOccupiesTab(current.snapshot.value) || current.views.value.size > 1))
        ) {
            return false;
        }
        const sourceView = source.getView(sourceTabId);
        const readingAnchor = seed || opening ? null : sourceView?.mountedWorkspace.value?.captureReadingAnchor?.() ?? null;
        // The reader's place and panels, not a scan-cleanup surface.
        const view = source.addView(targetTabId, seed ?? (sourceView
            ? {
                toolbarSnapshot: sourceView.toolbarSnapshot.value,
                viewState: createTabViewSessionState(sourceView.toolbarSnapshot.value),
            }
            : undefined));
        replaceSession(targetTabId, source);
        if (readingAnchor) {
            placeAtReadingAnchor(view, readingAnchor).catch((error: unknown) => {
                BrowserLogger.warn('workspace', 'A linked view could not take its source view\'s place', error);
            });
        }
        return true;
    }

    /** Gives a tab that shares its document an empty document of its own. */
    function detachView(tabId: string) {
        if ((sessionsByTabId.value.get(tabId)?.views.value.size ?? 0) < 2) {
            return false;
        }
        replaceSession(tabId, createController(tabId));
        return true;
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
        linkView,
        detachView,
        workspaceRefs,
    };
};

export type TWorkspaceDocumentSessions = ReturnType<typeof useWorkspaceDocumentSessions>;
