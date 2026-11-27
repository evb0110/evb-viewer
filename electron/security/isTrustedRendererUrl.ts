function parseUrl(value: string): URL | null {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function hasTrustedOrigin(candidate: URL, trusted: URL) {
    if (trusted.protocol === 'evb-viewer:') {
        return candidate.protocol === trusted.protocol && candidate.hostname === trusted.hostname;
    }

    return candidate.origin === trusted.origin;
}

function normalizeTrustedPath(pathname: string) {
    if (pathname === '/') {
        return pathname;
    }

    return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

function hasTrustedPath(candidate: URL, trusted: URL) {
    const trustedPath = normalizeTrustedPath(trusted.pathname);
    return trustedPath === '/' || candidate.pathname === trustedPath || candidate.pathname.startsWith(`${trustedPath}/`);
}

export function isTrustedRendererUrl(value: string, trustedRendererUrl: string) {
    const trusted = parseUrl(trustedRendererUrl);
    const candidate = parseUrl(value);
    if (!trusted || !candidate) {
        return false;
    }

    return hasTrustedOrigin(candidate, trusted) && hasTrustedPath(candidate, trusted);
}
