import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createDjvuDiskQuotaMonitor,
    openDjvuArtifactJob,
} from '@electron/features/djvu/main/djvuArtifactManifest';

describe('DjVu artifact manifests', () => {
    const directories: string[] = [];

    afterEach(() => {
        for (const directory of directories) {
            rmSync(directory, {
                force: true,
                recursive: true,
            });
        }
        directories.length = 0;
    });

    it('reuses verified page ranges and resets interrupted ranges', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const ranges = [
            {
                startPage: 1,
                endPage: 2,
            },
            {
                startPage: 3,
                endPage: 4,
            },
        ];
        const first = await openDjvuArtifactJob(sourcePath, ranges, {});
        writeFileSync(first.manifest.ranges[0]!.outputPath, 'valid-pdf-range');
        await first.updateRange(0, {
            status: 'verified',
            size: 15,
        });
        await first.updateRange(1, {status: 'running'});
        await first.close();
        const savedManifest = JSON.parse(readFileSync(first.manifestPath, 'utf8')) as Record<string, unknown> & {ranges: Array<Record<string, unknown>>};
        savedManifest.extra = 'stripped';
        savedManifest.ranges[0]!.extra = 'stripped';
        writeFileSync(first.manifestPath, JSON.stringify(savedManifest));

        const resumed = await openDjvuArtifactJob(sourcePath, ranges, {});

        expect(resumed.directory).toBe(first.directory);
        expect(Object.hasOwn(resumed.manifest, 'extra')).toBe(false);
        expect(Object.hasOwn(resumed.manifest.ranges[0]!, 'extra')).toBe(false);
        expect(resumed.manifest.ranges.map(range => range.status)).toEqual([
            'verified',
            'pending',
        ]);
        await resumed.cleanup?.();
    });

    it('rejects same-size tampering of a verified range artifact', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-tamper-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const ranges = [{
            startPage: 1,
            endPage: 1,
        }];
        const first = await openDjvuArtifactJob(sourcePath, ranges, {});
        writeFileSync(first.manifest.ranges[0]!.outputPath, 'AAAA');
        await first.updateRange(0, {status: 'verified'});
        await first.close();
        writeFileSync(first.manifest.ranges[0]!.outputPath, 'BBBB');

        const resumed = await openDjvuArtifactJob(sourcePath, ranges, {});

        expect(resumed.manifest.ranges[0]).toMatchObject({status: 'pending'});
        await resumed.cleanup?.();
    });

    it('serializes concurrent jobs with the same source fingerprint', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-lock-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const ranges = [{
            startPage: 1,
            endPage: 1,
        }];
        const first = await openDjvuArtifactJob(sourcePath, ranges, {});
        let secondOpened = false;
        const secondPromise = openDjvuArtifactJob(sourcePath, ranges, {}).then(job => {
            secondOpened = true;
            return job;
        });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(secondOpened).toBe(false);

        await first.close();
        const second = await secondPromise;
        expect(secondOpened).toBe(true);
        await second.cleanup?.();
    });

    it('rejects a manifest that redirects a range artifact outside its job directory', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-path-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const ranges = [{
            startPage: 1,
            endPage: 1,
        }];
        const first = await openDjvuArtifactJob(sourcePath, ranges, {});
        await first.close();
        const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf8')) as {ranges: Array<{outputPath: string}>;};
        manifest.ranges[0]!.outputPath = join(directory, 'unowned.pdf');
        writeFileSync(first.manifestPath, JSON.stringify(manifest));

        const reopened = await openDjvuArtifactJob(sourcePath, ranges, {});

        expect(reopened.manifest.ranges[0]!.outputPath).not.toBe(join(directory, 'unowned.pdf'));
        expect(reopened.manifest.ranges[0]!.status).toBe('pending');
        await reopened.cleanup?.();
    });

    it('removes a completed artifact job on explicit cleanup', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-cleanup-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const job = await openDjvuArtifactJob(sourcePath, [{
            startPage: 1,
            endPage: 1,
        }], {});

        await job.cleanup?.();

        expect(() => writeFileSync(job.manifestPath, 'gone', {flag: 'r+'})).toThrow();
    });

    it('serializes concurrent verification so ranges cannot race past the aggregate ceiling', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-budget-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const job = await openDjvuArtifactJob(sourcePath, [
            {
                startPage: 1,
                endPage: 1,
            },
            {
                startPage: 2,
                endPage: 2,
            },
        ], {maxTotalBytesForTests: 7});
        for (const range of job.manifest.ranges) {
            writeFileSync(range.outputPath, 'four');
        }

        const results = await Promise.allSettled([
            job.updateRange(0, {status: 'verified'}),
            job.updateRange(1, {status: 'verified'}),
        ]);

        expect(results.map(result => result.status).sort()).toEqual([
            'fulfilled',
            'rejected',
        ]);
        expect(job.manifest.ranges.map(range => range.status).sort()).toEqual([
            'failed',
            'verified',
        ]);
        expect(job.manifest.ranges.filter(range => range.status === 'verified')).toEqual([expect.objectContaining({
            accountedSize: 4,
            sha256: createHash('sha256').update('four').digest('hex'),
        })]);
        await job.cleanup?.();
    });

    it('charges additional compact artifacts to the same verified aggregate budget', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-manifest-compact-budget-test-'));
        directories.push(directory);
        const sourcePath = join(directory, 'source.djvu');
        writeFileSync(sourcePath, 'djvu-source');
        const job = await openDjvuArtifactJob(sourcePath, [{
            startPage: 1,
            endPage: 1,
        }], {
            artifactKind: 'compact-page',
            outputExtension: '.json',
            maxTotalBytesForTests: 7,
        });
        const checkpointPath = job.manifest.ranges[0]!.outputPath;
        const layerPath = join(job.directory, 'layer.pbm');
        writeFileSync(checkpointPath, 'four');
        writeFileSync(layerPath, 'more');

        await expect(job.updateRange(0, {status: 'verified'}, {additionalArtifacts: [{
            path: layerPath,
            size: 4,
            sha256: createHash('sha256').update('more').digest('hex'),
        }]})).rejects.toThrow('DjVu disk quota exceeded');

        expect(job.manifest.ranges[0]).toMatchObject({status: 'failed'});
        expect(() => readFileSync(checkpointPath)).toThrow();
        expect(() => readFileSync(layerPath)).toThrow();
        await job.cleanup?.();
    });

    it('aborts a live quota monitor when output growth crosses its byte ceiling', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-live-budget-test-'));
        directories.push(directory);
        const outputPath = join(directory, 'output.pdf');
        writeFileSync(outputPath, 'small');
        const monitor = await createDjvuDiskQuotaMonitor({
            paths: [outputPath],
            fileSystemPath: directory,
            maxTotalBytes: 5,
            freeSpaceReserveBytes: 0,
            intervalMs: 5,
        });
        writeFileSync(outputPath, 'too-large');

        await vi.waitFor(() => {
            expect(monitor.signal.aborted).toBe(true);
        });
        await expect(monitor.checkNow()).rejects.toThrow('DjVu disk quota exceeded');
        await monitor.stop();
    });

    it('rechecks the free-space reserve during growth and fails closed on simulated ENOSPC', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-live-space-test-'));
        directories.push(directory);
        const outputPath = join(directory, 'output.pdf');
        writeFileSync(outputPath, 'small');
        let availableBytes = 1_000;
        const monitor = await createDjvuDiskQuotaMonitor({
            paths: [outputPath],
            fileSystemPath: directory,
            maxTotalBytes: 1_000,
            freeSpaceReserveBytes: 500,
            intervalMs: 60_000,
            readAvailableBytesForTests: async () => availableBytes,
        });
        availableBytes = 500;

        await expect(monitor.checkNow()).rejects.toThrow('must remain free');
        expect(monitor.signal.aborted).toBe(true);
        await monitor.stop();
    });

    it('uses available space minus the reserve when no fixed artifact ceiling is supplied', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-djvu-available-space-test-'));
        directories.push(directory);
        const outputPath = join(directory, 'output.pdf');
        writeFileSync(outputPath, 'small');
        let availableBytes = 505;
        const monitor = await createDjvuDiskQuotaMonitor({
            paths: [outputPath],
            fileSystemPath: directory,
            freeSpaceReserveBytes: 500,
            intervalMs: 60_000,
            readAvailableBytesForTests: async () => availableBytes,
        });
        availableBytes = 504;

        await expect(monitor.checkNow()).rejects.toThrow('DjVu disk quota exceeded');
        expect(monitor.signal.aborted).toBe(true);
        await monitor.stop();
    });
});
