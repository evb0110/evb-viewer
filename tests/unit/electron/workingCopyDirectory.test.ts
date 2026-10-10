import { constants as fsConstants } from 'fs';
import {
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

describe('workingCopyDirectory', () => {
    afterEach(() => {
        delete process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER;
        delete process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER;
        vi.doUnmock('node:child_process');
        vi.doUnmock('fs/promises');
        vi.resetModules();
    });

    it('uses the native macOS clone helper without reading the file through Node', async () => {
        process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER = '1';
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            stderr: new PassThrough(),
        });
        const spawn = vi.fn(() => child);
        const copyFile = vi.fn();
        vi.doMock('node:child_process', () => ({spawn}));
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const {attemptWorkingCopyClone} = await import('@electron/file-access/workingCopyDirectory');
        const result = attemptWorkingCopyClone('/source.pdf', '/target.pdf');
        child.emit('exit', 0);

        await expect(result).resolves.toBe('cloned');
        expect(spawn).toHaveBeenCalledWith('/bin/cp', [
            '-c',
            '--',
            '/source.pdf',
            '/target.pdf',
        ], {
            stdio: [
                'ignore',
                'ignore',
                'pipe',
            ],
            windowsHide: true,
        });
        expect(copyFile).not.toHaveBeenCalled();
    });

    it('keeps genuine macOS clone incompatibility on the lazy-compatible path', async () => {
        process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER = '1';
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            stderr: new PassThrough(),
        });
        const spawn = vi.fn(() => child);
        const copyFile = vi.fn();
        vi.doMock('node:child_process', () => ({spawn}));
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const {attemptWorkingCopyClone} = await import('@electron/file-access/workingCopyDirectory');
        const result = attemptWorkingCopyClone('/source.pdf', '/target.pdf');
        child.stderr.write('clonefile failed: Operation not supported\n');
        child.emit('exit', 1, null);

        await expect(result).resolves.toBe('known-unsupported');
        expect(copyFile).not.toHaveBeenCalled();
    });

    it('does not turn a macOS clone capacity failure into lazy-original admission', async () => {
        process.env.EVB_TEST_FORCE_MAC_CLONE_HELPER = '1';
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            stderr: new PassThrough(),
        });
        const spawn = vi.fn(() => child);
        const error = Object.assign(new Error('No space left on device'), {code: 'ENOSPC'});
        const copyFile = vi.fn().mockRejectedValue(error);
        vi.doMock('node:child_process', () => ({spawn}));
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const {attemptWorkingCopyClone} = await import('@electron/file-access/workingCopyDirectory');
        const result = attemptWorkingCopyClone('/source.pdf', '/target.pdf');
        child.stderr.write('cp: /target.pdf: No space left on device\n');
        child.emit('exit', 1, null);

        await expect(result).rejects.toMatchObject({code: 'ENOSPC'});
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf');
    });

    it('reports a successful forced copy-on-write clone', async () => {
        process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER = '1';
        const copyFile = vi.fn(async () => undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf')).resolves.toBe('cloned');

        expect(copyFile).toHaveBeenCalledTimes(1);
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE_FORCE);
    });

    it.each([
        'ENOTSUP',
        'EOPNOTSUPP',
        'ENOSYS',
        'EINVAL',
        'EXDEV',
    ])('reports %s as known unsupported without starting an eager copy', async code => {
        process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER = '1';
        const error = Object.assign(new Error('clone unsupported'), {code});
        const copyFile = vi.fn().mockRejectedValueOnce(error);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf'))
            .resolves.toBe('known-unsupported');

        expect(copyFile).toHaveBeenCalledOnce();
        expect(copyFile).toHaveBeenCalledWith('/source.pdf', '/target.pdf', fsConstants.COPYFILE_FICLONE_FORCE);
    });

    it('uses the compatible eager fallback for an unknown clone failure', async () => {
        process.env.EVB_TEST_DISABLE_MAC_CLONE_HELPER = '1';
        const error = Object.assign(new Error('clone read failed'), {code: 'EIO'});
        const copyFile = vi.fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(undefined);
        vi.doMock('fs/promises', async (importOriginal) => ({
            ...await importOriginal(),
            copyFile,
        }));

        const { attemptWorkingCopyClone } = await import('@electron/file-access/workingCopyDirectory');

        await expect(attemptWorkingCopyClone('/source.pdf', '/target.pdf'))
            .resolves.toBe('unknown-error-eager-fallback');
        expect(copyFile).toHaveBeenCalledTimes(2);
        expect(copyFile).toHaveBeenNthCalledWith(
            1,
            '/source.pdf',
            '/target.pdf',
            fsConstants.COPYFILE_FICLONE_FORCE,
        );
        expect(copyFile).toHaveBeenNthCalledWith(2, '/source.pdf', '/target.pdf');
    });

    it('rejects a source replacement during the unsupported-clone fallback', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-stable-copy-test-'));
        const sourcePath = join(root, 'source.pdf');
        const targetPath = join(root, 'target.pdf');
        const replacementPath = join(root, 'replacement.pdf');
        writeFileSync(sourcePath, Buffer.alloc(3 * 1024 * 1024 + 17, 41));
        writeFileSync(replacementPath, Buffer.alloc(3 * 1024 * 1024 + 17, 97));
        let notifyCopy!: () => void;
        const copyStarted = new Promise<void>(resolve => {
            notifyCopy = resolve;
        });
        let releaseCopy!: () => void;
        const copyRelease = new Promise<void>(resolve => {
            releaseCopy = resolve;
        });
        try {
            vi.doMock('fs/promises', async importOriginal => {
                const original = await importOriginal<typeof FsPromises>();
                return {
                    ...original,
                    copyFile: async (...args: Parameters<typeof original.copyFile>) => {
                        await original.copyFile(...args);
                        notifyCopy();
                        await copyRelease;
                    },
                };
            });
            vi.resetModules();
            const {copyFileFromStableSource} = await import('@electron/file-access/workingCopyDirectory');
            const copy = copyFileFromStableSource(sourcePath, targetPath);
            await copyStarted;
            renameSync(sourcePath, join(root, 'old-source.pdf'));
            renameSync(replacementPath, sourcePath);
            releaseCopy();

            await expect(copy).rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
            expect(() => readFileSync(targetPath)).toThrow();
        } finally {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });
});
