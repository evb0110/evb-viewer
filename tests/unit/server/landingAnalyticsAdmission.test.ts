/* This test intentionally exercises the standalone landing project. */
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createLandingAnalyticsVisitorHash,
    isLandingAnalyticsAdmissionRejected,
    isLandingAnalyticsWriteAllowedForHost,
    isTrustedLandingAnalyticsRequestValues,
    LANDING_ANALYTICS_ADMISSION_DEFAULTS,
    LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE,
    resolveLandingAnalyticsAdmissionPolicy,
} from '../../../landing/server/utils/analytics';
import {
    decodeBoundedLandingAnalyticsJsonStream,
    parseLandingAnalyticsContentLength,
} from '../../../landing/server/utils/analyticsRequestBody';

function createBodyStream(body: string) {
    const bytes = new TextEncoder().encode(body);
    return new ReadableStream<Uint8Array>({start(controller) {
        controller.enqueue(bytes);
        controller.close();
    }});
}

describe('landing analytics admission policy', () => {
    it('never enables writes from DATABASE_URL alone', () => {
        expect(isLandingAnalyticsWriteAllowedForHost({DATABASE_URL: 'postgres://configured'}, 'evb-viewer.com')).toBe(false);
    });

    it('matches explicit enablement and allowed-host behavior', () => {
        expect(isLandingAnalyticsWriteAllowedForHost({
            LANDING_ANALYTICS_HASH_SECRET: 'a'.repeat(32),
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
            LANDING_ANALYTICS_ALLOWED_HOSTS: 'evb-viewer.com,www.evb-viewer.com',
        }, 'EVB-VIEWER.COM')).toBe(true);
        expect(isLandingAnalyticsWriteAllowedForHost({
            LANDING_ANALYTICS_HASH_SECRET: 'a'.repeat(32),
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
            LANDING_ANALYTICS_ALLOWED_HOSTS: 'evb-viewer.com',
        }, 'attacker.example')).toBe(false);
    });

    it('fails closed without a sufficiently strong hashing secret', () => {
        expect(isLandingAnalyticsWriteAllowedForHost({LANDING_ANALYTICS_WRITE_ENABLED: 'true'}, 'evb-viewer.com')).toBe(false);
        expect(isLandingAnalyticsWriteAllowedForHost({
            LANDING_ANALYTICS_HASH_SECRET: 'short',
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
        }, 'evb-viewer.com')).toBe(false);
        expect(isLandingAnalyticsWriteAllowedForHost({
            ANALYTICS_HASH_SECRET: 'a'.repeat(32),
            LANDING_ANALYTICS_WRITE_ENABLED: 'true',
        }, 'evb-viewer.com')).toBe(false);
    });

    it('requires same-origin JSON before analytics admission', () => {
        const trusted = {
            contentType: 'application/json; charset=utf-8',
            fetchSite: 'same-origin',
            origin: 'https://evb-viewer.com',
            requestOrigin: 'https://evb-viewer.com',
        };
        expect(isTrustedLandingAnalyticsRequestValues(trusted)).toBe(true);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            contentType: 'text/plain',
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            contentType: undefined,
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            fetchSite: 'cross-site',
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            fetchSite: undefined,
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            origin: 'https://attacker.example',
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            origin: undefined,
        })).toBe(false);
        expect(isTrustedLandingAnalyticsRequestValues({
            ...trusted,
            requestOrigin: undefined,
        })).toBe(false);
    });

    it('uses a keyed daily HMAC for visitor admission identities', async () => {
        const input = {
            date: '2026-08-19',
            ip: '203.0.113.7',
            secret: 'a'.repeat(32),
        };
        const hash = await createLandingAnalyticsVisitorHash(input);
        await expect(createLandingAnalyticsVisitorHash(input)).resolves.toBe(hash);
        await expect(createLandingAnalyticsVisitorHash({
            ...input,
            secret: 'b'.repeat(32),
        })).resolves.not.toBe(hash);
        await expect(createLandingAnalyticsVisitorHash({
            ...input,
            date: '2026-08-20',
        })).resolves.not.toBe(hash);
        await expect(createLandingAnalyticsVisitorHash({
            ...input,
            secret: 'short',
        })).rejects.toThrow('not configured securely');
    });

    it('uses surface-specific defaults and clamps overrides', () => {
        expect(resolveLandingAnalyticsAdmissionPolicy('download', {})).toEqual({
            bucketSeconds: LANDING_ANALYTICS_ADMISSION_DEFAULTS.bucketSeconds,
            dedupeSeconds: LANDING_ANALYTICS_ADMISSION_DEFAULTS.dedupeSeconds,
            globalEventLimit: LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadGlobalEventLimit,
            visitorEventLimit: LANDING_ANALYTICS_ADMISSION_DEFAULTS.downloadVisitorEventLimit,
        });
        expect(resolveLandingAnalyticsAdmissionPolicy('page_view', {
            LANDING_ANALYTICS_BUCKET_SECONDS: '9999',
            LANDING_ANALYTICS_PAGE_VIEW_GLOBAL_LIMIT: '1',
            LANDING_ANALYTICS_PAGE_VIEW_VISITOR_LIMIT: '999',
        })).toMatchObject({
            bucketSeconds: 3_600,
            globalEventLimit: 50,
            visitorEventLimit: 300,
        });
    });

    it('maps only the dedicated SQLSTATE to non-persisted admission', () => {
        expect(isLandingAnalyticsAdmissionRejected({cause: {code: LANDING_ANALYTICS_ADMISSION_REJECTED_SQLSTATE}})).toBe(true);
        expect(isLandingAnalyticsAdmissionRejected({code: '08006'})).toBe(false);
    });
});

describe('landing analytics body decoder', () => {
    it('rejects invalid and oversized Content-Length values', () => {
        expect(parseLandingAnalyticsContentLength('8', 8)).toBe(8);
        expect(() => parseLandingAnalyticsContentLength('-1', 8)).toThrow('Invalid Content-Length');
        expect(() => parseLandingAnalyticsContentLength('9', 8)).toThrow('too large');
    });

    it('caps the stream before parsing JSON', async () => {
        await expect(decodeBoundedLandingAnalyticsJsonStream(
            createBodyStream('{"path":"/oversized"}'),
            null,
            8,
        )).rejects.toMatchObject({statusCode: 413});
        await expect(decodeBoundedLandingAnalyticsJsonStream(
            createBodyStream('{"path":"/"}'),
            12,
            64,
        )).resolves.toEqual({path: '/'});
    });
});
