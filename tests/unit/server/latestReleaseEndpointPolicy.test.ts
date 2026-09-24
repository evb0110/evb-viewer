import {resolve} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

// The endpoint reads nothing off the event beyond the cookie helpers these
// tests stub, so one stand-in serves every invocation.
const eventStub = {} as never;

const release = {
    tag_name: 'v2.0.0',
    name: 'EVB Viewer v2',
    published_at: '2026-08-19T00:00:00Z',
    html_url: 'https://github.com/evb0110/evb-viewer/releases/tag/v2.0.0',
    assets: [
        {
            id: 1,
            name: 'EVB-Viewer-2.0.0-x64.exe',
            browser_download_url: 'https://github.com/evb0110/evb-viewer/releases/download/v2.0.0/EVB-Viewer-2.0.0-x64.exe',
            size: 1_024,
            updated_at: '2026-08-19T00:00:00Z',
            content_type: 'application/octet-stream',
        },
        {
            id: 2,
            name: 'EVB-Viewer-2.0.0-x64.zip',
            browser_download_url: 'https://github.com/evb0110/evb-viewer/releases/download/v2.0.0/EVB-Viewer-2.0.0-x64.zip',
            size: 2_048,
            updated_at: '2026-08-19T00:00:00Z',
            content_type: 'application/zip',
        },
        {
            id: 3,
            name: 'EVB-Viewer-2.0.0-arm64-setup.exe',
            browser_download_url: 'https://github.com/evb0110/evb-viewer/releases/download/v2.0.0/EVB-Viewer-2.0.0-arm64-setup.exe',
            size: 3_072,
            updated_at: '2026-08-19T00:00:00Z',
            content_type: 'application/octet-stream',
        },
    ],
};

describe('latest release endpoint policy', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it('sets a private response and an opaque cohort cookie without freezing a device recommendation', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        const setHeader = vi.fn();
        const setCookie = vi.fn();
        const fetch = vi.fn(async () => [release]);
        // The macOS Intel ZIP and the Windows ARM64 installer are attached
        // after promotion, so the mirror answers for them only once the
        // supplemental workflow has copied them.
        const probedMirrorUrls: string[] = [];
        const mirrorProbe = vi.fn(async (url: string) => {
            probedMirrorUrls.push(url);
            return {ok: false};
        });
        vi.stubGlobal('fetch', mirrorProbe);
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
        vi.stubGlobal('useRuntimeConfig', () => ({
            githubApiBase: 'https://api.github.com',
            githubOwner: 'evb0110',
            githubRepo: 'evb-viewer',
            githubToken: '',
            releaseMirrorBaseUrl: 'https://mirror.example.test/releases',
            releaseStableTags: '',
            releaseWithdrawnTags: '',
            releaseCanaryTag: '',
            releaseCanaryPercent: '0',
        }));
        vi.stubGlobal('setHeader', setHeader);
        vi.stubGlobal('getCookie', vi.fn(() => undefined));
        vi.stubGlobal('setCookie', setCookie);
        vi.stubGlobal('$fetch', fetch);
        vi.stubGlobal('createError', (details: {statusMessage: string}) => new Error(details.statusMessage));
        const endpointPath = resolve(process.cwd(), 'landing/server/api/releases/latest.get.ts');
        const {default: handler} = await import(endpointPath);

        const response = await handler(eventStub);

        expect(setHeader).toHaveBeenCalledWith({}, 'cache-control', 'private, no-store, max-age=0');
        expect(setCookie).toHaveBeenCalledWith(
            {},
            'evb_release_cohort',
            expect.stringMatching(/^[a-f\d-]{36}$/u),
            expect.objectContaining({
                httpOnly: true,
                maxAge: 7_776_000,
                path: '/api/releases/latest',
                sameSite: 'lax',
                secure: true,
            }),
        );
        expect(response.recommendation).toEqual({
            platform: 'unknown',
            arch: 'unknown',
            assetId: null,
        });
        const responseAssets = response.assets as Array<{
            name: string;
            mirrorDownloadUrl?: string
        }>;
        expect(responseAssets.find((asset: {name: string}) => asset.name.endsWith('x64.exe'))?.mirrorDownloadUrl)
            .toBe('https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-x64.exe');
        expect(responseAssets.find((asset: {name: string}) => asset.name.endsWith('x64.zip'))?.mirrorDownloadUrl).toBeUndefined();
        expect(responseAssets.find((asset: {name: string}) => asset.name.endsWith('arm64-setup.exe'))?.mirrorDownloadUrl).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(probedMirrorUrls).toEqual([
            'https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-x64.zip',
            'https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-arm64-setup.exe',
        ]);
    });

    it('offers mirror downloads for supplemental installers the mirror already holds', async () => {
        const fetch = vi.fn(async () => [release]);
        const mirrorProbe = vi.fn(async () => ({ok: true}));
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
        vi.stubGlobal('useRuntimeConfig', () => ({
            githubApiBase: 'https://api.github.com',
            githubOwner: 'evb0110',
            githubRepo: 'evb-viewer',
            githubToken: '',
            releaseMirrorBaseUrl: 'https://mirror.example.test/releases',
            releaseStableTags: '',
            releaseWithdrawnTags: '',
            releaseCanaryTag: '',
            releaseCanaryPercent: '0',
        }));
        vi.stubGlobal('setHeader', vi.fn());
        vi.stubGlobal('getCookie', vi.fn(() => undefined));
        vi.stubGlobal('setCookie', vi.fn());
        vi.stubGlobal('$fetch', fetch);
        vi.stubGlobal('fetch', mirrorProbe);
        vi.stubGlobal('createError', (details: {statusMessage: string}) => new Error(details.statusMessage));
        const endpointPath = resolve(process.cwd(), 'landing/server/api/releases/latest.get.ts');
        const {default: handler} = await import(endpointPath);

        const response = await handler(eventStub);
        const repeated = await handler(eventStub);

        const responseAssets = response.assets as Array<{
            name: string;
            mirrorDownloadUrl?: string
        }>;
        expect(responseAssets.find(asset => asset.name.endsWith('x64.zip'))?.mirrorDownloadUrl)
            .toBe('https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-x64.zip');
        expect(responseAssets.find(asset => asset.name.endsWith('arm64-setup.exe'))?.mirrorDownloadUrl)
            .toBe('https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-arm64-setup.exe');
        expect(repeated.assets).toEqual(response.assets);
        // An immutable object that answered once is not probed again.
        expect(mirrorProbe).toHaveBeenCalledTimes(2);
    });

    it('omits the mirror link instead of failing when the mirror cannot answer', async () => {
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const fetch = vi.fn(async () => [release]);
        const mirrorProbe = vi.fn().mockRejectedValue(new Error('TimeoutError'));
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
        vi.stubGlobal('useRuntimeConfig', () => ({
            githubApiBase: 'https://api.github.com',
            githubOwner: 'evb0110',
            githubRepo: 'evb-viewer',
            githubToken: '',
            releaseMirrorBaseUrl: 'https://mirror.example.test/releases',
            releaseStableTags: '',
            releaseWithdrawnTags: '',
            releaseCanaryTag: '',
            releaseCanaryPercent: '0',
        }));
        vi.stubGlobal('setHeader', vi.fn());
        vi.stubGlobal('getCookie', vi.fn(() => undefined));
        vi.stubGlobal('setCookie', vi.fn());
        vi.stubGlobal('$fetch', fetch);
        vi.stubGlobal('fetch', mirrorProbe);
        vi.stubGlobal('createError', (details: {statusMessage: string}) => new Error(details.statusMessage));

        try {
            const endpointPath = resolve(process.cwd(), 'landing/server/api/releases/latest.get.ts');
            const {default: handler} = await import(endpointPath);

            const response = await handler(eventStub);

            const responseAssets = response.assets as Array<{
                name: string;
                mirrorDownloadUrl?: string
            }>;
            expect(responseAssets.find(asset => asset.name.endsWith('x64.exe'))?.mirrorDownloadUrl)
                .toBe('https://mirror.example.test/releases/v2.0.0/EVB-Viewer-2.0.0-x64.exe');
            expect(responseAssets.find(asset => asset.name.endsWith('x64.zip'))?.mirrorDownloadUrl).toBeUndefined();
            expect(consoleWarn).toHaveBeenCalledWith(
                'Unable to probe the release mirror',
                expect.objectContaining({outcome: 'mirror-link-omitted'}),
            );
        } finally {
            consoleWarn.mockRestore();
        }
    });

    it('logs exhausted catalog availability as a warning without creating an occurrence', async () => {
        vi.useFakeTimers();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const upstreamError = {response: {status: 503}};
        const fetch = vi.fn().mockRejectedValue(upstreamError);
        const createError = vi.fn((details: {
            statusCode: number;
            statusMessage: string;
        }) => Object.assign(
            new Error(details.statusMessage),
            details,
        ));

        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler);
        vi.stubGlobal('useRuntimeConfig', () => ({
            githubApiBase: 'https://api.github.com',
            githubOwner: 'evb0110',
            githubRepo: 'evb-viewer',
            githubToken: '',
            releaseMirrorBaseUrl: '',
            releaseStableTags: '',
            releaseWithdrawnTags: '',
            releaseCanaryTag: '',
            releaseCanaryPercent: '0',
        }));
        vi.stubGlobal('setHeader', vi.fn());
        vi.stubGlobal('getCookie', vi.fn(() => undefined));
        vi.stubGlobal('setCookie', vi.fn());
        vi.stubGlobal('$fetch', fetch);
        vi.stubGlobal('createError', createError);

        try {
            const endpointPath = resolve(process.cwd(), 'landing/server/api/releases/latest.get.ts');
            const {default: handler} = await import(endpointPath);
            const request = handler(eventStub);
            const rejection = expect(request).rejects.toMatchObject({
                statusCode: 503,
                statusMessage: 'Release catalog is temporarily unavailable',
            });

            await vi.runAllTimersAsync();

            await rejection;
            expect(consoleWarn).toHaveBeenCalledWith('Unable to fetch release catalog', expect.objectContaining({
                outcome: 'temporarily-unavailable',
                statusCode: 503,
            }));
            expect(consoleError).not.toHaveBeenCalled();
            expect(fetch).toHaveBeenCalledTimes(3);
        } finally {
            consoleWarn.mockRestore();
            consoleError.mockRestore();
            vi.useRealTimers();
        }
    });
});
