import {
    app,
    net,
    protocol,
} from 'electron';
import {
    existsSync,
    statSync,
} from 'node:fs';
import {
    extname,
    join,
    normalize,
    relative,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '@electron/config';

const APP_PROTOCOL_SCHEME = 'evb-viewer';
const APP_PROTOCOL_HOST = 'app';

const MIME_TYPES = new Map([
    [
        '.css',
        'text/css; charset=utf-8',
    ],
    [
        '.html',
        'text/html; charset=utf-8',
    ],
    [
        '.ico',
        'image/x-icon',
    ],
    [
        '.js',
        'text/javascript; charset=utf-8',
    ],
    [
        '.json',
        'application/json; charset=utf-8',
    ],
    [
        '.mjs',
        'text/javascript; charset=utf-8',
    ],
    [
        '.png',
        'image/png',
    ],
    [
        '.svg',
        'image/svg+xml; charset=utf-8',
    ],
    [
        '.wasm',
        'application/wasm',
    ],
    [
        '.woff',
        'font/woff',
    ],
    [
        '.woff2',
        'font/woff2',
    ],
]);

let isSchemeRegistered = false;
let isHandlerRegistered = false;
const packagedPathResolutionCache = new Map<string, string | null>();
const PACKAGED_PATH_RESOLUTION_CACHE_MAX_ENTRIES = 4_096;

export function registerAppProtocolScheme() {
    if (isSchemeRegistered) {
        return;
    }
    isSchemeRegistered = true;
    protocol.registerSchemesAsPrivileged([{
        scheme: APP_PROTOCOL_SCHEME,
        privileges: {
            bypassCSP: false,
            corsEnabled: true,
            secure: true,
            standard: true,
            supportFetchAPI: true,
            codeCache: true,
        },
    }]);
}

function createResponse(body: BodyInit | null, init: ResponseInit = {}) {
    return new Response(body, init);
}

function resolveStaticFilePath(url: URL) {
    const cacheKey = `${url.hostname}\0${url.pathname}`;
    if (packagedPathResolutionCache.has(cacheKey)) {
        const cachedPath = packagedPathResolutionCache.get(cacheKey) ?? null;
        packagedPathResolutionCache.delete(cacheKey);
        packagedPathResolutionCache.set(cacheKey, cachedPath);
        return cachedPath;
    }

    const resolvedPath = resolveUncachedStaticFilePath(url);
    const oldestKey = packagedPathResolutionCache.keys().next().value;
    if (oldestKey !== undefined && packagedPathResolutionCache.size >= PACKAGED_PATH_RESOLUTION_CACHE_MAX_ENTRIES) {
        packagedPathResolutionCache.delete(oldestKey);
    }
    packagedPathResolutionCache.set(cacheKey, resolvedPath);
    return resolvedPath;
}

function resolveUncachedStaticFilePath(url: URL) {
    if (url.hostname !== APP_PROTOCOL_HOST) {
        return null;
    }

    let decodedPathname: string;
    try {
        decodedPathname = decodeURIComponent(url.pathname);
    } catch {
        return null;
    }
    const normalizedPath = normalize(decodedPathname.replace(/^\/+/u, ''));
    const candidatePath = join(config.renderer.staticRoot, normalizedPath);
    const relativePath = relative(config.renderer.staticRoot, candidatePath);
    if (relativePath.startsWith('..') || relativePath === '..') {
        return null;
    }

    if (existsSync(candidatePath)) {
        const stats = statSync(candidatePath);
        if (stats.isFile()) {
            return candidatePath;
        }
        if (stats.isDirectory()) {
            const indexPath = join(candidatePath, 'index.html');
            if (existsSync(indexPath) && statSync(indexPath).isFile()) {
                return indexPath;
            }
        }
    }

    if (!extname(normalizedPath)) {
        const fallbackPath = join(
            config.renderer.staticRoot,
            normalizedPath === 'electron' || normalizedPath.startsWith('electron/')
                ? 'electron/index.html'
                : 'index.html',
        );
        if (existsSync(fallbackPath) && statSync(fallbackPath).isFile()) {
            return fallbackPath;
        }
    }

    return null;
}

export function setupAppProtocolHandler() {
    if (isHandlerRegistered || config.isDev) {
        return;
    }
    if (!app.isReady()) {
        throw new Error('App protocol handler must be registered after Electron app readiness');
    }

    isHandlerRegistered = true;
    protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
        const url = new URL(request.url);
        const filePath = resolveStaticFilePath(url);
        if (!filePath) {
            return createResponse('Not found', {status: 404});
        }

        const response = await net.fetch(pathToFileURL(filePath).toString());
        const headers = new Headers(response.headers);
        const mimeType = MIME_TYPES.get(extname(filePath).toLowerCase());
        if (mimeType) {
            headers.set('content-type', mimeType);
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    });
}
