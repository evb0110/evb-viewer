import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createTiffBytes} from '../pdf-core/createTiffBytes';

const mocks = vi.hoisted(() => {
    let headerPrefix: Uint8Array = new Uint8Array();
    const fileReads = {bytes: 0};
    const openFileClose = vi.fn();
    const openFileRead = vi.fn(async (buffer: Uint8Array, offset = 0, length = buffer.byteLength, position = 0) => {
        const chunk = headerPrefix.subarray(position, position + length);
        buffer.set(chunk, offset);
        fileReads.bytes += chunk.byteLength;
        return {bytesRead: chunk.byteLength};
    });
    const open = vi.fn(async () => ({
        read: openFileRead,
        close: openFileClose,
    }));
    const stat = vi.fn(async () => ({
        isFile: () => true,
        size: 1024,
    }));

    return {
        get headerPrefix() {
            return headerPrefix;
        },
        set headerPrefix(value: Uint8Array) {
            headerPrefix = value;
        },
        fileReads,
        open,
        openFileClose,
        openFileRead,
        stat,
    };
});

vi.mock('fs/promises', () => ({
    open: mocks.open,
    stat: mocks.stat,
}));

const {stageNativeCombineInputs} = await import('@electron/image/pdfCombineShared');
const {isNativePdfImageCombineBitmapPath} = await import('@electron/image/tryCreatePdfWithNativeImageCombiner');

describe('native combine input preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.headerPrefix = new Uint8Array();
        mocks.fileReads.bytes = 0;
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
    });

    it('stages image sets above 500 pages', async () => {
        const inputPaths = Array.from({length: 501}, (_, index) => `/tmp/page-${index}.jpg`);

        await expect(stageNativeCombineInputs(inputPaths)).resolves.toMatchObject({inputPaths});
    });

    it('rejects oversized inputs before invoking the native combiner', async () => {
        mocks.stat.mockResolvedValueOnce({
            isFile: () => true,
            size: 513 * 1024 * 1024,
        });

        await expect(stageNativeCombineInputs(['/tmp/huge.png'])).rejects.toThrow(
            'Input file is too large to combine safely: /tmp/huge.png',
        );

        expect(mocks.open).not.toHaveBeenCalled();
    });

    it.each(['/tmp/sample.bmp', '/tmp/sample.gif', '/tmp/sample.webp'])(
        'passes %s directly to the native Rust combiner without Electron/Skia normalization',
        async (sourcePath) => {
            expect(isNativePdfImageCombineBitmapPath(sourcePath)).toBe(true);
            const staged = await stageNativeCombineInputs([sourcePath]);
            expect(staged.inputPaths).toEqual([sourcePath]);
            expect(mocks.open).not.toHaveBeenCalled();
            await staged.cleanup();
        },
    );
});

describe('TIFF combine preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.fileReads.bytes = 0;
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: 1024,
        });
    });

    it.each([
        [
            'more frames than the TIFF frame cap',
            createTiffBytes(
                Array.from({length: 251}, () => ({
                    width: 10,
                    height: 10,
                })),
            ),
            'TIFF frame count is capped at 250: /tmp/scan.tif',
        ],
        [
            'a frame over the pixel cap',
            createTiffBytes([
                {
                    width: 10_000,
                    height: 9_000,
                },
            ]),
            'TIFF frame dimensions are too large to decode safely: /tmp/scan.tif',
        ],
        [
            'a page directory chain that loops',
            createTiffBytes(
                [
                    {
                        width: 10,
                        height: 10,
                    },
                    {
                        width: 10,
                        height: 10,
                    },
                ],
                {loopLastDirectoryToFirst: true},
            ),
            'TIFF page directory is damaged or truncated: /tmp/scan.tif',
        ],
        ['no image directory', createTiffBytes([{height: 10}]), 'No decodable TIFF pages found in /tmp/scan.tif'],
        ['bytes that are not a TIFF', new TextEncoder().encode('not a TIFF at all'), 'No decodable TIFF pages found in /tmp/scan.tif'],
    ])('refuses %s before staging', async (_case, bytes, message) => {
        mocks.headerPrefix = bytes;

        await expect(stageNativeCombineInputs(['/tmp/scan.tif'])).rejects.toThrow(message);
    });
});
