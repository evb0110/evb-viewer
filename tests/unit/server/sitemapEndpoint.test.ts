import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveSiteUrl: vi.fn(),
    setHeader: vi.fn(),
}));

vi.mock('h3', () => ({
    defineEventHandler: (handler: unknown) => handler,
    setHeader: mocks.setHeader,
}));

vi.mock('@server/utils/normalizeSiteUrl', () => ({resolveSiteUrl: mocks.resolveSiteUrl}));

describe('sitemap endpoint', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.resolveSiteUrl.mockReturnValue('https://configured.example/');
    });

    it('returns the exact ordered public URL inventory from the configured site', async () => {
        const {default: handler} = await import('@server/routes/sitemap.xml');
        const event = {} as never;

        const xml = handler(event);
        const entries = [...xml.matchAll(/<url>\s*([\s\S]*?)\s*<\/url>/gu)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
        const topLevelLocations = entries.map((entry) => entry.match(/<loc>([^<]+)<\/loc>/u)?.[1]);

        expect(entries).toHaveLength(2);
        expect(topLevelLocations).toEqual(['https://configured.example/', 'https://configured.example/privacy']);
        expect(entries[0]).toContain('<image:loc>https://configured.example/evb-viewer-seo.png</image:loc>');
        expect(entries[0]).toContain('<image:title>EVB Viewer Web — browser document workspace</image:title>');
        expect(entries[1]).not.toContain('<image:');
        expect(xml).not.toContain('<lastmod>');
        expect(mocks.resolveSiteUrl).toHaveBeenCalledOnce();
        expect(mocks.resolveSiteUrl).toHaveBeenCalledWith(event);
        expect(mocks.setHeader).toHaveBeenCalledWith(event, 'content-type', 'application/xml; charset=utf-8');
    });
});
