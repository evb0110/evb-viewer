export const LANDING_ROUTE_PATHS = [
    '/',
    '/features',
    '/docs',
] as const;

const DEFAULT_SITE_URL = 'https://evb-viewer.vercel.app';

export function normalizeSiteUrl(siteUrl?: string): string {
    const fallback = siteUrl?.trim() || DEFAULT_SITE_URL;
    const withoutTrailingSlash = fallback.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(withoutTrailingSlash)) {
        return withoutTrailingSlash;
    }

    return `https://${withoutTrailingSlash}`;
}

export function normalizeCanonicalPath(path: string): string {
    if (!path || path === '/') {
        return '/';
    }

    return path.replace(/\/+$/, '');
}

export function buildAbsoluteUrl(siteUrl: string, path: string): string {
    const origin = normalizeSiteUrl(siteUrl);
    return new URL(normalizeCanonicalPath(path), `${origin}/`).toString();
}
