import type {IAgentAssistantErrorEnvelope, TAgentAssistantErrorCode} from '@contracts/agent';
import {isRecord} from '@contracts/runtimeGuards';
import {createEpochMs} from '@contracts/timestamps';
import {te} from '@electron/te';

// Adapted from T3 Code provider-core/server/failure.ts (0b6f482dc5), MIT.
// EVB additionally removes hosts and whole URLs, including endpoint paths.
export function sanitizeAssistantProviderText(value: string, limit = 4096): string {
    const safe = Array.from(value, character => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 8 || (point >= 11 && point <= 31) || point === 127 ? ' ' : character;
    }).join('')
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu, '[redacted endpoint]')
        .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"']*)?/giu, '[redacted host]')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gu, '[redacted host]')
        .replace(/\b(?:localhost|\[[a-f0-9:]+\])(?::\d+)?/giu, '[redacted host]')
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
        .replace(/(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu, '$1[redacted]$2')
        .replace(/((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[redacted]')
        .replace(/\b([A-Z][A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gu, '$1=[redacted]')
        .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+\b/gu, '[redacted]')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted]')
        .trim();
    if (safe.length <= limit) return safe;
    let end = limit - 1;
    if (/[\ud800-\udbff]/u.test(safe[end - 1] ?? '')) end -= 1;
    return `${safe.slice(0, end)}…`;
}

/** Unwrap native error/cause records and JSON messages without rendering JSON. */
function providerFailure(value: unknown) {
    let message = '';
    let code = '';
    let status: number | undefined;
    let retryable: boolean | undefined;
    const seen = new Set<unknown>();
    let parsedJson = false;
    let failureClass: IAgentAssistantErrorEnvelope['class'];
    for (let depth = 0; depth < 16 && value != null && !seen.has(value); depth += 1) {
        seen.add(value);
        if (typeof value === 'string') {
            message = value;
            if (!parsedJson) {
                const start = value.indexOf('{');
                if (start >= 0) {
                    parsedJson = true;
                    try { value = JSON.parse(value.slice(start)); continue; } catch { /* Plain provider text. */ }
                }
            }
            break;
        }
        if (!isRecord(value) && !(value instanceof Error)) break;
        const record = value as Record<string, unknown>;
        if (typeof record.message === 'string') message = record.message;
        if (typeof record.code === 'string' || typeof record.code === 'number') code = String(record.code);
        else if (typeof record.type === 'string' && record.type !== 'error') code = record.type;
        if (typeof record.status === 'number') status = record.status;
        if (typeof record.retryable === 'boolean') retryable = record.retryable;
        switch (record.class) {
            case 'usage_limit': case 'provider_error': case 'transport_error':
            case 'permission_error': case 'validation_error': case 'unknown':
                failureClass = record.class;
        }
        value = record.error ?? record.cause ?? record.data ?? record.message;
    }
    return {message, code, status, retryable, failureClass};
}

export function createAssistantErrorEnvelope(value: unknown): IAgentAssistantErrorEnvelope {
    const native = providerFailure(value);
    const text = native.message.toLowerCase();
    const nativeCode = native.code.toLowerCase();
    let code: TAgentAssistantErrorCode = 'INTERNAL';
    let failureClass: NonNullable<IAgentAssistantErrorEnvelope['class']> = 'unknown';
    let retryable = false;
    if (native.status === 429 || /rate_limit|usage_limit|quota/.test(nativeCode) || /rate limit|too many requests/.test(text)) {
        code = 'PROVIDER_RATE_LIMITED'; failureClass = 'usage_limit'; retryable = true;
    } else if (native.status === 401 || /authentication|unauthorized|invalid_api_key/.test(nativeCode) || /sign in|not logged in|login required/.test(text)) {
        code = 'AUTH_REQUIRED'; failureClass = 'permission_error';
    } else if (nativeCode === 'model_not_found' || /model.*(?:not supported|unavailable|unknown|not found)/.test(text)) {
        code = 'MODEL_UNAVAILABLE'; failureClass = 'provider_error';
    } else if (nativeCode === 'ENOENT'.toLowerCase() || /executable.*not found|not installed|install .*first|missing.*(?:codex|claude)|codex.*not found|claude.*not found/.test(text)) {
        code = 'INSTALL_MISSING'; failureClass = 'validation_error';
    } else if (/interrupt|cancel|aborted/.test(text)) {
        code = /sign.in|login/.test(text) ? 'LOGIN_CANCELLED' : 'USER_INTERRUPTED'; failureClass = 'unknown';
    } else if ((native.status !== undefined && native.status >= 500) || /econnreset|econnrefused|etimedout|overloaded/.test(nativeCode) || /timed out|timeout|did not (?:answer|finish|initialize)|network|connection|process.*(?:exit|stop)|server.*(?:closed|unavailable)/.test(text)) {
        code = 'RUNTIME_UNAVAILABLE'; failureClass = 'transport_error'; retryable = true;
    } else if (native.status === 403 || nativeCode === 'permission_error') {
        failureClass = 'permission_error';
    } else if (native.status === 400 || nativeCode === 'invalid_request_error') {
        failureClass = 'validation_error';
    } else if (native.code || native.status) {
        failureClass = 'provider_error';
    }
    // Permanent selection/auth/configuration failures cannot be repaired by resending.
    if (code !== 'MODEL_UNAVAILABLE' && code !== 'AUTH_REQUIRED' && code !== 'INSTALL_MISSING') retryable = native.retryable ?? retryable;
    const readable = native.message.trim().startsWith('{') ? '' : native.message;
    return {
        code,
        class: native.failureClass ?? failureClass,
        ...(native.code && /^[a-z0-9_.-]{1,128}$/iu.test(native.code) ? {providerCode: sanitizeAssistantProviderText(native.code, 128)} : {}),
        message: sanitizeAssistantProviderText(readable) || te('dialogs.agentAssistant.providerFailureFallback'),
        retryable,
        details: {timestamp: createEpochMs()},
    };
}

export function withAssistantErrorEnvelope<T extends object>(value: T): T {
    const candidate = value as {error?: unknown; errorEnvelope?: unknown};
    if (typeof candidate.error !== 'string' || !candidate.error || candidate.errorEnvelope) return value;
    const errorEnvelope = createAssistantErrorEnvelope(candidate.error);
    return {...value, error: errorEnvelope.message, errorEnvelope};
}
