import {buildAbsoluteUrl, normalizeSiteUrl} from '~~/shared/seo';

const AI_CRAWLERS = [
    'GPTBot',
    'ChatGPT-User',
    'Google-Extended',
    'CCBot',
    'anthropic-ai',
    'Claude-Web',
    'Bytespider',
    'Diffbot',
    'FacebookBot',
    'PerplexityBot',
    'Applebot-Extended',
    'YouBot',
    'Amazonbot',
    'cohere-ai',
];

export default defineEventHandler((event) => {
    const runtimeConfig = useRuntimeConfig(event);
    const siteUrl = normalizeSiteUrl(runtimeConfig.public.siteUrl);

    const lines = ['User-agent: *', 'Allow: /', 'Disallow: /api/', ''];

    for (const bot of AI_CRAWLERS) {
        lines.push(`User-agent: ${bot}`, 'Disallow: /', '');
    }

    lines.push(`Sitemap: ${buildAbsoluteUrl(siteUrl, '/sitemap.xml')}`);

    setHeader(event, 'content-type', 'text/plain; charset=utf-8');
    return `${lines.join('\n')}\n`;
});
