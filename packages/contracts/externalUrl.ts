import { assertNonEmptyString } from '@contracts/ipcAssertions';

export const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);

type TExternalUrlDecision =
    | {
        ok: true;
        normalizedUrl: string;
        url: URL;
    }
    | {
        ok: false;
        reason: 'empty' | 'invalid' | 'unsupported-protocol';
        protocol?: string;
    };

function tryParseUrl(value: string) {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

export function inspectAllowedExternalUrl(rawUrl: string): TExternalUrlDecision {
    const normalized = rawUrl.trim();
    if (!normalized) {
        return {
            ok: false,
            reason: 'empty',
        };
    }

    const parsed = tryParseUrl(normalized);
    if (!parsed) {
        return {
            ok: false,
            reason: 'invalid',
        };
    }
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
        return {
            ok: false,
            protocol: parsed.protocol,
            reason: 'unsupported-protocol',
        };
    }

    return {
        normalizedUrl: parsed.toString(),
        ok: true,
        url: parsed,
    };
}

export function normalizeAllowedExternalUrl(rawUrl: string) {
    const decision = inspectAllowedExternalUrl(rawUrl);
    return decision.ok
        ? decision.normalizedUrl
        : null;
}

export function sanitizeAllowedExternalUrl(rawUrl: unknown) {
    const normalized = assertNonEmptyString(rawUrl, 'url');
    const decision = inspectAllowedExternalUrl(normalized);
    if (decision.ok) {
        return decision.normalizedUrl;
    }

    if (decision.reason === 'unsupported-protocol') {
        throw new Error(`Unsupported external URL protocol: ${decision.protocol ?? '<missing>'}`);
    }

    throw new Error('Invalid external URL');
}
