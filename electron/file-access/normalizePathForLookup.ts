import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {
    dirname,
    join,
    relative,
    resolve,
    win32,
} from 'node:path';

const windowsCaseSensitivityByDirectory = new Map<string, boolean | null>();

interface IWindowsDirectoryLookup {
    caseSensitive: boolean | null;
    realPath: string | null;
    resolvedPath: string | null;
}

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

function normalizeResolvedWindowsPath(filePath: string) {
    return win32.resolve(stripWindowsExtendedLengthPrefix(filePath));
}

function resolveWindowsDirectoryLookup(directoryPath: string): IWindowsDirectoryLookup {
    let currentPath = normalizeResolvedWindowsPath(directoryPath);
    while (currentPath && currentPath !== win32.dirname(currentPath)) {
        try {
            const realDirectoryPath = normalizeResolvedWindowsPath(realpathSync.native(currentPath));
            if (windowsCaseSensitivityByDirectory.has(realDirectoryPath)) {
                return {
                    caseSensitive: windowsCaseSensitivityByDirectory.get(realDirectoryPath)!,
                    realPath: realDirectoryPath,
                    resolvedPath: currentPath,
                };
            }
            const result = spawnSync(
                'fsutil.exe',
                [
                    'file',
                    'queryCaseSensitiveInfo',
                    realDirectoryPath,
                ],
                {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 1_000,
                },
            );
            const output = `${String(result.stdout)}\n${String(result.stderr)}`;
            const caseSensitive = /case sensitive attribute .* is enabled/iu.test(output)
                ? true
                : /case sensitive attribute .* is disabled/iu.test(output)
                    ? false
                    : null;
            windowsCaseSensitivityByDirectory.set(realDirectoryPath, caseSensitive);
            return {
                caseSensitive,
                realPath: realDirectoryPath,
                resolvedPath: currentPath,
            };
        } catch {
            currentPath = win32.dirname(currentPath);
        }
    }
    return {
        caseSensitive: null,
        realPath: null,
        resolvedPath: null,
    };
}

function normalizeWindowsPathCase(filePath: string, caseSensitive: boolean | null) {
    return caseSensitive === false ? filePath.toLowerCase() : filePath;
}

export function normalizePathForLookup(filePath: string) {
    if (!filePath || filePath.trim().length === 0) {
        return '';
    }

    if (isWindowsPathLike(filePath)) {
        const resolvedWindowsPath = normalizeResolvedWindowsPath(filePath);
        try {
            // Native realpath preserves case-sensitive spellings while resolving Windows aliases.
            const realPath = normalizeResolvedWindowsPath(realpathSync.native(resolvedWindowsPath));
            const directory = resolveWindowsDirectoryLookup(win32.dirname(realPath));
            return normalizeWindowsPathCase(realPath, directory.caseSensitive);
        } catch {
            // A path whose leaf does not exist yet, such as a document ref, resolves its
            // existing parent, so its short and long Windows aliases keep one key.
            // Only the ordinary case-insensitive result is folded; an unknown or
            // case-sensitive share keeps its spelling.
            const directory = resolveWindowsDirectoryLookup(win32.dirname(resolvedWindowsPath));
            const missingLeafPath = directory.realPath && directory.resolvedPath
                ? win32.join(
                    directory.realPath,
                    win32.relative(directory.resolvedPath, resolvedWindowsPath),
                )
                : resolvedWindowsPath;
            return normalizeWindowsPathCase(missingLeafPath, directory.caseSensitive);
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

