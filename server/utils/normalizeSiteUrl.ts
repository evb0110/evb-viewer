import {type H3Event, getRequestURL} from 'h3';
import {compact} from 'es-toolkit/array';
import {firstNonEmptyStringPreservingWhitespace, getRuntimeEnv} from '@server/utils/getRuntimeEnv';

const DEFAULT_PRODUCTION_SITE_URL = 'https://web.evb-viewer.com';

export function normalizeSiteUrl(siteUrl: string) {
    let parsed: URL;
    try {
        parsed = new URL(siteUrl.trim());
    } catch {
        throw new Error('Configured site URL must be an absolute HTTP(S) URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        throw new Error('Configured site URL must be an absolute HTTP(S) URL');
    }
    if (parsed.username || parsed.password) {
        throw new Error('Configured site URL must not contain credentials');
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/`;
    return parsed.toString();
}

export function resolveSiteUrl(event: H3Event) {
    const requestUrl = getRequestURL(event);
    const env = getRuntimeEnv();
    const configuredSiteUrl = firstNonEmptyStringPreservingWhitespace([env.NUXT_PUBLIC_SITE_URL, env.NUXT_SITE_URL, env.SITE_URL]).trim();
    if (configuredSiteUrl) {
        return normalizeSiteUrl(configuredSiteUrl);
    }

    const allowedSiteHosts = compact((env.SITE_URL_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()));

    if (env.NODE_ENV !== 'production') {
        return normalizeSiteUrl(`${requestUrl.protocol}//${requestUrl.host}`);
    }

    if (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1' || requestUrl.hostname === '[::1]') {
        return normalizeSiteUrl(DEFAULT_PRODUCTION_SITE_URL);
    }

    if (!allowedSiteHosts.length) {
        return normalizeSiteUrl(DEFAULT_PRODUCTION_SITE_URL);
    }

    const requestHost = requestUrl.host.toLowerCase();
    if (!allowedSiteHosts.includes(requestHost)) {
        throw new Error('Cannot resolve sitemap site URL without a configured canonical URL or allowed request host');
    }

    return normalizeSiteUrl(`${requestUrl.protocol}//${requestUrl.host}`);
}
