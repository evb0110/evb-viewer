import {
    mkdtemp,
    chmod,
    readFile,
    readlink,
    rm,
    symlink,
    writeFile,
    stat,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {atomicReplace} from '@electron/utils/atomicReplace';

describe('atomicReplace real filesystem policy', () => {
    let root = '';

    afterEach(async () => {
        await rm(root, {
            force: true,
            recursive: true,
        });
    });

    it.skipIf(process.platform === 'win32')('rejects a symlink destination without replacing the link or referent', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-real-'));
        const sourcePath = join(root, 'source.pdf');
        const referentPath = join(root, 'referent.pdf');
        const destinationPath = join(root, 'destination.pdf');
        await writeFile(sourcePath, 'new bytes');
        await writeFile(referentPath, 'referent bytes');
        await symlink(referentPath, destinationPath);

        await expect(atomicReplace(sourcePath, destinationPath))
            .rejects
            .toThrow(`Invalid file path: symlink path segment is not allowed (${destinationPath})`);
        await expect(readlink(destinationPath)).resolves.toBe(referentPath);
        await expect(readFile(referentPath, 'utf8')).resolves.toBe('referent bytes');
        await expect(readFile(sourcePath, 'utf8')).resolves.toBe('new bytes');
    });

    it.skipIf(process.platform === 'win32')('publishes a read-only copy-on-write Save As staging file', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-readonly-'));
        const sourcePath = join(root, 'source.pdf');
        const stagingPath = join(root, 'staging.pdf');
        const destinationPath = join(root, 'saved.pdf');
        await writeFile(sourcePath, '%PDF-1.7\nsource bytes\n%%EOF');
        await chmod(sourcePath, 0o444);
        const previousCloneResult = process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'success';
        try {
            const {copyFileCopyOnWrite} = await import('@electron/file-access/workingCopyDirectory');
            await copyFileCopyOnWrite(sourcePath, stagingPath);
            await atomicReplace(stagingPath, destinationPath);
            await expect(readFile(destinationPath, 'utf8')).resolves.toBe('%PDF-1.7\nsource bytes\n%%EOF');
            expect((await stat(sourcePath)).mode & 0o777).toBe(0o444);
        } finally {
            if (previousCloneResult === undefined) {
                delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
            } else {
                process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = previousCloneResult;
            }
        }
    });
});
