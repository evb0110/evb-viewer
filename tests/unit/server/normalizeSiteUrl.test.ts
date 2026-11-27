import {afterEach, describe, expect, it, vi} from 'vitest';
import type {H3Event} from 'h3';

const requestUrlMock = vi.hoisted(() => ({value: new URL('https://example.test/sitemap.xml')}));

vi.mock('h3', () => ({getRequestURL: () => requestUrlMock.value}));

describe('resolveSiteUrl', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        requestUrlMock.value = new URL('https://example.test/sitemap.xml');
    });

    it('prefers a configured canonical site URL over the request host', async () => {
        vi.stubGlobal('process', {env: {NUXT_PUBLIC_SITE_URL: 'https://canonical.example'}});
        requestUrlMock.value = new URL('https://hostile.example/sitemap.xml');
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(resolveSiteUrl({} as H3Event)).toBe('https://canonical.example/');
    });

    it('falls through empty canonical URL values in precedence order', async () => {
        vi.stubGlobal('process', {
            env: {
                NUXT_PUBLIC_SITE_URL: '',
                NUXT_SITE_URL: 'https://secondary.example',
                SITE_URL: 'https://fallback.example',
            },
        });
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(resolveSiteUrl({} as H3Event)).toBe('https://secondary.example/');
    });

    it('keeps whitespace-only canonical values from selecting lower-priority URLs', async () => {
        vi.stubGlobal('process', {
            env: {
                NODE_ENV: 'development',
                NUXT_PUBLIC_SITE_URL: '   ',
                NUXT_SITE_URL: 'https://secondary.example',
            },
        });
        requestUrlMock.value = new URL('https://request.example/sitemap.xml');
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(resolveSiteUrl({} as H3Event)).toBe('https://request.example/');
    });

    it('rejects malformed, non-web, and credential-bearing configured URLs', async () => {
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');
        for (const siteUrl of ['not a URL', 'javascript:alert(1)', 'https://user:secret@example.test']) {
            vi.stubGlobal('process', {env: {NUXT_PUBLIC_SITE_URL: siteUrl}});
            expect(() => resolveSiteUrl({} as H3Event)).toThrow(/Configured site URL/u);
        }
    });

    it('rejects request hosts outside the explicit sitemap allowlist', async () => {
        vi.stubGlobal('process', {
            env: {
                NODE_ENV: 'production',
                SITE_URL_ALLOWED_HOSTS: 'example.test',
            },
        });
        requestUrlMock.value = new URL('https://hostile.example/sitemap.xml');
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(() => resolveSiteUrl({} as H3Event)).toThrow(/configured canonical URL or allowed request host/u);
    });

    it('allows request hosts from the explicit sitemap allowlist', async () => {
        vi.stubGlobal('process', {
            env: {
                NODE_ENV: 'production',
                SITE_URL_ALLOWED_HOSTS: 'example.test, www.example.test',
            },
        });
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(resolveSiteUrl({} as H3Event)).toBe('https://example.test/');
    });

    it('uses the canonical production default during local prerender', async () => {
        vi.stubGlobal('process', {env: {NODE_ENV: 'production'}});
        requestUrlMock.value = new URL('http://localhost/sitemap.xml');
        const {resolveSiteUrl} = await import('@server/utils/normalizeSiteUrl');

        expect(resolveSiteUrl({} as H3Event)).toBe('https://web.evb-viewer.com/');
    });
});
