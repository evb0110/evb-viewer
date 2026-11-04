import {
    mkdtemp,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import type * as FsPromises from 'fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('documentFileWriteAtomic immutable-source fallback', () => {
    let tempRoot = '';
    let previousCloneResult: string | undefined;
    let previousImmutableLinkResult: string | undefined;

    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-atomic-copy-fallback-'));
        previousCloneResult = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        previousImmutableLinkResult = process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT;
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';
        process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT = 'cross-device';
    });

    afterEach(async () => {
        if (previousCloneResult === undefined) {
            delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        } else {
            process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = previousCloneResult;
        }
        if (previousImmutableLinkResult === undefined) {
            delete process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT;
        } else {
            process.env.EVB_TEST_FORCE_IMMUTABLE_LINK_RESULT = previousImmutableLinkResult;
        }
        await rm(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('copies to a distinct inode when the immutable hard link crosses a device', async () => {
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        await writeFile(sourcePath, 'source bytes');
        const phases: string[] = [];
        const {copyFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');

        await copyFileAtomic(sourcePath, targetPath, {
            durable: false,
            linkImmutableSource: true,
            onPhase: phase => phases.push(phase),
        });

        await expect(readFile(targetPath, 'utf8')).resolves.toBe('source bytes');
        const [
            sourceStat,
            targetStat,
        ] = await Promise.all([
            stat(sourcePath, {bigint: true}),
            stat(targetPath, {bigint: true}),
        ]);
        expect(sourceStat.ino).not.toBe(targetStat.ino);
        expect(phases).toEqual(expect.arrayContaining([
            'clone',
            'link',
            'copy',
            'rename',
        ]));
    });

    it('checks the destination witness on the immutable publication fallback', async () => {
        const sourcePath = join(tempRoot, 'staged.pdf');
        const targetPath = join(tempRoot, 'original.pdf');
        await Promise.all([
            writeFile(sourcePath, 'renderer bytes'),
            writeFile(targetPath, 'external bytes'),
        ]);
        const conflict = new Error('original changed');
        const assertDestinationCurrent = vi.fn().mockRejectedValue(conflict);
        const {publishImmutableFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');

        await expect(publishImmutableFileAtomic(sourcePath, targetPath, {assertDestinationCurrent})).rejects.toBe(conflict);

        expect(assertDestinationCurrent).toHaveBeenCalledOnce();
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('external bytes');
        await expect(readFile(sourcePath, 'utf8')).resolves.toBe('renderer bytes');
    });

    it('refuses a source replaced while the unsupported-clone fallback copies it', async () => {
        const sourcePath = join(tempRoot, 'saved.pdf');
        const replacementPath = join(tempRoot, 'replacement.pdf');
        const targetPath = join(tempRoot, 'working.pdf');
        await writeFile(sourcePath, Buffer.alloc(3 * 1024 * 1024 + 17, 65));
        await writeFile(replacementPath, Buffer.alloc(3 * 1024 * 1024 + 17, 66));
        await writeFile(targetPath, 'prior working bytes');
        const firstRead = Promise.withResolvers<undefined>();
        const releaseRead = Promise.withResolvers<undefined>();
        vi.doMock('fs/promises', async importOriginal => {
            const original = await importOriginal<typeof FsPromises>();
            return {
                ...original,
                open: async (...args: Parameters<typeof original.open>) => {
                    const handle = await original.open(...args);
                    if (args[0] === sourcePath && args[1] === 'r') {
                        const read = handle.read.bind(handle);
                        let first = true;
                        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
                            if (first) {
                                first = false;
                                firstRead.resolve(undefined);
                                await releaseRead.promise;
                            }
                            return read(...readArgs);
                        }) as typeof handle.read;
                    }
                    return handle;
                },
            };
        });
        vi.resetModules();
        try {
            const {copyFileAtomic} = await import('@electron/file-access/documentFileWriteAtomic');
            const copy = copyFileAtomic(sourcePath, targetPath, {durable: false});
            await firstRead.promise;
            // Another program saves over the source while it is being copied.
            await rename(replacementPath, sourcePath);
            releaseRead.resolve(undefined);

            await expect(copy).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
            await expect(readFile(targetPath, 'utf8')).resolves.toBe('prior working bytes');
        } finally {
            vi.doUnmock('fs/promises');
            vi.resetModules();
        }
    });
});

