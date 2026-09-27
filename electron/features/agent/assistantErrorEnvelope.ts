import type {
    IAgentAssistantErrorEnvelope,
    TAgentAssistantErrorCode,
} from '@contracts/agent';
import {createEpochMs} from '@contracts/timestamps';

export function classifyAssistantError(message: string): {
    code: TAgentAssistantErrorCode;
    retryable: boolean;
} {
    const normalized = message.toLowerCase();
    if (normalized.includes('sign in') || normalized.includes('login') || normalized.includes('auth')) {
        return {
            code: normalized.includes('cancel') ? 'LOGIN_CANCELLED' : 'AUTH_REQUIRED',
            retryable: true,
        };
    }
    if (normalized.includes('install') || normalized.includes('not found') || normalized.includes('missing')) {
        return {
            code: 'INSTALL_MISSING',
            retryable: true,
        };
    }
    if (normalized.includes('interrupt') || normalized.includes('cancel')) {
        return {
            code: 'USER_INTERRUPTED',
            retryable: false,
        };
    }
    if (normalized.includes('model') && (normalized.includes('unavailable') || normalized.includes('unknown'))) {
        return {
            code: 'MODEL_UNAVAILABLE',
            retryable: true,
        };
    }
    if (normalized.includes('rate limit') || normalized.includes('429') || normalized.includes('too many requests')) {
        return {
            code: 'PROVIDER_RATE_LIMITED',
            retryable: true,
        };
    }
    if (normalized.includes('runtime') || normalized.includes('server') || normalized.includes('process')) {
        return {
            code: 'RUNTIME_UNAVAILABLE',
            retryable: true,
        };
    }
    return {
        code: 'INTERNAL',
        retryable: false,
    };
}

export function createAssistantErrorEnvelope(message: string): IAgentAssistantErrorEnvelope {
    const classified = classifyAssistantError(message);
    return {
        code: classified.code,
        message,
        retryable: classified.retryable,
        details: {timestamp: createEpochMs()},
    };
}

export function withAssistantErrorEnvelope<T extends {
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}>(
    value: T,
): T;
export function withAssistantErrorEnvelope<T extends object>(
    value: T,
): T;
export function withAssistantErrorEnvelope<T extends object>(
    value: T,
): T {
    const candidate = value as {
        error?: unknown;
        errorEnvelope?: unknown;
    };

    if (typeof candidate.error !== 'string' || !candidate.error || candidate.errorEnvelope) {
        return value;
    }
    return {
        ...value,
        errorEnvelope: createAssistantErrorEnvelope(candidate.error),
    };
}
