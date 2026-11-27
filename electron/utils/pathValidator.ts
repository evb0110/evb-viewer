import {getErrorMessage} from '@electron/utils/error';
import {basename, dirname, isAbsolute, relative, resolve, sep, win32} from 'path';
import {existsSync, lstatSync, realpathSync, statSync} from 'fs';
import {getManagedAppTempRoots, PINNED_REVISIONS_DIR_NAME} from '@electron/utils/appTempDir';

interface IPathOps {
    basename(path: string): string;
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
    sep: string;
}

type TManagedTempPathAccessValidator = (context: {senderId?: number}, filePath: unknown) => string | null | undefined;

let managedTempPathAccessValidator: TManagedTempPathAccessValidator | null = null;

export function setManagedTempPathAccessValidator(validator: TManagedTempPathAccessValidator) {
    managedTempPathAccessValidator = validator;
}

export function getManagedTempPathAccessDecision(context: {senderId?: number}, filePath: unknown) {
    return managedTempPathAccessValidator?.(context, filePath);
}

const defaultPathOps: IPathOps = {
    basename,
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
};

const windowsPathOps: IPathOps = {
    basename: win32.basename,
    dirname: win32.dirname,
    isAbsolute: win32.isAbsolute,
    relative: win32.relative,
    resolve: win32.resolve,
    sep: win32.sep,
};

function stripWindowsExtendedLengthPrefix(filePath: string) {
    if (filePath.startsWith('\\\\?\\UNC\\')) {
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

function getPathOps(...paths: string[]): IPathOps {
    return paths.some(isWindowsPathLike) ? windowsPathOps : defaultPathOps;
}

function normalizePathForComparison(filePath: string, ops: IPathOps) {
    const normalizedPath = ops.resolve(stripWindowsExtendedLengthPrefix(filePath));
    return ops === windowsPathOps ? normalizedPath.toLowerCase() : normalizedPath;
}

function normalizeCandidatePath(filePath: string) {
    if (!filePath || filePath.trim() === '') {
        return null;
    }

    try {
        const trimmedPath = filePath.trim();
        return getPathOps(trimmedPath).resolve(trimmedPath);
    } catch {
        return null;
    }
}

function isPathInsideBaseDir(baseDir: string, candidatePath: string) {
    const ops = getPathOps(baseDir, candidatePath);
    const relativePath = ops.relative(normalizePathForComparison(baseDir, ops), normalizePathForComparison(candidatePath, ops));

    if (relativePath === '' || relativePath === '.') {
        return false;
    }

    return relativePath !== '..' && !relativePath.startsWith(`..${ops.sep}`) && !ops.isAbsolute(relativePath);
}

function isPathInsideAnyBaseDir(baseDirs: string[], candidatePath: string) {
    for (const baseDir of baseDirs) {
        if (isPathInsideBaseDir(baseDir, candidatePath)) {
            return true;
        }
    }
    return false;
}

function isSamePath(left: string, right: string) {
    const ops = getPathOps(left, right);
    return normalizePathForComparison(left, ops) === normalizePathForComparison(right, ops);
}

function isPathSameAsAnyBaseDir(baseDirs: string[], candidatePath: string) {
    return baseDirs.some((baseDir) => isSamePath(baseDir, candidatePath));
}

function isReservedTempPathByName(tempBaseDirs: string[], candidatePath: string) {
    const reservedName = PINNED_REVISIONS_DIR_NAME.toLowerCase();
    for (const baseDir of tempBaseDirs) {
        const ops = getPathOps(baseDir, candidatePath);
        const relativePath = ops.relative(normalizePathForComparison(baseDir, ops), normalizePathForComparison(candidatePath, ops));
        if (
            relativePath !== '' &&
            relativePath !== '.' &&
            relativePath !== '..' &&
            !relativePath.startsWith(`..${ops.sep}`) &&
            !ops.isAbsolute(relativePath)
        ) {
            const firstSegment = relativePath.split(ops.sep)[0];
            if (firstSegment && firstSegment.toLowerCase() === reservedName) {
                return true;
            }
        }
    }
    return false;
}

interface IReservedDirIdentity {
    dev: bigint;
    ino: bigint;
}

function readDirectoryIdentity(targetPath: string): IReservedDirIdentity | null {
    try {
        const stats = statSync(targetPath, {bigint: true});
        if (typeof stats?.dev === 'bigint' && typeof stats?.ino === 'bigint' && stats.ino !== 0n) {
            return {
                dev: stats.dev,
                ino: stats.ino,
            };
        }
    } catch {
        // Missing or unreadable paths do not reveal a reserved directory identity.
    }
    return null;
}

function hasReservedTempDirIdentity(tempBaseDirs: string[], candidatePath: string) {
    const reservedIdentities: IReservedDirIdentity[] = [];
    for (const baseDir of tempBaseDirs) {
        const identity = readDirectoryIdentity(`${baseDir}${getPathOps(baseDir).sep}${PINNED_REVISIONS_DIR_NAME}`);
        if (identity) {
            reservedIdentities.push(identity);
        }
    }
    if (reservedIdentities.length === 0) {
        return false;
    }

    const ops = getPathOps(candidatePath);
    let current = ops.resolve(stripWindowsExtendedLengthPrefix(candidatePath));
    for (;;) {
        const identity = readDirectoryIdentity(current);
        if (identity && reservedIdentities.some((reserved) => reserved.dev === identity.dev && reserved.ino === identity.ino)) {
            return true;
        }
        if (isPathSameAsAnyBaseDir(tempBaseDirs, current)) {
            return false;
        }
        const parent = ops.dirname(current);
        if (parent === current) {
            return false;
        }
        current = parent;
    }
}

/**
 * A pinned document revision belongs to the window that pinned it, and the document store checks that on every read;
 * a path check here cannot, so it refuses the whole folder to every generic read and write, across case spellings and
 * filesystem aliases pointing to the same reserved directory.
 */
function isReservedTempPathInBaseDirs(tempBaseDirs: string[], candidatePath: string) {
    return isReservedTempPathByName(tempBaseDirs, candidatePath) || hasReservedTempDirIdentity(tempBaseDirs, candidatePath);
}

function resolveKernelPathPrefixSync(rawPath: string): string | null {
    if (!rawPath || rawPath.trim() === '') {
        return null;
    }

    const ops = getPathOps(rawPath);
    const unprefixed = stripWindowsExtendedLengthPrefix(rawPath);
    const realpathNative = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
    const remainder: string[] = [];
    let prefix = unprefixed;

    for (;;) {
        try {
            const resolvedPrefix = realpathNative(prefix);
            return remainder.length === 0 ? resolvedPrefix : ops.resolve(resolvedPrefix, ...remainder.toReversed());
        } catch {
            const segment = ops.basename(prefix);
            if (segment !== '') {
                remainder.push(segment);
            }
            const parent = ops.dirname(prefix);
            if (parent === prefix) {
                return null;
            }
            prefix = parent;
        }
    }
}

function hasReservedKernelPathSync(tempBaseDirs: string[], filePath: string) {
    const kernelPath = resolveKernelPathPrefixSync(filePath);
    if (kernelPath !== null && isReservedTempPathInBaseDirs(tempBaseDirs, kernelPath)) {
        return true;
    }
    const trimmedPath = filePath.trim();
    if (trimmedPath !== filePath) {
        const trimmedKernelPath = resolveKernelPathPrefixSync(trimmedPath);
        if (trimmedKernelPath !== null && isReservedTempPathInBaseDirs(tempBaseDirs, trimmedKernelPath)) {
            return true;
        }
    }
    return false;
}

/** Whether `filePath` (directly, by case variant, or via symlinked file/parent directory) targets the reserved pin directory. */
export function isReservedTempPath(filePath: string): boolean {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return false;
    }

    try {
        const tempBaseDirs = getTempBaseDirsSync();
        if (isReservedTempPathInBaseDirs(tempBaseDirs, absolutePath)) {
            return true;
        }
        if (hasReservedKernelPathSync(tempBaseDirs, filePath)) {
            return true;
        }
        const resolvedAbsolutePath = safeRealpathSync(absolutePath);
        if (resolvedAbsolutePath !== absolutePath && isReservedTempPathInBaseDirs(tempBaseDirs, resolvedAbsolutePath)) {
            return true;
        }
        if (filePath !== absolutePath) {
            const resolvedRawPath = safeRealpathSync(filePath);
            if (resolvedRawPath !== filePath && isReservedTempPathInBaseDirs(tempBaseDirs, resolvedRawPath)) {
                return true;
            }
        }
        const parentDir = getPathOps(absolutePath).dirname(absolutePath);
        const resolvedParentDir = safeRealpathSync(parentDir);
        if (resolvedParentDir !== parentDir && isReservedTempPathInBaseDirs(tempBaseDirs, resolvedParentDir)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function safeRealpathSync(path: string) {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

// The temp namespace is fixed at startup and getAppTempDir() refuses symlinked
// temp roots, so the canonical base dirs cannot legitimately change while the
// configured path stays the same; caching them avoids a realpath per validation.
// Only a successful canonicalization is cached. Caching the pre-existence
// fallback pinned an uncanonicalized base set for the process lifetime, which
// rejected every temp read on hosts where the configured and canonical forms
// differ (Windows 8.3 short names, macOS /var symlinks).
const canonicalTempBaseDirs = new Map<string, string[]>();

function getTempBaseDirsSync() {
    // The namespace an earlier release left in temp stays readable for its working copies.
    return getManagedAppTempRoots().flatMap((configuredTempDir) => {
        const cached = canonicalTempBaseDirs.get(configuredTempDir);
        if (cached) {
            return cached;
        }
        const tempDir = normalizeCandidatePath(configuredTempDir) ?? resolve(configuredTempDir);
        let canonicalTempDir: string;
        try {
            canonicalTempDir = realpathSync(tempDir);
        } catch {
            // The app temp dir is created lazily; before it exists realpath
            // cannot resolve it and the canonical form is unknown.
            return [tempDir];
        }
        const baseDirs = isSamePath(canonicalTempDir, tempDir) ? [tempDir] : [tempDir, canonicalTempDir];
        canonicalTempBaseDirs.set(configuredTempDir, baseDirs);
        return baseDirs;
    });
}

export function resetPathValidatorCachesForTests() {
    canonicalTempBaseDirs.clear();
}

/**
 * Compact validator-state description for read-rejection errors. Rejections
 * proved undiagnosable from renderer-visible state alone (issue #82), so the
 * error must carry what the validator actually computed and observed.
 */
export function describeReadPathValidationForDiagnostics(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return 'candidate=unnormalizable';
    }
    let baseDirs: string[];
    try {
        baseDirs = getTempBaseDirsSync();
    } catch (error) {
        return `baseDirs=error:${getErrorMessage(error)}`;
    }
    let lstatOutcome = 'ok';
    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            lstatOutcome = 'symlink';
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        lstatOutcome = `error:${code}`;
    }
    let realpathOutcome: string;
    try {
        realpathOutcome = realpathSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        realpathOutcome = `error:${code}`;
    }
    return `baseDirs=[${baseDirs.join(' | ')}]; lstat=${lstatOutcome}; realpath=${realpathOutcome}`;
}

function isSymlinkPathSync(path: string) {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

function resolveExistingTempPath(absolutePath: string, tempBaseDirs: string[]): string | false | null {
    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return false;
        }

        const resolvedPath = safeRealpathSync(absolutePath);
        return isPathInsideAnyBaseDir(tempBaseDirs, resolvedPath) ? resolvedPath : false;
    } catch {
        return null;
    }
}

export function isAllowedWritePath(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return false;
    }

    try {
        const tempBaseDirs = getTempBaseDirsSync();
        if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath) || isReservedTempPathInBaseDirs(tempBaseDirs, absolutePath)) {
            return false;
        }

        if (isSymlinkPathSync(absolutePath)) {
            return false;
        }

        return !hasReservedKernelPathSync(tempBaseDirs, filePath);
    } catch {
        return false;
    }
}

export function isAllowedReadPath(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return false;
    }

    try {
        const tempBaseDirs = getTempBaseDirsSync();
        if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath) || isReservedTempPathInBaseDirs(tempBaseDirs, absolutePath)) {
            return false;
        }

        if (!existsSync(absolutePath)) {
            return false;
        }

        if (isSymlinkPathSync(absolutePath)) {
            return false;
        }

        return !hasReservedKernelPathSync(tempBaseDirs, filePath);
    } catch {
        return false;
    }
}

// Deliberately synchronous: in packaged Windows builds Electron's ASAR fs
// shim intercepts fs.promises metadata calls (its fs.Stats construction is
// what emits DEP0180) and rejected lstat/realpath for valid working-copy
// paths, failing every temp-sandbox read (issue #82). The sync fs API on the
// same paths works, as it did before the async conversion.
function resolveAllowedReadPathSync(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirsSync();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath) || isReservedTempPathInBaseDirs(tempBaseDirs, absolutePath)) {
        return null;
    }

    try {
        if (lstatSync(absolutePath).isSymbolicLink()) {
            return null;
        }

        if (hasReservedKernelPathSync(tempBaseDirs, filePath)) {
            return null;
        }

        const resolvedPath = safeRealpathSync(absolutePath);
        return isPathInsideAnyBaseDir(tempBaseDirs, resolvedPath) && !isReservedTempPathInBaseDirs(tempBaseDirs, resolvedPath)
            ? resolvedPath
            : null;
    } catch {
        return null;
    }
}

export function resolveAllowedReadPath(filePath: string) {
    return Promise.resolve(resolveAllowedReadPathSync(filePath));
}

function resolveAllowedWritePathSync(filePath: string) {
    const absolutePath = normalizeCandidatePath(filePath);
    if (!absolutePath) {
        return null;
    }

    const tempBaseDirs = getTempBaseDirsSync();
    if (!isPathInsideAnyBaseDir(tempBaseDirs, absolutePath) || isReservedTempPathInBaseDirs(tempBaseDirs, absolutePath)) {
        return null;
    }

    const resolvedTargetPath = resolveExistingTempPath(absolutePath, tempBaseDirs);
    if (resolvedTargetPath === false || (resolvedTargetPath !== null && isReservedTempPathInBaseDirs(tempBaseDirs, resolvedTargetPath))) {
        return null;
    }
    if (resolvedTargetPath === null) {
        // The target may not exist yet. Validate the parent directory path.
    }

    if (hasReservedKernelPathSync(tempBaseDirs, filePath)) {
        return null;
    }

    try {
        const ops = getPathOps(absolutePath);
        const parentDir = ops.dirname(absolutePath);
        const resolvedParentDir = safeRealpathSync(parentDir);
        const isTempDirRoot = isPathSameAsAnyBaseDir(tempBaseDirs, resolvedParentDir);
        if (
            (!isPathInsideAnyBaseDir(tempBaseDirs, resolvedParentDir) && !isTempDirRoot) ||
            isReservedTempPathInBaseDirs(tempBaseDirs, resolvedParentDir)
        ) {
            return null;
        }
    } catch {
        return null;
    }

    return absolutePath;
}

export function resolveAllowedWritePath(filePath: string) {
    return Promise.resolve(resolveAllowedWritePathSync(filePath));
}
