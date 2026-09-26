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

    it('removes a managed scope after success and failure', async () => {
        let successfulPath = '';
        await usingManagedScratchScope('pdfExport-', mocks.appTempDir, async scratchPath => { successfulPath = scratchPath; expect(existsSync(scratchPath)).toBe(true); });
        expect(existsSync(successfulPath)).toBe(false);
        let failedPath = '';
        await expect(usingManagedScratchScope('qpdfArgs-', mocks.appTempDir, async scratchPath => { failedPath = scratchPath; throw new Error('scope failed'); })).rejects.toThrow('scope failed');
        expect(existsSync(failedPath)).toBe(false);
    });
});
