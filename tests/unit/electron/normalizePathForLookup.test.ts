import {mkdirSync, mkdtempSync, realpathSync as realFsRealpathSync, rmSync, symlinkSync, writeFileSync, type BigIntStats} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, win32} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface IFakeWindowsEntry {
    name: string;
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    birthtimeNs: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
    kind: 'file' | 'dir' | 'symlink';
    /** Target path for symlinks/junctions when resolved by realpathSync.native. */
    realTarget?: string;
    /** When true, dereferencing this symlink via realpathSync.native throws ENOENT. */
    dangling?: boolean;
}

interface IFakeWindowsDirectory {
    canonicalPath: string;
    caseSensitive: boolean;
    dev: bigint;
    ino: bigint;
    birthtimeNs: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
    listErrorCode?: string;
    statErrorCode?: string;
    entries: IFakeWindowsEntry[];
}

function makeErrno(code: string, message = code): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

function asciiLower(value: string) {
    let lowered = '';
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        lowered += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : value[index]!;
    }
    return lowered;
}

function makeBigIntStats(fields: {
    dev: bigint;
    ino: bigint;
    nlink: bigint;
    birthtimeNs: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
    kind: 'file' | 'dir' | 'symlink';
}): BigIntStats {
    return {
        dev: fields.dev,
        ino: fields.ino,
        nlink: fields.nlink,
        birthtimeNs: fields.birthtimeNs,
        ctimeNs: fields.ctimeNs,
        mtimeNs: fields.mtimeNs,
        isDirectory: () => fields.kind === 'dir',
        isFile: () => fields.kind === 'file',
        isSymbolicLink: () => fields.kind === 'symlink',
    } as unknown as BigIntStats;
}

const fakeWinFs = vi.hoisted(() => {
    const splitWindowsPath = (inputPath: string): {root: string; segments: string[]} | null => {
        const resolved = win32.resolve(inputPath);
        if (/^[a-zA-Z]:\\/u.test(resolved)) {
            const root = `${resolved[0]!.toUpperCase()}:\\`;
            const rest = resolved.slice(3);
            return {root, segments: rest ? rest.split('\\').filter(Boolean) : []};
        }
        if (resolved.startsWith('\\\\')) {
            const parts = resolved.slice(2).split('\\').filter(Boolean);
            if (parts.length < 2) {
                return null;
            }
            return {
                root: `\\\\${parts[0]!.toLowerCase()}\\${parts[1]!.toLowerCase()}\\`,
                segments: parts.slice(2),
            };
        }
        return null;
    };

    const asciiLowerInner = (value: string) => {
        let lowered = '';
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            lowered += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 32) : value[index]!;
        }
        return lowered;
    };

    const state = {
        enabled: false,
        directories: new Map<string, IFakeWindowsDirectory>(),
        directoriesByLower: new Map<string, IFakeWindowsDirectory[]>(),
        pathAliases: new Map<string, string>(),
        opendirCalls: [] as string[],
        lstatCalls: [] as string[],
        realpathCalls: [] as string[],
        lstatInterceptor: null as null | ((path: string, next: () => BigIntStats) => BigIntStats),
        realpathInterceptor: null as null | ((path: string, next: () => string) => string),
        reset() {
            state.enabled = false;
            state.directories.clear();
            state.directoriesByLower.clear();
            state.pathAliases.clear();
            state.opendirCalls.length = 0;
            state.lstatCalls.length = 0;
            state.realpathCalls.length = 0;
            state.lstatInterceptor = null;
            state.realpathInterceptor = null;
        },
        setDirectory(dir: IFakeWindowsDirectory) {
            state.directories.set(dir.canonicalPath, dir);
            const lowerKey = asciiLowerInner(win32.resolve(dir.canonicalPath));
            const bucket = state.directoriesByLower.get(lowerKey) ?? [];
            const existingIndex = bucket.findIndex((item) => item.canonicalPath === dir.canonicalPath);
            if (existingIndex === -1) {
                bucket.push(dir);
            } else {
                bucket[existingIndex] = dir;
            }
            state.directoriesByLower.set(lowerKey, bucket);
        },
        resolveAlias(inputPath: string): string {
            for (const [alias, target] of state.pathAliases) {
                if (asciiLowerInner(inputPath) === asciiLowerInner(alias)) {
                    return target;
                }
                const prefix = alias.endsWith('\\') ? alias : `${alias}\\`;
                if (asciiLowerInner(inputPath).startsWith(asciiLowerInner(prefix))) {
                    return `${target}${inputPath.slice(alias.length)}`;
                }
            }
            return inputPath;
        },
        /**
         * Resolves a directory path component-by-component respecting each parent directory's
         * `caseSensitive` flag (instead of folding the whole path case-insensitively), so mixed
         * case-sensitive/case-insensitive hierarchies (`C:\CS\A\Docs` vs `C:\CS\a\Docs`) behave like NTFS.
         */
        findDirectory(dirPath: string): IFakeWindowsDirectory | undefined {
            const direct = state.directories.get(dirPath);
            if (direct) {
                return direct;
            }
            const candidates = state.directoriesByLower.get(asciiLowerInner(win32.resolve(dirPath)));
            if (!candidates || candidates.length === 0) {
                return undefined;
            }
            const targetParts = splitWindowsPath(dirPath);
            if (!targetParts) {
                return undefined;
            }
            for (const candidate of candidates) {
                const candidateParts = splitWindowsPath(candidate.canonicalPath);
                if (!candidateParts || candidateParts.root !== targetParts.root) {
                    continue;
                }
                if (candidateParts.segments.length !== targetParts.segments.length) {
                    continue;
                }
                let matched = true;
                let prefix = candidateParts.root;
                for (let index = 0; index < candidateParts.segments.length; index += 1) {
                    const parentDir = state.directories.get(prefix);
                    const caseSensitive = parentDir?.caseSensitive ?? false;
                    const expectedSeg = candidateParts.segments[index]!;
                    const actualSeg = targetParts.segments[index]!;
                    const segMatches = caseSensitive
                        ? expectedSeg === actualSeg
                        : asciiLowerInner(expectedSeg) === asciiLowerInner(actualSeg);
                    if (!segMatches) {
                        matched = false;
                        break;
                    }
                    prefix = win32.join(prefix, expectedSeg);
                }
                if (matched) {
                    return candidate;
                }
            }
            return undefined;
        },
        findEntry(dir: IFakeWindowsDirectory, name: string): IFakeWindowsEntry | undefined {
            if (dir.caseSensitive) {
                return dir.entries.find((entry) => entry.name === name);
            }
            // NTFS ASCII folding does NOT equate Turkish İ (\u0130) with i\u0307.
            const lowered = asciiLowerInner(name);
            return dir.entries.find((entry) => asciiLowerInner(entry.name) === lowered);
        },
    };
    return state;
});

const spawnSyncSpy = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:child_process')>();
    return {
        ...original,
        spawnSync: spawnSyncSpy,
    };
});

vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();

    const isWindowsInput = (p: unknown): p is string => typeof p === 'string' && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'));

    const fakeLstatSync = (targetPath: string): BigIntStats => {
        fakeWinFs.lstatCalls.push(targetPath);
        const runDefault = () => {
            const resolved = fakeWinFs.resolveAlias(targetPath);
            const asDir = fakeWinFs.findDirectory(resolved);
            if (asDir) {
                if (asDir.statErrorCode) {
                    throw makeErrno(asDir.statErrorCode);
                }
                return makeBigIntStats({
                    dev: asDir.dev,
                    ino: asDir.ino,
                    nlink: 1n,
                    birthtimeNs: asDir.birthtimeNs,
                    ctimeNs: asDir.ctimeNs,
                    mtimeNs: asDir.mtimeNs,
                    kind: 'dir',
                });
            }
            const parentPath = win32.dirname(resolved);
            const leafName = win32.basename(resolved);
            const parentDir = fakeWinFs.findDirectory(parentPath);
            if (!parentDir) {
                throw makeErrno('ENOENT');
            }
            const entry = fakeWinFs.findEntry(parentDir, leafName);
            if (!entry) {
                throw makeErrno('ENOENT');
            }
            return makeBigIntStats({
                dev: entry.dev,
                ino: entry.ino,
                nlink: entry.nlink,
                birthtimeNs: entry.birthtimeNs,
                ctimeNs: entry.ctimeNs,
                mtimeNs: entry.mtimeNs,
                kind: entry.kind,
            });
        };
        return fakeWinFs.lstatInterceptor ? fakeWinFs.lstatInterceptor(targetPath, runDefault) : runDefault();
    };

    const fakeRealpathNative = (targetPath: string): string => {
        fakeWinFs.realpathCalls.push(targetPath);
        const runDefault = () => {
            const resolved = fakeWinFs.resolveAlias(targetPath);
            const asDir = fakeWinFs.findDirectory(resolved);
            if (asDir) {
                return asDir.canonicalPath;
            }
            const parentPath = win32.dirname(resolved);
            const leafName = win32.basename(resolved);
            const parentDir = fakeWinFs.findDirectory(parentPath);
            if (!parentDir) {
                throw makeErrno('ENOENT');
            }
            const entry = fakeWinFs.findEntry(parentDir, leafName);
            if (!entry) {
                throw makeErrno('ENOENT');
            }
            if (entry.dangling) {
                throw makeErrno('ENOENT');
            }
            if (entry.realTarget) {
                return entry.realTarget;
            }
            return win32.join(parentDir.canonicalPath, entry.name);
        };
        return fakeWinFs.realpathInterceptor ? fakeWinFs.realpathInterceptor(targetPath, runDefault) : runDefault();
    };

    const fakeOpendirSync = (dirPath: string) => {
        fakeWinFs.opendirCalls.push(dirPath);
        const resolved = fakeWinFs.resolveAlias(dirPath);
        const dir = fakeWinFs.findDirectory(resolved);
        if (!dir) {
            throw makeErrno('ENOENT');
        }
        if (dir.listErrorCode) {
            throw makeErrno(dir.listErrorCode);
        }
        let cursor = 0;
        const snapshot = [...dir.entries];
        return {
            path: dir.canonicalPath,
            readSync: () => {
                if (cursor >= snapshot.length) {
                    return null;
                }
                const entry = snapshot[cursor++]!;
                return {name: entry.name};
            },
            closeSync: () => undefined,
        };
    };

    const realpathSync = Object.assign((...args: Parameters<typeof original.realpathSync>) => original.realpathSync(...args), {
        native: ((
            targetPath: Parameters<typeof original.realpathSync.native>[0],
            options?: Parameters<typeof original.realpathSync.native>[1],
        ) => {
            if (fakeWinFs.enabled && isWindowsInput(targetPath)) {
                return fakeRealpathNative(targetPath);
            }
            return original.realpathSync.native(targetPath, options as never);
        }) as typeof original.realpathSync.native,
    });

    const lstatSync = ((targetPath: Parameters<typeof original.lstatSync>[0], options?: Parameters<typeof original.lstatSync>[1]) => {
        if (fakeWinFs.enabled && isWindowsInput(targetPath)) {
            return fakeLstatSync(targetPath);
        }
        return original.lstatSync(targetPath, options as never);
    }) as typeof original.lstatSync;

    const opendirSync = ((targetPath: Parameters<typeof original.opendirSync>[0], options?: Parameters<typeof original.opendirSync>[1]) => {
        if (fakeWinFs.enabled && isWindowsInput(targetPath)) {
            return fakeOpendirSync(targetPath);
        }
        return original.opendirSync(targetPath, options as never);
    }) as typeof original.opendirSync;

    return {
        ...original,
        lstatSync,
        opendirSync,
        realpathSync,
    };
});

const {normalizePathForLookup, resetWindowsPathLookupCacheForTests, WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES} =
    await import('@electron/file-access/normalizePathForLookup');
const {withOriginalPathMutationLock} = await import('@electron/file-access/withOriginalPathMutationLock');

function addFakeDirectory(options: {
    path: string;
    caseSensitive: boolean;
    dev?: bigint;
    ino?: bigint;
    birthtimeNs?: bigint;
    ctimeNs?: bigint;
    mtimeNs?: bigint;
    listErrorCode?: string;
    statErrorCode?: string;
    entries?: Array<Partial<IFakeWindowsEntry> & {name: string}>;
}): IFakeWindowsDirectory {
    const dev = options.dev ?? 100n;
    const baseIno = options.ino ?? BigInt(10_000 + fakeWinFs.directories.size * 1_000);
    const birthtimeNs = options.birthtimeNs ?? 1_000_000n;
    const ctimeNs = options.ctimeNs ?? birthtimeNs;
    const mtimeNs = options.mtimeNs ?? birthtimeNs;
    const dir: IFakeWindowsDirectory = {
        canonicalPath: options.path,
        caseSensitive: options.caseSensitive,
        dev,
        ino: baseIno,
        birthtimeNs,
        ctimeNs,
        mtimeNs,
        ...(options.listErrorCode ? {listErrorCode: options.listErrorCode} : {}),
        ...(options.statErrorCode ? {statErrorCode: options.statErrorCode} : {}),
        entries: (options.entries ?? []).map((entry, index) => ({
            name: entry.name,
            dev: entry.dev ?? dev,
            ino: entry.ino ?? baseIno + BigInt(index + 1),
            nlink: entry.nlink ?? 1n,
            birthtimeNs: entry.birthtimeNs ?? birthtimeNs,
            ctimeNs: entry.ctimeNs ?? ctimeNs,
            mtimeNs: entry.mtimeNs ?? mtimeNs,
            kind: entry.kind ?? 'file',
            ...(entry.realTarget ? {realTarget: entry.realTarget} : {}),
            ...(entry.dangling ? {dangling: true} : {}),
        })),
    };
    fakeWinFs.setDirectory(dir);
    return dir;
}

describe('normalizePathForLookup (Windows fast sync probe & LRU cache)', () => {
    beforeEach(() => {
        fakeWinFs.reset();
        fakeWinFs.enabled = true;
        spawnSyncSpy.mockClear();
        resetWindowsPathLookupCacheForTests();
    });

    afterEach(() => {
        fakeWinFs.reset();
        resetWindowsPathLookupCacheForTests();
        vi.useRealTimers();
    });

    it('detects case-insensitive directories synchronously via the leaf entry with zero opendirSync and zero spawnSync calls', () => {
        addFakeDirectory({
            path: 'C:\\Users\\Alice\\Docs',
            caseSensitive: false,
            entries: [{name: 'Report.pdf'}],
        });

        expect(normalizePathForLookup('C:\\Users\\Alice\\Docs\\Report.pdf')).toBe('C:\\Users\\Alice\\Docs\\report.pdf');
        expect(normalizePathForLookup('c:\\USERS\\alice\\docs\\REPORT.PDF')).toBe('C:\\Users\\Alice\\Docs\\report.pdf');
        expect(fakeWinFs.opendirCalls).toEqual([]);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('skips probing completely when the existing or missing leaf has no uppercase ASCII letters', () => {
        addFakeDirectory({
            path: 'C:\\Users\\Alice\\Docs',
            caseSensitive: false,
            entries: [{name: 'report.pdf'}],
        });

        expect(normalizePathForLookup('C:\\Users\\Alice\\Docs\\report.pdf')).toBe('C:\\Users\\Alice\\Docs\\report.pdf');
        expect(normalizePathForLookup('C:\\Users\\Alice\\Docs\\missing.pdf')).toBe('C:\\Users\\Alice\\Docs\\missing.pdf');
        expect(fakeWinFs.lstatCalls).toEqual([]);
        expect(fakeWinFs.opendirCalls).toEqual([]);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('preserves canonical spelling of case-sensitive parent directories even when child directories are case-insensitive', () => {
        addFakeDirectory({
            path: 'C:\\CS',
            caseSensitive: true,
            entries: [
                {name: 'A', kind: 'dir'},
                {name: 'a', kind: 'dir'},
            ],
        });
        addFakeDirectory({
            path: 'C:\\CS\\A\\Docs',
            caseSensitive: false,
            entries: [{name: 'Report.pdf', ino: 101n}],
        });
        addFakeDirectory({
            path: 'C:\\CS\\a\\Docs',
            caseSensitive: false,
            entries: [{name: 'Report.pdf', ino: 102n}],
        });

        // Distinct files under C:\CS\A vs C:\CS\a must NEVER collapse to the same key.
        expect(normalizePathForLookup('C:\\CS\\A\\Docs\\Report.pdf')).toBe('C:\\CS\\A\\Docs\\report.pdf');
        expect(normalizePathForLookup('C:\\CS\\a\\Docs\\Report.pdf')).toBe('C:\\CS\\a\\Docs\\report.pdf');
        expect(normalizePathForLookup('C:\\CS\\A\\DOCS\\REPORT.PDF')).toBe('C:\\CS\\A\\Docs\\report.pdf');
        expect(normalizePathForLookup('C:\\CS\\A\\Docs\\NewSave.pdf')).toBe('C:\\CS\\A\\Docs\\newsave.pdf');
        expect(normalizePathForLookup('C:\\CS\\a\\Docs\\NewSave.pdf')).toBe('C:\\CS\\a\\Docs\\newsave.pdf');
    });

    it('does not collapse NTFS-distinct Unicode spellings such as İ.pdf and i\\u0307.pdf', () => {
        addFakeDirectory({
            path: 'C:\\Work\\Unicode',
            caseSensitive: false,
            entries: [
                {name: 'İ.pdf', ino: 201n},
                {name: 'i\u0307.pdf', ino: 202n},
                {name: 'Normal.pdf', ino: 203n},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\Unicode\\İ.pdf')).toBe('C:\\Work\\Unicode\\İ.pdf');
        expect(normalizePathForLookup('C:\\Work\\Unicode\\i\u0307.pdf')).toBe('C:\\Work\\Unicode\\i\u0307.pdf');
        expect(normalizePathForLookup('C:\\Work\\Unicode\\İ.PDF')).toBe('C:\\Work\\Unicode\\İ.pdf');
        expect(normalizePathForLookup('C:\\Work\\Unicode\\İ.pdf')).not.toBe(normalizePathForLookup('C:\\Work\\Unicode\\i\u0307.pdf'));
    });

    it('keeps existing directory canonical casing intact so prefix containment with children holds', () => {
        addFakeDirectory({
            path: 'C:\\Temp\\Store',
            caseSensitive: false,
            entries: [{name: 'MyDocs', kind: 'dir'}],
        });
        addFakeDirectory({
            path: 'C:\\Temp\\Store\\MyDocs',
            caseSensitive: false,
            entries: [{name: 'Report.pdf'}],
        });

        const dirKey = normalizePathForLookup('C:\\Temp\\Store\\mydocs');
        const fileKey = normalizePathForLookup('C:\\Temp\\Store\\MYDOCS\\REPORT.PDF');
        expect(dirKey).toBe('C:\\Temp\\Store\\MyDocs');
        expect(fileKey).toBe('C:\\Temp\\Store\\MyDocs\\report.pdf');
        expect(fileKey.startsWith(`${dirKey}\\`)).toBe(true);
    });

    it('detects case-sensitive directories when toggled name returns ENOENT and preserves distinct spellings', () => {
        addFakeDirectory({
            path: 'C:\\Work\\CaseSensitive',
            caseSensitive: true,
            entries: [{name: 'Report.pdf'}],
        });

        expect(normalizePathForLookup('C:\\Work\\CaseSensitive\\Report.pdf')).toBe('C:\\Work\\CaseSensitive\\Report.pdf');
        expect(normalizePathForLookup('C:\\Work\\CaseSensitive\\report.pdf')).toBe('C:\\Work\\CaseSensitive\\report.pdf');
        expect(fakeWinFs.opendirCalls).toEqual([]);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('detects case-sensitive directories when both Foo.pdf and fOO.PDF exist as distinct files', () => {
        addFakeDirectory({
            path: 'C:\\Work\\Twins',
            caseSensitive: true,
            entries: [
                {name: 'Foo.pdf', ino: 501n},
                {name: 'fOO.PDF', ino: 502n},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\Twins\\Foo.pdf')).toBe('C:\\Work\\Twins\\Foo.pdf');
        expect(normalizePathForLookup('C:\\Work\\Twins\\fOO.PDF')).toBe('C:\\Work\\Twins\\fOO.PDF');
        expect(fakeWinFs.opendirCalls).toEqual([]);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('never misclassifies hard-linked case twins (nlink > 1) in a case-sensitive directory as case-insensitive', () => {
        addFakeDirectory({
            path: 'C:\\Work\\HardLinkTwins',
            caseSensitive: true,
            entries: [
                {name: 'Foo.pdf', ino: 700n, nlink: 2n},
                {name: 'fOO.PDF', ino: 700n, nlink: 2n},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\HardLinkTwins\\Foo.pdf')).toBe('C:\\Work\\HardLinkTwins\\Foo.pdf');
        expect(normalizePathForLookup('C:\\Work\\HardLinkTwins\\fOO.PDF')).toBe('C:\\Work\\HardLinkTwins\\fOO.PDF');
        expect(fakeWinFs.opendirCalls).toEqual(['C:\\Work\\HardLinkTwins']);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('defeats libuv synthetic nlink = 1 fallback on locked hard-linked case twins via realpathSync.native corroboration', () => {
        // Simulate Windows libuv fallback where lstatSync returns nlink = 1 for both hard links
        // (Foo.pdf and fOO.PDF) on ERROR_SHARING_VIOLATION, while realpathSync.native returns each opened link name.
        addFakeDirectory({
            path: 'C:\\Work\\SyntheticNlink',
            caseSensitive: true,
            entries: [
                {name: 'Foo.pdf', ino: 710n, nlink: 1n},
                {name: 'fOO.PDF', ino: 710n, nlink: 1n},
                {name: 'Other.pdf', ino: 711n, nlink: 1n},
                {name: 'other.pdf', ino: 712n, nlink: 1n},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\SyntheticNlink\\Foo.pdf')).toBe('C:\\Work\\SyntheticNlink\\Foo.pdf');
        expect(normalizePathForLookup('C:\\Work\\SyntheticNlink\\fOO.PDF')).toBe('C:\\Work\\SyntheticNlink\\fOO.PDF');
        expect(normalizePathForLookup('C:\\Work\\SyntheticNlink\\Other.pdf')).toBe('C:\\Work\\SyntheticNlink\\Other.pdf');
        expect(normalizePathForLookup('C:\\Work\\SyntheticNlink\\other.pdf')).toBe('C:\\Work\\SyntheticNlink\\other.pdf');
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('falls back to another nlink === 1 entry in a case-insensitive directory when the leaf is hard-linked', () => {
        addFakeDirectory({
            path: 'C:\\Work\\MixedLinks',
            caseSensitive: false,
            entries: [
                {name: 'Linked.pdf', ino: 800n, nlink: 2n},
                {name: 'Normal.pdf', ino: 801n, nlink: 1n},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\MixedLinks\\Linked.pdf')).toBe('C:\\Work\\MixedLinks\\linked.pdf');
        expect(fakeWinFs.opendirCalls).toEqual(['C:\\Work\\MixedLinks']);
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('preserves original spelling conservatively when every entry has nlink > 1 and no case twins exist', () => {
        addFakeDirectory({
            path: 'C:\\Work\\OnlyHardLinks',
            caseSensitive: false,
            entries: [{name: 'Linked.pdf', ino: 810n, nlink: 2n}],
        });

        expect(normalizePathForLookup('C:\\Work\\OnlyHardLinks\\Linked.pdf')).toBe('C:\\Work\\OnlyHardLinks\\Linked.pdf');
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('rejects synthetic zero inodes, stops serial SMB entry stats early (including on toggled EACCES), and never caches false when dirStat.ino === 0n', () => {
        const entries = Array.from({length: 30}, (_, index) => ({
            name: `Doc${index}.pdf`,
            ino: 0n,
            nlink: 1n,
        }));
        addFakeDirectory({
            path: '\\\\nas\\share\\ZeroIno',
            caseSensitive: false,
            ino: 0n,
            birthtimeNs: 0n,
            ctimeNs: 5_000n,
            mtimeNs: 5_000n,
            entries,
        });

        expect(normalizePathForLookup('\\\\nas\\share\\ZeroIno\\Missing.pdf')).toBe('\\\\nas\\share\\ZeroIno\\Missing.pdf');
        // Directory lstat + only the first zero-inode entry pair (stopped probing further entries immediately).
        expect(fakeWinFs.lstatCalls.length).toBeLessThanOrEqual(4);

        fakeWinFs.lstatCalls.length = 0;
        fakeWinFs.opendirCalls.length = 0;
        // Second lookup hits the null cache without repeating opendirSync or entry lstat calls.
        expect(normalizePathForLookup('\\\\nas\\share\\ZeroIno\\Another.pdf')).toBe('\\\\nas\\share\\ZeroIno\\Another.pdf');
        expect(fakeWinFs.opendirCalls).toEqual([]);
        expect(fakeWinFs.lstatCalls).toEqual(['\\\\nas\\share\\ZeroIno']);

        // Also stop immediately when original entry has ino === 0n and toggled lstat returns EACCES.
        addFakeDirectory({
            path: '\\\\nas\\share\\ZeroInoAccess',
            caseSensitive: false,
            ino: 0n,
            birthtimeNs: 0n,
            ctimeNs: 6_000n,
            mtimeNs: 6_000n,
            entries,
        });
        fakeWinFs.lstatCalls.length = 0;
        fakeWinFs.lstatInterceptor = (targetPath, next) => {
            if (targetPath.startsWith('\\\\nas\\share\\ZeroInoAccess\\dOC')) {
                throw makeErrno('EACCES');
            }
            return next();
        };
        expect(normalizePathForLookup('\\\\nas\\share\\ZeroInoAccess\\Missing.pdf')).toBe('\\\\nas\\share\\ZeroInoAccess\\Missing.pdf');
        expect(fakeWinFs.lstatCalls.length).toBeLessThanOrEqual(4);
        fakeWinFs.lstatInterceptor = null;

        // A directory with dirStat.ino === 0n and nonzero birthtimeNs must NOT cache `false` even if entries have nonzero inodes.
        const zeroInoDir = addFakeDirectory({
            path: '\\\\nas\\share\\ZeroDirIno',
            caseSensitive: false,
            ino: 0n,
            birthtimeNs: 7_000n,
            ctimeNs: 7_000n,
            mtimeNs: 7_000n,
            entries: [{name: 'Real.pdf', ino: 500n, nlink: 1n}],
        });
        expect(normalizePathForLookup('\\\\nas\\share\\ZeroDirIno\\Missing.pdf')).toBe('\\\\nas\\share\\ZeroDirIno\\missing.pdf');
        // Flip case-sensitivity without changing timestamps (same-tick replacement on zero-inode volume) -> must not serve stale `false`.
        zeroInoDir.caseSensitive = true;
        expect(normalizePathForLookup('\\\\nas\\share\\ZeroDirIno\\Missing.pdf')).toBe('\\\\nas\\share\\ZeroDirIno\\Missing.pdf');
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('distinguishes symlinks pointing to the same target in a case-sensitive directory via lstatSync', () => {
        addFakeDirectory({
            path: 'C:\\Targets',
            caseSensitive: false,
            entries: [{name: 'Shared.pdf', ino: 900n}],
        });
        addFakeDirectory({
            path: 'C:\\Work\\SymlinkTwins',
            caseSensitive: true,
            entries: [
                {name: 'Link.pdf', kind: 'symlink', ino: 901n, nlink: 1n, realTarget: 'C:\\Targets\\Shared.pdf'},
                {name: 'lINK.PDF', kind: 'symlink', ino: 902n, nlink: 1n, realTarget: 'C:\\Targets\\Shared.pdf'},
            ],
        });

        expect(normalizePathForLookup('C:\\Work\\SymlinkTwins\\NewSave.pdf')).toBe('C:\\Work\\SymlinkTwins\\NewSave.pdf');
        expect(normalizePathForLookup('C:\\Work\\SymlinkTwins\\newsave.pdf')).toBe('C:\\Work\\SymlinkTwins\\newsave.pdf');
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('handles dangling symlinks without concluding case-insensitivity from a symlink alone, and falls back to regular files', () => {
        addFakeDirectory({
            path: 'C:\\Work\\Dangling',
            caseSensitive: false,
            entries: [
                {name: 'Broken.pdf', kind: 'symlink', dangling: true, ino: 950n, nlink: 1n},
                {name: 'Real.pdf', kind: 'file', ino: 951n, nlink: 1n},
            ],
        });

        // Dereferencing Broken.pdf throws ENOENT and falls back to probing the parent via Real.pdf.
        expect(normalizePathForLookup('C:\\Work\\Dangling\\Broken.pdf')).toBe('C:\\Work\\Dangling\\broken.pdf');
        expect(normalizePathForLookup('C:\\Work\\Dangling\\MissingTarget.pdf')).toBe('C:\\Work\\Dangling\\missingtarget.pdf');
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('skips entries without ASCII letters conservatively and re-probes after directory replacement', () => {
        addFakeDirectory({
            path: 'C:\\Work\\DigitsOnly',
            caseSensitive: false,
            ino: 12_001n,
            birthtimeNs: 1_000n,
            mtimeNs: 1_000n,
            entries: [{name: '1234'}, {name: 'отчет'}],
        });

        expect(normalizePathForLookup('C:\\Work\\DigitsOnly\\MissingSave.pdf')).toBe('C:\\Work\\DigitsOnly\\MissingSave.pdf');

        // Replacing the directory at the same path with a populated directory invalidates the cached inconclusive entry.
        addFakeDirectory({
            path: 'C:\\Work\\DigitsOnly',
            caseSensitive: false,
            ino: 12_002n,
            birthtimeNs: 2_000n,
            mtimeNs: 2_000n,
            entries: [{name: '1234'}, {name: 'Report.pdf', ino: 99_999n}],
        });

        expect(normalizePathForLookup('C:\\Work\\DigitsOnly\\Report.pdf')).toBe('C:\\Work\\DigitsOnly\\report.pdf');
        expect(normalizePathForLookup('C:\\Work\\DigitsOnly\\MissingSave.pdf')).toBe('C:\\Work\\DigitsOnly\\missingsave.pdf');
    });

    it('keeps empty-directory lookup keys stable across staging .tmp creation so concurrent Save As locks serialize', async () => {
        const dir = addFakeDirectory({
            path: 'C:\\Work\\FreshEmpty',
            caseSensitive: false,
            ino: 55_000n,
            birthtimeNs: 2_000n,
            ctimeNs: 2_000n,
            mtimeNs: 2_000n,
            entries: [],
        });

        const order: string[] = [];
        let markStaged!: () => void;
        const staged = new Promise<void>((resolve) => {
            markStaged = resolve;
        });
        let releaseFirst!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        let firstSave: Promise<void> | undefined;
        let secondSave: Promise<void> | undefined;
        try {
            firstSave = withOriginalPathMutationLock('C:\\Work\\FreshEmpty\\Report.pdf', async () => {
                order.push('first:start');
                // First Save As stages a sibling .tmp file inside the previously empty directory, advancing mtime/ctime.
                dir.ctimeNs = 3_000n;
                dir.mtimeNs = 3_000n;
                dir.entries.push({
                    name: '.0123456789abcdef.tmp',
                    dev: dir.dev,
                    ino: 55_001n,
                    nlink: 1n,
                    birthtimeNs: 3_000n,
                    ctimeNs: 3_000n,
                    mtimeNs: 3_000n,
                    kind: 'file',
                });
                markStaged();
                await gate;
                order.push('first:end');
            });

            await staged;
            expect(order).toEqual(['first:start']);

            // Second Save As to the same Report.pdf must see the exact same lock key and wait behind the first.
            secondSave = withOriginalPathMutationLock('C:\\Work\\FreshEmpty\\Report.pdf', async () => {
                order.push('second:start');
                order.push('second:end');
            });
            await Promise.resolve();
            expect(order).toEqual(['first:start']);
            expect(fakeWinFs.opendirCalls).toHaveLength(1);
        } finally {
            releaseFirst();
            await Promise.allSettled([firstSave, secondSave]);
        }
        expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });

    it('handles inaccessible directories (EACCES/EPERM) without throwing and still probes existing files in traverse-only dirs', () => {
        addFakeDirectory({
            path: 'C:\\Work\\Locked',
            caseSensitive: false,
            listErrorCode: 'EACCES',
            entries: [{name: 'Visible.pdf'}],
        });

        // Existing file inside a traverse-only directory resolves case-insensitivity via leaf fast-path without opendirSync succeeding.
        expect(normalizePathForLookup('C:\\Work\\Locked\\Visible.pdf')).toBe('C:\\Work\\Locked\\visible.pdf');
        expect(normalizePathForLookup('C:\\Work\\Locked\\Missing.pdf')).toBe('C:\\Work\\Locked\\missing.pdf');

        // A missing leaf in an unreadable directory whose cache is cold preserves spelling safely without throwing.
        addFakeDirectory({
            path: 'C:\\Work\\LockedCold',
            caseSensitive: false,
            listErrorCode: 'EACCES',
            entries: [],
        });
        expect(normalizePathForLookup('C:\\Work\\LockedCold\\Missing.pdf')).toBe('C:\\Work\\LockedCold\\Missing.pdf');
    });

    it('normalizes missing-leaf Save targets, nested missing folders, 8.3 short aliases, drive roots, and extended-length/UNC paths', () => {
        addFakeDirectory({
            path: 'C:\\',
            caseSensitive: false,
            entries: [{name: 'Windows', kind: 'dir'}],
        });
        addFakeDirectory({
            path: 'C:\\Program Files\\Docs',
            caseSensitive: false,
            entries: [{name: 'Existing.pdf'}],
        });
        fakeWinFs.pathAliases.set('C:\\PROGRA~1\\Docs', 'C:\\Program Files\\Docs');

        addFakeDirectory({
            path: '\\\\fileserver\\shared\\',
            caseSensitive: false,
            entries: [{name: 'Index.pdf'}],
        });
        addFakeDirectory({
            path: '\\\\fileserver\\shared\\Team',
            caseSensitive: true,
            entries: [{name: 'Spec.pdf'}],
        });

        // Short 8.3 alias + nested missing leaf
        expect(normalizePathForLookup('C:\\PROGRA~1\\Docs\\NewFolder\\Draft.pdf')).toBe('C:\\Program Files\\Docs\\newfolder\\draft.pdf');
        // Extended-length local path
        expect(normalizePathForLookup('\\\\?\\C:\\Program Files\\Docs\\Existing.pdf')).toBe('C:\\Program Files\\Docs\\existing.pdf');
        // Drive root missing leaf
        expect(normalizePathForLookup('C:\\RootTarget.pdf')).toBe('C:\\roottarget.pdf');
        // Extended-length UNC (uppercase UNC and lowercase unc) on case-insensitive share root
        expect(normalizePathForLookup('\\\\?\\UNC\\FileServer\\Shared\\Index.pdf')).toBe('\\\\fileserver\\shared\\index.pdf');
        expect(normalizePathForLookup('\\\\?\\unc\\FileServer\\Shared\\Missing.pdf')).toBe('\\\\fileserver\\shared\\missing.pdf');
        // Extended-length UNC on case-sensitive subdirectory preserves casing inside share while normalizing UNC host/share
        expect(normalizePathForLookup('\\\\?\\UNC\\FileServer\\Shared\\Team\\Spec.pdf')).toBe('\\\\fileserver\\shared\\Team\\Spec.pdf');
        expect(normalizePathForLookup('\\\\?\\UNC\\FileServer\\Shared\\Team\\NewFile.pdf')).toBe(
            '\\\\fileserver\\shared\\Team\\NewFile.pdf',
        );
        expect(spawnSyncSpy).not.toHaveBeenCalled();
    });

    it('invalidates cached directory case sensitivity immediately when a directory is replaced or emptied and toggled in-place', () => {
        const dir = addFakeDirectory({
            path: 'C:\\Work\\Replaced',
            caseSensitive: false,
            ino: 30_001n,
            birthtimeNs: 5_000n,
            ctimeNs: 5_000n,
            mtimeNs: 5_000n,
            entries: [{name: 'Doc.pdf', ino: 30_002n}],
        });

        expect(normalizePathForLookup('C:\\Work\\Replaced\\Doc.pdf')).toBe('C:\\Work\\Replaced\\doc.pdf');

        // 1. In-place NTFS attribute flip: empty directory, enable case sensitivity, repopulate (same dev/ino/birthtime, new ctime/mtime).
        dir.caseSensitive = true;
        dir.ctimeNs = 6_000n;
        dir.mtimeNs = 6_000n;
        dir.entries = [
            {name: 'Foo.pdf', dev: dir.dev, ino: 30_003n, nlink: 1n, birthtimeNs: 6_000n, ctimeNs: 6_000n, mtimeNs: 6_000n, kind: 'file'},
            {name: 'foo.pdf', dev: dir.dev, ino: 30_004n, nlink: 1n, birthtimeNs: 6_000n, ctimeNs: 6_000n, mtimeNs: 6_000n, kind: 'file'},
        ];
        expect(normalizePathForLookup('C:\\Work\\Replaced\\Foo.pdf')).toBe('C:\\Work\\Replaced\\Foo.pdf');
        expect(normalizePathForLookup('C:\\Work\\Replaced\\foo.pdf')).toBe('C:\\Work\\Replaced\\foo.pdf');

        // 2. Full directory replacement at the same path (new ino & birthtimeNs).
        addFakeDirectory({
            path: 'C:\\Work\\Replaced',
            caseSensitive: false,
            ino: 40_001n,
            birthtimeNs: 9_000n,
            entries: [{name: 'Doc.pdf', ino: 40_002n}],
        });
        expect(normalizePathForLookup('C:\\Work\\Replaced\\Doc.pdf')).toBe('C:\\Work\\Replaced\\doc.pdf');
    });

    it('fails safe to preserving spelling on concurrent deletion or rename races during probe', () => {
        // 1. Concurrent deletion between original lstat and toggled lstat in a case-insensitive directory
        addFakeDirectory({
            path: 'C:\\Race\\Delete',
            caseSensitive: false,
            entries: [{name: 'Doc.pdf', ino: 1001n}],
        });
        let deleteStage = 0;
        fakeWinFs.lstatInterceptor = (p, next) => {
            if (asciiLower(p) === 'c:\\race\\delete\\doc.pdf') {
                deleteStage += 1;
                if (deleteStage >= 2) {
                    throw makeErrno('ENOENT');
                }
            }
            return next();
        };
        expect(normalizePathForLookup('C:\\Race\\Delete\\Doc.pdf')).toBe('C:\\Race\\Delete\\Doc.pdf');

        // 2. Concurrent rename Foo.pdf -> fOO.PDF in a case-sensitive directory
        fakeWinFs.lstatInterceptor = null;
        addFakeDirectory({
            path: 'C:\\Race\\Rename',
            caseSensitive: true,
            entries: [{name: 'Foo.pdf', ino: 2001n, nlink: 1n}],
        });
        let renameStage = 0;
        fakeWinFs.lstatInterceptor = (p, next) => {
            if (p === 'C:\\Race\\Rename\\fOO.PDF') {
                renameStage = 1;
                return makeBigIntStats({
                    dev: 100n,
                    ino: 2001n,
                    nlink: 1n,
                    birthtimeNs: 1n,
                    ctimeNs: 1n,
                    mtimeNs: 1n,
                    kind: 'file',
                });
            }
            if (p === 'C:\\Race\\Rename\\Foo.pdf' && renameStage === 1) {
                throw makeErrno('ENOENT');
            }
            return next();
        };
        expect(normalizePathForLookup('C:\\Race\\Rename\\Foo.pdf')).toBe('C:\\Race\\Rename\\Foo.pdf');
    });

    it('enforces the LRU cache cap and refreshes recency on hits', () => {
        const totalDirs = WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES + 1;
        for (let index = 0; index < totalDirs; index += 1) {
            addFakeDirectory({
                path: `C:\\Lru\\Dir${index}`,
                caseSensitive: false,
                ino: BigInt(100_000 + index),
                entries: [{name: 'A.pdf', ino: BigInt(200_000 + index)}],
            });
        }

        // Fill cache to capacity: Dir0 .. Dir1023
        for (let index = 0; index < WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES; index += 1) {
            expect(normalizePathForLookup(`C:\\Lru\\Dir${index}\\A.pdf`)).toBe(`C:\\Lru\\Dir${index}\\a.pdf`);
        }

        // Touch Dir0 so Dir1 becomes the least-recently-used entry.
        expect(normalizePathForLookup('C:\\Lru\\Dir0\\A.pdf')).toBe('C:\\Lru\\Dir0\\a.pdf');

        // Insert Dir1024 -> should evict Dir1, NOT Dir0.
        expect(normalizePathForLookup(`C:\\Lru\\Dir${WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES}\\A.pdf`)).toBe(
            `C:\\Lru\\Dir${WINDOWS_CASE_SENSITIVITY_CACHE_MAX_ENTRIES}\\a.pdf`,
        );

        fakeWinFs.lstatCalls.length = 0;
        // Dir0 should still be a cache hit: target lstat + directory lstat only (no toggled-name probe).
        expect(normalizePathForLookup('C:\\Lru\\Dir0\\A.pdf')).toBe('C:\\Lru\\Dir0\\a.pdf');
        expect(fakeWinFs.lstatCalls).toEqual(['C:\\Lru\\Dir0\\A.pdf', 'C:\\Lru\\Dir0']);

        fakeWinFs.lstatCalls.length = 0;
        // Dir1 was evicted: must re-probe toggled entry a.PDF and confirm A.pdf.
        expect(normalizePathForLookup('C:\\Lru\\Dir1\\A.pdf')).toBe('C:\\Lru\\Dir1\\a.pdf');
        expect(fakeWinFs.lstatCalls).toEqual(['C:\\Lru\\Dir1\\A.pdf', 'C:\\Lru\\Dir1', 'C:\\Lru\\Dir1\\a.PDF', 'C:\\Lru\\Dir1\\A.pdf']);
    });

    it('re-probes cached entries after TTL expires even if timestamps did not advance', () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);

        const dir = addFakeDirectory({
            path: 'C:\\Work\\TtlDir',
            caseSensitive: false,
            entries: [{name: 'Report.pdf'}],
        });

        expect(normalizePathForLookup('C:\\Work\\TtlDir\\Report.pdf')).toBe('C:\\Work\\TtlDir\\report.pdf');

        // Simulate a coarse-clock volume where timestamps stayed identical across an in-place change.
        dir.caseSensitive = true;
        expect(normalizePathForLookup('C:\\Work\\TtlDir\\Report.pdf')).toBe('C:\\Work\\TtlDir\\report.pdf');

        vi.setSystemTime(75_000);
        expect(normalizePathForLookup('C:\\Work\\TtlDir\\Report.pdf')).toBe('C:\\Work\\TtlDir\\Report.pdf');
    });
});

describe('normalizePathForLookup (real filesystem behavior)', () => {
    let tempRoot = '';

    beforeEach(() => {
        fakeWinFs.reset();
        spawnSyncSpy.mockClear();
        resetWindowsPathLookupCacheForTests();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-normalize-lookup-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {recursive: true, force: true});
    });

    it('returns empty string for empty or whitespace-only paths and preserves trailing whitespace in real filenames', () => {
        expect(normalizePathForLookup('')).toBe('');
        expect(normalizePathForLookup('   ')).toBe('');

        if (process.platform !== 'win32') {
            const spaced = join(tempRoot, 'trail.pdf ');
            writeFileSync(spaced, 'x');
            expect(normalizePathForLookup(spaced)).toBe(realFsRealpathSync.native(spaced));
        }
    });

    it.runIf(process.platform !== 'win32')('resolves POSIX symlinks and missing leaves under symlinked ancestors', () => {
        const realDir = join(tempRoot, 'real-dir');
        const linkDir = join(tempRoot, 'link-dir');
        mkdirSync(realDir);
        symlinkSync(realDir, linkDir);

        const existing = join(realDir, 'doc.pdf');
        writeFileSync(existing, 'pdf');

        expect(normalizePathForLookup(join(linkDir, 'doc.pdf'))).toBe(realFsRealpathSync.native(existing));
        expect(normalizePathForLookup(join(linkDir, 'sub', 'future.pdf'))).toBe(
            join(realFsRealpathSync.native(realDir), 'sub', 'future.pdf'),
        );
    });

    it.runIf(process.platform === 'win32')(
        'normalizes real Windows paths, missing leaves, and extended-length prefixes without spawnSync',
        () => {
            const subDir = join(tempRoot, 'MixedCaseDir');
            mkdirSync(subDir);
            const existing = join(subDir, 'Report.pdf');
            writeFileSync(existing, 'pdf');

            const canonicalKey = normalizePathForLookup(existing);
            expect(normalizePathForLookup(existing.toUpperCase())).toBe(canonicalKey);
            expect(normalizePathForLookup(`\\\\?\\${existing}`)).toBe(canonicalKey);
            expect(normalizePathForLookup(join(subDir, 'FutureSave.pdf'))).toBe(
                normalizePathForLookup(join(subDir.toUpperCase(), 'futuresave.pdf')),
            );
            expect(spawnSyncSpy).not.toHaveBeenCalled();
        },
    );
});
