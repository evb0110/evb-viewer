import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

interface IDocumentWorkspaceAutomationContext extends Record<string, unknown> {
    currentPage: number;
    documentRevisionToken: string | null;
    path: unknown;
    tabId: string;
    totalPages: number;
}

interface ICreateDocumentWorkspaceAutomationHandlersOptions {
    getContext: () => IDocumentWorkspaceAutomationContext;
    handleSave: () => Promise<boolean>;
}

export function createDocumentWorkspaceAutomationHandlers(
    options: ICreateDocumentWorkspaceAutomationHandlersOptions,
) {
    function handleInitialVisualReady() {
        emitAutomationEvent('first-page-rendered', options.getContext());
    }

    async function handleSave() {
        const saved = await options.handleSave();
        if (saved) {
            const {
                documentRevisionToken,
                path,
                tabId,
            } = options.getContext();
            emitAutomationEvent('save-committed', {
                documentRevisionToken,
                path,
                tabId,
            });
        }
        return saved;
    }

    return {
        handleInitialVisualReady,
        handleSave,
    };
}
