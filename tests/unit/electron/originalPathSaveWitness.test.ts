import type * as TViMockOriginalModule from '@electron/file-access/workingCopyStore';

import {
    mkdtemp,
    rm,
    stat,
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

const mocks = vi.hoisted(() => ({
    getWorkingCopyOriginalFileExpectation: vi.fn(),
    mutatePostHashStatPath: '',
}));

vi.mock('node:fs/promises', async importOriginal => {
    const original = await importOriginal<typeof FsPromises>();
    return {
        ...original,
        open: async (...args: Parameters<typeof original.open>) => {
            const handle = await original.open(...args);
            if (String(args[0]) !== mocks.mutatePostHashStatPath) {
                return handle;
            }
            const originalStat = handle.stat.bind(handle);
            let statCallCount = 0;
            handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
                const fileStat = await originalStat(...statArgs) as BigIntStats;
                statCallCount += 1;
                if (statCallCount === 2) {
                    return {
                        ...fileStat,
                        ctimeNs: fileStat.ctimeNs + 1n,
                        mtimeNs: fileStat.mtimeNs + 1n,
                    };
                }
                return fileStat;
            }) as typeof handle.stat;
            return handle;
        },
    };
});

vi.mock('@electron/file-access/workingCopyStore', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule>()),
    getWorkingCopyOriginalFileExpectation: mocks.getWorkingCopyOriginalFileExpectation,
}));

const {
    captureOriginalPathSaveWitness,
    capturePathSaveWitness,
    originalPathSaveBaseMatches,
} = await import('@electron/file-access/originalPathSaveWitness');

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
        mocks.mutatePostHashStatPath = '';
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

    it('rejects a same-size edit even when its mtime is restored', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const expected = await captureExpectation(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(expected);

        await writeFile(originalPath, Buffer.from('edit'));
        const restoredSeconds = Number(BigInt(expected.mtimeNs)) / 1_000_000_000;
        await utimes(originalPath, restoredSeconds, restoredSeconds);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('rejects an atomic replacement with the same bytes', async () => {
        const originalPath = join(tempDir, 'original.pdf');
        const replacementPath = join(tempDir, 'replacement.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue(await captureExpectation(originalPath));
        await writeFile(replacementPath, Buffer.from('base'));
        await rm(originalPath);
        const {rename} = await import('fs/promises');
        await rename(replacementPath, originalPath);

        await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(false);
    });

    it('records a bounded full hash for small Windows witnesses', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        try {
            const originalPath = join(tempDir, 'original.pdf');
            const bytes = Buffer.alloc(256 * 1024, 7);
            await writeFile(originalPath, bytes);
            const admitted = await capturePathSaveWitness(originalPath);
            expect(admitted).not.toBeNull();
            const admittedSnapshot = admitted!.getSnapshotForJournal();
            await admitted!.close();

            bytes[70_000] = 8;
            await writeFile(originalPath, bytes);
            const changed = await capturePathSaveWitness(originalPath);
            expect(changed).not.toBeNull();
            const changedSnapshot = changed!.getSnapshotForJournal();
            await changed!.close();

            expect(admittedSnapshot.sampleSha256).toBe(changedSnapshot.sampleSha256);
            expect(admittedSnapshot.fullSha256).toMatch(/^[0-9a-f]{64}$/u);
            expect(changedSnapshot.fullSha256).not.toBe(admittedSnapshot.fullSha256);
        } finally {
            Object.defineProperty(process, 'platform', {
                configurable: true,
                value: originalPlatform,
            });
        }
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
            await witness!.close();
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

    it('keeps legacy size and mtime expectations compatible on Windows without reading bytes', async () => {
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        const originalPath = join(tempDir, 'original.pdf');
        await writeFile(originalPath, Buffer.from('base'));
        const fileStat = await stat(originalPath);
        mocks.getWorkingCopyOriginalFileExpectation.mockReturnValue({
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
        });

        try {
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
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

    it('accepts sub-millisecond rounding in a legacy mtime witness', async () => {
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
            await expect(originalPathSaveBaseMatches('/unused-working.pdf', originalPath, 12)).resolves.toBe(true);
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
