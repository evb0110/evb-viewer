import {
    tryOnScopeDispose,
    useEventListener,
} from '@vueuse/core';
import { isPlainObject as isToolkitPlainObject } from 'es-toolkit/predicate';
import type {
    JsonObject,
    JsonValue,
} from 'type-fest';
import { isBrowserPlatformActive } from '@app/utils/platform';
import {
    createBrowserSafeId,
    safeGetSessionStorageItem,
    safeSetSessionStorageItem,
} from '@app/utils/browserSafe';
import {
    isViewerAnalyticsResponse,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
import { createIsoTimestamp } from '@contracts/timestamps';
import {
    createSessionId,
    parseSessionId,
    requireSessionId,
    type TSessionId,
} from '@contracts/shared';
import type {
    IAnalyticsDocumentContext,
    IAnalyticsEventEnvelope,
    TAnalyticsEventName,
    TAnalyticsScreenCategory,
} from '@contracts/analytics';

const ANALYTICS_SESSION_STORAGE_KEY = 'evb-viewer:analytics-session-id';
const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 100;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 500;
const MAX_NORMALIZE_DEPTH = 4;
const FLUSH_DELAY_MS = 1_500;

interface IAnalyticsBrowserState {
    activeDocumentScopeKey: string | null;
    documentContexts: Map<string, IAnalyticsDocumentContext>;
    flushTimer: number | null;
    isFlushing: boolean;
    lifecycleCleanup: (() => void) | null;
    lifecycleConsumers: number;
    lifecycleInstalled: boolean;
    queue: IAnalyticsEventEnvelope[];
    sessionId: TSessionId | null;
}

type TNormalizedAnalyticsEntry = readonly [string, JsonValue];
const LEGACY_DOCUMENT_SCOPE_KEY = 'legacy';

const analyticsBrowserState: IAnalyticsBrowserState = {
    activeDocumentScopeKey: null,
    documentContexts: new Map(),
    flushTimer: null,
    isFlushing: false,
    lifecycleCleanup: null,
    lifecycleConsumers: 0,
    lifecycleInstalled: false,
    queue: [],
    sessionId: null,
};

export interface IAnalyticsDocumentScope {
    readonly key: string;
    activate: () => void;
    clear: () => void;
    deactivate: () => void;
    dispose: () => void;
    merge: (nextContext: Partial<IAnalyticsDocumentContext>) => void;
    set: (nextContext: IAnalyticsDocumentContext | null) => void;
}

function isTruthyFlag(value: unknown) {
    return value === true
        || value === 1
        || value === '1'
        || value === 'true';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return isToolkitPlainObject(value);
}

function normalizePayloadValue(
    value: unknown,
    depth = 0,
): JsonValue | undefined {
    const scalar = normalizeAnalyticsScalar(value, {
        maxStringLength: MAX_STRING_LENGTH,
        nonFiniteFallback: undefined,
    });
    if (scalar !== undefined || value === undefined) {
        return scalar;
    }

    if (depth >= MAX_NORMALIZE_DEPTH) {
        return undefined;
    }

    if (Array.isArray(value)) {
        const normalizedItems: JsonValue[] = [];
        for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
            const normalizedItem = normalizePayloadValue(item, depth + 1);
            if (normalizedItem !== undefined) {
                normalizedItems.push(normalizedItem);
            }
        }
        return normalizedItems;
    }

    if (!isPlainObject(value)) {
        return undefined;
    }

    const normalizedEntries: TNormalizedAnalyticsEntry[] = [];
    for (const entry of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
        const key = entry[0];
        const entryValue = entry[1];
        const normalizedValue = normalizePayloadValue(entryValue, depth + 1);
        if (normalizedValue === undefined) {
            continue;
        }

        normalizedEntries.push([
            key.slice(0, 64),
            normalizedValue,
        ] as const);
    }

    return Object.fromEntries(normalizedEntries);
}

function normalizePayload(
    payload: Record<string, unknown> | undefined,
): JsonObject {
    if (!payload) {
        return {};
    }

    const normalizedValue = normalizePayloadValue(payload);
    return isPlainObject(normalizedValue) ? normalizedValue : {};
}

function normalizeDocumentContext(
    context: Partial<IAnalyticsDocumentContext>,
): IAnalyticsDocumentContext {
    return normalizePayload(context);
}

function getScreenCategory(width: number): TAnalyticsScreenCategory {
    if (width < 768) {
        return 'mobile';
    }
    if (width < 1200) {
        return 'tablet';
    }
    return 'desktop';
}

function isClientAnalyticsEnabled(enabledFlag: unknown) {
    return import.meta.client
        && isBrowserPlatformActive()
        && isTruthyFlag(enabledFlag);
}

function getBrowserLocale() {
    const documentLocale = document.documentElement.lang.trim();
    if (documentLocale) {
        return documentLocale;
    }

    const [preferredLanguage] = navigator.languages;
    if (typeof preferredLanguage === 'string' && preferredLanguage.trim()) {
        return preferredLanguage;
    }

    return typeof navigator.language === 'string' && navigator.language.trim()
        ? navigator.language
        : null;
}

function getSessionId() {
    if (!import.meta.client) {
        return requireSessionId('server');
    }

    if (analyticsBrowserState.sessionId) {
        return analyticsBrowserState.sessionId;
    }

    const existingValue = safeGetSessionStorageItem(ANALYTICS_SESSION_STORAGE_KEY);
    const parsedExistingValue = parseSessionId(existingValue);
    if (parsedExistingValue !== null) {
        analyticsBrowserState.sessionId = parsedExistingValue;
        return parsedExistingValue;
    }

    const nextValue = parseSessionId(createBrowserSafeId()) ?? createSessionId('analytics');
    analyticsBrowserState.sessionId = nextValue;
    safeSetSessionStorageItem(ANALYTICS_SESSION_STORAGE_KEY, nextValue);

    return nextValue;
}

function clearFlushTimer() {
    if (analyticsBrowserState.flushTimer) {
        clearTimeout(analyticsBrowserState.flushTimer);
        analyticsBrowserState.flushTimer = null;
    }
}

async function postAnalyticsBatch(
    events: IAnalyticsEventEnvelope[],
    useBeacon = false,
) {
    if (!import.meta.client || events.length === 0) {
        return 'persisted' as const;
    }

    const body = JSON.stringify({ events });

    if (useBeacon && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(
            '/api/analytics/events',
            new Blob([body], { type: 'application/json' }),
        );
        return 'retryable' as const;
    }

    const response = await fetch('/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
    });

    let responseBody: unknown = null;
    try {
        responseBody = await response.json();
    } catch {
        return 'retryable' as const;
    }

    if (response.ok && isViewerAnalyticsResponse(responseBody) && responseBody.persisted) {
        return 'persisted' as const;
    }

    if (isViewerAnalyticsResponse(responseBody) && !responseBody.retryable) {
        return 'permanent' as const;
    }

    return 'retryable' as const;
}

async function flushAnalyticsQueue(enabledFlag: unknown, useBeacon = false) {
    if (!isClientAnalyticsEnabled(enabledFlag) || analyticsBrowserState.queue.length === 0) {
        return;
    }

    if (analyticsBrowserState.isFlushing && !useBeacon) {
        return;
    }

    clearFlushTimer();

    const batch = analyticsBrowserState.queue.splice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) {
        return;
    }

    if (!useBeacon) {
        analyticsBrowserState.isFlushing = true;
    }

    try {
        const outcome = await postAnalyticsBatch(batch, useBeacon);
        if (outcome !== 'persisted' && outcome !== 'permanent') {
            analyticsBrowserState.queue = [
                ...batch,
                ...analyticsBrowserState.queue,
            ].slice(0, MAX_QUEUE_SIZE);
        }
    } catch {
        analyticsBrowserState.queue = [
            ...batch,
            ...analyticsBrowserState.queue,
        ].slice(0, MAX_QUEUE_SIZE);
    } finally {
        if (!useBeacon) {
            analyticsBrowserState.isFlushing = false;
        }
    }
}

function ensureAnalyticsLifecycle(enabledFlag: unknown) {
    if (!isClientAnalyticsEnabled(enabledFlag) || analyticsBrowserState.lifecycleInstalled) {
        return;
    }

    analyticsBrowserState.lifecycleInstalled = true;

    const flushWithBeacon = () => {
        void flushAnalyticsQueue(enabledFlag, true);
    };
    const flushWhenHidden = () => {
        if (document.visibilityState === 'hidden') {
            flushWithBeacon();
        }
    };

    const lifecycleScope = effectScope(true);
    lifecycleScope.run(() => {
        useEventListener(window, 'pagehide', flushWithBeacon);
        useEventListener(document, 'visibilitychange', flushWhenHidden);
    });
    analyticsBrowserState.lifecycleCleanup = () => {
        lifecycleScope.stop();
        analyticsBrowserState.lifecycleCleanup = null;
        analyticsBrowserState.lifecycleInstalled = false;
    };
}

function retainAnalyticsLifecycle(enabledFlag: unknown) {
    if (!isClientAnalyticsEnabled(enabledFlag)) {
        return;
    }

    analyticsBrowserState.lifecycleConsumers += 1;
    ensureAnalyticsLifecycle(enabledFlag);
}

function releaseAnalyticsLifecycle() {
    if (analyticsBrowserState.lifecycleConsumers <= 0) {
        return;
    }

    analyticsBrowserState.lifecycleConsumers -= 1;
    if (analyticsBrowserState.lifecycleConsumers > 0) {
        return;
    }

    analyticsBrowserState.lifecycleCleanup?.();
    clearFlushTimer();
}

function getDocumentContext(scopeKey: string | null) {
    if (!scopeKey) {
        return null;
    }

    return analyticsBrowserState.documentContexts.get(scopeKey) ?? null;
}

function getActiveDocumentContext() {
    return getDocumentContext(analyticsBrowserState.activeDocumentScopeKey)
        ?? getDocumentContext(LEGACY_DOCUMENT_SCOPE_KEY);
}

function setScopedDocumentContext(
    scopeKey: string,
    nextContext: IAnalyticsDocumentContext | null,
) {
    if (nextContext) {
        analyticsBrowserState.documentContexts.set(scopeKey, normalizeDocumentContext(nextContext));
        return;
    }

    analyticsBrowserState.documentContexts.delete(scopeKey);
}

function mergeScopedDocumentContext(
    scopeKey: string,
    nextContext: Partial<IAnalyticsDocumentContext>,
) {
    analyticsBrowserState.documentContexts.set(scopeKey, {
        ...(analyticsBrowserState.documentContexts.get(scopeKey) ?? {}),
        ...normalizeDocumentContext(nextContext),
    });
}

export const useAnalytics = () => {
    const runtimeConfig = useRuntimeConfig();
    const enabledFlag = runtimeConfig.public.analyticsEnabled ?? false;
    retainAnalyticsLifecycle(enabledFlag);
    if (!tryOnScopeDispose(() => {
        releaseAnalyticsLifecycle();
    })) {
        releaseAnalyticsLifecycle();
    }

    function createDocumentScope(
        key: string,
        options: {
            activate?: boolean;
            context?: IAnalyticsDocumentContext | null;
        } = {},
    ): IAnalyticsDocumentScope {
        const normalizedKey = key.trim() || createBrowserSafeId();
        let disposed = false;

        if (options.context !== undefined) {
            setScopedDocumentContext(normalizedKey, options.context);
        }
        if (options.activate === true) {
            analyticsBrowserState.activeDocumentScopeKey = normalizedKey;
        }

        function assertActive() {
            return !disposed && isClientAnalyticsEnabled(enabledFlag);
        }

        const scope: IAnalyticsDocumentScope = {
            key: normalizedKey,
            activate() {
                if (disposed) {
                    return;
                }
                analyticsBrowserState.activeDocumentScopeKey = normalizedKey;
            },
            clear() {
                if (!assertActive()) {
                    return;
                }
                analyticsBrowserState.documentContexts.delete(normalizedKey);
            },
            deactivate() {
                if (analyticsBrowserState.activeDocumentScopeKey === normalizedKey) {
                    analyticsBrowserState.activeDocumentScopeKey = null;
                }
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                analyticsBrowserState.documentContexts.delete(normalizedKey);
                if (analyticsBrowserState.activeDocumentScopeKey === normalizedKey) {
                    analyticsBrowserState.activeDocumentScopeKey = null;
                }
            },
            merge(nextContext) {
                if (!assertActive()) {
                    return;
                }
                mergeScopedDocumentContext(normalizedKey, nextContext);
            },
            set(nextContext) {
                if (!assertActive()) {
                    return;
                }
                setScopedDocumentContext(normalizedKey, nextContext);
            },
        };

        tryOnScopeDispose(scope.dispose);
        return scope;
    }

    function getDefaultDocumentScopeKey() {
        return analyticsBrowserState.activeDocumentScopeKey ?? LEGACY_DOCUMENT_SCOPE_KEY;
    }

    function mergeDocumentContext(nextContext: Partial<IAnalyticsDocumentContext>) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        mergeScopedDocumentContext(getDefaultDocumentScopeKey(), nextContext);
    }

    function setDocumentContext(nextContext: IAnalyticsDocumentContext | null) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        setScopedDocumentContext(getDefaultDocumentScopeKey(), nextContext);
    }

    function clearDocumentContext() {
        analyticsBrowserState.documentContexts.delete(getDefaultDocumentScopeKey());
    }

    function track(
        name: TAnalyticsEventName,
        payload?: Record<string, unknown>,
        options?: {
            includeReferrer?: boolean;
            path?: string;
        },
    ) {
        if (!isClientAnalyticsEnabled(enabledFlag)) {
            return;
        }

        ensureAnalyticsLifecycle(enabledFlag);

        const locale = getBrowserLocale();
        const normalizedPayload = normalizePayload({
            ...(getActiveDocumentContext() ?? {}),
            ...(payload ?? {}),
        });

        analyticsBrowserState.queue.push({
            name,
            occurredAt: createIsoTimestamp(),
            path: (options?.path ?? window.location.pathname).slice(0, 255),
            locale: typeof locale === 'string' ? locale.slice(0, 16) : null,
            referrer: options?.includeReferrer ? (document.referrer || null) : null,
            screenCategory: getScreenCategory(window.innerWidth),
            sessionId: getSessionId(),
            payload: normalizedPayload,
        });

        if (analyticsBrowserState.queue.length > MAX_QUEUE_SIZE) {
            analyticsBrowserState.queue = analyticsBrowserState.queue.slice(-MAX_QUEUE_SIZE);
        }

        if (analyticsBrowserState.queue.length >= MAX_BATCH_SIZE) {
            void flushAnalyticsQueue(enabledFlag);
            return;
        }

        analyticsBrowserState.flushTimer ??= window.setTimeout(() => {
            analyticsBrowserState.flushTimer = null;
            void flushAnalyticsQueue(enabledFlag);
        }, FLUSH_DELAY_MS);
    }

    return {
        clearDocumentContext,
        createDocumentScope,
        enabled: isClientAnalyticsEnabled(enabledFlag),
        flush: (useBeacon = false) => flushAnalyticsQueue(enabledFlag, useBeacon),
        installLifecycle: () => ensureAnalyticsLifecycle(enabledFlag),
        mergeDocumentContext,
        setDocumentContext,
        track,
    };
};
