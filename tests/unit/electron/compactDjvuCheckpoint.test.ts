import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
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
    loadOrBuildCompactDjvuPage,
    openCompactDjvuCheckpointJob,
} from '@electron/features/djvu/main/compactDjvuCheckpoint';

describe('compact DjVu checkpoints', () => {
    let tempDir = '';
    afterEach(async () => rm(tempDir, {
        recursive: true,
        force: true,
    }));

    it('reuses a verified per-page artifact after reopening the job', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'compact-checkpoint-test-'));
        const sourcePath = join(tempDir, 'source.djvu');
        let maskPath = '';
        await writeFile(sourcePath, 'fixture');
        const build = vi.fn(async () => {
            await mkdir(join(maskPath, '..'), {recursive: true});
            await writeFile(maskPath, 'P4\n1 1\n\0');
            return {
                pageNumber: 1,
                manifestLine: `mask\t72\t72\t${maskPath}`,
                kind: 'bitonal' as const,
                reason: 'test',
                effectivePpi: 300,
            };
        });

        const first = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        maskPath = join(first.directory, 'compact-pages', 'mask.pbm');
        const expectedSpec = await loadOrBuildCompactDjvuPage(first, 0, build);
        await first.close();
        const reopened = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        const resumedSpec = await loadOrBuildCompactDjvuPage(reopened, 0, build);

        expect(resumedSpec).toEqual(expectedSpec);
        expect(build).toHaveBeenCalledTimes(1);
        expect(reopened.manifest.ranges[0]).toMatchObject({status: 'verified'});
        await reopened.cleanup?.();
    });

    it('rebuilds a verified page when a referenced layer is tampered without changing size', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'compact-checkpoint-tamper-test-'));
        const sourcePath = join(tempDir, 'source.djvu');
        let maskPath = '';
        await writeFile(sourcePath, 'fixture');
        const build = vi.fn(async () => {
            await mkdir(join(maskPath, '..'), {recursive: true});
            await writeFile(maskPath, 'AAAA');
            return {
                pageNumber: 1,
                manifestLine: `mask\t72\t72\t${maskPath}`,
                kind: 'bitonal' as const,
                reason: 'test',
                effectivePpi: 300,
            };
        });
        const first = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        maskPath = join(first.directory, 'compact-pages', 'mask.pbm');
        await loadOrBuildCompactDjvuPage(first, 0, build);
        await first.close();
        await writeFile(maskPath, 'BBBB');

        const reopened = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');
        await loadOrBuildCompactDjvuPage(reopened, 0, build);

        expect(build).toHaveBeenCalledTimes(2);
        await reopened.cleanup?.();
    });

    it('rejects a checkpoint build that points at an artifact outside the job directory', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'compact-checkpoint-path-test-'));
        const sourcePath = join(tempDir, 'source.djvu');
        const outsidePath = join(tempDir, 'outside.pbm');
        await Promise.all([
            writeFile(sourcePath, 'fixture'),
            writeFile(outsidePath, 'AAAA'),
        ]);
        const job = await openCompactDjvuCheckpointJob(sourcePath, [1], 'balanced');

        await expect(loadOrBuildCompactDjvuPage(job, 0, async () => ({
            pageNumber: 1,
            manifestLine: `mask\t72\t72\t${outsidePath}`,
            kind: 'bitonal',
            reason: 'test',
            effectivePpi: 300,
        }))).rejects.toThrow('escapes its job directory');

        expect(job.manifest.ranges[0]).toMatchObject({status: 'failed'});
        await job.cleanup?.();
    });
});
