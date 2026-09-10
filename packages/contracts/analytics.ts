import type {
    JsonObject,
    JsonValue,
} from 'type-fest';
import type {TSessionId} from '@contracts/shared';
import type {TIsoTimestamp} from '@contracts/timestamps';

export const ANALYTICS_EVENT_NAMES = [
    'viewer_session_started',
    'browser_install_hint_interacted',
    'document_opened',
    'search_executed',
    'viewer_mode_changed',
    'save_completed',
    'page_operation_completed',
    'export_completed',
] as const;

export type TAnalyticsEventName = typeof ANALYTICS_EVENT_NAMES[number];

export type TAnalyticsScreenCategory = 'mobile' | 'tablet' | 'desktop';

export const ANALYTICS_GEO_LIMITS = {
    country: 2,
    region: 32,
    city: 255,
    timezone: 64,
} as const;

export type TAnalyticsPayloadValue = JsonValue;

export interface IAnalyticsDocumentContext {
    documentKind?: 'pdf' | 'djvu';
    fileExtension?: string | null;
    fileSizeBucket?: string | null;
    isGenerated?: boolean;
    pageCountBucket?: string | null;
    totalPages?: number | null;
}

export interface IAnalyticsEventEnvelope {
    name: TAnalyticsEventName;
    // Analytics is an external server wire format, so it keeps ISO text.
    occurredAt: TIsoTimestamp;
    path: string;
    locale: string | null;
    referrer: string | null;
    screenCategory: TAnalyticsScreenCategory;
    sessionId: TSessionId;
    payload: JsonObject;
}

export type TViewerAnalyticsResponse =
    | {
        ok: true;
        persisted: true;
        retryable: false;
        count: number;
    }
    | {
        ok: false;
        persisted: false;
        retryable: true;
    }
    | {
        ok: true;
        persisted: false;
        retryable: false;
    };

export function isViewerAnalyticsResponse(value: unknown): value is TViewerAnalyticsResponse {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    if (typeof candidate.ok !== 'boolean'
        || typeof candidate.persisted !== 'boolean'
        || typeof candidate.retryable !== 'boolean') {
        return false;
    }

    if (candidate.persisted === true) {
        return candidate.ok === true
            && candidate.retryable === false
            && typeof candidate.count === 'number'
            && Number.isInteger(candidate.count)
            && candidate.count > 0;
    }

    return candidate.ok === true && candidate.retryable === false
        || candidate.ok === false && candidate.retryable === true;
}

export interface IAnalyticsGeoData {
    country: string | null;
    city: string | null;
    region: string | null;
    timezone: string | null;
}

export interface INormalizeAnalyticsScalarOptions {
    maxStringLength: number;
    nonFiniteFallback: TAnalyticsPayloadValue | undefined;
}

export type TAnalyticsScalarResult = TAnalyticsPayloadValue | undefined;

function normalizeOptionalAnalyticsString(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim();
    return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeAnalyticsCountry(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toUpperCase();
    return normalized && /^[A-Z]{2}$/u.test(normalized) ? normalized : null;
}

export function normalizeAnalyticsGeo(value: {
    country?: unknown;
    city?: unknown;
    region?: unknown;
    timezone?: unknown;
}): IAnalyticsGeoData {
    return {
        country: normalizeAnalyticsCountry(value.country),
        city: normalizeOptionalAnalyticsString(value.city, ANALYTICS_GEO_LIMITS.city),
        region: normalizeOptionalAnalyticsString(value.region, ANALYTICS_GEO_LIMITS.region),
        timezone: normalizeOptionalAnalyticsString(value.timezone, ANALYTICS_GEO_LIMITS.timezone),
    };
}

export function normalizeAnalyticsScalar(
    value: unknown,
    options: INormalizeAnalyticsScalarOptions,
): TAnalyticsScalarResult {
    if (value === null) {
        return null;
    }
    if (typeof value === 'string') {
        return value.slice(0, options.maxStringLength);
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : options.nonFiniteFallback;
    }
    return undefined;
}
