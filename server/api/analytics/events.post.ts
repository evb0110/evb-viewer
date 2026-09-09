import {
    createError,
    defineEventHandler,
    getHeader,
    setHeader,
} from 'h3';
import { getOptionalAnalyticsDb } from '@server/db';
import { admitViewerAnalyticsEvents } from '@server/db/admitViewerAnalyticsEvents';
import {
    extractGeo,
    getAnalyticsRequestHost,
    hashVisitorIdentity,
    isAnalyticsWriteAllowed,
    isTrustedAnalyticsRequest,
} from '@server/utils/analytics';
import {
    createAnalyticsDedupeKey,
    isAnalyticsAdmissionRejected,
    resolveRootAnalyticsAdmissionPolicy,
    ROOT_ANALYTICS_BODY_MAX_BYTES,
    ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH,
} from '@server/utils/analyticsAdmission';
import { readBoundedAnalyticsJsonBody } from '@server/utils/analyticsRequestBody';
import { decodeViewerAnalyticsEventsBody } from '@server/utils/decodeViewerAnalyticsEventsBody';
import { getRuntimeEnv } from '@server/utils/getRuntimeEnv';
import {captureServerFailure} from '@server/utils/serverFailureReporter';

export default defineEventHandler(async (event) => {
    setHeader(event, 'cache-control', 'no-store');

    if (!isAnalyticsWriteAllowed(event)) {
        return {
            ok: true,
            persisted: false,
            retryable: false,
        };
    }
    if (!isTrustedAnalyticsRequest(event)) {
        throw createError({
            statusCode: 403,
            statusMessage: 'Analytics request is not same-origin JSON',
        });
    }
    let db: ReturnType<typeof getOptionalAnalyticsDb>;
    try {
        db = getOptionalAnalyticsDb();
    } catch (error) {
        captureServerFailure({
            code: 'NITRO_ANALYTICS_DATABASE_INITIALIZATION_FAILED',
            context: {},
            local: {
                source: 'viewer-analytics',
                message: 'Viewer analytics database initialization failed',
                cause: error,
            },
        }, event);
        return {
            ok: false,
            persisted: false,
            retryable: true,
        };
    }
    if (!db) {
        return {
            ok: true,
            persisted: false,
            retryable: false,
        };
    }

    const body = await readBoundedAnalyticsJsonBody(event, ROOT_ANALYTICS_BODY_MAX_BYTES);
    const parsedEvents = decodeViewerAnalyticsEventsBody(body);
    if (parsedEvents.length === 0) {
        return {
            ok: true,
            persisted: false,
            retryable: false,
        };
    }

    const geo = extractGeo(event);
    const visitorHash = await hashVisitorIdentity(event);
    const userAgent = getHeader(event, 'user-agent')?.slice(0, ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH) ?? null;
    const deploymentHost = getAnalyticsRequestHost(event);
    const policy = resolveRootAnalyticsAdmissionPolicy(getRuntimeEnv());
    const dedupeKey = await createAnalyticsDedupeKey(
        'viewer_events',
        visitorHash,
        parsedEvents,
    );

    try {
        await admitViewerAnalyticsEvents(db, {
            ...policy,
            events: parsedEvents,
            visitorHash,
            deploymentHost,
            userAgent,
            country: geo.country,
            city: geo.city,
            region: geo.region,
            dedupeKey,
        });
    } catch (error) {
        if (isAnalyticsAdmissionRejected(error)) {
            return {
                ok: true,
                persisted: false,
                retryable: false,
            };
        }
        captureServerFailure({
            code: 'NITRO_ANALYTICS_INSERT_FAILED',
            context: {},
            local: {
                source: 'viewer-analytics',
                message: 'Viewer analytics insert failed',
                cause: error,
            },
        }, event);
        return {
            ok: false,
            persisted: false,
            retryable: true,
        };
    }

    return {
        ok: true,
        persisted: true,
        retryable: false,
        count: parsedEvents.length,
    };
});
