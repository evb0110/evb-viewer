import {join} from 'node:path';
import {escapeRegExp} from 'es-toolkit/string';
import type * as TDdjvuConversionModule from '@electron/features/djvu/main/ddjvuConversion';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
    const tinyPpm = Buffer.concat([Buffer.from('P6\n3 2\n255\n', 'ascii'), Buffer.alloc(3 * 2 * 3)]);
    return {
        tinyPpm,
        convertDjvuPageToImage: vi.fn(async (_inputPath: string, outputPath: string) => ({
            success: true,
            outputPath,
            fileSize: 12,
        })),
        isNativePdfImageCombineDisabled: vi.fn(() => false),
        open: vi.fn(async () => ({
            read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
                const bytesRead = Math.max(0, Math.min(length, tinyPpm.byteLength - position));
                buffer.set(tinyPpm.subarray(position, position + bytesRead), offset);
                return {bytesRead};
            },
            stat: async () => ({
                ctimeMs: 1,
                dev: 1,
                ino: 1,
                mtimeMs: 1,
                size: tinyPpm.byteLength,
            }),
            close: async () => undefined,
        })),
        runNativeToolCommand: vi.fn(async () => undefined),
        runDjvuEngine: vi.fn(),
        mkdtemp: vi.fn(async () => '/tmp/djvu-preview-test'),
        readFile: vi.fn(async () => tinyPpm),
        rm: vi.fn(async () => undefined),
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
    open: mocks.open,
    readFile: (path: string, ...args: unknown[]) =>
        path.endsWith('.evb-scratch-record')
            ? Promise.reject(Object.assign(new Error('no scratch record'), {code: 'ENOENT'}))
            : Reflect.apply(mocks.readFile, undefined, [path, ...args]),
    rm: mocks.rm,
    stat: mocks.stat,
}));
vi.mock('@electron/features/djvu/main/djvuEnginePool', () => ({runDjvuEngine: mocks.runDjvuEngine}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({
    isNativePdfImageCombineDisabled: mocks.isNativePdfImageCombineDisabled,
    resolveNativePdfImageCombinePath: () => '/tools/evb-pdf-image-combine',
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', async (importOriginal) => ({
    ...(await importOriginal<typeof TDdjvuConversionModule>()),
    convertDjvuPageToImage: mocks.convertDjvuPageToImage,
}));

const {
    clearDjvuPageSizeCacheForTests,
    DJVU_PAGE_SIZE_ARRAY_MAX_PAGES,
    DjvuPageSizeArrayLimitError,
    getDjvuPageSizeForViewing,
    getDjvuPageSizeWindowsForViewing,
    getDjvuPageSizesForViewing,
    renderDjvuPagePreview,
} = await import('@electron/features/djvu/main/pagePreview');

describe('DjVu page preview helpers (DjVuLibre WASM)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearDjvuPageSizeCacheForTests();
        mocks.convertDjvuPageToImage.mockResolvedValue({
            success: true,
            outputPath: '/tmp/djvu-preview-test/page.ppm',
            fileSize: 12,
        });
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-preview-test');
        mocks.readFile.mockResolvedValue(mocks.tinyPpm);
        mocks.runNativeToolCommand.mockResolvedValue(undefined);
        mocks.runDjvuEngine.mockImplementation(async (request: {type: string; pageNumbers?: readonly number[]}) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 1,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            if (request.type === 'getPageSizes') {
                const count = request.pageNumbers?.length ?? 1;
                return Array.from({length: count}, () => ({
                    width: 100,
                    height: 200,
                    dpi: 300,
                }));
            }
            throw new Error(`Unexpected DjVu engine request: ${request.type}`);
        });
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            mtimeMs: 1,
            size: mocks.tinyPpm.byteLength,
        });
    });

    it('raises unsafe full-resolution preview requests to the minimum subsample floor', async () => {
        mocks.runDjvuEngine.mockImplementation(async (request: {type: string}) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 1,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            return [
                {
                    width: 10_000,
                    height: 10_000,
                    dpi: 300,
                },
            ];
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 1});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(new RegExp(`^${escapeRegExp(join('/tmp/djvu-preview-test', 'page-1-'))}.+\\.ppm$`, 'u')),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                subsample: 2,
            },
        );
    });

    it('ignores over-native target size for previews', async () => {
        mocks.runDjvuEngine.mockImplementation(async (request: {type: string}) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 1,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            return [
                {
                    width: 1293,
                    height: 1966,
                    dpi: 300,
                },
            ];
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 2484});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(new RegExp(`^${escapeRegExp(join('/tmp/djvu-preview-test', 'page-1-'))}.+\\.ppm$`, 'u')),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {format: 'ppm'},
        );
    });

    it('downsamples viewport previews directly in the DjVuLibre engine', async () => {
        mocks.runDjvuEngine.mockImplementation(async (request: {type: string}) => {
            if (request.type === 'getDocInfo') {
                return {
                    pageCount: 1,
                    sourceDpi: 300,
                    isIndirect: false,
                    files: [],
                };
            }
            return [
                {
                    width: 1293,
                    height: 1966,
                    dpi: 300,
                },
            ];
        });

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(new RegExp(`^${escapeRegExp(join('/tmp/djvu-preview-test', 'page-1-'))}.+\\.ppm$`, 'u')),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                targetHeightPx: 608,
                targetWidthPx: 400,
            },
        );
    });

    it('reuses the page metrics loaded at open instead of probing per preview', async () => {
        mocks.runDjvuEngine.mockResolvedValueOnce([
            {
                width: 1293,
                height: 1966,
                dpi: 300,
            },
        ]);
        await getDjvuPageSizesForViewing('/tmp/book.djvu', 1);

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {targetWidthPx: 400});

        expect(mocks.runDjvuEngine).toHaveBeenCalledOnce();
    });

    it('probes page sizes through bounded windows and selected page ranges', async () => {
        const windows: Array<{
            firstPage: number;
            count: number;
        }> = [];
        for await (const window of getDjvuPageSizeWindowsForViewing('/tmp/huge.djvu', 2050)) {
            windows.push({
                firstPage: window.firstPage,
                count: window.sizes.length,
            });
        }
        expect(windows).toEqual([
            {
                firstPage: 1,
                count: 1024,
            },
            {
                firstPage: 1025,
                count: 1024,
            },
            {
                firstPage: 2049,
                count: 2,
            },
        ]);

        const selectedWindows: number[] = [];
        for await (const window of getDjvuPageSizeWindowsForViewing('/tmp/huge.djvu', 2050, {
            pageNumbers: [2050, 5, 6],
        })) {
            selectedWindows.push(window.firstPage);
        }
        expect(selectedWindows).toEqual([5, 2050]);
    });

    it('refuses dense page-size arrays above the bounded compatibility ceiling', async () => {
        await expect(getDjvuPageSizesForViewing('/tmp/too-many.djvu', DJVU_PAGE_SIZE_ARRAY_MAX_PAGES + 1)).rejects.toBeInstanceOf(
            DjvuPageSizeArrayLimitError,
        );
    });

    it('invalidates cached page metrics when the file revision changes at the same path', async () => {
        let revisionMtime = 1;
        mocks.stat.mockImplementation(async () => ({
            isFile: () => true,
            mtimeMs: revisionMtime,
            size: 100 + revisionMtime,
        }));

        await getDjvuPageSizeForViewing('/tmp/book.djvu', 1);
        const callsAfterFirst = mocks.runDjvuEngine.mock.calls.length;
        await getDjvuPageSizeForViewing('/tmp/book.djvu', 1);
        expect(mocks.runDjvuEngine.mock.calls.length).toBe(callsAfterFirst);

        revisionMtime = 2;
        await getDjvuPageSizeForViewing('/tmp/book.djvu', 1);
        expect(mocks.runDjvuEngine.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('rejects oversized PPM output before reading it into memory', async () => {
        mocks.stat.mockImplementation(async (targetPath?: string) => ({
            isFile: () => true,
            mtimeMs: 1,
            size: targetPath?.endsWith('.ppm') ? 256 * 1024 * 1024 : 100,
        }));

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1)).rejects.toThrow('DjVu preview output exceeds safe read limit');
    });

    it('fails recoverably when native PNG preview encoding is disabled', async () => {
        mocks.isNativePdfImageCombineDisabled.mockReturnValue(true);

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1)).rejects.toThrow('Native DjVu preview encoding is unavailable');
    });
});
