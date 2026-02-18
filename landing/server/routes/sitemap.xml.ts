import {
    buildAbsoluteUrl,
    LANDING_ROUTE_PATHS,
    normalizeSiteUrl,
} from '~~/shared/seo';

const CHANGE_FREQUENCY: Record<(typeof LANDING_ROUTE_PATHS)[number], string> = {
    '/': 'daily',
    '/features': 'weekly',
    '/docs': 'weekly',
};

const PRIORITY: Record<(typeof LANDING_ROUTE_PATHS)[number], string> = {
    '/': '1.0',
    '/features': '0.8',
    '/docs': '0.8',
};

export default defineEventHandler((event) => {
    const runtimeConfig = useRuntimeConfig(event);
    const siteUrl = normalizeSiteUrl(runtimeConfig.public.siteUrl);
    const modifiedAt = new Date().toISOString();

    const urlEntries = LANDING_ROUTE_PATHS.map((path) => {
        const location = buildAbsoluteUrl(siteUrl, path);
        const changeFreq = CHANGE_FREQUENCY[path];
        const priority = PRIORITY[path];

        return [
            '  <url>',
            `    <loc>${location}</loc>`,
            `    <lastmod>${modifiedAt}</lastmod>`,
            `    <changefreq>${changeFreq}</changefreq>`,
            `    <priority>${priority}</priority>`,
            '  </url>',
        ].join('\n');
    }).join('\n');

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urlEntries,
        '</urlset>',
    ].join('\n');

    setHeader(event, 'content-type', 'application/xml; charset=utf-8');
    return `${xml}\n`;
});
