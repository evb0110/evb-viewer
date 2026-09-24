import { getErrorMessage } from '@app/utils/error';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';

interface IDocumentWorkspaceCrashOptions {tabId: string;}

export function handleDocumentWorkspaceCrash(
    error: unknown,
    componentName: string | null,
    info: string,
    options: IDocumentWorkspaceCrashOptions,
) {
    const errorDiagnostic = error instanceof Error
        ? {
            name: error.name,
            message: getErrorMessage(error),
            stack: error.stack ?? null,
            cause: error.cause instanceof Error
                ? {
                    name: error.cause.name,
                    message: getErrorMessage(error.cause),
                    stack: error.cause.stack ?? null,
                }
                : error.cause ?? null,
        }
        : error;
    const failure = getFailureReceipt(error) ?? BrowserLogger.error('workspace-host', 'Document tab crashed; isolating the failed workspace', {
        tabId: options.tabId,
        component: componentName,
        info,
        error: errorDiagnostic,
    }, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'});
    return failure;
}
