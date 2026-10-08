import type { WebContents } from 'electron';
import { sep } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';
import { normalizePossiblyEncodedExistingPath } from '@electron/utils/normalizePossiblyEncodedExistingPath';
import type { Tagged } from 'type-fest';

export type TOpenPath = Tagged<string, 'OpenPath'>;

const logger = createLogger('open-path-capabilities');
interface IOpenPathGrant { expiresAtMs: number; }

const allowedOpenPathsByOwner = new Map<number, Map<string, IOpenPathGrant>>();
const allowedRevealPathsByOwner = new Map<number, Map<string, IOpenPathGrant>>();
const ownerCleanupRegistered = new Set<number>();
export const MAX_ALLOWED_OPEN_PATHS = 2_048;
export const OPEN_PATH_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;

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

    if (typeof owner.on !== 'function') {
        return;
    }

    ownerCleanupRegistered.add(ownerId);
    const stop = onSenderLifetimeEnd(owner, () => {
        stop();
        removeAllowedPathsForOwner(ownerId);
    }, {navigation: true});
}

function isDestroyedOwner(owner: number | WebContents) {
    return typeof owner !== 'number'
        && typeof owner.isDestroyed === 'function'
        && owner.isDestroyed();
}

/** Grants every path that resolves; one expiration sweep covers the whole batch. */
function allowPathsForWebContents(
    allowedPathsByOwner: Map<number, Map<string, IOpenPathGrant>>,
    owner: number | WebContents,
    filePaths: readonly string[],
) {
    const normalizedPaths = filePaths.map(filePath => normalizeOpenPath(filePath) as TOpenPath | null);
    if (normalizedPaths.every(normalizedPath => normalizedPath === null)) {
        return normalizedPaths;
    }

    const ownerId = getOwnerId(owner);
    if (isDestroyedOwner(owner)) {
        removeAllowedPathsForOwner(ownerId);
        return normalizedPaths.map(() => null);
    }

    registerOwnerCleanup(owner, ownerId);
    const allowedOpenPaths = getAllowedPaths(allowedPathsByOwner, ownerId);
    const expiresAtMs = Date.now() + OPEN_PATH_CAPABILITY_TTL_MS;
    for (const normalizedPath of normalizedPaths) {
        if (normalizedPath !== null) {
            allowedOpenPaths.delete(normalizedPath);
            allowedOpenPaths.set(normalizedPath, {expiresAtMs});
        }
    }
    pruneAllowedPaths();
    // A batch larger than the owner's cap loses its oldest grants to the
    // prune; report only the paths that are still granted.
    return normalizedPaths.map(normalizedPath => (
        normalizedPath !== null && allowedOpenPaths.has(normalizedPath) ? normalizedPath : null
    ));
}

export function allowOpenPath(filePath: string, owner?: number | WebContents) {
    return allowPathsForWebContents(allowedOpenPathsByOwner, owner ?? 0, [filePath])[0] ?? null;
}

export function allowOpenPaths(filePaths: readonly string[], owner?: number | WebContents) {
    return allowPathsForWebContents(allowedOpenPathsByOwner, owner ?? 0, filePaths);
}

export function allowRevealPath(filePath: string, owner?: number | WebContents) {
    return allowPathsForWebContents(allowedRevealPathsByOwner, owner ?? 0, [filePath])[0] ?? null;
}

export function allowRevealPaths(filePaths: readonly string[], owner?: number | WebContents) {
    return allowPathsForWebContents(allowedRevealPathsByOwner, owner ?? 0, filePaths);
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

/** Whether a path resolves to an existing file, independent of any grant. */
export function isOpenPathAccessible(rawPath: string) {
    return normalizeOpenPath(rawPath) !== null;
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
