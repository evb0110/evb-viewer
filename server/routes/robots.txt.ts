import {defineEventHandler, setHeader} from 'h3';
import {resolveSiteUrl} from '@server/utils/normalizeSiteUrl';

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
    const siteUrl = resolveSiteUrl(event);

    setHeader(event, 'content-type', 'text/plain; charset=utf-8');

    const lines = ['User-agent: *', 'Allow: /', 'Disallow: /electron', 'Disallow: /workspace', 'Disallow: /_nuxt/', 'Disallow: /api/', ''];

    for (const bot of AI_CRAWLERS) {
        lines.push(`User-agent: ${bot}`, 'Disallow: /', '');
    }

    lines.push(`Sitemap: ${new URL('/sitemap.xml', siteUrl).toString()}`, '');

    return lines.join('\n');
});
