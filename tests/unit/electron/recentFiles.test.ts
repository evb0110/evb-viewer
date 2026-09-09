import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    readdirSync,
    rmSync,
    unlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';

const mocks = vi.hoisted(() => {
    const app = { getPath: vi.fn() };
    const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    };
    let actualStat: ((...args: unknown[]) => Promise<unknown>) | null = null;
    const stat = vi.fn((...args: unknown[]) => {
        if (!actualStat) {
            throw new Error('fs/promises stat mock was not initialized');
        }
        return actualStat(...args);
    });
    return {
        app,
        logger,
        resetStat: () => {
            stat.mockImplementation((...args: unknown[]) => {
                if (!actualStat) {
                    throw new Error('fs/promises stat mock was not initialized');
                }
                return actualStat(...args);
            });
        },
        setActualStat: (implementation: (...args: unknown[]) => Promise<unknown>) => {
            actualStat = implementation;
        },
        stat,
    };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => mocks.logger }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    mocks.setActualStat((...args: unknown[]) => actual.stat(...(args as Parameters<typeof actual.stat>)));
    mocks.resetStat();
    return {
        ...actual,
        stat: mocks.stat,
    };
});

async function loadRecentFilesModule() {
    vi.resetModules();
    return import('@electron/recentFiles');
}

describe('recentFiles persistence', () => {
    let appDataDir = '';
    let userDataDir = '';

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE;
        delete process.env.EVB_RECENT_FILE_STAT_TIMEOUT_MS;
        mocks.resetStat();
        appDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-app-data-'));
        userDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-'));
        mocks.app.getPath.mockImplementation((name: string) => {
            if (name === 'appData') {
                return appDataDir;
            }

            if (name === 'userData') {
                return userDataDir;
            }

            return userDataDir;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        rmSync(appDataDir, {
            recursive: true,
            force: true,
        });
        rmSync(userDataDir, {
            recursive: true,
            force: true,
        });
    });

    function writeFixture(name: string, contents = name) {
        const filePath = join(userDataDir, name);
        writeFileSync(filePath, contents);
        return filePath;
    }

    it('persists recent files across cache reinitialization and keeps the newest duplicate first', async () => {
        const fileA = writeFixture('alpha.pdf');
        const fileB = writeFixture('beta.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(fileA);
        await recentFiles.addRecentFile(fileB);
        await recentFiles.addRecentFile(fileA);

        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([
            fileA,
            fileB,
        ]);
        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);

        recentFiles = await loadRecentFilesModule();
        expect(recentFiles.getRecentFilesSync()).toEqual([]);

        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([
            fileA,
            fileB,
        ]);
    });

    it('persists and refreshes modified-time identity for same-size source replacements', async () => {
        const filePath = writeFixture('same-size.pdf', 'first');
        const recentFiles = await loadRecentFilesModule();

        await recentFiles.addRecentFile(filePath);
        const initial = (await recentFiles.getRecentFiles())[0];
        expect(initial).toMatchObject({
            originalPath: filePath,
            fileSize: 5,
            modifiedAt: expect.any(Number),
        });
        const persisted = JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')) as {files: Array<{modifiedAt?: number}>};
        expect(persisted.files[0]?.modifiedAt).toBe(initial?.modifiedAt);

        writeFileSync(filePath, 'other');
        const replacementTime = new Date((initial?.modifiedAt ?? Date.now()) + 10_000);
        utimesSync(filePath, replacementTime, replacementTime);
        await recentFiles.initRecentFilesCache();

        const refreshed = (await recentFiles.getRecentFiles())[0];
        expect(refreshed?.fileSize).toBe(initial?.fileSize);
        expect(refreshed?.modifiedAt).not.toBe(initial?.modifiedAt);
        expect(Math.abs((refreshed?.modifiedAt ?? 0) - replacementTime.getTime())).toBeLessThanOrEqual(2);
    });

    it('serializes concurrent additions without losing either persisted entry', async () => {
        const fileA = writeFixture('concurrent-alpha.pdf');
        const fileB = writeFixture('concurrent-beta.pdf');
        let recentFiles = await loadRecentFilesModule();

        await Promise.all([
            recentFiles.addRecentFile(fileA),
            recentFiles.addRecentFile(fileB),
        ]);

        expect(new Set(recentFiles.getRecentFilesSync())).toEqual(new Set([
            fileA,
            fileB,
        ]));
        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();
        expect(new Set(recentFiles.getRecentFilesSync())).toEqual(new Set([
            fileA,
            fileB,
        ]));
    });

    it('persists the original document identity instead of a managed working-copy path', async () => {
        const originalPath = writeFixture('original.pdf', 'original');
        const workingDir = join(userDataDir, 'evb-viewer', 'pdf-work-recent-authority');
        mkdirSync(workingDir, {recursive: true});
        const workingPath = join(workingDir, 'original.pdf');
        writeFileSync(workingPath, 'working');

        const recentFiles = await loadRecentFilesModule();
        const workingCopyStore = await import('@electron/file-access/workingCopyStore');
        await workingCopyStore.setWorkingCopyOriginalPath(workingPath, originalPath, 42);

        await recentFiles.addRecentFile(workingPath, 42);

        expect(recentFiles.getRecentFilesSync()).toEqual([originalPath]);
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([originalPath]);
        workingCopyStore.clearWorkingCopyOriginalPaths();
    });

    it('refuses to persist an unmapped managed working-copy temp path', async () => {
        const workingDir = join(userDataDir, 'evb-viewer', 'pdf-work-unmapped');
        mkdirSync(workingDir, {recursive: true});
        const workingPath = join(workingDir, 'internal.pdf');
        writeFileSync(workingPath, 'working');
        const recentFiles = await loadRecentFilesModule();

        await recentFiles.addRecentFile(workingPath, 42);

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Refusing to persist unmapped'));
    });

    it('removes historical unmanaged working-copy entries while loading and rewrites storage', async () => {
        const workingDir = join(realpathSync.native(userDataDir), 'evb-viewer', 'pdf-work-historical');
        mkdirSync(workingDir, {recursive: true});
        const workingPath = join(workingDir, 'internal.pdf');
        writeFileSync(workingPath, 'working');
        const storagePath = join(userDataDir, 'recentFiles.json');
        writeFileSync(storagePath, JSON.stringify({
            version: 1,
            files: [{
                originalPath: workingPath,
                fileName: 'internal.pdf',
                timestamp: 123,
                fileSize: 7,
            }],
        }));

        const recentFiles = await loadRecentFilesModule();
        await expect(recentFiles.getRecentFiles()).resolves.toEqual([]);
        expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({
            version: 1,
            files: [],
        });
    });

    it('migrates a historical owned working-copy entry to its canonical source while loading', async () => {
        const originalPath = writeFixture('historical-original.pdf', 'original');
        const workingDir = join(userDataDir, 'evb-viewer', 'pdf-work-historical-mapped');
        mkdirSync(workingDir, {recursive: true});
        const workingPath = join(workingDir, 'historical-original.pdf');
        writeFileSync(workingPath, 'working');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: workingPath,
                fileName: 'historical-original.pdf',
                timestamp: 123,
                fileSize: 7,
            }],
        }));
        const recentFiles = await loadRecentFilesModule();
        const workingCopyStore = await import('@electron/file-access/workingCopyStore');
        await workingCopyStore.setWorkingCopyOriginalPath(workingPath, originalPath, 42);
        await expect(recentFiles.getRecentFiles()).resolves.toMatchObject([{
            originalPath,
            fileName: 'historical-original.pdf',
        }]);
        const persisted = JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')) as {files: Array<{originalPath: string}>};
        expect(persisted.files.map(file => file.originalPath)).toEqual([originalPath]);
        workingCopyStore.clearWorkingCopyOriginalPaths();
    });

    it('does not reject a user document merely because its folder starts with pdf-work-', async () => {
        const userFolder = join(appDataDir, 'pdf-work-publications');
        mkdirSync(userFolder);
        const filePath = join(userFolder, 'paper.pdf');
        writeFileSync(filePath, 'paper');
        const recentFiles = await loadRecentFilesModule();

        await recentFiles.addRecentFile(filePath);

        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);
    });

    it('preserves an existing target and removes staged data when atomic promotion fails', async () => {
        const filePath = writeFixture('atomic-failure.pdf');
        const storagePath = join(userDataDir, 'recentFiles.json');
        mkdirSync(storagePath);
        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.addRecentFile(filePath)).rejects.toThrow();

        expect(readdirSync(storagePath)).toEqual([]);
        expect(readdirSync(userDataDir).sort()).toEqual([
            'atomic-failure.pdf',
            'recentFiles.json',
        ]);
    });

    it('quarantines malformed persisted JSON and writes a clean empty store', async () => {
        const storagePath = join(userDataDir, 'recentFiles.json');
        writeFileSync(storagePath, '{malformed');

        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.getRecentFiles()).resolves.toEqual([]);
        expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({
            version: 1,
            files: [],
        });
        expect(readdirSync(userDataDir).some(name => /^recentFiles\.json\.\d+\.corrupt$/u.test(name))).toBe(true);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt recent-files state'));
    });

    it('propagates an existing-store read failure instead of returning an empty recent list', async () => {
        const storagePath = join(userDataDir, 'recentFiles.json');
        mkdirSync(storagePath);
        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.getRecentFiles()).rejects.toThrow();
        expect(readdirSync(storagePath)).toEqual([]);
    });

    it('dedupes persisted recent files by path when rebuilding the cache from disk', async () => {
        const fileA = writeFixture('alpha.pdf');
        const fileB = writeFixture('beta.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [
                {
                    originalPath: fileA,
                    fileName: 'alpha-new.pdf',
                    timestamp: 3,
                    fileSize: 5,
                },
                {
                    originalPath: fileB,
                    fileName: 'beta.pdf',
                    timestamp: 2,
                    fileSize: 4,
                },
                {
                    originalPath: fileA,
                    fileName: 'alpha-old.pdf',
                    timestamp: 1,
                    fileSize: 5,
                },
            ],
        }));

        const recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);
        expect((await recentFiles.getRecentFiles()).map(file => file.fileName)).toEqual([
            'alpha-new.pdf',
            'beta.pdf',
        ]);
    });

    it('preserves missing files when rebuilding the cache from disk', async () => {
        const filePath = writeFixture('stale.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        unlinkSync(filePath);

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);
        expect(await recentFiles.getRecentFiles()).toEqual([expect.objectContaining({originalPath: filePath})]);
        expect(JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8'))).toEqual({
            version: 1,
            files: [expect.objectContaining({originalPath: filePath})],
        });
        await recentFiles.removeRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([]);
    });

    it('does not restore filtered missing files after removing a visible entry', async () => {
        const visibleA = writeFixture('visible-a.pdf');
        const visibleB = writeFixture('visible-b.pdf');
        const missingPath = join(userDataDir, 'missing-output.pdf');
        const storagePath = join(userDataDir, 'recentFiles.json');
        writeFileSync(storagePath, JSON.stringify({
            version: 1,
            files: [
                {
                    originalPath: visibleA,
                    fileName: 'visible-a.pdf',
                    timestamp: 3,
                    fileSize: 1,
                },
                {
                    originalPath: missingPath,
                    fileName: 'missing-output.pdf',
                    timestamp: 2,
                    fileSize: 1,
                },
                {
                    originalPath: visibleB,
                    fileName: 'visible-b.pdf',
                    timestamp: 1,
                    fileSize: 1,
                },
            ],
        }));
        const recentFiles = await loadRecentFilesModule();

        await recentFiles.initRecentFilesCache();
        expect(recentFiles.getRecentFilesSync()).toEqual([
            visibleA,
            missingPath,
            visibleB,
        ]);

        await recentFiles.removeRecentFile(visibleA);

        expect(recentFiles.getRecentFilesSync()).toEqual([
            missingPath,
            visibleB,
        ]);
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([
            missingPath,
            visibleB,
        ]);
        const persisted = JSON.parse(readFileSync(storagePath, 'utf-8')) as {files: Array<{originalPath: string}>};
        expect(persisted.files.map(file => file.originalPath)).toEqual([
            missingPath,
            visibleB,
        ]);
    });

    it('shares one cold refresh across concurrent getters and cache initialization', async () => {
        const filePath = writeFixture('single-flight.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'single-flight.pdf',
                timestamp: 1,
                fileSize: 1,
            }],
        }));
        const recentFiles = await loadRecentFilesModule();

        const [
            first,
            second,
        ] = await Promise.all([
            recentFiles.getRecentFiles(),
            recentFiles.getRecentFiles(),
            recentFiles.initRecentFilesCache(),
        ]);

        expect(first).toEqual(second);
        expect(mocks.stat).toHaveBeenCalledTimes(1);
    });

    it('does not stat Recent paths again during a fresh TTL hit', async () => {
        const filePath = writeFixture('ttl-hit.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'ttl-hit.pdf',
                timestamp: 1,
                fileSize: 1,
            }],
        }));
        const recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();
        mocks.stat.mockClear();

        await recentFiles.getRecentFiles();
        await recentFiles.getRecentFiles();

        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('performs one validation pass for concurrent getters after TTL expiry', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const filePath = writeFixture('ttl-expired.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'ttl-expired.pdf',
                timestamp: 1,
                fileSize: 1,
            }],
        }));
        const recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();
        mocks.stat.mockClear();
        vi.setSystemTime(15_001);

        await Promise.all([
            recentFiles.getRecentFiles(),
            recentFiles.getRecentFiles(),
        ]);

        expect(mocks.stat).toHaveBeenCalledTimes(1);
    });

    it('clears persisted storage and the synchronous cache together', async () => {
        const filePath = writeFixture('clear-me.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        await recentFiles.clearRecentFiles();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('removes a recent entry only through the explicit remove action', async () => {
        const filePath = writeFixture('deleted-after-load.pdf');
        const recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);

        await expect(recentFiles.getRecentFiles()).resolves.toEqual([expect.objectContaining({originalPath: filePath})]);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        unlinkSync(filePath);

        await recentFiles.initRecentFilesCache();
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        await recentFiles.removeRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('bootstraps the default interactive automation profile from canonical dev recents only once', async () => {
        process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE = '1';
        const filePath = writeFixture('bootstrap.pdf');
        const canonicalDir = join(appDataDir, 'EVB Viewer Dev');
        mkdirSync(canonicalDir, { recursive: true });
        writeFileSync(join(canonicalDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'bootstrap.pdf',
                timestamp: 123,
                fileSize: 9,
            }],
        }, null, 2));

        let recentFiles = await loadRecentFilesModule();
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([filePath]);

        const persisted = JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')) as { files: Array<{ originalPath: string }>; };
        expect(persisted.files.map(file => file.originalPath)).toEqual([filePath]);

        await recentFiles.clearRecentFiles();

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('keeps timed-out recent paths without waiting indefinitely for stat', async () => {
        vi.stubEnv('EVB_RECENT_FILE_STAT_TIMEOUT_MS', '100');
        const filePath = join(userDataDir, 'network-share.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'network-share.pdf',
                timestamp: 123,
                fileSize: 9,
            }],
        }));
        mocks.stat.mockImplementation((path: unknown) => {
            if (path === filePath) {
                return new Promise(() => {});
            }
            return Promise.reject(new Error(`Unexpected stat path: ${path}`));
        });

        const recentFiles = await loadRecentFilesModule();
        await expect(recentFiles.getRecentFiles()).resolves.toMatchObject([{
            originalPath: filePath,
            fileName: 'network-share.pdf',
        }]);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            `Recent file path stat timed out; preserving entry (${filePath})`,
        );
    });

    it('preserves entries when availability checks report directory, I/O, or permission failures', async () => {
        const paths = [
            join(userDataDir, 'offline-share', 'document.pdf'),
            join(userDataDir, 'io-error.pdf'),
            join(userDataDir, 'permission-denied.pdf'),
        ];
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: paths.map((originalPath, index) => ({
                originalPath,
                fileName: originalPath.split('/').at(-1),
                timestamp: index + 1,
                fileSize: 9,
            })),
        }));
        mocks.stat.mockImplementation((path: unknown) => {
            const code = path === paths[0]
                ? 'ENOTDIR'
                : path === paths[1]
                    ? 'EIO'
                    : 'EACCES';
            return Promise.reject(Object.assign(new Error(code), {code}));
        });

        const recentFiles = await loadRecentFilesModule();
        await expect(recentFiles.getRecentFiles()).resolves.toEqual(
            paths.map(originalPath => expect.objectContaining({originalPath})),
        );
        expect(recentFiles.getRecentFilesSync()).toEqual(paths);
        expect(JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')).files)
            .toHaveLength(paths.length);
    });

    it('retries a transient ENOENT before preserving a recent path', async () => {
        const filePath = writeFixture('transient-enoent.pdf');
        const recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);

        let statCalls = 0;
        mocks.stat.mockImplementation((path: unknown) => {
            if (path !== filePath) {
                return Promise.reject(new Error(`Unexpected stat path: ${path}`));
            }
            statCalls += 1;
            if (statCalls === 1) {
                return Promise.reject(Object.assign(new Error('temporary disappearance'), {code: 'ENOENT'}));
            }
            return Promise.resolve({
                size: 17,
                mtimeMs: 123,
            });
        });

        await expect(recentFiles.initRecentFilesCache()).resolves.toBeUndefined();
        expect(statCalls).toBe(2);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);
    });
});
