import {
    mkdtempSync,
    readFileSync,
    readlinkSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
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

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    markMutationCommitStarted: vi.fn(),
    open: vi.fn(),
    readFile: vi.fn(),
    rename: vi.fn(),
    stat: vi.fn(),
    sync: vi.fn(),
    unlink: vi.fn(),
}));

const originalPlatform = process.platform;

vi.mock('node:crypto', () => ({ randomBytes: () => Buffer.from('fixed-id') }));

vi.mock('fs/promises', () => ({
    open: (...args: unknown[]) => mocks.open(...args),
    readFile: (...args: unknown[]) => mocks.readFile(...args),
    rename: (...args: unknown[]) => mocks.rename(...args),
    stat: (...args: unknown[]) => mocks.stat(...args),
    unlink: (...args: unknown[]) => mocks.unlink(...args),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', () => ({markActiveWorkingCopyMutationCommitStarted: mocks.markMutationCommitStarted}));

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}

describe('atomicReplace', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.close.mockResolvedValue(undefined);
        mocks.open.mockResolvedValue({
            close: mocks.close,
            sync: mocks.sync,
        });
        mocks.readFile.mockRejectedValue(Object.assign(new Error('not found'), {code: 'ENOENT'}));
        mocks.rename.mockResolvedValue(undefined);
        mocks.stat.mockResolvedValue({});
        mocks.unlink.mockResolvedValue(undefined);
        mocks.sync.mockResolvedValue(undefined);
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    it('continues replacing output when Windows refuses to fsync the temp file', async () => {
        setPlatform('win32');
        const fsyncError = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' });
        mocks.sync.mockRejectedValueOnce(fsyncError);

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf')).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(1, 'C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf');
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('still rejects unexpected temp-file fsync failures', async () => {
        setPlatform('darwin');
        const fsyncError = Object.assign(new Error('operation not permitted, fsync'), { code: 'EPERM' });
        mocks.sync.mockRejectedValueOnce(fsyncError);

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf')).rejects.toThrow('operation not permitted');

        expect(mocks.rename).not.toHaveBeenCalled();
        expect(mocks.close).toHaveBeenCalledTimes(1);
    });

    it('uses one same-directory rename on POSIX so the destination is never moved aside first', async () => {
        setPlatform('darwin');
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf')).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenCalledTimes(1);
        expect(mocks.rename).toHaveBeenCalledWith('/out/tmp.pdf', '/out/extract.pdf');
        expect(mocks.unlink).not.toHaveBeenCalled();
    });

    it('checks a destination witness immediately before the POSIX rename', async () => {
        setPlatform('linux');
        const conflict = new Error('destination changed');
        const assertDestinationCurrent = vi.fn().mockRejectedValue(conflict);
        const {atomicReplace} = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf', {assertDestinationCurrent})).rejects.toBe(conflict);

        expect(assertDestinationCurrent).toHaveBeenCalledOnce();
        expect(mocks.markMutationCommitStarted).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('checks a destination witness before the Windows backup rename', async () => {
        setPlatform('win32');
        const conflict = new Error('destination changed');
        const assertDestinationCurrent = vi.fn().mockRejectedValue(conflict);
        const {atomicReplace} = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf', {assertDestinationCurrent}))
            .rejects.toBe(conflict);

        expect(assertDestinationCurrent).toHaveBeenCalledOnce();
        expect(mocks.markMutationCommitStarted).not.toHaveBeenCalled();
        expect(mocks.rename).not.toHaveBeenCalled();
    });

    it('signals mutation commit after the destination witness passes and before POSIX rename', async () => {
        setPlatform('linux');
        const order: string[] = [];
        const assertDestinationCurrent = vi.fn(async () => {
            order.push('assert');
        });
        mocks.markMutationCommitStarted.mockImplementation(() => {
            order.push('mark');
        });
        mocks.rename.mockImplementation(async () => {
            order.push('rename');
        });
        const {atomicReplace} = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/out/tmp.pdf', '/out/extract.pdf', {assertDestinationCurrent}))
            .resolves.toBeUndefined();

        expect(order).toEqual([
            'assert',
            'mark',
            'rename',
        ]);
    });

    it('rejects a symlink destination before replacing its leaf', async () => {
        setPlatform('darwin');
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-replace-symlink-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const referentPath = join(tempRoot, 'referent.pdf');
        const destinationPath = join(tempRoot, 'destination.pdf');
        writeFileSync(sourcePath, 'new bytes');
        writeFileSync(referentPath, 'referent bytes');
        symlinkSync(referentPath, destinationPath);

        try {
            const {atomicReplace} = await import('@electron/utils/atomicReplace');

            await expect(atomicReplace(sourcePath, destinationPath))
                .rejects
                .toThrow(`Invalid file path: symlink path segment is not allowed (${destinationPath})`);

            expect(mocks.rename).not.toHaveBeenCalled();
            expect(readlinkSync(destinationPath)).toBe(referentPath);
            expect(readFileSync(referentPath, 'utf8')).toBe('referent bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('allows a regular destination below the permitted /tmp ancestor', async () => {
        setPlatform('darwin');
        const {atomicReplace} = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('/tmp/evb-atomic-replace-source.tmp', '/tmp/evb-atomic-replace-target.pdf'))
            .resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenCalledWith(
            '/tmp/evb-atomic-replace-source.tmp',
            '/tmp/evb-atomic-replace-target.pdf',
        );
    });

    it('propagates an unsupported Windows replacement error without moving the destination aside', async () => {
        setPlatform('win32');
        const replacementError = Object.assign(new Error('replacement failed'), {code: 'EIO'});
        mocks.rename.mockRejectedValueOnce(replacementError);

        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf'))
            .rejects.toBe(replacementError);
        expect(mocks.rename).toHaveBeenCalledOnce();
        expect(mocks.rename).toHaveBeenCalledWith('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf');
    });

    it('moves a live Windows destination aside for a non-durable cache publication', async () => {
        setPlatform('win32');
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        // A retained scan-cleanup raster is republished over a path a sidecar
        // manifest may still be reading. A bare rename onto that destination
        // fails EPERM/EACCES on Windows; the replace moves it aside first.
        await expect(atomicReplace('C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png', {
            durable: false,
            markMutationCommitStarted: false,
        })).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenNthCalledWith(1, 'C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png');
        // A within-run cache lives in a scratch directory that is discarded on
        // exit, so it never pays for the durability fsyncs.
        expect(mocks.sync).not.toHaveBeenCalled();
    });

    it('surfaces a Windows deny-delete destination error before promoting the temp file', async () => {
        setPlatform('win32');
        const denyDelete = Object.assign(new Error('sharing violation'), {code: 'EIO'});
        mocks.rename.mockRejectedValueOnce(denyDelete);
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        await expect(atomicReplace('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf'))
            .rejects.toBe(denyDelete);
        expect(mocks.rename).toHaveBeenCalledOnce();
        expect(mocks.rename).toHaveBeenCalledWith('C:\\out\\tmp.pdf', 'C:\\out\\extract.pdf');
    });

    it('keeps the destination readable when Windows cannot remove the moved-aside file', async () => {
        setPlatform('win32');
        const { atomicReplace } = await import('@electron/utils/atomicReplace');

        // The reader still holding the old bytes keeps them; the new raster is
        // in place regardless.
        await expect(atomicReplace('C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png', {
            durable: false,
            markMutationCommitStarted: false,
        })).resolves.toBeUndefined();

        expect(mocks.rename).toHaveBeenCalledWith('C:\\scratch\\page.part.png', 'C:\\scratch\\page-1-150.png');
    });
});
