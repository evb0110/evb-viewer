const DEFAULT_SITE_URL = 'https://evb-viewer.com';
export const SEO_IMAGE_PATH = '/evb-viewer-seo.png';

export function normalizeSiteUrl(siteUrl?: string): string {
    const trimmedSiteUrl = siteUrl?.trim() ?? '';
    const configured = trimmedSiteUrl.length > 0 ? trimmedSiteUrl : DEFAULT_SITE_URL;
    const withProtocol = /^https?:\/\//iu.test(configured)
        ? configured
        : `https://${configured}`;

    try {
        const normalized = new URL(withProtocol);
        if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
            return DEFAULT_SITE_URL;
        }
        normalized.hash = '';
        normalized.search = '';
        return normalized.toString().replace(/\/+$/u, '');
    } catch {
        return DEFAULT_SITE_URL;
    }
}

function normalizeCanonicalPath(path: string): string {
    if (!path || path === '/') {
        return '/';
    }

    return path.replace(/\/+$/, '');
}

export function buildAbsoluteUrl(siteUrl: string, path: string): string {
    const origin = normalizeSiteUrl(siteUrl);
    return new URL(normalizeCanonicalPath(path), `${origin}/`).toString();
}
