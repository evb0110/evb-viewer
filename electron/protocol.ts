import {
    app,
    net,
    protocol,
} from 'electron';
import { readdirSync } from 'node:fs';
import {
    basename,
    dirname,
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

type TStaticEntryKind = 'file' | 'directory';

let isSchemeRegistered = false;
let isHandlerRegistered = false;
const packagedPathResolutionCache = new Map<string, string | null>();
const PACKAGED_PATH_RESOLUTION_CACHE_MAX_ENTRIES = 4_096;
const packagedDirectoryEntryCache = new Map<string, ReadonlyMap<string, TStaticEntryKind> | null>();
const PACKAGED_DIRECTORY_ENTRY_CACHE_MAX_ENTRIES = 256;

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

function isPackagedDirectoryCacheEnabled() {
    return !config.isDev && app.isPackaged;
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

function readUncachedDirectoryEntryKinds(directoryPath: string): ReadonlyMap<string, TStaticEntryKind> | null {
    try {
        const entries = new Map<string, TStaticEntryKind>();
        for (const candidate of readdirSync(directoryPath, {withFileTypes: true})) {
            if (candidate.isFile()) {
                entries.set(candidate.name, 'file');
            } else if (candidate.isDirectory()) {
                entries.set(candidate.name, 'directory');
            }
        }
        return entries;
    } catch {
        return null;
    }
}

function readPackagedDirectoryEntryKinds(directoryPath: string) {
    if (packagedDirectoryEntryCache.has(directoryPath)) {
        const cachedEntries = packagedDirectoryEntryCache.get(directoryPath) ?? null;
        packagedDirectoryEntryCache.delete(directoryPath);
        packagedDirectoryEntryCache.set(directoryPath, cachedEntries);
        return cachedEntries;
    }

    const entries = readUncachedDirectoryEntryKinds(directoryPath);
    const oldestKey = packagedDirectoryEntryCache.keys().next().value;
    if (oldestKey !== undefined && packagedDirectoryEntryCache.size >= PACKAGED_DIRECTORY_ENTRY_CACHE_MAX_ENTRIES) {
        packagedDirectoryEntryCache.delete(oldestKey);
    }
    packagedDirectoryEntryCache.set(directoryPath, entries);
    return entries;
}

// Electron answers a stat inside app.asar by constructing an fs.Stats, which
// Node deprecates (DEP0180), so the packaged app printed that warning on its
// first request. A directory listing reports the entry kind without one.
function readStaticEntryKind(entryPath: string): TStaticEntryKind | null {
    const name = basename(entryPath);
    const directoryPath = dirname(entryPath);
    if (isPackagedDirectoryCacheEnabled()) {
        return readPackagedDirectoryEntryKinds(directoryPath)?.get(name) ?? null;
    }

    try {
        const entry = readdirSync(directoryPath, {withFileTypes: true})
            .find(candidate => candidate.name === name);
        return entry?.isFile()
            ? 'file'
            : entry?.isDirectory()
                ? 'directory'
                : null;
    } catch {
        return null;
    }
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

    const candidateKind = readStaticEntryKind(candidatePath);
    if (candidateKind === 'file') {
        return candidatePath;
    }
    if (candidateKind === 'directory') {
        const indexPath = join(candidatePath, 'index.html');
        if (readStaticEntryKind(indexPath) === 'file') {
            return indexPath;
        }
    }

    if (!extname(normalizedPath)) {
        const fallbackPath = join(
            config.renderer.staticRoot,
            normalizedPath === 'electron' || normalizedPath.startsWith('electron/')
                ? 'electron/index.html'
                : 'index.html',
        );
        if (readStaticEntryKind(fallbackPath) === 'file') {
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
