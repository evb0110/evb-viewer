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
import {createTestEventSender} from '@tests/helpers/electronEventEmitterHarness';

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
        mocks.resetStat();
        appDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-app-data-'));
        userDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-'));
        vi.stubEnv('TMPDIR', userDataDir);
        vi.stubEnv('TEMP', userDataDir);
        vi.stubEnv('TMP', userDataDir);
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

    describe('reading views', () => {
        const readingView = {
            currentPage: 27,
            pageCount: 40,
            zoom: 1.85,
            zoomMode: 'custom' as const,
            viewMode: 'single' as const,
            continuousScroll: true,
            viewRotation: 0 as const,
        };

        async function openWorkingCopy(originalPath: string, name: string) {
            const workingDir = join(userDataDir, 'evb-viewer', `pdf-work-${name}`);
            mkdirSync(workingDir, {recursive: true});
            const workingPath = join(workingDir, 'original.pdf');
            writeFileSync(workingPath, 'working');
            const workingCopyStore = await import('@electron/file-access/workingCopyStore');
            await workingCopyStore.setWorkingCopyOriginalPath(workingPath, originalPath, 42);
            return workingPath;
        }

        async function load() {
            const recentFiles = await loadRecentFilesModule();
            const readingViews = await import('@electron/recentReadingViews');
            const workingCopyStore = await import('@electron/file-access/workingCopyStore');
            return {
                recentFiles,
                readingViews,
                workingCopyStore,
            };
        }

        it('reopens unchanged bytes at the remembered view and keeps it off the list', async () => {
            const originalPath = writeFixture('reading.pdf', 'reading bytes');
            const {
                recentFiles, readingViews, workingCopyStore,
            } = await load();
            const firstOpen = await openWorkingCopy(originalPath, 'first');
            await recentFiles.addRecentFile(firstOpen, 42);
            await readingViews.rememberRecentReadingView(firstOpen, readingView, 42);
            workingCopyStore.clearWorkingCopyOriginalPaths();

            const reopened = await openWorkingCopy(originalPath, 'second');
            await recentFiles.addRecentFile(reopened, 42);

            expect(await readingViews.getRecentReadingView(reopened, 42)).toEqual(readingView);
            expect(await readingViews.getRecentReadingView(reopened, 7)).toBeNull();
            expect(await recentFiles.getRecentFiles()).toEqual([expect.not.objectContaining({readingView: expect.anything()})]);
            workingCopyStore.clearWorkingCopyOriginalPaths();
        });

        it('starts a changed source at the defaults', async () => {
            const originalPath = writeFixture('changed.pdf', 'first bytes');
            const {
                recentFiles, readingViews, workingCopyStore,
            } = await load();
            const firstOpen = await openWorkingCopy(originalPath, 'first');
            await recentFiles.addRecentFile(firstOpen, 42);
            await readingViews.rememberRecentReadingView(firstOpen, readingView, 42);
            workingCopyStore.clearWorkingCopyOriginalPaths();

            writeFileSync(originalPath, 'replaced with longer bytes');
            const reopened = await openWorkingCopy(originalPath, 'second');

            expect(await readingViews.getRecentReadingView(reopened, 42)).toBeNull();
            workingCopyStore.clearWorkingCopyOriginalPaths();
        });

        it('does not bring back a removed or cleared entry', async () => {
            const originalPath = writeFixture('forgotten.pdf');
            const {
                recentFiles, readingViews, workingCopyStore,
            } = await load();
            const workingPath = await openWorkingCopy(originalPath, 'forgotten');
            await recentFiles.addRecentFile(workingPath, 42);
            await recentFiles.removeRecentFile(originalPath);
            await readingViews.rememberRecentReadingView(workingPath, readingView, 42);
            expect(await recentFiles.getRecentFiles()).toEqual([]);

            await recentFiles.addRecentFile(workingPath, 42);
            await recentFiles.clearRecentFiles();
            await readingViews.rememberRecentReadingView(workingPath, readingView, 42);
            expect(await recentFiles.getRecentFiles()).toEqual([]);

            await recentFiles.addRecentFile(workingPath, 42);
            expect(await readingViews.getRecentReadingView(workingPath, 42)).toBeNull();
            workingCopyStore.clearWorkingCopyOriginalPaths();
        });

        async function openDjvu(djvuPath: string, senderId: number) {
            const viewing = await import('@electron/features/djvu/main/viewing');
            const {readDjvuSourceRevision} = await import('@electron/features/djvu/main/djvuPageSourceInfoCache');
            const context = {
                sender: createTestEventSender(senderId) as never,
                senderId,
            };
            const {
                sourceModifiedAt, sourceSize,
            } = await readDjvuSourceRevision(djvuPath);
            viewing.adoptDjvuViewingPath(context, djvuPath, {
                sourceModifiedAt,
                sourceSize,
            });
            return () => viewing.releaseDjvuViewingPath(context, djvuPath);
        }

        it('reopens an unchanged DjVu at the view its sender left, for that sender only', async () => {
            const djvuPath = writeFixture('reading.djvu', 'djvu bytes');
            const {
                recentFiles, readingViews,
            } = await load();
            const closeFirst = await openDjvu(djvuPath, 42);
            await recentFiles.addRecentFile(djvuPath, 42);
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 7);
            expect(await recentFiles.getRecentFiles()).toEqual([expect.not.objectContaining({readingView: expect.anything()})]);
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            closeFirst();
            expect(await readingViews.getRecentReadingView(djvuPath, 42)).toBeNull();

            const closeReopened = await openDjvu(djvuPath, 42);
            expect(await readingViews.getRecentReadingView(djvuPath, 42)).toEqual(readingView);
            expect(await readingViews.getRecentReadingView(djvuPath, 7)).toBeNull();
            closeReopened();
        });

        it('does not remember or restore a DjVu view over bytes changed since its open', async () => {
            const djvuPath = writeFixture('changed.djvu', 'first djvu bytes');
            const {
                recentFiles, readingViews,
            } = await load();
            const closeFirst = await openDjvu(djvuPath, 42);
            await recentFiles.addRecentFile(djvuPath, 42);
            writeFileSync(djvuPath, 'replaced with longer djvu bytes');
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            expect(await recentFiles.getRecentFiles()).toEqual([expect.not.objectContaining({readingView: expect.anything()})]);
            closeFirst();

            writeFileSync(djvuPath, 'first djvu bytes');
            const closeSecond = await openDjvu(djvuPath, 42);
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            closeSecond();
            writeFileSync(djvuPath, 'replaced with longer djvu bytes');
            const closeReopened = await openDjvu(djvuPath, 42);
            expect(await readingViews.getRecentReadingView(djvuPath, 42)).toBeNull();
            closeReopened();
        });

        it('remembers no DjVu view while two live opens of it read different bytes, until both are released', async () => {
            const djvuPath = writeFixture('ambiguous.djvu', 'first djvu bytes');
            const {
                recentFiles, readingViews,
            } = await load();
            const closeFirst = await openDjvu(djvuPath, 42);
            await recentFiles.addRecentFile(djvuPath, 42);
            writeFileSync(djvuPath, 'replaced with longer djvu bytes');
            const closeSecond = await openDjvu(djvuPath, 42);
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            expect(await readingViews.getRecentReadingView(djvuPath, 42)).toBeNull();
            closeSecond();
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            expect(await recentFiles.getRecentFiles()).toEqual([expect.not.objectContaining({readingView: expect.anything()})]);
            closeFirst();

            const closeFresh = await openDjvu(djvuPath, 42);
            await readingViews.rememberRecentReadingView(djvuPath, readingView, 42);
            expect(await readingViews.getRecentReadingView(djvuPath, 42)).toEqual(readingView);
            closeFresh();
        });

        it('forgets an unreadable stored view and keeps its entry', async () => {
            const originalPath = writeFixture('stored.pdf');
            writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
                version: 1,
                files: [{
                    originalPath,
                    backend: 'electron',
                    fileName: 'stored.pdf',
                    timestamp: 1,
                    fileSize: 10,
                    readingView: {
                        ...readingView,
                        currentPage: -3,
                    },
                }],
            }));
            const {
                recentFiles, readingViews, workingCopyStore,
            } = await load();
            const workingPath = await openWorkingCopy(originalPath, 'stored');

            expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([originalPath]);
            expect(await readingViews.getRecentReadingView(workingPath, 42)).toBeNull();
            workingCopyStore.clearWorkingCopyOriginalPaths();
        });
    });

    it('persists the exact original identity when its filename ends in whitespace', async () => {
        const originalPath = writeFixture('original.pdf ', 'original');
        const workingDir = join(userDataDir, 'evb-viewer', 'pdf-work-recent-exact-path');
        mkdirSync(workingDir, {recursive: true});
        const workingPath = join(workingDir, 'original.pdf');
        writeFileSync(workingPath, 'working');

        const recentFiles = await loadRecentFilesModule();
        const workingCopyStore = await import('@electron/file-access/workingCopyStore');
        await workingCopyStore.setWorkingCopyOriginalPath(workingPath, originalPath, 42);

        await recentFiles.addRecentFile(workingPath, 42);

        expect(recentFiles.getRecentFilesSync()).toEqual([originalPath]);
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

    it('logs filtered entries and leaves them on disk for a later compatible reader', async () => {
        const validPath = join(userDataDir, 'missing-compatible.pdf');
        const storagePath = join(userDataDir, 'recentFiles.json');
        const persisted = {
            version: 1,
            futureStoreField: 'kept on disk until a write',
            files: [
                {
                    originalPath: validPath,
                    fileName: 'missing-compatible.pdf',
                    timestamp: 123,
                    fileSize: 7,
                    modifiedAt: 122,
                    futureEntryField: true,
                },
                {
                    originalPath: 'relative.pdf',
                    fileName: 'relative.pdf',
                    timestamp: 124,
                    fileSize: 8,
                },
            ],
        };
        writeFileSync(storagePath, JSON.stringify(persisted));

        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.getRecentFiles()).resolves.toEqual([{
            originalPath: validPath,
            backend: 'electron',
            fileName: 'missing-compatible.pdf',
            timestamp: 123,
            fileSize: 7,
            modifiedAt: 122,
        }]);
        expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual(persisted);
        expect(mocks.logger.warn).toHaveBeenCalledWith('Dropped invalid recent file entry 1');
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

    it('keeps a deleted file listed through refreshes until it is removed', async () => {
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

    it('removes an entry whose file is gone when asked, and only then', async () => {
        const filePath = writeFixture('gone-on-open.pdf');
        const recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);

        await expect(recentFiles.removeRecentFileIfMissing(filePath)).resolves.toBe(false);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        unlinkSync(filePath);

        await expect(recentFiles.removeRecentFileIfMissing(filePath)).resolves.toBe(true);
        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')).files).toEqual([]);
        await expect(recentFiles.removeRecentFileIfMissing(filePath)).resolves.toBe(false);
    });

    it('keeps an entry whose file cannot be checked or whose volume is not mounted', async () => {
        const offlineVolumePath = '/Volumes/Offline Drive/Books/document.pdf';
        const paths = [
            join(userDataDir, 'not-a-directory', 'document.pdf'),
            join(userDataDir, 'io-error.pdf'),
            join(userDataDir, 'permission-denied.pdf'),
            offlineVolumePath,
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
                    : path === paths[2]
                        ? 'EACCES'
                        : 'ENOENT';
            return Promise.reject(Object.assign(new Error(code), {code}));
        });

        const recentFiles = await loadRecentFilesModule();
        for (const path of paths) {
            await expect(recentFiles.removeRecentFileIfMissing(path)).resolves.toBe(false);
        }
        expect(recentFiles.getRecentFilesSync()).toEqual(paths);
        expect(mocks.stat).toHaveBeenCalledWith('/Volumes/Offline Drive');
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
        vi.useFakeTimers();
        const filePath = join(userDataDir, 'network-share.pdf');
        let resolveStatStarted: (() => void) | undefined;
        const statStarted = new Promise<void>((resolve) => {
            resolveStatStarted = resolve;
        });
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
                resolveStatStarted?.();
                return new Promise(() => {});
            }
            return Promise.reject(new Error(`Unexpected stat path: ${path}`));
        });

        const recentFiles = await loadRecentFilesModule();
        const pendingRecentFiles = recentFiles.getRecentFiles();
        await statStarted;
        await vi.advanceTimersByTimeAsync(1_500);
        await expect(pendingRecentFiles).resolves.toMatchObject([{
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
