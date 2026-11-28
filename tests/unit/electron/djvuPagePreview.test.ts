import {join} from 'node:path';
import {decode as decodePng} from 'fast-png';
import {escapeRegExp} from 'es-toolkit/string';
import type * as TDdjvuConversionModule from '@electron/features/djvu/main/ddjvuConversion';
import type {IJobBrokerRunContext} from '@electron/resources/jobBroker';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
    const tinyPixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const tinyPpm = Buffer.concat([Buffer.from('P6\n3 2\n255\n', 'ascii'), tinyPixels]);
    return {
        tinyPixels,
        tinyPpm,
        currentPpm: tinyPpm,
        convertDjvuPageToImage: vi.fn(async (_inputPath: string, outputPath: string) => ({
            success: true,
            outputPath,
            fileSize: tinyPpm.byteLength,
        })),
        open: vi.fn(async () => ({
            read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
                const source = mocks.currentPpm;
                const bytesRead = Math.max(0, Math.min(length, source.byteLength - position));
                buffer.set(source.subarray(position, position + bytesRead), offset);
                return {bytesRead};
            },
            stat: async () => ({
                ctimeMs: 1,
                dev: 1,
                ino: 1,
                mtimeMs: 1,
                size: mocks.currentPpm.byteLength,
            }),
            close: async () => undefined,
        })),
        runDjvuEngine: vi.fn(),
        mkdtemp: vi.fn(async () => '/tmp/djvu-preview-test'),
        readFile: vi.fn(async () => tinyPpm),
        rm: vi.fn(async () => undefined),
        stat: vi.fn(async (_path?: string) => ({
            isFile: () => true,
            mtimeMs: 1,
            size: mocks.currentPpm.byteLength,
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
        mocks.currentPpm = mocks.tinyPpm;
        mocks.convertDjvuPageToImage.mockResolvedValue({
            success: true,
            outputPath: '/tmp/djvu-preview-test/page.ppm',
            fileSize: mocks.tinyPpm.byteLength,
        });
        mocks.mkdtemp.mockResolvedValue('/tmp/djvu-preview-test');
        mocks.readFile.mockResolvedValue(mocks.tinyPpm);
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

    it('encodes PPM preview pixels directly into a valid lossless RGB PNG without spawning native tools', async () => {
        const preview = await renderDjvuPagePreview('/tmp/book.djvu', 1);

        expect(preview.width).toBe(3);
        expect(preview.height).toBe(2);
        const decoded = decodePng(preview.bytes);
        expect(decoded.width).toBe(3);
        expect(decoded.height).toBe(2);
        expect(decoded.channels).toBe(3);
        expect(Buffer.from(decoded.data)).toEqual(mocks.tinyPixels);
    });

    it('forwards onTerminationProof without bypassing the separate DjVu engine decode lease', async () => {
        const onTerminationProof = vi.fn();
        const brokerRun = {
            broker: {} as IJobBrokerRunContext['broker'],
            lease: {} as IJobBrokerRunContext['lease'],
            onTerminationProof,
        };

        await renderDjvuPagePreview('/tmp/book.djvu', 1, {subsample: 1}, {brokerRun, onTerminationProof});

        expect(mocks.convertDjvuPageToImage).toHaveBeenCalledWith(
            '/tmp/book.djvu',
            expect.stringMatching(new RegExp(`^${escapeRegExp(join('/tmp/djvu-preview-test', 'page-1-'))}.+\\.ppm$`, 'u')),
            1,
            expect.stringMatching(/^djvu-preview-page-1-/u),
            {
                format: 'ppm',
                onTerminationProof,
            },
        );
    });

    it('stops cooperatively between decode and PNG encode when aborted right after decode', async () => {
        const controller = new AbortController();
        mocks.convertDjvuPageToImage.mockImplementationOnce(async (_inputPath, outputPath) => {
            controller.abort(new DOMException('Scroll canceled', 'AbortError'));
            return {
                success: true,
                outputPath,
                fileSize: mocks.tinyPpm.byteLength,
            };
        });

        await expect(renderDjvuPagePreview('/tmp/book.djvu', 1, undefined, {signal: controller.signal})).rejects.toThrow('Scroll canceled');
        expect(mocks.open).not.toHaveBeenCalled();
    });
});
