import type { WebContents } from 'electron';
import { sep } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { Tagged } from 'type-fest';

export type TOpenPath = Tagged<string, 'OpenPath'>;

const logger = createLogger('open-path-capabilities');
interface IOpenPathGrant { expiresAtMs: number; }

const allowedOpenPathsByOwner = new Map<number, Map<string, IOpenPathGrant>>();
const allowedRevealPathsByOwner = new Map<number, Map<string, IOpenPathGrant>>();
const ownerCleanupRegistered = new Set<number>();
export const MAX_ALLOWED_OPEN_PATHS = (() => {
    const parsed = Number.parseInt(process.env.EVB_ALLOWED_OPEN_PATHS_MAX ?? '2048', 10);
    if (!Number.isFinite(parsed) || parsed < 64) {
        return 2048;
    }
    return Math.min(parsed, 100_000);
})();
export const OPEN_PATH_CAPABILITY_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_OPEN_PATH_CAPABILITY_TTL_MS ?? `${24 * 60 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 60_000) {
        return 24 * 60 * 60 * 1000;
    }
    return Math.min(parsed, 7 * 24 * 60 * 60 * 1000);
})();

function normalizeOpenPath(filePath: string) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return null;
    }

    return normalizePossiblyEncodedExistingPath(filePath);
}

function pruneAllowedPathMap(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    now: number,
) {
    for (const [
        ownerId,
        allowedOpenPaths,
    ] of allowedPathsByOwner.entries()) {
        for (const [
            filePath,
            grant,
        ] of allowedOpenPaths.entries()) {
            if (grant.expiresAtMs <= now) {
                allowedOpenPaths.delete(filePath);
            }
        }

        while (allowedOpenPaths.size > MAX_ALLOWED_OPEN_PATHS) {
            const oldestPath = allowedOpenPaths.keys().next().value;
            if (!oldestPath) {
                return;
            }
            allowedOpenPaths.delete(oldestPath);
        }

        if (allowedOpenPaths.size === 0) {
            allowedPathsByOwner.delete(ownerId);
        }
    }
}

function pruneAllowedPaths(now = Date.now()) {
    pruneAllowedPathMap(allowedOpenPathsByOwner, now);
    pruneAllowedPathMap(allowedRevealPathsByOwner, now);
}

function getAllowedPaths(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    ownerId: number,
) {
    let allowedOpenPaths = allowedPathsByOwner.get(ownerId);
    if (!allowedOpenPaths) {
        allowedOpenPaths = new Map<string, IOpenPathGrant>();
        allowedPathsByOwner.set(ownerId, allowedOpenPaths);
    }
    return allowedOpenPaths;
}

function removeAllowedPathsForOwner(ownerId: number) {
    allowedOpenPathsByOwner.delete(ownerId);
    allowedRevealPathsByOwner.delete(ownerId);
    ownerCleanupRegistered.delete(ownerId);
}

function getOwnerId(owner: number | WebContents) {
    if (typeof owner === 'number') {
        return owner;
    }

    return typeof owner.id === 'number' ? owner.id : 0;
}

function registerOwnerCleanup(owner: number | WebContents, ownerId: number) {
    if (typeof owner === 'number' || ownerId === 0 || ownerCleanupRegistered.has(ownerId)) {
        return;
    }

    if (typeof owner.isDestroyed === 'function' && owner.isDestroyed()) {
        removeAllowedPathsForOwner(ownerId);
        return;
    }

    if (typeof owner.once !== 'function') {
        return;
    }

    ownerCleanupRegistered.add(ownerId);
    const cleanup = () => {
        owner.removeListener('destroyed', cleanup);
        owner.removeListener('render-process-gone', cleanup);
        owner.removeListener('did-start-navigation', handleNavigation);
        removeAllowedPathsForOwner(ownerId);
    };
    const handleNavigation = (
        _event: unknown,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
    ) => {
        if (isMainFrame && !isInPlace) {
            cleanup();
        }
    };
    owner.once('destroyed', cleanup);
    owner.once('render-process-gone', cleanup);
    owner.on('did-start-navigation', handleNavigation);
}

function isDestroyedOwner(owner: number | WebContents) {
    return typeof owner !== 'number'
        && typeof owner.isDestroyed === 'function'
        && owner.isDestroyed();
}

function allowPathForWebContents(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    owner: number | WebContents,
    filePath: string,
) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return null;
    }

    if (isDestroyedOwner(owner)) {
        removeAllowedPathsForOwner(getOwnerId(owner));
        return null;
    }

    const ownerId = getOwnerId(owner);
    registerOwnerCleanup(owner, ownerId);
    const allowedOpenPaths = getAllowedPaths(allowedPathsByOwner, ownerId);
    allowedOpenPaths.delete(normalizedPath);
    allowedOpenPaths.set(normalizedPath, {expiresAtMs: Date.now() + OPEN_PATH_CAPABILITY_TTL_MS});
    pruneAllowedPaths();
    return normalizedPath as TOpenPath;
}

function allowPathsForWebContents(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    owner: number | WebContents,
    filePaths: string[],
) {
    for (const filePath of filePaths) {
        allowPathForWebContents(allowedPathsByOwner, owner, filePath);
    }
}

export function allowOpenPath(filePath: string, owner?: number | WebContents) {
    if (owner !== undefined) {
        return allowPathForWebContents(allowedOpenPathsByOwner, owner, filePath);
    }

    return allowPathForWebContents(allowedOpenPathsByOwner, 0, filePath);
}

export function allowOpenPaths(filePaths: string[], owner?: number | WebContents) {
    allowPathsForWebContents(allowedOpenPathsByOwner, owner ?? 0, filePaths);
}

export function allowRevealPath(filePath: string, owner?: number | WebContents) {
    if (owner !== undefined) {
        return allowPathForWebContents(allowedRevealPathsByOwner, owner, filePath);
    }

    return allowPathForWebContents(allowedRevealPathsByOwner, 0, filePath);
}

export function allowRevealPaths(filePaths: string[], owner?: number | WebContents) {
    allowPathsForWebContents(allowedRevealPathsByOwner, owner ?? 0, filePaths);
}

function isAllowedPath(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    filePath: string,
    owner?: number | WebContents,
) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return false;
    }

    const ownerId = getOwnerId(owner ?? 0);
    const allowedOpenPaths = allowedPathsByOwner.get(ownerId);
    const grant = allowedOpenPaths?.get(normalizedPath);
    if (!grant) {
        return false;
    }

    if (grant.expiresAtMs <= Date.now()) {
        allowedOpenPaths?.delete(normalizedPath);
        if (allowedOpenPaths?.size === 0) {
            allowedPathsByOwner.delete(ownerId);
        }
        return false;
    }

    return true;
}

export function requireOpenPath(rawPath: string, owner?: number | WebContents): TOpenPath {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        throw new Error('Path not accessible');
    }

    const normalizedPath = normalizeOpenPath(rawPath);
    if (!normalizedPath) {
        throw new Error('Path not accessible');
    }

    if (!isAllowedPath(allowedOpenPathsByOwner, normalizedPath, owner)) {
        throw new Error(`Path not allowed: ${rawPath}`);
    }

    return normalizedPath as TOpenPath;
}

export function requireRevealPath(rawPath: string, owner?: number | WebContents): TOpenPath {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        throw new Error('Path not accessible');
    }

    const normalizedPath = normalizeOpenPath(rawPath);
    if (!normalizedPath) {
        throw new Error('Path not accessible');
    }

    if (
        !isAllowedPath(allowedRevealPathsByOwner, normalizedPath, owner)
        && !isAllowedPath(allowedOpenPathsByOwner, normalizedPath, owner)
    ) {
        throw new Error(`Path not allowed: ${rawPath}`);
    }

    return normalizedPath as TOpenPath;
}

export function removeAllowedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return;
    }
    for (const allowedOpenPaths of allowedOpenPathsByOwner.values()) {
        allowedOpenPaths.delete(normalizedPath);
    }
}

export function removeAllowedRevealPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    if (!normalizedPath) {
        return;
    }
    for (const allowedRevealPaths of allowedRevealPathsByOwner.values()) {
        allowedRevealPaths.delete(normalizedPath);
    }
}

export function logRejectedOpenPath(filePath: string) {
    const normalizedPath = normalizeOpenPath(filePath);
    const displayPath = normalizedPath
        ? normalizedPath.split(sep).slice(-3).join(sep)
        : '<invalid>';
    logger.warn(`Rejected renderer direct-open request without a main-issued capability: ${displayPath}`);
}
