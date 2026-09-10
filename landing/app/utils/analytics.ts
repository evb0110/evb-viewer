interface IAnalyticsPageViewPayload {
    path: string;
    referrer: string | null;
}

interface IAnalyticsDownloadPayload {
    platform: string;
    arch: string;
    version: string;
    fileName: string;
}

type TAnalyticsPayload = IAnalyticsPageViewPayload | IAnalyticsDownloadPayload;

interface IQueuedAnalyticsRequest {
    requestId: string;
    path: '/api/analytics/pageView' | '/api/analytics/download';
    payload: TAnalyticsPayload;
}

type TAnalyticsRequestOutcome = 'persisted' | 'permanent-rejection' | 'retryable-failure';

const ANALYTICS_QUEUE_STORAGE_KEY = 'evb.analytics.pending.v1';
const MAX_QUEUED_ANALYTICS_REQUESTS = 20;
let replayPromise: Promise<void> | null = null;
let analyticsRequestSequence = 0;

export function isAnalyticsResponsePersisted(value: unknown): value is { persisted: true } {
    return typeof value === 'object'
        && value !== null
        && 'persisted' in value
        && value.persisted === true;
}

function getAnalyticsStorage() {
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

function createAnalyticsRequestId() {
    try {
        return globalThis.crypto.randomUUID();
    } catch {
        // Fall back to a process-local ID when the browser does not expose
        // crypto.randomUUID or its implementation rejects the call.
    }
    analyticsRequestSequence += 1;
    return `${Date.now().toString(36)}-${analyticsRequestSequence.toString(36)}`;
}

function readQueuedAnalyticsRequests(): IQueuedAnalyticsRequest[] {
    const storage = getAnalyticsStorage();
    if (!storage) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(storage.getItem(ANALYTICS_QUEUE_STORAGE_KEY) ?? '[]');
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap((request): IQueuedAnalyticsRequest[] => {
            if (typeof request !== 'object' || request === null) {
                return [];
            }
            const candidate = request as {
                requestId?: unknown;
                path?: unknown;
                payload?: unknown;
            };
            if ((candidate.path !== '/api/analytics/pageView'
                && candidate.path !== '/api/analytics/download')
                || typeof candidate.payload !== 'object'
                || candidate.payload === null) {
                return [];
            }
            return [{
                requestId: typeof candidate.requestId === 'string' && candidate.requestId.length > 0
                    ? candidate.requestId
                    : createAnalyticsRequestId(),
                path: candidate.path,
                payload: candidate.payload as TAnalyticsPayload,
            }];
        });
    } catch {
        return [];
    }
}

function writeQueuedAnalyticsRequests(requests: IQueuedAnalyticsRequest[]) {
    const storage = getAnalyticsStorage();
    if (!storage) {
        return;
    }
    try {
        storage.setItem(
            ANALYTICS_QUEUE_STORAGE_KEY,
            JSON.stringify(requests.slice(-MAX_QUEUED_ANALYTICS_REQUESTS)),
        );
    } catch {
        // Storage is a best-effort retry buffer. The keepalive request still
        // carries the current event during a page navigation.
    }
}

function enqueueAnalyticsRequest(request: IQueuedAnalyticsRequest) {
    const requests = readQueuedAnalyticsRequests();
    if (!requests.some(candidate => candidate.requestId === request.requestId)) {
        requests.push(request);
        writeQueuedAnalyticsRequests(requests);
    }
}

async function sendAnalyticsRequest(
    request: IQueuedAnalyticsRequest,
    queueOnFailure: boolean,
): Promise<TAnalyticsRequestOutcome> {
    if (typeof fetch !== 'function') {
        if (queueOnFailure) {
            enqueueAnalyticsRequest(request);
        }
        return 'retryable-failure';
    }

    try {
        const response = await fetch(request.path, {
            body: JSON.stringify(request.payload),
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/json'},
            keepalive: true,
            method: 'POST',
        });
        let responseBody: unknown = null;
        try {
            responseBody = await response.json();
        } catch {
            // A non-JSON response is a failed persistence acknowledgement.
        }
        if (response.ok && isAnalyticsResponsePersisted(responseBody)) {
            return 'persisted';
        }

        const permanentRejection = typeof responseBody === 'object'
            && responseBody !== null
            && 'retryable' in responseBody
            && responseBody.retryable === false;
        const outcome = permanentRejection ? 'permanent-rejection' : 'retryable-failure';
        if (queueOnFailure && outcome === 'retryable-failure') {
            enqueueAnalyticsRequest(request);
        }
        return outcome;
    } catch {
        if (queueOnFailure) {
            enqueueAnalyticsRequest(request);
        }
        return 'retryable-failure';
    }
}

async function replayQueuedAnalyticsRequests() {
    if (replayPromise) {
        return replayPromise;
    }
    replayPromise = (async () => {
        const queued = readQueuedAnalyticsRequests();
        if (queued.length === 0) {
            return;
        }
        writeQueuedAnalyticsRequests([]);
        for (const request of queued) {
            if (await sendAnalyticsRequest(request, false) === 'retryable-failure') {
                enqueueAnalyticsRequest(request);
            }
        }
    })().finally(() => {
        replayPromise = null;
    });
    return replayPromise;
}

function postAnalytics(path: IQueuedAnalyticsRequest['path'], payload: TAnalyticsPayload) {
    const request = {
        path,
        payload,
        requestId: createAnalyticsRequestId(),
    };
    void replayQueuedAnalyticsRequests();
    void sendAnalyticsRequest(request, true);
}

export function trackPageView(payload: IAnalyticsPageViewPayload) {
    postAnalytics('/api/analytics/pageView', payload);
}

export function trackDownload(payload: IAnalyticsDownloadPayload) {
    postAnalytics('/api/analytics/download', payload);
}
