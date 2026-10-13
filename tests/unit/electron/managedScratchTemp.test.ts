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
    rename,
    writeFile,
} from 'fs/promises';
import { spawn } from 'child_process';
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
    recordManagedScratchBackup,
    recordManagedScratchPublish,
    removeManagedScratchTempDir,
    sweepStaleManagedScratchTempDirs,
    usingManagedScratchScope,
} = await import('@electron/utils/managedScratchTemp');
const {readFileIdentity} = await import('@electron/utils/fileIdentity');

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

    it('puts back an original whose record names a pid an unrelated live process now holds', async () => {
        // Records survive a reboot, and a pid is reused: a live process with
        // the recorded pid is not the export that wrote the record.
        const unrelated = spawn(process.execPath, [
            '-e',
            'setInterval(() => {}, 1000);',
        ], {stdio: 'ignore'});
        try {
            const target = join(mocks.appTempDir, 'page.png');
            const backup = join(mocks.appTempDir, '.0000000000000001.tmp');
            await writeFile(target, 'original');
            await writeFile(backup, 'original');
            const scratchPath = await createManagedScratchTempDir('pdfExport-', mocks.appTempDir);
            await recordManagedScratchBackup(scratchPath, backup, target, (await readFileIdentity(target))!);
            await writeFile(join(mocks.appTempDir, 'staged'), 'exported');
            await recordManagedScratchPublish(scratchPath, target, (await readFileIdentity(join(mocks.appTempDir, 'staged')))!);
            await rename(join(mocks.appTempDir, 'staged'), target);
            await writeFile(join(scratchPath, '.evb-managed-scratch.json'), `${JSON.stringify({
                createdAt: Date.now(),
                pid: unrelated.pid,
                prefix: 'pdfExport-',
            })}\n`, 'utf8');
            const previousRun = await createManagedScratchTempDir('qpdfOutput-', mocks.appTempDir);
            await writeFile(join(previousRun, '.evb-managed-scratch.json'), `${JSON.stringify({
                createdAt: 0,
                pid: process.pid,
                prefix: 'qpdfOutput-',
            })}\n`, 'utf8');
            const thisRun = await createManagedScratchTempDir('pdf-page-ops-', mocks.appTempDir);

            await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(2);

            expect(unrelated.exitCode).toBeNull();
            await expect(readFile(target, 'utf8')).resolves.toBe('original');
            expect(existsSync(backup)).toBe(false);
            expect(existsSync(scratchPath)).toBe(false);
            expect(existsSync(previousRun), 'this pid before the last boot is another run').toBe(false);
            expect(existsSync(thisRun)).toBe(true);
        } finally {
            unrelated.kill('SIGKILL');
        }
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

    it('removes exactly the complete temporary names a dead owner recorded, whatever the age of its scratch', async () => {
        const ownerPath = await createManagedScratchTempDir('pdfExport-', mocks.appTempDir);
        await writeFile(join(ownerPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: Date.now(),
            pid: 2_147_483_647,
            prefix: 'pdfExport-',
        })}\n`, 'utf8');
        const folder = join(mocks.appTempDir, 'destination');
        await mkdir(folder);
        const stagePath = join(folder, '.0123456789abcdef.tmp');
        const reportPath = join(folder, 'report.pdf');
        const unrecordedPath = join(folder, '.fedcba9876543210.tmp');
        const truncatedPath = join(folder, '.1111111111111111.tmp');
        // An earlier version named a writer's temporary file this way.
        const writerPath = join(folder, '.2222222222222222.tmp');
        for (const path of [
            stagePath,
            writerPath,
            reportPath,
            unrecordedPath,
            truncatedPath,
        ]) {
            await writeFile(path, 'x', 'utf8');
        }
        // The last append was cut short: its line has no newline, so it names nothing.
        const entry = (kind: string, path: string) => JSON.stringify({
            kind,
            path,
        });
        await writeFile(join(ownerPath, '.evb-scratch-record'), `${entry('stage', stagePath)}\n${entry('writer', writerPath)}\n${entry('stage', truncatedPath)}`, 'utf8');

        await sweepStaleManagedScratchTempDirs(mocks.appTempDir);

        expect(existsSync(stagePath)).toBe(false);
        expect(existsSync(writerPath)).toBe(false);
        expect(existsSync(reportPath)).toBe(true);
        expect(existsSync(unrecordedPath)).toBe(true);
        expect(existsSync(truncatedPath)).toBe(true);
    });

    it.each([
        [
            'a name that is not a stage',
            (path: string) => JSON.stringify({
                kind: 'stage',
                path: join(path, 'report.pdf'),
            }),
        ],
        [
            'a corrupt line',
            () => '{"kind":"stage","path":',
        ],
    ])('keeps a dead owner\'s whole record and everything it names when a complete line holds %s', async (_label, unreadableLine) => {
        const ownerPath = await createManagedScratchTempDir('pdfExport-', mocks.appTempDir);
        await writeFile(join(ownerPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'pdfExport-',
        })}\n`, 'utf8');
        const folder = join(mocks.appTempDir, 'destination');
        await mkdir(folder);
        const stagePath = join(folder, '.0123456789abcdef.tmp');
        await writeFile(stagePath, 'x', 'utf8');
        await writeFile(join(folder, 'report.pdf'), 'report', 'utf8');
        const recordPath = join(ownerPath, '.evb-scratch-record');
        await writeFile(recordPath, `${JSON.stringify({
            kind: 'stage',
            path: stagePath,
        })}\n${unreadableLine(folder)}\n`, 'utf8');

        await expect(sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0)).resolves.toBe(0);

        expect(existsSync(stagePath)).toBe(true);
        await expect(readFile(join(folder, 'report.pdf'), 'utf8')).resolves.toBe('report');
        expect(existsSync(recordPath)).toBe(true);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(recordPath));
    });

    it('leaves the stages recorded by a live owner alone', async () => {
        const ownerPath = await createManagedScratchTempDir('pdfExport-', mocks.appTempDir);
        const stagePath = join(mocks.appTempDir, '.0123456789abcdef.tmp');
        await writeFile(stagePath, 'x', 'utf8');
        await writeFile(join(ownerPath, '.evb-scratch-record'), `${JSON.stringify({
            kind: 'stage',
            path: stagePath,
        })}\n`, 'utf8');

        await sweepStaleManagedScratchTempDirs(mocks.appTempDir, 0);

        expect(existsSync(stagePath)).toBe(true);
    });
});
