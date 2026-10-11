import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    chmod,
    link,
    mkdtemp,
    open,
    readFile,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'fs/promises';
import type {BigIntStats} from 'node:fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {createOriginalFileContentFingerprintHash} from '@electron/file-access/createOriginalFileContentFingerprintHash';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import type * as ReadFileChunk from '@electron/file-access/readFileChunk';

const mocks = vi.hoisted(() => ({
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    identityChurnPath: '',
    identityStats: 0,
    mutateDuringWitnessPath: '',
    mutateDuringWitnessReplacementPath: '',
    mutateDuringWitnessByte: -1,
    mutateDuringWitnessCtime: null as bigint | null,
    mutatePostHashStatPath: '',
    postHashStatCalls: 0,
    witnessReads: 0,
}));

vi.mock('node:fs/promises', async importOriginal => {
    const original = await importOriginal<typeof FsPromises>();
    return {
        ...original,
        stat: async (...args: Parameters<typeof original.stat>) => {
            const fileStat = await original.stat(...args);
            if (String(args[0]) !== mocks.identityChurnPath) return fileStat;
            const bigintStat = fileStat as BigIntStats;
            const sequence = BigInt(++mocks.identityStats);
            return {
                ...bigintStat,
                isFile: () => bigintStat.isFile(),
                dev: bigintStat.dev + sequence,
                ino: bigintStat.ino + sequence,
            };
        },
        lstat: async (...args: Parameters<typeof original.lstat>) => {
            const fileStat = await original.lstat(...args);
            if (String(args[0]) === mocks.identityChurnPath) {
                const bigintStat = fileStat as BigIntStats;
                const sequence = BigInt(++mocks.identityStats);
                return {
                    ...bigintStat,
                    isFile: () => bigintStat.isFile(),
                    dev: bigintStat.dev + sequence,
                    ino: bigintStat.ino + sequence,
                };
            }

            if (String(args[0]) === mocks.mutatePostHashStatPath && ++mocks.postHashStatCalls === 2) {
                const bigintStat = fileStat as BigIntStats;
                return {
                    ...bigintStat,
                    isFile: () => bigintStat.isFile(),
                    ctimeNs: bigintStat.ctimeNs + 1n,
                    mtimeNs: bigintStat.mtimeNs + 1n,
                };
            }
            if (String(args[0]) === mocks.mutateDuringWitnessPath && mocks.mutateDuringWitnessCtime !== null) {
                const bigintStat = fileStat as BigIntStats;
                return Object.assign(Object.create(Object.getPrototypeOf(bigintStat)), bigintStat, {ctimeNs: mocks.mutateDuringWitnessCtime});
            }
            return fileStat;
        },
    };
});

vi.mock('@electron/file-access/readFileChunk', async importOriginal => {
    const original = await importOriginal<typeof ReadFileChunk>();
    const fs = await import('node:fs/promises');
    return {readFileChunk: async (...args: Parameters<typeof original.readFileChunk>) => {
        const bytesRead = await original.readFileChunk(...args);
        if (args[0] === mocks.mutateDuringWitnessPath && ++mocks.witnessReads === 2) {
            const fileStat = await fs.stat(args[0]);
            const bytes = await fs.readFile(args[0]);
            if (mocks.mutateDuringWitnessByte >= 0) bytes[mocks.mutateDuringWitnessByte] = 8;
            await fs.writeFile(mocks.mutateDuringWitnessReplacementPath, bytes);
            await fs.utimes(mocks.mutateDuringWitnessReplacementPath, fileStat.atime, fileStat.mtime);
            await fs.rename(mocks.mutateDuringWitnessReplacementPath, mocks.mutateDuringWitnessPath);
        }
        return bytesRead;
    }};
});

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalFileExpectation: mocks.getWorkingCopyOriginalFileExpectation,
}));

const {
    captureOpenSourceWitness,
    captureOriginalPathSaveWitness,
    originalPathSaveBaseMatches,
} = await import('@electron/file-access/originalPathSaveWitness');
const {
    hashContentFingerprintFilePath,
    OriginalPathSaveConflictError,
} = await import('@electron/file-access/originalPathSnapshot');

async function captureExpectation(path: string) {
    const fileStat = await stat(path, {bigint: true});
    return {
        ctimeNs: fileStat.ctimeNs.toString(),
        deviceId: fileStat.dev.toString(),
        inode: fileStat.ino.toString(),
        mtimeMs: Number(fileStat.mtimeNs) / 1_000_000,
        mtimeNs: fileStat.mtimeNs.toString(),
        size: Number(fileStat.size),
    };
}

describe('originalPathSaveBaseMatches', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.identityChurnPath = '';
        mocks.identityStats = 0;
        mocks.mutateDuringWitnessPath = '';
        mocks.mutateDuringWitnessByte = -1;
        mocks.mutateDuringWitnessCtime = null;
        mocks.mutateDuringWitnessReplacementPath = '';
        mocks.mutatePostHashStatPath = '';
        mocks.postHashStatCalls = 0;
        mocks.witnessReads = 0;
        tempDir = await mkdtemp(join(tmpdir(), 'save-base-matches-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('matches an unchanged original from its stat witness', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
    });

    it.each([
        'unchanged',
        'changed',
        'missing-baseline',
    ])('requires admitted content proof for identity-only churn: %s', async (scenario) => {
        const originalPath = join(tempDir, 'network-original.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 65));
        const expected = await captureExpectation(originalPath);
        const contentFingerprint = await hashContentFingerprintFilePath(originalPath, BigInt(expected.size));
        if (scenario === 'changed') {
            const handle = await open(originalPath, 'r+');
            await handle.write('EXTERNAL-EDIT', 262144);
            await handle.close();
        }
        // A remote filesystem can return stale content timestamps and changing
        // client-generated inode numbers. The admitted full bytes remain the oracle.
        const current = await captureExpectation(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            ctimeNs: current.ctimeNs,
            mtimeNs: current.mtimeNs,
            mtimeMs: current.mtimeMs,
            ...(scenario === 'missing-baseline' ? {} : {contentFingerprint}),
        });
        mocks.identityChurnPath = originalPath;
        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness !== null).toBe(scenario === 'unchanged');
        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12))
            .resolves.toBe(scenario === 'unchanged');
        if (witness) {
            await expect(witness.assertCurrent()).resolves.toBeUndefined();
        }
    });

    it('rejects a same-size edit even when its mtime is restored', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const originalBytes = Buffer.from('base');
        await writeFile(originalPath, originalBytes);
        const expected = await captureExpectation(originalPath);
        const hash = createOriginalFileContentFingerprintHash(originalBytes.byteLength);
        hash.update(originalBytes);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
        });

        await writeFile(originalPath, Buffer.from('edit'));
        const restoredSeconds = Number(BigInt(expected.mtimeNs)) / 1_000_000_000;
        await utimes(originalPath, restoredSeconds, restoredSeconds);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('accepts an atomic replacement with identical bytes using the admitted full baseline', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        const bytes = Buffer.from('base');
        await writeFile(originalPath, bytes);
        const originalExpectation = await captureExpectation(originalPath);
        const hash = createOriginalFileContentFingerprintHash(bytes.byteLength);
        hash.update(bytes);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...originalExpectation,
            contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
        });
        await writeFile(replacementPath, Buffer.from('base'));
        await rm(originalPath);
        const {rename} = await import('fs/promises');
        await rename(replacementPath, originalPath);

        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness).not.toBeNull();
        await expect(witness!.assertCurrent()).resolves.toBeUndefined();
    });

    it('rejects an atomic replacement with an interior byte changed', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        const bytes = Buffer.alloc(256 * 1024, 7);
        await writeFile(originalPath, bytes);
        const expected = await captureExpectation(originalPath);
        const hash = createOriginalFileContentFingerprintHash(bytes.byteLength);
        hash.update(bytes);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
        });
        bytes[70_000] = 8;
        await writeFile(replacementPath, bytes);
        await rm(originalPath);
        const {rename} = await import('fs/promises');
        await rename(replacementPath, originalPath);

        await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12))
            .resolves.toBeNull();
    });

    it.each([
        false,
        true,
    ])('proves full replacement content during comparison, edited=%s', async edited => {
        const originalPath = join(tempDir, 'original.pdf');
        const bytes = Buffer.alloc(256 * 1024, 7);
        await writeFile(originalPath, bytes);
        await utimes(originalPath, 1700000000, 1700000000);
        const expected = await captureExpectation(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            // Force the full read deterministically, independent of the clock tick.
            ctimeNs: (BigInt(expected.ctimeNs) - 1n).toString(),
            contentFingerprint: await hashContentFingerprintFilePath(originalPath, BigInt(bytes.length)),
        });
        mocks.mutateDuringWitnessPath = originalPath;
        mocks.mutateDuringWitnessReplacementPath = join(tempDir, 'during-comparison.pdf');
        mocks.mutateDuringWitnessByte = edited ? 70_000 : -1;
        mocks.mutateDuringWitnessCtime = BigInt(expected.ctimeNs);

        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect((await stat(originalPath, {bigint: true})).ino).not.toBe(BigInt(expected.inode));
        if (edited) expect(witness).toBeNull();
        else {
            expect(witness).not.toBeNull();
            await expect(witness!.assertCurrent()).resolves.toBeUndefined();
            expect((await readFile(originalPath)).equals(bytes)).toBe(true);
        }
    });

    it('rejects an identical replacement when the full baseline is not available', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        await writeFile(replacementPath, Buffer.from('base'));
        await rm(originalPath);
        const {rename} = await import('fs/promises');
        await rename(replacementPath, originalPath);

        await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12))
            .resolves.toBeNull();
    });

    it.skipIf(process.platform === 'win32')('rejects a symlink replacement even when its target has identical bytes', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const targetPath = join(tempDir, 'target.pdf');
        const bytes = Buffer.from('base');
        await writeFile(originalPath, bytes);
        const expected = await captureExpectation(originalPath);
        const hash = createOriginalFileContentFingerprintHash(bytes.byteLength);
        hash.update(bytes);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
        });
        await writeFile(targetPath, bytes);
        await rm(originalPath);
        await symlink(targetPath, originalPath);

        await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12))
            .resolves.toBeNull();
    });

    it('rejects a Windows content change when the stat witness is unchanged', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        try {
            const originalPath = join(tempDir, 'original.pdf');
            const originalBytes = Buffer.alloc(256 * 1024, 7);
            const originalHash = createOriginalFileContentFingerprintHash(originalBytes.byteLength);
            originalHash.update(originalBytes);
            const originalFingerprint = `sha256-full-v1:${originalHash.digest('hex')}`;
            await writeFile(originalPath, originalBytes);

            const changedBytes = Buffer.from(originalBytes);
            changedBytes[70_000] = 8;
            await writeFile(originalPath, changedBytes);
            const changedStat = await stat(originalPath, {bigint: true});
            mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
                contentFingerprint: originalFingerprint,
                mtimeMs: Number(changedStat.mtimeNs) / 1_000_000,
                size: Number(changedStat.size),
            });

            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('rejects a Windows content change before admitting a transaction witness', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        try {
            const originalPath = join(tempDir, 'original.pdf');
            const originalBytes = Buffer.alloc(256 * 1024, 7);
            const originalHash = createOriginalFileContentFingerprintHash(originalBytes.byteLength);
            originalHash.update(originalBytes);
            const originalFingerprint = `sha256-full-v1:${originalHash.digest('hex')}`;

            const changedBytes = Buffer.from(originalBytes);
            changedBytes[70_000] = 8;
            await writeFile(originalPath, changedBytes);
            const changedStat = await stat(originalPath, {bigint: true});
            mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
                contentFingerprint: originalFingerprint,
                ctimeNs: changedStat.ctimeNs.toString(),
                deviceId: changedStat.dev.toString(),
                inode: changedStat.ino.toString(),
                mtimeMs: Number(changedStat.mtimeNs) / 1_000_000,
                mtimeNs: changedStat.mtimeNs.toString(),
                size: Number(changedStat.size),
            });

            await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12))
                .resolves.toBeNull();
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('admits a Windows witness when the stored content fingerprint matches', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        try {
            const originalPath = join(tempDir, 'original.pdf');
            const bytes = Buffer.alloc(256 * 1024, 7);
            const hash = createOriginalFileContentFingerprintHash(bytes.byteLength);
            hash.update(bytes);
            await writeFile(originalPath, bytes);
            const originalStat = await stat(originalPath, {bigint: true});
            mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
                contentFingerprint: `sha256-full-v1:${hash.digest('hex')}`,
                ctimeNs: originalStat.ctimeNs.toString(),
                deviceId: originalStat.dev.toString(),
                inode: originalStat.ino.toString(),
                mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
                mtimeNs: originalStat.mtimeNs.toString(),
                size: Number(originalStat.size),
            });

            const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
            expect(witness).not.toBeNull();
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('rejects a Windows content fingerprint when metadata changes after hashing', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        try {
            const originalPath = join(tempDir, 'original.pdf');
            const bytes = Buffer.alloc(256 * 1024, 7);
            const originalHash = createOriginalFileContentFingerprintHash(bytes.byteLength);
            originalHash.update(bytes);
            const originalFingerprint = `sha256-full-v1:${originalHash.digest('hex')}`;
            await writeFile(originalPath, bytes);
            const originalStat = await stat(originalPath, {bigint: true});
            mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
                contentFingerprint: originalFingerprint,
                mtimeMs: Number(originalStat.mtimeNs) / 1_000_000,
                size: Number(originalStat.size),
            });
            mocks.mutatePostHashStatPath = originalPath;

            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
        } finally {
            mocks.mutatePostHashStatPath = '';
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('refuses a legacy Windows baseline that cannot distinguish an interior edit', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        const originalPath = join(tempDir, 'original.pdf');
        const bytes = Buffer.alloc(256 * 1024, 7);
        await writeFile(originalPath, bytes);
        await utimes(originalPath, 1700000000, 1700000000);
        const fileStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
        });

        bytes[70_000] = 8;
        await writeFile(originalPath, bytes);
        await utimes(originalPath, 1700000000, 1700000000);
        try {
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
            await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12)).resolves.toBeNull();
            expect((await readFile(originalPath)).equals(bytes)).toBe(true);
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('rejects a legacy size and mtime expectation on POSIX', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'darwin',
        });
        const originalPath = join(tempDir, 'legacy-posix-original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const fileStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
        });

        try {
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
            await expect(captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12)).resolves.toBeNull();
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('refuses a rounded legacy Windows timestamp without historical content proof', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const fileStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: fileStat.mtimeMs + 0.5,
            size: fileStat.size,
        });

        try {
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
    });

    it('fails closed when no original expectation exists', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(null);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('fails closed when the original path no longer exists', async () => {
        const originalPath = join(tempDir, 'missing.pdf');
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: 0,
            size: 4,
        });

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });
});

describe('captureOriginalPathSaveWitness rebase', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'save-witness-rebase-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('refuses an unsampled in-place edit whose mtime was restored when the saved original is rebased', async () => {
        const originalPath = join(tempDir, 'unsampled-edit.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 65));
        const wholeSecond = Math.floor(Number((await stat(originalPath, {bigint: true})).mtimeNs) / 1e9);
        await utimes(originalPath, wholeSecond, wholeSecond);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness).not.toBeNull();

        // Offset 262144 lies outside the head, middle and tail samples.
        const handle = await open(originalPath, 'r+');
        await handle.write('EXTERNAL-EDIT', 262144);
        await handle.close();
        await utimes(originalPath, wholeSecond, wholeSecond);

        await expect(witness!.assertCurrent()).rejects.toBeInstanceOf(OriginalPathSaveConflictError);
        await expect(witness!.rebaseOnUnchangedContent()).rejects.toBeInstanceOf(OriginalPathSaveConflictError);
    });

    it.each([
        'before-link',
        'after-link',
    ])('refuses an unsampled external edit %s with restored mtime', async (changeAt) => {
        const originalPath = join(tempDir, `unsampled-${changeAt}.pdf`);
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 65));
        await utimes(originalPath, 1700000000, 1700000000);
        const expected = await captureExpectation(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            ...expected,
            contentFingerprint: await hashContentFingerprintFilePath(originalPath, BigInt(expected.size)),
        });
        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness).not.toBeNull();
        await witness!.assertCurrent();
        const edit = async () => {
            const handle = await open(originalPath, 'r+');
            await handle.write('EXTERNAL-EDIT', 262144);
            await handle.close();
            await utimes(originalPath, 1700000000, 1700000000);
        };
        if (changeAt === 'before-link') {
            await edit();
        }
        await link(originalPath, join(tempDir, 'backup.pdf'));
        if (changeAt === 'after-link') {
            await edit();
        }

        await expect(witness!.rebaseOnUnchangedContent()).rejects.toBeInstanceOf(OriginalPathSaveConflictError);
        const {readFile} = await import('fs/promises');
        expect((await readFile(originalPath)).subarray(262144, 262157).toString()).toBe('EXTERNAL-EDIT');
    });

    it('rebases over the save\'s own backup link when the admitted content still matches', async () => {
        const originalPath = join(tempDir, 'metadata-only.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 66));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness).not.toBeNull();

        await link(originalPath, join(tempDir, 'backup.pdf'));
        await chmod(originalPath, 0o600);

        await expect(witness!.rebaseOnUnchangedContent()).resolves.toBeUndefined();
        await expect(witness!.assertCurrent()).resolves.toBeUndefined();
    });

    it('refuses a metadata-only change that is not the backup link', async () => {
        const originalPath = join(tempDir, 'metadata-only-no-link.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 67));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        const witness = await captureOriginalPathSaveWitness('/unused-working.pdf', originalPath, 12);
        expect(witness).not.toBeNull();

        await chmod(originalPath, 0o600);

        await expect(witness!.rebaseOnUnchangedContent()).rejects.toBeInstanceOf(OriginalPathSaveConflictError);
    });
});

describe('captureOpenSourceWitness', () => {
    let tempDir = '';

    beforeEach(async () => {
        mocks.identityChurnPath = '';
        mocks.identityStats = 0;
        mocks.mutateDuringWitnessPath = '';
        mocks.mutateDuringWitnessByte = -1;
        mocks.mutateDuringWitnessCtime = null;
        mocks.mutateDuringWitnessReplacementPath = '';
        mocks.mutatePostHashStatPath = '';
        mocks.postHashStatCalls = 0;
        mocks.witnessReads = 0;
        tempDir = await mkdtemp(join(tmpdir(), 'open-source-witness-test-'));
    });

    afterEach(async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        });
    });

    it('reports a vanished source with its own error, not as a changed source', async () => {
        const error = await captureOpenSourceWitness(join(tempDir, 'missing.pdf')).catch((caught: unknown) => caught);

        expect(error).toMatchObject({code: 'ENOENT'});
        expect(error).not.toBeInstanceOf(OriginalPathSaveConflictError);
    });

    it('refuses an unsampled in-place edit whose mtime was restored when an open has no copy proof', async () => {
        const originalPath = join(tempDir, 'open-unsampled-edit.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 68));
        const wholeSecond = Math.floor(Number((await stat(originalPath, {bigint: true})).mtimeNs) / 1e9);
        await utimes(originalPath, wholeSecond, wholeSecond);
        const witness = await captureOpenSourceWitness(originalPath);

        // Offset 262144 lies outside the head, middle and tail samples.
        const handle = await open(originalPath, 'r+');
        await handle.write('EXTERNAL-EDIT', 262144);
        await handle.close();
        await utimes(originalPath, wholeSecond, wholeSecond);

        await expect(witness.rebaseOnUnchangedContent({
            kind: 'open-copy',
            source: null,
        }))
            .rejects.toBeInstanceOf(OriginalPathSaveConflictError);
    });

    it('accepts a metadata-only move of an open when the copy hashed the same bytes', async () => {
        const originalPath = join(tempDir, 'open-metadata-only.pdf');
        await writeFile(originalPath, Buffer.alloc(1024 * 1024, 69));
        const witness = await captureOpenSourceWitness(originalPath);
        const contentFingerprint = await hashContentFingerprintFilePath(originalPath, BigInt(1024 * 1024));

        await chmod(originalPath, 0o600);

        await expect(witness.rebaseOnUnchangedContent({
            kind: 'open-copy',
            source: {contentFingerprint},
        }))
            .resolves.toBeUndefined();
        await expect(witness.rebaseOnUnchangedContent({
            kind: 'open-copy',
            source: null,
        })).resolves.toBeUndefined();
    });

    it('reports a source swapped while witnessing as a conflict', async () => {
        const originalPath = join(tempDir, 'swapped.pdf');
        await writeFile(originalPath, Buffer.alloc(200 * 1024, 1));
        mocks.mutateDuringWitnessPath = originalPath;
        mocks.mutateDuringWitnessReplacementPath = `${originalPath}.replacement`;

        await expect(captureOpenSourceWitness(originalPath)).rejects.toBeInstanceOf(OriginalPathSaveConflictError);
    });
});
