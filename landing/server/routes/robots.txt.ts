import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
} from '~~/shared/seo';

export default defineEventHandler((event) => {
    const runtimeConfig = useRuntimeConfig(event);
    const siteUrl = normalizeSiteUrl(runtimeConfig.public.siteUrl);

    const body = [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        `Sitemap: ${buildAbsoluteUrl(siteUrl, '/sitemap.xml')}`,
    ].join('\n');

    setHeader(event, 'content-type', 'text/plain; charset=utf-8');
    return `${body}\n`;
});
