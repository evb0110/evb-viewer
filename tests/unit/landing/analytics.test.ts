import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

function createResponse(body: unknown, ok = true) {
    return {
        json: vi.fn(async () => body),
        ok,
        status: ok ? 200 : 503,
    };
}

describe('landing analytics client', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('fetch', vi.fn(async () => createResponse({
            ok: true,
            persisted: true,
        })));
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses keepalive and requires a persisted response body', async () => {
        const fetch = vi.mocked(globalThis.fetch);
        const response = createResponse({
            ok: true,
            persisted: true,
        });
        fetch.mockResolvedValue(response as never);
        const {trackDownload} = await import('@landing/app/utils/analytics');

        trackDownload({
            arch: 'arm64',
            fileName: 'EVB-Viewer-arm64.dmg',
            platform: 'macos',
            version: '2.0.0',
        });
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

        expect(fetch).toHaveBeenCalledWith('/api/analytics/download', expect.objectContaining({
            credentials: 'same-origin',
            keepalive: true,
            method: 'POST',
        }));
        expect(response.json).toHaveBeenCalledOnce();
    });

    it('keeps identical events as separate retry requests', async () => {
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
        vi.stubGlobal('fetch', vi.fn(async () => createResponse({
            ok: false,
            persisted: false,
            retryable: true,
        })));
        const {trackPageView} = await import('@landing/app/utils/analytics');

        const payload = {
            path: '/privacy',
            referrer: null,
        };
        trackPageView(payload);
        trackPageView(payload);
        await vi.waitFor(() => {
            const queued = JSON.parse(values.get('evb.analytics.pending.v1') ?? '[]') as Array<{requestId: string}>;
            expect(queued).toHaveLength(2);
            expect(queued[0]?.requestId).not.toBe(queued[1]?.requestId);
        });
    });

    it('retains a response that reports non-persistence for a later retry', async () => {
        const values = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
        vi.stubGlobal('fetch', vi.fn(async () => createResponse({
            ok: false,
            persisted: false,
            retryable: true,
        })));
        const {trackPageView} = await import('@landing/app/utils/analytics');

        trackPageView({
            path: '/privacy',
            referrer: null,
        });
        await vi.waitFor(() => expect(values.get('evb.analytics.pending.v1')).toContain('/privacy'));
    });

    it('drops a permanently rejected queued event during replay', async () => {
        const values = new Map([
            ['evb.analytics.pending.v1', JSON.stringify([{
                path: '/api/analytics/pageView',
                payload: {path: '/privacy', referrer: null},
                requestId: 'rejected-event',
            }])],
        ]);
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
        });
        const fetch = vi.mocked(globalThis.fetch);
        fetch
            .mockResolvedValueOnce(createResponse({
                ok: true,
                persisted: false,
                retryable: false,
            }) as never)
            .mockResolvedValue(createResponse({
                ok: true,
                persisted: true,
            }) as never);
        const {trackPageView} = await import('@landing/app/utils/analytics');

        trackPageView({path: '/features', referrer: null});
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

        expect(JSON.parse(values.get('evb.analytics.pending.v1') ?? '[]')).toEqual([]);
        trackPageView({path: '/docs', referrer: null});
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
        expect(fetch.mock.calls[2]?.[0]).toBe('/api/analytics/pageView');
        expect(fetch.mock.calls.some(([, init]) => String(init?.body).includes('/privacy'))).toBe(true);
        expect(fetch.mock.calls.filter(([, init]) => String(init?.body).includes('/privacy'))).toHaveLength(1);
    });
});
