import type {FailurePresentation} from '@app/composables/useFailureToast';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getErrorMessage} from '@app/utils/error';
import {captureFailureForPresentation} from '@app/utils/failureReporter';
import {isRecord} from '@contracts/runtimeGuards';
import {
    getFailureReceipt,
    isExpectedOutcome,
    type ExpectedOutcome,
    type ExpectedOutcomeCode,
} from '@contracts/diagnostics/failureReceipt';
export type TAssistantFailureAction =
    | 'refresh'
    | 'install'
    | 'login'
    | 'cancel'
    | 'switch-provider'
    | 'load'
    | 'scope-refresh'
    | 'send'
    | 'retry'
    | 'interrupt'
    | 'reset'
    | 'mcp-refresh'
    | 'mcp-update'
    | 'mcp-install';

export type TAssistantActionErrorTarget = 'status' | 'composer' | 'none';

export interface IAssistantActionErrorOptions {
    action: TAssistantFailureAction;
    title: string;
    target?: TAssistantActionErrorTarget;
    expected?: ExpectedOutcomeCode;
}

export function createAssistantActionOptions(
    action: TAssistantFailureAction,
    title: string,
    target?: TAssistantActionErrorTarget,
    expected?: ExpectedOutcomeCode,
): IAssistantActionErrorOptions {
    const options: IAssistantActionErrorOptions = {
        action,
        title,
    };
    if (target !== undefined) {
        options.target = target;
    }
    if (expected !== undefined) {
        options.expected = expected;
    }
    return options;
}

const EXPECTED_ASSISTANT_ERROR_OUTCOMES: Readonly<Record<string, ExpectedOutcomeCode>> = {
    AUTH_REQUIRED: 'handled-absence',
    INSTALL_MISSING: 'handled-absence',
    LOGIN_CANCELLED: 'canceled',
    USER_INTERRUPTED: 'canceled',
    MODEL_UNAVAILABLE: 'temporarily-unavailable',
    RUNTIME_UNAVAILABLE: 'temporarily-unavailable',
    PROVIDER_RATE_LIMITED: 'temporarily-unavailable',
};

function getAssistantErrorEnvelopeCode(error: unknown) {
    if (!isRecord(error) || !isRecord(error.errorEnvelope)) {
        return null;
    }
    return typeof error.errorEnvelope.code === 'string'
        ? error.errorEnvelope.code
        : null;
}

function isCancellationError(error: unknown) {
    const name = isRecord(error) && typeof error.name === 'string'
        ? error.name
        : null;
    if (
        name === 'AbortError'
        || name === 'AbortException'
        || name === 'RenderingCancelledException'
    ) {
        return true;
    }

    const code = isRecord(error) && typeof error.code === 'string'
        ? error.code
        : null;
    return code === 'ABORT_ERR' || code === 'ERR_CANCELED';
}

export function getAssistantExpectedOutcome(
    error: unknown,
    forcedCode?: ExpectedOutcomeCode,
): ExpectedOutcome | null {
    if (forcedCode) {
        return {
            kind: 'expected',
            code: forcedCode,
        };
    }
    if (isRecord(error) && isExpectedOutcome(error.expected)) {
        return error.expected;
    }

    const errorCode = getAssistantErrorEnvelopeCode(error);
    const expectedCode = errorCode === null
        ? isCancellationError(error) ? 'canceled' : undefined
        : EXPECTED_ASSISTANT_ERROR_OUTCOMES[errorCode];
    return expectedCode === undefined
        ? null
        : {
            kind: 'expected',
            code: expectedCode,
        };
}

export interface IAssistantFailureOptions {
    action: TAssistantFailureAction;
    title: string;
    description?: string;
    logMessage?: string;
    section?: string;
}

export function captureAssistantFailure(
    error: unknown,
    options: IAssistantFailureOptions,
): FailurePresentation {
    const existingFailure = getFailureReceipt(error);
    const capture = existingFailure
        ? {failure: existingFailure}
        : captureFailureForPresentation({
            code: 'ASSISTANT_ACTION_FAILED',
            local: {
                source: options.section ?? 'assistant',
                message: options.logMessage ?? options.title,
                cause: error,
                data: {action: options.action},
            },
        });
    const logMessage = options.logMessage ?? options.title;
    BrowserLogger.error(
        options.section ?? 'assistant',
        logMessage,
        error,
        capture.failure,
    );

    const description = options.description ?? getErrorMessage(error);
    return {
        ...capture,
        title: options.title,
        ...(description.trim().length > 0 ? {description} : {}),
    };
}
