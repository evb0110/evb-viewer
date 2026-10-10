import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdtempSync,
    rmSync,
} from 'fs';
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
    appTempDir: '',
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const {
    createManagedScratchTempDir,
    removeManagedScratchTempDir,
    sweepStaleManagedScratchTempDirs,
    usingManagedScratchScope,
} = await import('@electron/utils/managedScratchTemp');

describe('managed scratch temp cleanup', () => {
    beforeEach(() => {
        mocks.appTempDir = mkdtempSync(join(tmpdir(), 'managed-scratch-test-'));
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(mocks.appTempDir, {
            force: true,
            recursive: true,
        });
    });

    it('creates a missing scratch root before creating a managed directory', async () => {
        const rootPath = join(mocks.appTempDir, 'namespace');

        const scratchPath = await createManagedScratchTempDir('native-command-', rootPath);

        expect(existsSync(scratchPath)).toBe(true);
        expect(existsSync(rootPath)).toBe(true);
    });

    it('preserves live owners and sweeps only stale dead marked managed prefixes', async () => {
        const liveMarkedPath = await createManagedScratchTempDir('pdfExport-', mocks.appTempDir);
        const marker = JSON.parse(await readFile(join(liveMarkedPath, '.evb-managed-scratch.json'), 'utf8')) as {
            pid?: unknown;
            prefix?: unknown;
        };
        expect(marker.prefix).toBe('pdfExport-');
        expect(marker.pid).toBe(process.pid);

        const deadMarkedPath = await createManagedScratchTempDir('qpdfOutput-', mocks.appTempDir);
        await writeFile(join(deadMarkedPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'qpdfOutput-',
        })}\n`, 'utf8');

        const unmarkedManagedPath = join(mocks.appTempDir, 'qpdfArgs-unmarked');
        const unrelatedPath = join(mocks.appTempDir, 'other-stale');
        await mkdir(unmarkedManagedPath);
        await mkdir(unrelatedPath);

        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(1);

        expect(existsSync(liveMarkedPath)).toBe(true);
        expect(existsSync(deadMarkedPath)).toBe(false);
        expect(existsSync(unmarkedManagedPath)).toBe(true);
        expect(existsSync(unrelatedPath)).toBe(true);
        expect(mocks.logger.info).toHaveBeenCalledWith('Cleaned up 1 stale managed scratch directory');
    });

    it('leaves fresh marked scratch dirs inside the TTL window', async () => {
        const markedPath = await createManagedScratchTempDir('pdf-page-ops-', mocks.appTempDir);

        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 60_000)).resolves.toBe(0);

        expect(existsSync(markedPath)).toBe(true);
        expect(mocks.logger.info).not.toHaveBeenCalled();
    });

    it('leaves native command scratch to the process registry reaper', async () => {
        const scratchPath = await createManagedScratchTempDir('native-command-', mocks.appTempDir);
        await writeFile(join(scratchPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'native-command-',
        })}\n`, 'utf8');

        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(0);
        expect(existsSync(scratchPath)).toBe(true);

        await expect(removeManagedScratchTempDir(scratchPath, 'native-command-', mocks.appTempDir)).resolves.toBe(true);
        expect(existsSync(scratchPath)).toBe(false);
    });

    it('applies the sweep budget only to managed scratch candidates', async () => {
        await mkdir(join(mocks.appTempDir, 'aaa-unrelated'));
        const deadMarkedPath = await createManagedScratchTempDir('qpdfOutput-', mocks.appTempDir);
        await writeFile(join(deadMarkedPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'qpdfOutput-',
        })}\n`, 'utf8');
        const deadMarkedStat = await lstat(deadMarkedPath);
        vi.spyOn(Date, 'now').mockReturnValue(Math.floor(Math.max(
            deadMarkedStat.mtimeMs,
            deadMarkedStat.ctimeMs,
        )));

        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0, 1)).resolves.toBe(1);

        expect(existsSync(deadMarkedPath)).toBe(false);
        await expect(readdir(mocks.appTempDir)).resolves.toEqual(['aaa-unrelated']);
    });

    it('keeps nested managed scratch until its native owner is gone and the sweep can reclaim it', async () => {
        const {markUnprovenNativeTermination} = await import('@electron/utils/nativeTerminationProof');
        let retainedPath = '';
        let pagePath = '';
        await expect(usingManagedScratchScope('pdfExport-scope-', mocks.appTempDir, async scratchPath => {
            retainedPath = scratchPath;
            return usingManagedScratchScope('pdfExport-', scratchPath, async renderPath => {
                pagePath = join(renderPath, 'page.jpg');
                await writeFile(pagePath, 'rendered page');
                throw markUnprovenNativeTermination(new Error('native child timed out'), 'kill was not confirmed');
            });
        })).rejects.toThrow('native child timed out');
        await expect(readFile(pagePath, 'utf8')).resolves.toBe('rendered page');
        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(0);
        const markerPath = join(retainedPath, '.evb-managed-scratch.json');
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
            pid: number;
            prefix: string
        };
        expect(marker.prefix).toBe('pdfExport-scope-');
        expect(marker.pid).toBe(process.pid);
        await writeFile(markerPath, JSON.stringify({
            ...marker,
            pid: 2_147_483_647,
        }));
        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(1);
        expect(existsSync(pagePath)).toBe(false);
        expect(existsSync(retainedPath)).toBe(false);
    });

    it('removes a managed scope after success and failure', async () => {
        let successfulPath = '';
        await usingManagedScratchScope('pdfExport-', mocks.appTempDir, async scratchPath => { successfulPath = scratchPath; expect(existsSync(scratchPath)).toBe(true); });
        expect(existsSync(successfulPath)).toBe(false);
        let failedPath = '';
        await expect(usingManagedScratchScope('qpdfArgs-', mocks.appTempDir, async scratchPath => { failedPath = scratchPath; throw new Error('scope failed'); })).rejects.toThrow('scope failed');
        expect(existsSync(failedPath)).toBe(false);
    });

    // A read-only root makes the scratch directory impossible to remove, as a
    // file held open on Windows does. Windows and root ignore that mode.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the scope outcome and leaves the scratch to the sweep when removal fails', async () => {
        const rootPath = join(mocks.appTempDir, 'locked-root');
        const runLocked = async <T>(run: () => T) => {
            let retainedPath = '';
            try {
                return await usingManagedScratchScope('djvu-export-', rootPath, async (scratchPath) => {
                    retainedPath = scratchPath;
                    await chmod(rootPath, 0o555);
                    return run();
                });
            } finally {
                await chmod(rootPath, 0o755);
                expect(existsSync(retainedPath)).toBe(true);
                expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(retainedPath));
            }
        };
        await expect(runLocked(() => 'converted')).resolves.toBe('converted');
        await expect(runLocked(() => {
            throw new Error('conversion failed');
        })).rejects.toThrow('conversion failed');
    });
});
