import {
    extname,
    resolve,
} from 'path';
import type { WebContents } from 'electron';
import { onSenderLifetimeEnd } from '@electron/utils/onSenderLifetimeEnd';

const DJVU_WRITE_PATH_MAX_ENTRIES = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_WRITE_PATH_MAX_ENTRIES ?? '64', 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 64;
    }
    return Math.min(parsed, 1_024);
})();
const DJVU_WRITE_PATH_TTL_MS = (() => {
    const parsed = Number.parseInt(process.env.EVB_DJVU_WRITE_PATH_TTL_MS ?? `${15 * 60 * 1000}`, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return 15 * 60 * 1000;
    }
    return parsed;
})();
interface IDjvuWriteCapabilityEntry {
    normalizedPath: string;
    ownerWebContentsId: number | null;
    expiresAt: number;
}

const allowedDjvuWritePaths = new Map<string, IDjvuWriteCapabilityEntry>();
const ownerCleanupRegistered = new Set<number>();

type TDjvuWriteCapabilityOwner = number | WebContents | undefined;

function normalizePath(filePath: string) {
    return resolve(filePath.trim());
}

function normalizeOwnerWebContentsId(owner: TDjvuWriteCapabilityOwner) {
    const ownerWebContentsId = typeof owner === 'number' ? owner : owner?.id;
    if (typeof ownerWebContentsId !== 'number' || !Number.isInteger(ownerWebContentsId) || ownerWebContentsId < 1) {
        return null;
    }
    return ownerWebContentsId;
}

function toCapabilityKey(normalizedPath: string, ownerWebContentsId: number | null) {
    return `${ownerWebContentsId ?? 'any'}:${normalizedPath}`;
}

function normalizeDjvuOutputPdfPath(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    if (extname(normalizedPath).toLowerCase() !== '.pdf') {
        throw new Error('Invalid file type: only PDF files are allowed');
    }
    return normalizedPath;
}

function pruneAllowedDjvuWritePaths(now = Date.now()) {
    for (const [
        capabilityKey,
        capability,
    ] of allowedDjvuWritePaths.entries()) {
        if (capability.expiresAt <= now) {
            allowedDjvuWritePaths.delete(capabilityKey);
        }
    }

    if (allowedDjvuWritePaths.size <= DJVU_WRITE_PATH_MAX_ENTRIES) {
        return;
    }

    const overflowCount = allowedDjvuWritePaths.size - DJVU_WRITE_PATH_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const oldestPath = allowedDjvuWritePaths.keys().next().value;
        if (typeof oldestPath !== 'string') {
            break;
        }
        allowedDjvuWritePaths.delete(oldestPath);
    }
}

function removeAllowedDjvuWritePathsForOwner(ownerWebContentsId: number) {
    for (const [
        capabilityKey,
        capability,
    ] of allowedDjvuWritePaths.entries()) {
        if (capability.ownerWebContentsId === ownerWebContentsId) {
            allowedDjvuWritePaths.delete(capabilityKey);
        }
    }
    ownerCleanupRegistered.delete(ownerWebContentsId);
}

function registerOwnerCleanup(owner: TDjvuWriteCapabilityOwner, ownerWebContentsId: number | null) {
    if (
        typeof owner === 'number'
        || owner === undefined
        || ownerWebContentsId === null
        || ownerCleanupRegistered.has(ownerWebContentsId)
    ) {
        return;
    }

    if (typeof owner.isDestroyed === 'function' && owner.isDestroyed()) {
        removeAllowedDjvuWritePathsForOwner(ownerWebContentsId);
        return;
    }

    if (typeof owner.on !== 'function') {
        return;
    }

    ownerCleanupRegistered.add(ownerWebContentsId);
    const stop = onSenderLifetimeEnd(owner, () => {
        stop();
        removeAllowedDjvuWritePathsForOwner(ownerWebContentsId);
    }, {navigation: true});
}

export function allowDjvuWritePath(filePath: string, owner?: TDjvuWriteCapabilityOwner) {
    const normalizedPath = normalizeDjvuOutputPdfPath(filePath);
    const normalizedOwnerWebContentsId = normalizeOwnerWebContentsId(owner);
    registerOwnerCleanup(owner, normalizedOwnerWebContentsId);
    if (typeof owner !== 'number' && owner !== undefined && typeof owner.isDestroyed === 'function' && owner.isDestroyed()) {
        return;
    }

    const capabilityKey = toCapabilityKey(normalizedPath, normalizedOwnerWebContentsId);
    const now = Date.now();
    pruneAllowedDjvuWritePaths(now);
    if (allowedDjvuWritePaths.has(capabilityKey)) {
        allowedDjvuWritePaths.delete(capabilityKey);
    }
    allowedDjvuWritePaths.set(capabilityKey, {
        normalizedPath,
        ownerWebContentsId: normalizedOwnerWebContentsId,
        expiresAt: now + DJVU_WRITE_PATH_TTL_MS,
    });
    pruneAllowedDjvuWritePaths(now);
}

function consumeCapabilityByKey(capabilityKey: string, now: number) {
    const capability = allowedDjvuWritePaths.get(capabilityKey);
    if (!capability) {
        return null;
    }
    if (capability.expiresAt <= now) {
        allowedDjvuWritePaths.delete(capabilityKey);
        return null;
    }
    allowedDjvuWritePaths.delete(capabilityKey);
    return capability;
}

export function consumeAllowedDjvuWritePath(filePath: string, owner?: TDjvuWriteCapabilityOwner) {
    const normalizedPath = normalizeDjvuOutputPdfPath(filePath);
    const normalizedOwnerWebContentsId = normalizeOwnerWebContentsId(owner);
    const now = Date.now();
    pruneAllowedDjvuWritePaths(now);

    const ownedCapability = consumeCapabilityByKey(
        toCapabilityKey(normalizedPath, normalizedOwnerWebContentsId),
        now,
    );
    if (ownedCapability) {
        return ownedCapability.normalizedPath;
    }

    if (normalizedOwnerWebContentsId !== null) {
        const sharedCapability = consumeCapabilityByKey(
            toCapabilityKey(normalizedPath, null),
            now,
        );
        if (sharedCapability) {
            return sharedCapability.normalizedPath;
        }
    }

    return null;
}
