import type * as TFsPromisesOriginalModule from 'fs/promises';

import {
    link,
    mkdtemp,
    chmod,
    readFile,
    readdir,
    readlink,
    rename,
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
import {capturePathSaveWitness} from '@electron/file-access/originalPathSaveWitness';
import {
    atomicReplace,
    recoverWindowsAtomicReplace,
} from '@electron/utils/atomicReplace';

vi.mock('fs/promises', {spy: true});

describe('atomicReplace real filesystem policy', () => {
    let root = '';

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, {
            force: true,
            recursive: true,
        });
    });

    it('finishes a published Windows replacement whose cleanup removed the backup but not the journal', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-journal-'));
        const destination = join(root, 'manifest.json');
        const source = join(root, '.next.tmp');
        await writeFile(destination, 'old manifest');
        await writeFile(source, 'new manifest');
        const [
            destinationWitness,
            sourceWitness,
        ] = await Promise.all([
            capturePathSaveWitness(destination),
            capturePathSaveWitness(source),
        ]);
        const journal = `${destination}.evb-atomic-replace.json`;
        const writeJournal = () => writeFile(journal, JSON.stringify({
            version: 1,
            sourcePath: source,
            destinationPath: destination,
            backupPath: `${destination}.bak-gone`,
            destinationSnapshot: destinationWitness!.getSnapshotForJournal(),
            sourceSnapshot: sourceWitness!.getSnapshotForJournal(),
        }));
        // The new file was published and its backup removed; only the journal remains.
        await rm(destination);
        await rename(source, destination);
        await writeJournal();

        await recoverWindowsAtomicReplace(destination);

        expect(await readFile(destination, 'utf8')).toBe('new manifest');
        expect(await readdir(root)).toEqual(['manifest.json']);

        // A destination that is neither recorded file is still not overwritten.
        await writeFile(destination, 'someone else');
        await writeJournal();
        await expect(recoverWindowsAtomicReplace(destination)).rejects.toThrow('refused to overwrite');
        expect(await readFile(destination, 'utf8')).toBe('someone else');
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

    it.skipIf(process.platform === 'win32').each([
        false,
        true,
    ])(
        'keeps old private bytes when chmod is refused (durable=%s)', async (durable) => {
            root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-mode-refused-'));
            const destinationPath = join(root, 'private.pdf');
            const stagingPath = join(root, 'staging.pdf');
            await writeFile(destinationPath, 'old bytes');
            await chmod(destinationPath, 0o600);
            await writeFile(stagingPath, 'new bytes');
            await chmod(stagingPath, 0o644);
            const {chmod: productChmod} = await import('fs/promises');
            vi.mocked(productChmod).mockRejectedValueOnce(Object.assign(new Error('Operation not permitted'), {code: 'EPERM'}));

            await expect(atomicReplace(stagingPath, destinationPath, {durable})).rejects.toMatchObject({code: 'EPERM'});

            await expect(readFile(destinationPath, 'utf8')).resolves.toBe('old bytes');
            expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
            await expect(readFile(stagingPath, 'utf8')).resolves.toBe('new bytes');
        },
    );

    it.skipIf(process.platform === 'win32')('saves with stricter staging permissions when chmod is refused', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-stricter-'));
        const destinationPath = join(root, 'destination.pdf');
        const stagingPath = join(root, 'staging.pdf');
        await writeFile(destinationPath, 'old bytes');
        await chmod(destinationPath, 0o644);
        await writeFile(stagingPath, 'new bytes');
        await chmod(stagingPath, 0o600);
        const {chmod: productChmod} = await import('fs/promises');
        vi.mocked(productChmod).mockRejectedValueOnce(Object.assign(new Error('Operation not permitted'), {code: 'EPERM'}));

        await atomicReplace(stagingPath, destinationPath);

        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes');
        expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
    });

    // POSIX read permission is enforced on macOS/Linux for nonroot users.
    // Windows uses r+ for fsync and does not apply POSIX destination modes.
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0).each([
        {
            mode: 0o200,
            linked: false,
        },
        {
            mode: 0o000,
            linked: false,
        },
        {
            mode: 0o200,
            linked: true,
        },
        {
            mode: 0o000,
            linked: true,
        },
    ])('durably replaces an unreadable destination (%j)', async ({
        mode, linked,
    }) => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-unreadable-'));
        const destinationPath = join(root, 'destination.pdf');
        const stagingPath = join(root, 'staging.pdf');
        const sourcePath = join(root, 'source.pdf');
        await writeFile(destinationPath, 'old bytes');
        await chmod(destinationPath, mode);
        await writeFile(sourcePath, 'new bytes');
        await chmod(sourcePath, 0o644);
        if (linked) await link(sourcePath, stagingPath);
        else await writeFile(stagingPath, 'new bytes', {mode: 0o644});

        await atomicReplace(stagingPath, destinationPath);

        expect((await stat(destinationPath)).mode & 0o777).toBe(mode);
        await chmod(destinationPath, 0o600);
        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes');
        expect((await stat(sourcePath)).mode & 0o777).toBe(0o644);
        await expect(readFile(sourcePath, 'utf8')).resolves.toBe('new bytes');
        await expect(stat(stagingPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it.skipIf(process.platform === 'win32')('syncs the detached inode that is actually published', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-sync-inode-'));
        const sourcePath = join(root, 'source.pdf');
        const stagingPath = join(root, 'staging.pdf');
        const destinationPath = join(root, 'destination.pdf');
        await writeFile(sourcePath, 'new bytes');
        await chmod(sourcePath, 0o644);
        await link(sourcePath, stagingPath);
        await writeFile(destinationPath, 'old bytes');
        await chmod(destinationPath, 0o600);
        const actual = await vi.importActual<typeof TFsPromisesOriginalModule>('fs/promises');
        const {open: productOpen} = await import('fs/promises');
        let syncedInode: number | undefined;
        vi.mocked(productOpen).mockImplementationOnce(async (path, flags, mode) => {
            const handle = await actual.open(path, flags, mode);
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, 'sync').mockImplementation(async () => {
                await sync();
                syncedInode = (await handle.stat()).ino;
            });
            return handle;
        });

        await atomicReplace(stagingPath, destinationPath);

        expect((await stat(destinationPath)).ino).toBe(syncedInode);
        expect((await stat(sourcePath)).ino).not.toBe(syncedInode);
        expect((await stat(sourcePath)).mode & 0o777).toBe(0o644);
        await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes');
    });

    it.skipIf(process.platform === 'win32').each([
        'copy',
        'rename',
    ])(
        'removes the detached copy after failed %s', async (failure) => {
            root = await mkdtemp(join(tmpdir(), 'evb-atomic-replace-detach-failure-'));
            const sourcePath = join(root, 'source.pdf');
            const stagingPath = join(root, 'staging.pdf');
            const destinationPath = join(root, 'destination.pdf');
            await writeFile(sourcePath, 'private new document');
            await chmod(sourcePath, 0o644);
            await link(sourcePath, stagingPath);
            await writeFile(destinationPath, 'old bytes');
            await chmod(destinationPath, 0o600);
            const fs = await import('fs/promises');
            const refused = Object.assign(new Error('detach refused'), {code: 'EPERM'});
            if (failure === 'copy') {
                vi.mocked(fs.copyFile).mockImplementationOnce(async (_source, destination) => {
                    await writeFile(destination, 'partial private document');
                    throw refused;
                });
            } else {
                vi.mocked(fs.rename).mockRejectedValueOnce(refused);
            }

            await expect(atomicReplace(stagingPath, destinationPath)).rejects.toBe(refused);

            await expect(readFile(destinationPath, 'utf8')).resolves.toBe('old bytes');
            expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
            await expect(readFile(sourcePath, 'utf8')).resolves.toBe('private new document');
            expect((await stat(sourcePath)).mode & 0o777).toBe(0o644);
            await expect(readFile(stagingPath, 'utf8')).resolves.toBe('private new document');
            expect((await readdir(root)).sort()).toEqual([
                'destination.pdf',
                'source.pdf',
                'staging.pdf',
            ]);
        },
    );
});
