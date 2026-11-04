import {
    link,
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
    vi,
} from 'vitest';
import {atomicReplace} from '@electron/utils/atomicReplace';

vi.mock('fs/promises', {spy: true});

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

    it.skipIf(process.platform === 'win32')('keeps a private destination private and leaves a linked source alone', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-mode-'));
        const destinationPath = join(root, 'private.pdf');
        const stagingPath = join(root, 'staging.pdf');
        await writeFile(destinationPath, 'old bytes', {mode: 0o600});
        await chmod(destinationPath, 0o600);
        await writeFile(stagingPath, 'new bytes');
        await chmod(stagingPath, 0o644);

        await atomicReplace(stagingPath, destinationPath);

        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes');
        expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);

        // A staged hard link shares the source's inode; the source keeps its mode.
        const sourcePath = join(root, 'source.pdf');
        const linkedPath = join(root, 'linked.pdf');
        await writeFile(sourcePath, 'source bytes');
        await chmod(sourcePath, 0o644);
        await link(sourcePath, linkedPath);
        await atomicReplace(linkedPath, destinationPath);
        expect((await stat(sourcePath)).mode & 0o777).toBe(0o644);
        // ...while the destination still keeps its own.
        expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('source bytes');
    });

    it.skipIf(process.platform === 'win32')('saves even when the filesystem refuses to keep the destination mode', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-mode-refused-'));
        const destinationPath = join(root, 'private.pdf');
        const stagingPath = join(root, 'staging.pdf');
        await writeFile(destinationPath, 'old bytes', {mode: 0o600});
        await chmod(destinationPath, 0o600);
        await writeFile(stagingPath, 'new bytes');
        await chmod(stagingPath, 0o644);
        const {chmod: productChmod} = await import('fs/promises');
        vi.mocked(productChmod).mockRejectedValueOnce(Object.assign(new Error('Operation not permitted'), {code: 'EPERM'}));

        await atomicReplace(stagingPath, destinationPath);

        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes');
    });
});
