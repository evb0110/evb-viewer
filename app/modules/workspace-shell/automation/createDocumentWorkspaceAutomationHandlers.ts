import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';
import type { TDocumentCommitReceipt } from '@app/types/workspaceExpose';

interface IDocumentWorkspaceAutomationContext extends Record<string, unknown> {
    currentPage: number;
    documentRevisionToken: string | null;
    path: unknown;
    tabId: string;
    totalPages: number;
}

interface ICreateDocumentWorkspaceAutomationHandlersOptions {
    getContext: () => IDocumentWorkspaceAutomationContext;
    handleSave: (onCommitted?: TDocumentCommitReceipt) => Promise<boolean>;
}

export function createDocumentWorkspaceAutomationHandlers(
    options: ICreateDocumentWorkspaceAutomationHandlersOptions,
) {
    function handleInitialVisualReady() {
        emitAutomationEvent('first-page-rendered', options.getContext());
    }

    // The Save returns at its durable result; the event names the revision
    // and file it committed, read when it commits, never after.
    async function handleSave() {
        let committed: Record<string, unknown> | null = null;
        const saved = await options.handleSave((documentRevisionToken) => {
            const {path, tabId} = options.getContext();
            committed = {documentRevisionToken, path, tabId};
        });
        // A clean document commits nothing; its Save resolves without waiting, on the same document.
        if (saved) {
            const {documentRevisionToken, path, tabId} = options.getContext();
            emitAutomationEvent('save-committed', committed ?? {documentRevisionToken, path, tabId});
        }
        return saved;
    }

    return {
        handleInitialVisualReady,
        handleSave,
    };
}
