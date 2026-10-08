import type * as TDjvuNativeToolPathsModule from '@electron/features/djvu/main/nativeToolPaths';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    const tinyPpm = Buffer.from('P6\n1 1\n255\n\x00\x00\x00', 'binary');
    return {
        tinyPpm,
        convertDjvuPageToImage: vi.fn(async (_inputPath: string, outputPath: string) => ({
            success: true,
            outputPath,
            fileSize: 12,
        })),
        probeNativeNetpbm: vi.fn<() => Promise<{
            width: number;
            height: number;
            channels: number;
        } | null>>(async () => ({
            width: 1,
            height: 1,
            channels: 3,
        })),
        runNativeToolCommand: vi.fn(async () => undefined),
        getDjvuPageCount: vi.fn(async () => 1),
        getDjvuResolution: vi.fn(async () => 300),
        mkdtemp: vi.fn(async () => '/tmp/djvu-preview-test'),
        readFile: vi.fn(async () => tinyPpm),
        rm: vi.fn(async () => undefined),
        runNativeCommand: vi.fn(async () => ({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        })),
        stat: vi.fn(async (_path?: string) => ({
            isFile: () => true,
            mtimeMs: 1,
            size: tinyPpm.byteLength,
        })),
    };
});

vi.mock('fs/promises', () => ({
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    lstat: vi.fn(async () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
    })),
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
}));
vi.mock('@electron/features/djvu/main/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
}));
vi.mock('@electron/features/djvu/main/nativeToolPaths', async importOriginal => ({
    ...await importOriginal<typeof TDjvuNativeToolPathsModule>(),
    getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'}),
}));
vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({DJVU: '1'})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/features/djvu/main/probeNativeNetpbm', () => ({probeNativeNetpbm: mocks.probeNativeNetpbm}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineDisabled: () => false,
    resolveNativePdfImageCombinePath: () => '/tools/evb-pdf-image-combine',
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({convertDjvuPageToImage: mocks.convertDjvuPageToImage}));

const {
    clearDjvuPageSizeCacheForTests,
    getDjvuPageSizeForViewing,
    getDjvuPageSizeWindowsForViewing,
    getDjvuPageSizesForViewing,
    parseDjvuPageSizeOutput,
    renderDjvuPagePreview,
} = await import('@electron/features/djvu/main/pagePreview');

describe('DjVu native page preview helpers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearDjvuPageSizeCacheForTests();
        mocks.convertDjvuPageToImage.mockResolvedValue({
            success: true,
            outputPath: '/tmp/djvu-preview-test/page.ppm',
            fileSize: 12,
        });
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuPageCount.mockResolvedValue(1);
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-preview-test');
        mocks.readFile.mockResolvedValue(mocks.tinyPpm);
        mocks.probeNativeNetpbm.mockResolvedValue({
            width: 1,
            height: 1,
            channels: 3,
        });
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            mtimeMs: 1,
            size: mocks.tinyPpm.byteLength,
        });
    });

    it('parses djvused page size output variants', () => {
        expect(parseDjvuPageSizeOutput([
            'width=640 height=480',
            '800x600',
            '1024 768',
            'not a size',
        ].join('\n'), 300)).toEqual([
            {
                width: 640,
                height: 480,
                dpi: 300,
            },
            {
                width: 800,
                height: 600,
                dpi: 300,
            },
            {
                width: 1024,
                height: 768,
                dpi: 300,
            },
        ]);
    });

    it('raises unsafe full-resolution preview requests to the minimum subsample floor', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '10000 10000',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 1});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                subsample: 2,
            },
        );
    });

    it('ignores over-native target size for native ddjvu previews', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, { targetWidthPx: 2484 });

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {format: 'ppm'},
        );
    });

    it('downsamples viewport previews in ddjvu instead of decoding archival resolution', async () => {
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(/^\/tmp\/djvu-preview-test\/page-1-.+\.ppm$/u),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                targetHeightPx: 608,
                targetWidthPx: 400,
            },
        );
    });

    it('reuses the page metrics loaded at open instead of spawning a size probe per preview', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '1293 1966',
            stderr: '',
            exitCode: 0,
        });
        await getDjvuPageSizesForViewing('/tmp/book.djvu', 1);

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.any(String),
            1,
            expect.any(String),
            expect.objectContaining({
                targetHeightPx: 608,
                targetWidthPx: 400,
            }),
        );
    });

    it('probes page sizes through bounded windows', async () => {
        mocks.runNativeCommand.mockImplementation(async (...rawArgs: unknown[]) => {
            const args = rawArgs[1] as string[];
            const pageNumbers = [...String(args[2]).matchAll(/select (\d+); size/gu)]
                .map(match => Number.parseInt(match[1] ?? '', 10));
            return {
                stdout: pageNumbers.map(page => `${100 + page} ${200 + page}`).join('\n'),
                stderr: '',
                exitCode: 0,
            };
        });

        const windows = [];
        for await (const window of getDjvuPageSizeWindowsForViewing('/tmp/large.djvu', 513)) {
            windows.push(window);
        }

        expect(windows.map(window => [
            window.firstPage,
            window.sizes.length,
        ])).toEqual([
            [
                1,
                256,
            ],
            [
                257,
                256,
            ],
            [
                513,
                1,
            ],
        ]);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(3);
        const calls = mocks.runNativeCommand.mock.calls as unknown[][];
        expect((calls[0]?.[1] as string[] | undefined)?.[2]).toContain('select 256; size');
        expect((calls[1]?.[1] as string[] | undefined)?.[2]).toContain('select 257; size');
    });

    it('probes only selected pages instead of scanning every intervening window', async () => {
        mocks.runNativeCommand.mockImplementation(async (...rawArgs: unknown[]) => {
            const args = rawArgs[1] as string[];
            const pageNumbers = [...String(args[2]).matchAll(/select (\d+); size/gu)]
                .map(match => Number.parseInt(match[1] ?? '', 10));
            return {
                stdout: pageNumbers.map(page => `${100 + page} ${200 + page}`).join('\n'),
                stderr: '',
                exitCode: 0,
            };
        });

        const windows = [];
        for await (const window of getDjvuPageSizeWindowsForViewing(
            '/tmp/selected.djvu',
            5_001,
            {pageNumbers: [
                1,
                5_000,
            ]},
        )) {
            windows.push(window);
        }

        expect(windows.map(window => [
            window.firstPage,
            window.sizes.length,
        ])).toEqual([
            [
                1,
                1,
            ],
            [
                5_000,
                1,
            ],
        ]);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        const calls = mocks.runNativeCommand.mock.calls as unknown[][];
        expect((calls[0]?.[1] as string[] | undefined)?.[2]).toBe('select 1; size');
        expect((calls[1]?.[1] as string[] | undefined)?.[2]).toBe('select 5000; size');
    });

    it('bounds cached page metadata after a full-document scan', async () => {
        mocks.runNativeCommand.mockImplementation(async (...rawArgs: unknown[]) => {
            const args = rawArgs[1] as string[];
            const pageNumbers = [...String(args[2]).matchAll(/select (\d+); size/gu)]
                .map(match => Number.parseInt(match[1] ?? '', 10));
            return {
                stdout: pageNumbers.map(page => `${100 + page} ${200 + page}`).join('\n'),
                stderr: '',
                exitCode: 0,
            };
        });

        await getDjvuPageSizesForViewing('/tmp/cache-bound.djvu', 513);
        await getDjvuPageSizesForViewing('/tmp/cache-bound.djvu', 513);

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(6);
    });

    it('refuses dense page-size arrays above the bounded compatibility ceiling', async () => {
        await expect(getDjvuPageSizesForViewing('/tmp/too-many-pages.djvu', 10_001))
            .rejects.toMatchObject({
                code: 'too-large',
                maxPages: 10_000,
                pageCount: 10_001,
            });

        expect(mocks.runNativeCommand).not.toHaveBeenCalled();
    });

    it('stops a million-page size scan immediately after cancellation', async () => {
        const controller = new AbortController();
        mocks.runNativeCommand.mockImplementation(async () => {
            controller.abort();
            return {
                stdout: '100 200',
                stderr: '',
                exitCode: 0,
            };
        });

        const iterator = getDjvuPageSizeWindowsForViewing('/tmp/million-page.djvu', 1_000_001, {signal: controller.signal});
        await expect(iterator.next()).rejects.toThrow('aborted');
        expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
    });

    it('invalidates cached page metrics when the file revision changes at the same path', async () => {
        mocks.stat
            .mockResolvedValueOnce({
                isFile: () => true,
                mtimeMs: 1,
                size: 100,
            })
            .mockResolvedValueOnce({
                isFile: () => true,
                mtimeMs: 2,
                size: 101,
            });
        mocks.runNativeCommand
            .mockResolvedValueOnce({
                stdout: '100 200',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                stdout: '300 400',
                stderr: '',
                exitCode: 0,
            });

        await getDjvuPageSizesForViewing('/tmp/reused.djvu', 1);
        await renderDjvuPagePreview('/tmp/reused.djvu', 1, {targetWidthPx: 150});

        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/reused.djvu',
            expect.any(String),
            1,
            expect.any(String),
            expect.objectContaining({targetHeightPx: 200}),
        );
    });

    it('coalesces and stores one single-page metadata probe per source revision', async () => {
        const firstRevision = {
            isFile: () => true as const,
            mtimeMs: 1.9,
            size: 100,
        };
        mocks.stat.mockResolvedValue(firstRevision);
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });

        await expect(Promise.all([
            getDjvuPageSizeForViewing('/tmp/coalesced.djvu', 1),
            getDjvuPageSizeForViewing('/tmp/coalesced.djvu', 1),
        ])).resolves.toEqual([
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
            {
                width: 100,
                height: 200,
                dpi: 300,
            },
        ]);
        await getDjvuPageSizeForViewing('/tmp/coalesced.djvu', 1);

        expect(mocks.getDjvuPageCount).toHaveBeenCalledOnce();
        expect(mocks.getDjvuResolution).toHaveBeenCalledOnce();
        expect(mocks.runNativeCommand).toHaveBeenCalledOnce();

        mocks.stat.mockResolvedValue({
            isFile: () => true,
            mtimeMs: 2.1,
            size: 101,
        });
        mocks.runNativeCommand.mockResolvedValueOnce({
            stdout: '300 400',
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuPageSizeForViewing('/tmp/coalesced.djvu', 1)).resolves.toEqual({
            width: 300,
            height: 400,
            dpi: 300,
        });
        expect(mocks.getDjvuPageCount).toHaveBeenCalledTimes(2);
        expect(mocks.getDjvuResolution).toHaveBeenCalledTimes(2);
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
    });

    it('runs one page-size command per distinct cold page once the source revision is known', async () => {
        mocks.getDjvuPageCount.mockResolvedValue(20);
        mocks.runNativeCommand.mockImplementation(async (...rawArgs: unknown[]) => {
            const args = rawArgs[1] as string[];
            const pageNumber = Number.parseInt(/select (\d+); size/u.exec(String(args[2]))?.[1] ?? '', 10);
            return {
                stdout: `${100 + pageNumber} 200`,
                stderr: '',
                exitCode: 0,
            };
        });

        for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
            await expect(getDjvuPageSizeForViewing('/tmp/cold-pages.djvu', pageNumber)).resolves.toEqual({
                width: 100 + pageNumber,
                height: 200,
                dpi: 300,
            });
        }
        await getDjvuPageSizeForViewing('/tmp/cold-pages.djvu', 7);

        expect(mocks.getDjvuPageCount).toHaveBeenCalledOnce();
        expect(mocks.getDjvuResolution).toHaveBeenCalledOnce();
        expect(mocks.runNativeCommand.mock.calls.map(call => (call as unknown[])[1])).toEqual(
            Array.from({length: 20}, (_, index) => [
                '/tmp/cold-pages.djvu',
                '-e',
                `select ${index + 1}; size`,
            ]),
        );
    });

    it('does not share or block in-flight page probes across document paths', async () => {
        const firstProbe = Promise.withResolvers<{
            stdout: string;
            stderr: string;
            exitCode: number;
        }>();
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            mtimeMs: 1,
            size: 100,
        });
        mocks.runNativeCommand
            .mockReturnValueOnce(firstProbe.promise)
            .mockResolvedValueOnce({
                stdout: '300 400',
                stderr: '',
                exitCode: 0,
            });

        const firstDocumentSize = getDjvuPageSizeForViewing('/tmp/first.djvu', 1);
        await vi.waitFor(() => {
            expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
        });

        await expect(getDjvuPageSizeForViewing('/tmp/second.djvu', 1)).resolves.toEqual({
            width: 300,
            height: 400,
            dpi: 300,
        });
        expect(mocks.runNativeCommand).toHaveBeenNthCalledWith(
            2,
            '/tools/djvused',
            [
                '/tmp/second.djvu',
                '-e',
                'select 1; size',
            ],
            expect.any(Object),
        );

        firstProbe.resolve({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });
        await expect(firstDocumentSize).resolves.toEqual({
            width: 100,
            height: 200,
            dpi: 300,
        });
    });

    it('does not let an in-flight probe from an old revision block the replacement revision', async () => {
        const oldRevisionProbe = Promise.withResolvers<{
            stdout: string;
            stderr: string;
            exitCode: number;
        }>();
        mocks.stat
            .mockResolvedValueOnce({
                isFile: () => true,
                mtimeMs: 1,
                size: 100,
            })
            .mockResolvedValue({
                isFile: () => true,
                mtimeMs: 2,
                size: 101,
            });
        mocks.runNativeCommand
            .mockReturnValueOnce(oldRevisionProbe.promise)
            .mockResolvedValueOnce({
                stdout: '300 400',
                stderr: '',
                exitCode: 0,
            });

        const oldRevisionSize = getDjvuPageSizeForViewing('/tmp/replaced.djvu', 1);
        await vi.waitFor(() => {
            expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
        });

        await expect(getDjvuPageSizeForViewing('/tmp/replaced.djvu', 1)).resolves.toEqual({
            width: 300,
            height: 400,
            dpi: 300,
        });

        oldRevisionProbe.resolve({
            stdout: '100 200',
            stderr: '',
            exitCode: 0,
        });
        await expect(oldRevisionSize).resolves.toEqual({
            width: 100,
            height: 200,
            dpi: 300,
        });
        await expect(getDjvuPageSizeForViewing('/tmp/replaced.djvu', 1)).resolves.toEqual({
            width: 300,
            height: 400,
            dpi: 300,
        });
        expect(mocks.runNativeCommand).toHaveBeenCalledTimes(2);
    });

    it('rejects oversized PPM output before reading it into memory', async () => {
        mocks.stat.mockImplementation(async (path?: string) => ({
            isFile: () => true as const,
            mtimeMs: 1,
            size: path?.endsWith('.ppm') === true
                ? 193 * 1024 * 1024
                : mocks.tinyPpm.byteLength,
        }));

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 4}))
            .rejects
            .toThrow('DjVu preview output exceeds safe read limit (192MB)');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });

    it('fails recoverably instead of decoding a large Netpbm buffer in the main process', async () => {
        mocks.probeNativeNetpbm.mockResolvedValueOnce(null);

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 4}))
            .rejects
            .toThrow('large Netpbm fallback is intentionally disabled');

        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
