import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { useWebSeo } from '@app/composables/useWebSeo';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({
        locale: ref('en'),
        t: (key: string) => key,
    }),
}));

const seoMetaInputs: Array<Record<string, unknown>> = [];
const headInputs: unknown[] = [];

function installSeoStubs(siteUrl: unknown) {
    vi.stubGlobal('useRuntimeConfig', () => ({public: {siteUrl}}));
    vi.stubGlobal('useSeoMeta', (input: Record<string, unknown>) => {
        seoMetaInputs.push(input);
    });
    vi.stubGlobal('useHead', (input: unknown) => {
        headInputs.push(input);
    });
}

function seoMeta(field: string) {
    const input = seoMetaInputs.at(-1);
    expect(input).toBeDefined();
    const value = input![field];
    return typeof value === 'function' ? value() : value;
}

interface IHeadPayload {
    htmlAttrs: {lang: string};
    titleTemplate: (title?: string | null) => string;
    link: Array<{
        rel: string;
        href: string;
    }>;
    script: Array<{
        key: string;
        type: string;
        innerHTML: string;
    }>;
}

function headPayload(): IHeadPayload {
    const input = headInputs.at(-1);
    expect(typeof input).toBe('function');
    return (input as () => IHeadPayload)();
}

afterEach(() => {
    vi.unstubAllGlobals();
    seoMetaInputs.length = 0;
    headInputs.length = 0;
});

describe('useWebSeo', () => {
    it('falls back to the default site URL when none is configured', () => {
        installSeoStubs('');
        useWebSeo();
        expect(seoMeta('ogUrl')).toBe('https://web.evb-viewer.com/');
        expect(seoMeta('ogImage')).toBe('https://web.evb-viewer.com/evb-viewer-seo.png');
        expect(String(seoMeta('robots'))).toContain('index, follow');
    });

    it('normalizes a configured site URL', () => {
        installSeoStubs(' Example.com/docs?utm=1#frag ');
        useWebSeo();
        expect(seoMeta('ogUrl')).toBe('https://example.com/');
        expect(seoMeta('ogImage')).toBe('https://example.com/evb-viewer-seo.png');
    });

    it('falls back when the configured site URL cannot be parsed', () => {
        installSeoStubs('https://exa mple.com');
        useWebSeo();
        expect(seoMeta('ogUrl')).toBe('https://web.evb-viewer.com/');
    });

    it('ignores a non-string configured site URL', () => {
        installSeoStubs(42);
        useWebSeo();
        expect(seoMeta('ogUrl')).toBe('https://web.evb-viewer.com/');
    });

    it('publishes structured data, canonical link, and locale for indexable pages', () => {
        installSeoStubs('');
        useWebSeo();
        const payload = headPayload();
        expect(payload.htmlAttrs.lang).toBe('en');
        expect(payload.link).toEqual([{
            rel: 'canonical',
            href: 'https://web.evb-viewer.com/',
        }]);
        expect(payload.script.map(script => script.key)).toEqual([
            'ld-web-application',
            'ld-website',
            'ld-webpage',
        ]);
        const webApplication = JSON.parse(payload.script[0]!.innerHTML) as Record<string, unknown>;
        expect(webApplication['@type']).toBe('WebApplication');
        expect(webApplication.screenshot).toMatchObject({
            width: seoMeta('ogImageWidth'),
            height: seoMeta('ogImageHeight'),
        });
        expect(webApplication.offers).toMatchObject({price: '0'});
        expect(payload.titleTemplate('Docs')).toContain('Docs');
    });

    it('sets noindex robots and drops structured data when asked', () => {
        installSeoStubs('');
        useWebSeo({noindex: true});
        expect(seoMeta('robots')).toBe('noindex, nofollow');
        expect(headPayload().script).toEqual([]);
    });

    it('keeps the SEO image constants in sync with the shipped PNG', () => {
        const png = readFileSync(join(process.cwd(), 'public/evb-viewer-seo.png'));
        installSeoStubs('');
        useWebSeo();
        expect(seoMeta('ogImageWidth')).toBe(png.readUInt32BE(16));
        expect(seoMeta('ogImageHeight')).toBe(png.readUInt32BE(20));
    });
});
