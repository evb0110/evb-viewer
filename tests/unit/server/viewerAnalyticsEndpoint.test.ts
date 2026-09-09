import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    admitViewerAnalyticsEvents: vi.fn(),
    captureServerFailure: vi.fn(),
    createAnalyticsDedupeKey: vi.fn(),
    decodeViewerAnalyticsEventsBody: vi.fn(),
    extractGeo: vi.fn(),
    getAnalyticsRequestHost: vi.fn(),
    getOptionalAnalyticsDb: vi.fn(),
    getRuntimeEnv: vi.fn(),
    hashVisitorIdentity: vi.fn(),
    isAnalyticsAdmissionRejected: vi.fn(),
    isAnalyticsWriteAllowed: vi.fn(),
    isTrustedAnalyticsRequest: vi.fn(),
    readBoundedAnalyticsJsonBody: vi.fn(),
    resolveRootAnalyticsAdmissionPolicy: vi.fn(),
    setHeader: vi.fn(),
}));

vi.mock('h3', () => ({
    createError: (details: Record<string, unknown>) => Object.assign(
        new Error(String(details.statusMessage ?? 'Request failed')),
        details,
    ),
    defineEventHandler: (handler: unknown) => handler,
    getHeader: () => undefined,
    setHeader: mocks.setHeader,
}));

vi.mock('@server/db', () => ({getOptionalAnalyticsDb: mocks.getOptionalAnalyticsDb}));
vi.mock('@server/db/admitViewerAnalyticsEvents', () => ({admitViewerAnalyticsEvents: mocks.admitViewerAnalyticsEvents}));
vi.mock('@server/utils/analytics', () => ({
    extractGeo: mocks.extractGeo,
    getAnalyticsRequestHost: mocks.getAnalyticsRequestHost,
    hashVisitorIdentity: mocks.hashVisitorIdentity,
    isAnalyticsWriteAllowed: mocks.isAnalyticsWriteAllowed,
    isTrustedAnalyticsRequest: mocks.isTrustedAnalyticsRequest,
}));
vi.mock('@server/utils/analyticsAdmission', () => ({
    createAnalyticsDedupeKey: mocks.createAnalyticsDedupeKey,
    isAnalyticsAdmissionRejected: mocks.isAnalyticsAdmissionRejected,
    resolveRootAnalyticsAdmissionPolicy: mocks.resolveRootAnalyticsAdmissionPolicy,
    ROOT_ANALYTICS_BODY_MAX_BYTES: 1_024,
    ROOT_ANALYTICS_USER_AGENT_MAX_LENGTH: 1_024,
}));
vi.mock('@server/utils/analyticsRequestBody', () => ({readBoundedAnalyticsJsonBody: mocks.readBoundedAnalyticsJsonBody}));
vi.mock('@server/utils/decodeViewerAnalyticsEventsBody', () => ({decodeViewerAnalyticsEventsBody: mocks.decodeViewerAnalyticsEventsBody}));
vi.mock('@server/utils/getRuntimeEnv', () => ({getRuntimeEnv: mocks.getRuntimeEnv}));
vi.mock('@server/utils/serverFailureReporter', () => ({captureServerFailure: mocks.captureServerFailure}));

describe('viewer analytics endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isAnalyticsAdmissionRejected.mockReturnValue(false);
        mocks.isAnalyticsWriteAllowed.mockReturnValue(true);
        mocks.isTrustedAnalyticsRequest.mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('skips request processing when analytics storage is not configured', async () => {
        mocks.getOptionalAnalyticsDb.mockReturnValue(null);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler({} as never)).resolves.toEqual({
            ok: true,
            persisted: false,
            retryable: false,
        });
        expect(mocks.getOptionalAnalyticsDb).toHaveBeenCalledWith();
        expect(mocks.readBoundedAnalyticsJsonBody).not.toHaveBeenCalled();
        expect(mocks.hashVisitorIdentity).not.toHaveBeenCalled();
        expect(mocks.captureServerFailure).not.toHaveBeenCalled();
    });

    it('returns a controlled failure when database initialization fails', async () => {
        const initializationError = new Error('database client failed');
        mocks.getOptionalAnalyticsDb.mockImplementation(() => {
            throw initializationError;
        });
        const {default: handler} = await import('@server/api/analytics/events.post');
        const event = {} as never;

        await expect(handler(event)).resolves.toEqual({
            ok: false,
            persisted: false,
            retryable: true,
        });
        expect(mocks.getOptionalAnalyticsDb).toHaveBeenCalledWith();
        expect(mocks.readBoundedAnalyticsJsonBody).not.toHaveBeenCalled();
        expect(mocks.admitViewerAnalyticsEvents).not.toHaveBeenCalled();
        expect(mocks.captureServerFailure).toHaveBeenCalledWith({
            code: 'NITRO_ANALYTICS_DATABASE_INITIALIZATION_FAILED',
            context: {},
            local: {
                source: 'viewer-analytics',
                message: 'Viewer analytics database initialization failed',
                cause: initializationError,
            },
        }, event);
    });

    it('reports storage failures without copying request data into diagnostics', async () => {
        const insertError = new Error('insert failed');
        const event = {requestSecret: 'must-not-cross'} as never;
        mocks.getOptionalAnalyticsDb.mockReturnValue({});
        mocks.readBoundedAnalyticsJsonBody.mockResolvedValue({});
        mocks.decodeViewerAnalyticsEventsBody.mockReturnValue([{name: 'open'}]);
        mocks.extractGeo.mockReturnValue({
            country: null,
            city: null,
            region: null,
        });
        mocks.hashVisitorIdentity.mockResolvedValue('visitor-hash');
        mocks.getAnalyticsRequestHost.mockReturnValue('evb-viewer.com');
        mocks.getRuntimeEnv.mockReturnValue({});
        mocks.resolveRootAnalyticsAdmissionPolicy.mockReturnValue({});
        mocks.createAnalyticsDedupeKey.mockResolvedValue('dedupe-key');
        mocks.admitViewerAnalyticsEvents.mockRejectedValue(insertError);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler(event)).resolves.toEqual({
            ok: false,
            persisted: false,
            retryable: true,
        });
        expect(mocks.captureServerFailure).toHaveBeenCalledWith({
            code: 'NITRO_ANALYTICS_INSERT_FAILED',
            context: {},
            local: {
                source: 'viewer-analytics',
                message: 'Viewer analytics insert failed',
                cause: insertError,
            },
        }, event);
    });

    it('classifies admission rejection as a permanent non-persistence outcome', async () => {
        mocks.getOptionalAnalyticsDb.mockReturnValue({});
        mocks.readBoundedAnalyticsJsonBody.mockResolvedValue({});
        mocks.decodeViewerAnalyticsEventsBody.mockReturnValue([{name: 'open'}]);
        mocks.extractGeo.mockReturnValue({
            country: null,
            city: null,
            region: null,
        });
        mocks.hashVisitorIdentity.mockResolvedValue('visitor-hash');
        mocks.getAnalyticsRequestHost.mockReturnValue('evb-viewer.com');
        mocks.getRuntimeEnv.mockReturnValue({});
        mocks.resolveRootAnalyticsAdmissionPolicy.mockReturnValue({});
        mocks.createAnalyticsDedupeKey.mockResolvedValue('dedupe-key');
        mocks.admitViewerAnalyticsEvents.mockRejectedValue(new Error('rejected'));
        mocks.isAnalyticsAdmissionRejected.mockReturnValue(true);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler({} as never)).resolves.toEqual({
            ok: true,
            persisted: false,
            retryable: false,
        });
        expect(mocks.captureServerFailure).not.toHaveBeenCalled();
    });

    it('reports successful persistence as an acknowledgement outcome', async () => {
        mocks.getOptionalAnalyticsDb.mockReturnValue({});
        mocks.readBoundedAnalyticsJsonBody.mockResolvedValue({});
        mocks.decodeViewerAnalyticsEventsBody.mockReturnValue([{name: 'open'}]);
        mocks.extractGeo.mockReturnValue({
            country: null,
            city: null,
            region: null,
        });
        mocks.hashVisitorIdentity.mockResolvedValue('visitor-hash');
        mocks.getAnalyticsRequestHost.mockReturnValue('evb-viewer.com');
        mocks.getRuntimeEnv.mockReturnValue({});
        mocks.resolveRootAnalyticsAdmissionPolicy.mockReturnValue({});
        mocks.createAnalyticsDedupeKey.mockResolvedValue('dedupe-key');
        mocks.admitViewerAnalyticsEvents.mockResolvedValue(undefined);
        const {default: handler} = await import('@server/api/analytics/events.post');

        await expect(handler({} as never)).resolves.toEqual({
            ok: true,
            persisted: true,
            retryable: false,
            count: 1,
        });
    });
});
