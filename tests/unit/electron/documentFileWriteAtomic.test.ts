import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import * as atomicReplaceModule from '@electron/utils/atomicReplace';
import {
    copyFileAtomic,
    publishImmutableFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: platform,
    });
}

describe('documentFileWriteAtomic', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        setPlatform(originalPlatform);
        delete process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT;
    });

    it('keeps a successful copy successful when phase reporting fails', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-copy-phase-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        writeFileSync(sourcePath, 'source bytes');

        try {
            const onPhase = vi.fn(() => {
                throw new Error('phase reporter failed');
            });
            await expect(copyFileAtomic(sourcePath, targetPath, {
                durable: false,
                onPhase,
            })).resolves.toBeUndefined();

            expect(onPhase).toHaveBeenCalledWith('clone', expect.any(Number));
            expect(onPhase).toHaveBeenCalledWith('rename', expect.any(Number));
            expect(readFileSync(targetPath, 'utf8')).toBe('source bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('replaces an existing destination on Windows', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-copy-windows-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        writeFileSync(sourcePath, 'new bytes');
        writeFileSync(targetPath, 'old bytes');
        setPlatform('win32');
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';

        try {
            await expect(copyFileAtomic(sourcePath, targetPath, {durable: false})).resolves.toBeUndefined();

            expect(readFileSync(targetPath, 'utf8')).toBe('new bytes');
            expect(readFileSync(sourcePath, 'utf8')).toBe('new bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('preserves the destination when the Windows revision witness rejects', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-copy-windows-witness-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        writeFileSync(sourcePath, 'new bytes');
        writeFileSync(targetPath, 'old bytes');
        setPlatform('win32');
        process.env.EVB_TEST_FORCE_WORKING_COPY_CLONE_RESULT = 'unsupported';

        try {
            const assertDestinationCurrent = vi.fn(async () => {
                throw new Error('destination changed');
            });
            await expect(copyFileAtomic(sourcePath, targetPath, {
                assertDestinationCurrent,
                durable: false,
            })).rejects.toThrow('destination changed');

            expect(assertDestinationCurrent).toHaveBeenCalledOnce();
            expect(readFileSync(targetPath, 'utf8')).toBe('old bytes');
            expect(readFileSync(sourcePath, 'utf8')).toBe('new bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('uses backup-first replacement for an immutable Windows publication', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-publish-windows-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        writeFileSync(sourcePath, 'new bytes');
        writeFileSync(targetPath, 'old bytes');
        setPlatform('win32');
        const atomicReplaceSpy = vi.spyOn(atomicReplaceModule, 'atomicReplace');

        try {
            await expect(publishImmutableFileAtomic(sourcePath, targetPath)).resolves.toBeUndefined();

            expect(atomicReplaceSpy).toHaveBeenCalledWith(
                expect.stringMatching(/(?:^|[/\\])\.[0-9a-f]{16}\.tmp$/u),
                targetPath,
                expect.objectContaining({
                    durable: false,
                    markMutationCommitStarted: false,
                }),
            );
            expect(readFileSync(targetPath, 'utf8')).toBe('new bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
