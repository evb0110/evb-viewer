import {
    appendFile,
    cp,
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
import type * as TDjvuNativeToolPathsModule from '@electron/features/djvu/main/nativeToolPaths';
import {
    loadOrBuildCompactDjvuPage,
    openCompactDjvuCheckpointJob,
} from '@electron/features/djvu/main/compactDjvuCheckpoint';
import { assertDjvuSourceIdentity } from '@electron/features/djvu/main/djvuArtifactManifest';

// `djvused index.djvu -e ls` on tests/fixtures/djvu/sources/indirect, so the
// listing does not need the platform's DjVu tools.
const runDjvuSourceCommand = vi.hoisted(() => vi.fn(async () => ({
    stdout: '   1 P        0  low-dpi.djvu\n   2 P        0  high-dpi.djvu\n',
    stderr: '',
    exitCode: 0,
})));
vi.mock('@electron/features/djvu/main/nativeToolPaths', async importOriginal => ({
    ...await importOriginal<typeof TDjvuNativeToolPathsModule>(),
    getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'}),
    runDjvuSourceCommand,
}));

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

    it('resumes an unchanged indirect document and rebuilds once one of its page files changes', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'compact-checkpoint-indirect-test-'));
        await cp(join(process.cwd(), 'tests/fixtures/djvu/sources/indirect'), tempDir, {recursive: true});
        const sourcePath = join(tempDir, 'index.djvu');
        let maskPath = '';
        const build = vi.fn(async () => {
            await mkdir(join(maskPath, '..'), {recursive: true});
            await writeFile(maskPath, 'P4\n1 1\n\0');
            return {
                pageNumber: 2,
                manifestLine: `mask\t72\t72\t${maskPath}`,
                kind: 'bitonal' as const,
                reason: 'test',
                effectivePpi: 300,
            };
        });
        const convertPage = async () => {
            const job = await openCompactDjvuCheckpointJob(sourcePath, [2], 'balanced');
            maskPath = join(job.directory, 'compact-pages', 'mask.pbm');
            await loadOrBuildCompactDjvuPage(job, 0, build);
            return job;
        };

        const first = await convertPage();
        expect(runDjvuSourceCommand).toHaveBeenCalledWith('/tools/djvused', [
            sourcePath,
            '-e',
            'ls',
        ], 0, expect.anything());
        expect(first.sourceIdentity.components.map(component => component.path)).toEqual([
            join(tempDir, 'low-dpi.djvu'),
            join(tempDir, 'high-dpi.djvu'),
        ]);
        await first.close();
        const resumed = await convertPage();
        expect(build, 'an unchanged document resumes its checkpoint').toHaveBeenCalledTimes(1);
        await resumed.close();

        // Only the page's own file changes; the index stays byte for byte.
        await appendFile(join(tempDir, 'high-dpi.djvu'), '\0');
        await expect(assertDjvuSourceIdentity(sourcePath, resumed.sourceIdentity), 'an export in progress stops').rejects.toThrow(/changed/u);
        const changed = await convertPage();
        expect(build, 'the edited page is converted again').toHaveBeenCalledTimes(2);
        expect(changed.directory).not.toBe(resumed.directory);
        await changed.close();
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

    it('refuses an indirect document whose index names a component outside its folder, and lists thousands', async () => {
        const {getDjvuIndirectComponentPaths} = await import('@electron/features/djvu/main/metadata');
        const index = join(process.cwd(), 'tests', 'fixtures', 'djvu', 'sources', 'indirect', 'index.djvu');
        runDjvuSourceCommand.mockResolvedValueOnce({
            stdout: '   1 P        0  ../outside.djvu\n',
            stderr: '',
            exitCode: 0,
        });
        await expect(getDjvuIndirectComponentPaths(index)).rejects.toThrow('outside its folder');

        runDjvuSourceCommand.mockResolvedValueOnce({
            stdout: Array.from({length: 10_000}, (_, page) => `${String(page + 1).padStart(6)} P        0  page-${String(page + 1).padStart(5, '0')}.djvu`).join('\n'),
            stderr: '',
            exitCode: 0,
        });
        await expect(getDjvuIndirectComponentPaths(index)).resolves.toHaveLength(10_000);
        // The real tool stops at this limit; the listing above needs about 480 KB.
        const [
            , , , commandOptions,
        ] = (runDjvuSourceCommand.mock.lastCall ?? []) as unknown[];
        expect(commandOptions).toMatchObject({maxStdoutBytes: expect.any(Number)});
        expect((commandOptions as {maxStdoutBytes: number}).maxStdoutBytes).toBeGreaterThan(10_000 * 48);
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
