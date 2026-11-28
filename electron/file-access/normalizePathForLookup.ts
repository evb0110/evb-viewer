import {lstatSync, opendirSync, realpathSync, type BigIntStats} from 'node:fs';
import {dirname, join, relative, resolve, win32} from 'node:path';
import {isErrnoException} from '@contracts/runtimeGuards';

export const WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES = 1_024;
const WINDOWS_CASE_SENSITIVITY_CACHE_TTL_MS = 60_000;
const MAX_DIRECTORY_SCAN_ENTRIES = 64;
const MAX_DIRECTORY_PROBE_ENTRIES = 8;

interface IWindowsDirectoryCaseCacheEntry {
    readonly caseSensitive: boolean | null;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly birthtimeNs: bigint;
    readonly ctimeNs: bigint;
    readonly mtimeNs: bigint;
    readonly cachedAt: number;
}

interface IWindowsDirectoryLookup {
    realPath: string | null;
    resolvedPath: string | null;
}

type TLstatProbeResult = {readonly kind: 'ok'; readonly stats: BigIntStats} | {readonly kind: 'enoent'} | {readonly kind: 'error'};
type TEntryProbeOutcome = boolean | null | 'zero-ino';

const windowsCaseSensitivityByDirectory = new Map<string, IWindowsDirectoryCaseCacheEntry>();

export function resetWindowsPathLookupCacheForTests() {
    windowsCaseSensitivityByDirectory.clear();
}

function stripWindowsExtendedLengthPrefix(filePath: string) {
    if (filePath.length >= 8 && filePath.slice(0, 8).toUpperCase() === '\\\\?\\UNC\\') {
        return `\\\\${filePath.slice(8)}`;
    }
    if (filePath.startsWith('\\\\?\\')) {
        return filePath.slice(4);
    }
    return filePath;
}

function isWindowsPathLike(filePath: string) {
    const normalizedPath = stripWindowsExtendedLengthPrefix(filePath);
    return /^[a-zA-Z]:[\\/]/.test(normalizedPath) || normalizedPath.startsWith('\\\\');
}

function hasAsciiUppercase(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x41 && code <= 0x5a) {
            return true;
        }
    }
    return false;
}

function toAsciiLowerCase(value: string): string {
    let lowered = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        lowered += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : value[index]!;
    }
    return lowered;
}

/**
 * Normalizes only the inherently case-insensitive Windows root prefix:
 * uppercase drive letter (`C:`) matching `GetFinalPathNameByHandleW`, and
 * ASCII-lowercased UNC `\\server\share` header (DNS/SMB host & share names).
 * Directory and file components below the root are never modified here.
 */
function normalizeWindowsRootCasing(windowsPath: string): string {
    if (windowsPath.length >= 2 && windowsPath[1] === ':') {
        const driveCode = windowsPath.charCodeAt(0);
        if (driveCode >= 0x61 && driveCode <= 0x7a) {
            return `${String.fromCharCode(driveCode - 32)}${windowsPath.slice(1)}`;
        }
        return windowsPath;
    }
    if (windowsPath.startsWith('\\\\')) {
        const serverEnd = windowsPath.indexOf('\\', 2);
        if (serverEnd === -1) {
            return toAsciiLowerCase(windowsPath);
        }
        const shareEnd = windowsPath.indexOf('\\', serverEnd + 1);
        if (shareEnd === -1) {
            return toAsciiLowerCase(windowsPath);
        }
        return `${toAsciiLowerCase(windowsPath.slice(0, shareEnd))}${windowsPath.slice(shareEnd)}`;
    }
    return windowsPath;
}

function normalizeResolvedWindowsPath(filePath: string) {
    return normalizeWindowsRootCasing(win32.resolve(stripWindowsExtendedLengthPrefix(filePath)));
}

function toggleAsciiCase(value: string): string | null {
    let changed = false;
    let toggled = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0x41 && code <= 0x5a) {
            toggled += String.fromCharCode(code + 32);
            changed = true;
        } else if (code >= 0x61 && code <= 0x7a) {
            toggled += String.fromCharCode(code - 32);
            changed = true;
        } else {
            toggled += value[index]!;
        }
    }
    return changed ? toggled : null;
}

function tryLstatBigInt(targetPath: string): TLstatProbeResult {
    try {
        return {
            kind: 'ok',
            stats: lstatSync(targetPath, {bigint: true}),
        };
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return {kind: 'enoent'};
        }
        return {kind: 'error'};
    }
}

function tryRealpathNativeNormalized(targetPath: string): string | null {
    try {
        return normalizeResolvedWindowsPath(realpathSync.native(targetPath));
    } catch {
        return null;
    }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats) {
    return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Probes one directory entry by toggling ASCII letters (`a-z`/`A-Z`) with `lstatSync(..., {bigint: true})`
 * and corroborating `realpathSync.native` spelling:
 * - Uses `lstatSync` so symlinks/junctions are compared by their own entry identity rather than targets.
 * - Rejects synthetic zero inodes (`ino === 0n`).
 * - Requires both `nlink === 1n` AND identical `realpathSync.native` output ending in `entryName` before
 *   concluding `false`, defeating libuv's Windows directory-enumeration fallback (which synthesizes
 *   `nlink = 1` on `ERROR_SHARING_VIOLATION` / `ERROR_ACCESS_DENIED`) as well as hard-linked case twins.
 */
function probeEntryCaseSensitivity(directoryPath: string, entryName: string, knownOriginalStats?: BigIntStats): TEntryProbeOutcome {
    const toggledName = toggleAsciiCase(entryName);
    if (toggledName === null) {
        return null;
    }

    const entryPath = win32.join(directoryPath, entryName);
    const original: TLstatProbeResult = knownOriginalStats ? {kind: 'ok', stats: knownOriginalStats} : tryLstatBigInt(entryPath);
    if (original.kind !== 'ok') {
        return null;
    }

    const toggledPath = win32.join(directoryPath, toggledName);
    const toggled = tryLstatBigInt(toggledPath);

    if (toggled.kind === 'enoent') {
        // Confirm the entry was not concurrently removed or replaced mid-probe.
        const confirmed = tryLstatBigInt(entryPath);
        if (confirmed.kind === 'ok' && (original.stats.ino === 0n || sameFileIdentity(original.stats, confirmed.stats))) {
            return true;
        }
        return null;
    }

    if (original.stats.ino === 0n) {
        return 'zero-ino';
    }

    if (toggled.kind !== 'ok') {
        return null;
    }

    if (toggled.stats.ino === 0n) {
        return 'zero-ino';
    }

    if (!sameFileIdentity(original.stats, toggled.stats)) {
        // Distinct (dev, ino) proves case-sensitivity once confirmed that entryPath was not replaced mid-probe.
        const confirmed = tryLstatBigInt(entryPath);
        if (confirmed.kind === 'ok' && sameFileIdentity(original.stats, confirmed.stats)) {
            return true;
        }
        return null;
    }

    // Do not conclude case-insensitivity from a symlink/junction or a multi-link inode.
    if (original.stats.isSymbolicLink() || toggled.stats.isSymbolicLink()) {
        return null;
    }

    if (original.stats.nlink !== 1n || toggled.stats.nlink !== 1n) {
        return null;
    }

    // Corroborate via GetFinalPathNameByHandleW (`realpathSync.native`): on Windows, if lstatSync
    // fell back to directory enumeration (synthetic nlink = 1) on a locked hard-linked pair
    // (`Foo.pdf` + `fOO.PDF`), `realpathSync.native` either throws or returns distinct link spellings.
    const realOriginal = tryRealpathNativeNormalized(entryPath);
    const realToggled = tryRealpathNativeNormalized(toggledPath);
    if (realOriginal === null || realToggled === null) {
        return null;
    }

    if (realOriginal !== realToggled) {
        const confirmed = tryLstatBigInt(entryPath);
        if (confirmed.kind === 'ok' && sameFileIdentity(original.stats, confirmed.stats)) {
            return true;
        }
        return null;
    }

    if (win32.dirname(realOriginal) !== directoryPath || win32.basename(realOriginal) !== entryName) {
        return null;
    }

    // Confirm the entry was not concurrently renamed to toggledName mid-probe.
    const confirmed = tryLstatBigInt(entryPath);
    if (confirmed.kind === 'ok' && sameFileIdentity(original.stats, confirmed.stats) && confirmed.stats.nlink === 1n) {
        return false;
    }
    return null;
}

function probeWindowsDirectoryCaseSensitivity(
    realDirectoryPath: string,
    hintEntryName: string | null,
    hintEntryStats?: BigIntStats,
): boolean | null {
    const hintHasAsciiLetter = hintEntryName !== null && toggleAsciiCase(hintEntryName) !== null;
    let sawZeroInode = false;
    if (hintEntryName !== null && hintHasAsciiLetter) {
        const hintResult = probeEntryCaseSensitivity(realDirectoryPath, hintEntryName, hintEntryStats);
        if (typeof hintResult === 'boolean') {
            return hintResult;
        }
        if (hintResult === 'zero-ino') {
            sawZeroInode = true;
        }
    }

    let dir: ReturnType<typeof opendirSync> | null = null;
    try {
        dir = opendirSync(realDirectoryPath);
        const seenAsciiLower = new Map<string, string>();
        if (hintEntryName !== null && hintHasAsciiLetter) {
            seenAsciiLower.set(toAsciiLowerCase(hintEntryName), hintEntryName);
        }

        let scannedEntries = 0;
        let probedEntries = 0;
        while (scannedEntries < MAX_DIRECTORY_SCAN_ENTRIES) {
            const dirent = dir.readSync();
            if (dirent === null) {
                break;
            }
            scannedEntries += 1;

            const entryName = dirent.name;
            if (toggleAsciiCase(entryName) === null) {
                continue;
            }

            const asciiLower = toAsciiLowerCase(entryName);
            const existingSpelling = seenAsciiLower.get(asciiLower);
            if (existingSpelling !== undefined && existingSpelling !== entryName) {
                // Two directory entries differing only in ASCII case prove case-sensitivity even for hard links.
                return true;
            }
            seenAsciiLower.set(asciiLower, entryName);

            if (sawZeroInode || entryName === hintEntryName || probedEntries >= MAX_DIRECTORY_PROBE_ENTRIES) {
                continue;
            }
            probedEntries += 1;

            const entryResult = probeEntryCaseSensitivity(realDirectoryPath, entryName);
            if (typeof entryResult === 'boolean') {
                return entryResult;
            }
            if (entryResult === 'zero-ino') {
                // Stop issuing serial entry stats on synthetic zero-inode volumes (e.g. virtual SMB mounts).
                sawZeroInode = true;
            }
        }

        return null;
    } catch {
        return null;
    } finally {
        try {
            dir?.closeSync();
        } catch {
            // Ignore close errors after a failed read.
        }
    }
}

function getCachedDirectoryCaseSensitivity(realDirectoryPath: string, dirStat: BigIntStats): boolean | null | undefined {
    const entry = windowsCaseSensitivityByDirectory.get(realDirectoryPath);
    if (!entry) {
        return undefined;
    }

    const identityChanged = entry.dev !== dirStat.dev || entry.ino !== dirStat.ino || entry.birthtimeNs !== dirStat.birthtimeNs;
    if (identityChanged) {
        windowsCaseSensitivityByDirectory.delete(realDirectoryPath);
        return undefined;
    }

    // Keep inconclusive (`null`) results stable for the directory's lifetime while cached so creating
    // a sibling file (such as a Save As `.tmp` staging file in an empty directory) cannot flip a live
    // lookup key mid-operation (`null` preserves exact spelling and can never alias distinct files).
    // For conclusive (`true`/`false`) results, validate ctime/mtime and TTL so directory replacement
    // and in-place NTFS attribute flips (empty + setCaseSensitiveInfo + repopulate) invalidate immediately.
    if (entry.caseSensitive !== null) {
        const ageMs = Date.now() - entry.cachedAt;
        const timestampsChanged = entry.ctimeNs !== dirStat.ctimeNs || entry.mtimeNs !== dirStat.mtimeNs;
        if (ageMs < 0 || ageMs >= WINDOWS_CASE_SENSITIVITY_CACHE_TTL_MS || timestampsChanged) {
            windowsCaseSensitivityByDirectory.delete(realDirectoryPath);
            return undefined;
        }
    }

    // Refresh LRU recency.
    windowsCaseSensitivityByDirectory.delete(realDirectoryPath);
    windowsCaseSensitivityByDirectory.set(realDirectoryPath, entry);
    return entry.caseSensitive;
}

function setCachedDirectoryCaseSensitivity(realDirectoryPath: string, dirStat: BigIntStats, caseSensitive: boolean | null) {
    const hasDirectoryInode = dirStat.ino !== 0n;
    const hasAnyMetadata = hasDirectoryInode || dirStat.birthtimeNs !== 0n || dirStat.ctimeNs !== 0n || dirStat.mtimeNs !== 0n;
    // Never cache `false` when the directory lacks a real inode (dirStat.ino === 0n) so synthetic-inode
    // volumes cannot serve a stale `false` across same-tick replacements. Allow caching `null`/`true`
    // when metadata exists so zero-inode SMB directories do not repeat full scans on every lookup.
    if (!hasAnyMetadata || (caseSensitive === false && !hasDirectoryInode)) {
        return;
    }

    if (windowsCaseSensitivityByDirectory.has(realDirectoryPath)) {
        windowsCaseSensitivityByDirectory.delete(realDirectoryPath);
    } else {
        while (windowsCaseSensitivityByDirectory.size >= WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES) {
            const oldestKey = windowsCaseSensitivityByDirectory.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            windowsCaseSensitivityByDirectory.delete(oldestKey);
        }
    }

    windowsCaseSensitivityByDirectory.set(realDirectoryPath, {
        caseSensitive,
        dev: dirStat.dev,
        ino: dirStat.ino,
        birthtimeNs: dirStat.birthtimeNs,
        ctimeNs: dirStat.ctimeNs,
        mtimeNs: dirStat.mtimeNs,
        cachedAt: Date.now(),
    });
}

function resolveRealWindowsDirectoryCaseSensitivity(
    realDirectoryPath: string,
    hintEntryName: string | null,
    hintEntryStats?: BigIntStats,
): boolean | null {
    const dirStat = tryLstatBigInt(realDirectoryPath);
    if (dirStat.kind === 'ok') {
        const cached = getCachedDirectoryCaseSensitivity(realDirectoryPath, dirStat.stats);
        if (cached !== undefined) {
            return cached;
        }
    }

    const caseSensitive = probeWindowsDirectoryCaseSensitivity(realDirectoryPath, hintEntryName, hintEntryStats);
    if (dirStat.kind === 'ok') {
        setCachedDirectoryCaseSensitivity(realDirectoryPath, dirStat.stats, caseSensitive);
    }
    return caseSensitive;
}

function resolveWindowsMissingAncestorLookup(directoryPath: string): IWindowsDirectoryLookup {
    let currentPath = normalizeResolvedWindowsPath(directoryPath);
    while (currentPath) {
        try {
            const realDirectoryPath = normalizeResolvedWindowsPath(realpathSync.native(currentPath));
            return {
                realPath: realDirectoryPath,
                resolvedPath: currentPath,
            };
        } catch {
            const parentPath = win32.dirname(currentPath);
            if (!parentPath || parentPath === currentPath) {
                break;
            }
            currentPath = parentPath;
        }
    }
    return {
        realPath: null,
        resolvedPath: null,
    };
}

function foldWindowsSuffix(baseDirectory: string, suffix: string, caseSensitive: boolean | null) {
    // Only ASCII A-Z is folded, and only on the suffix below the canonical ancestor,
    // so case-sensitive parents (`A\Docs` vs `a\Docs`) and NTFS Unicode pairs (`İ.pdf` vs `i\u0307.pdf`) never collide.
    return win32.join(baseDirectory, caseSensitive === false ? toAsciiLowerCase(suffix) : suffix);
}

export function normalizePathForLookup(filePath: string) {
    if (!filePath || filePath.trim().length === 0) {
        return '';
    }

    if (isWindowsPathLike(filePath)) {
        const resolvedWindowsPath = normalizeResolvedWindowsPath(filePath);
        try {
            // Native realpath returns canonical on-disk casing for every existing ancestor and leaf,
            // resolving symlinks, junctions, and 8.3 short aliases in one syscall.
            const realPath = normalizeResolvedWindowsPath(realpathSync.native(resolvedWindowsPath));
            const realDirectoryPath = win32.dirname(realPath);
            if (realDirectoryPath === realPath) {
                return realPath;
            }
            const leafName = win32.basename(realPath);
            if (!leafName || !hasAsciiUppercase(leafName)) {
                return realPath;
            }
            const targetStat = tryLstatBigInt(realPath);
            if (targetStat.kind === 'ok' && targetStat.stats.isDirectory()) {
                // Keep existing directories' canonical on-disk spelling so prefix containment with children holds.
                return realPath;
            }
            const caseSensitive = resolveRealWindowsDirectoryCaseSensitivity(
                realDirectoryPath,
                leafName,
                targetStat.kind === 'ok' ? targetStat.stats : undefined,
            );
            return foldWindowsSuffix(realDirectoryPath, leafName, caseSensitive);
        } catch {
            // A path whose leaf does not exist yet, such as a document ref or Save As target, resolves its
            // nearest existing ancestor so short/long aliases keep one canonical parent prefix.
            // Only the missing suffix is ASCII-folded when that parent is proven case-insensitive.
            const directory = resolveWindowsMissingAncestorLookup(win32.dirname(resolvedWindowsPath));
            if (!directory.realPath || !directory.resolvedPath) {
                return resolvedWindowsPath;
            }
            const missingSuffix = win32.relative(directory.resolvedPath, resolvedWindowsPath);
            if (!hasAsciiUppercase(missingSuffix)) {
                return win32.join(directory.realPath, missingSuffix);
            }
            const caseSensitive = resolveRealWindowsDirectoryCaseSensitivity(directory.realPath, null);
            return foldWindowsSuffix(directory.realPath, missingSuffix, caseSensitive);
        }
    }

    const resolvedPath = resolve(filePath);
    try {
        return realpathSync.native(resolvedPath);
    } catch {
        return resolvePosixMissingLeafLookup(resolvedPath);
    }
}

// A path whose leaf does not exist yet resolves its nearest existing ancestor,
// so it keeps one key before and after the leaf appears
// when a parent is a symlink, such as macOS /var and /tmp.
function resolvePosixMissingLeafLookup(resolvedPath: string) {
    let ancestorPath = dirname(resolvedPath);
    while (ancestorPath !== dirname(ancestorPath)) {
        try {
            return join(realpathSync.native(ancestorPath), relative(ancestorPath, resolvedPath));
        } catch {
            ancestorPath = dirname(ancestorPath);
        }
    }
    return resolvedPath;
}
