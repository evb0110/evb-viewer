import type { Ref } from 'vue';
import type { IAgentAssistantChatScope } from '@contracts/agent';
import type { ITab } from '@app/types/tabs';
import { parseTabId } from '@contracts/windowTabs';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';
import type {
    describeTabDocument,
    IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';

interface IUseAssistantChatScopeOptions {
    activeTabId: Readonly<Ref<string | null>>;
    tabs: Readonly<Ref<readonly ITab[]>>;
    activeDocumentSession: Readonly<Ref<IWorkspaceDocumentController | null>>;
    activeTabDocument: Readonly<Ref<ReturnType<typeof describeTabDocument> | null>>;
    isTabEmpty: (tabId: string) => boolean;
    isScopedCommandRunning: (tabId: string) => boolean;
}

/** The document the assistant panel works on, and whether its turn is running a command there. */
export const useAssistantChatScope = (options: IUseAssistantChatScopeOptions) => {
    const hasActiveDocument = computed(() => (options.activeTabId.value ? !options.isTabEmpty(options.activeTabId.value) : false));
    const hasAnyDocument = computed(() => options.tabs.value.some(tab => !options.isTabEmpty(tab.id)));
    const activeDocumentName = computed(() => hasActiveDocument.value
        ? options.activeTabDocument.value?.fileName ?? null
        : null);
    const chatScopePending = computed(() => {
        const phase = options.activeDocumentSession.value?.snapshot.value.phase;
        return phase === 'opening' || phase === 'closing';
    });
    const chatScope = computed<IAgentAssistantChatScope | null>(() => {
        const session = options.activeDocumentSession.value;
        const tabDocument = options.activeTabDocument.value;
        const tabId = parseTabId(options.activeTabId.value);
        if (!session || !tabDocument || !hasActiveDocument.value || tabId === null) {
            return null;
        }
        const identity = session.snapshot.value.identity;
        const documentSessionKey = identity.documentSessionKey;
        const documentInstanceId = identity.documentInstanceId;
        const documentRef = tabDocument.originalPath;
        const documentBackend = resolveDocumentRefBackend(documentRef);
        const documentIdentity = identity.revisionInfo;
        return {
            kind: 'document',
            // Saved chats are looked up by this key after a relaunch, and every
            // open mints a new document session key, so the key follows the file.
            key: documentRef
                ? `document:${documentBackend ?? 'unknown'}:${documentRef}`
                : `tab:${tabId}`,
            title: tabDocument.fileName ?? documentRef ?? null,
            tabId,
            ...(documentSessionKey ? { documentSessionKey } : {}),
            ...(documentInstanceId ? { documentInstanceId } : {}),
            ...(documentRef ? { documentRef } : {}),
            ...(documentBackend === undefined ? {} : {documentBackend}),
            ...(documentIdentity ? { documentIdentity } : {}),
            commandTarget: session.createCommandTarget(tabId),
        };
    });
    const commandRunning = computed(() => {
        const tabId = chatScope.value?.tabId;
        return tabId != null && options.isScopedCommandRunning(tabId);
    });
    return {
        hasActiveDocument,
        hasAnyDocument,
        activeDocumentName,
        chatScopePending,
        chatScope,
        commandRunning,
    };
};
