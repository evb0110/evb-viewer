import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    BROWSER_RASTER_MAX_ICC_PROFILE_BYTES,
    readBrowserRasterImageMetadata,
    readBrowserTiffFrameDpi,
    resolveBrowserRasterIccProfile,
} from '@app/platform/browser-api/browserRasterImageMetadata';
import {assertBrowserCombinedPdfOutputBytes} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    probeBrowserImageFile,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
} from '@app/platform/browser-api/browserImageResourcePolicy';

function jpegWithExifOrientation(orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) {
    return new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xe1,
        0x00,
        0x22,
        0x45,
        0x78,
        0x69,
        0x66,
        0x00,
        0x00,
        0x49,
        0x49,
        0x2a,
        0x00,
        0x08,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x12,
        0x01,
        0x03,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00,
        orientation,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        0x04,
        0xb0,
        0x03,
        0x20,
        0x03,
        0x01,
        0x11,
        0x00,
        0x02,
        0x11,
        0x00,
        0x03,
        0x11,
        0x00,
        0xff,
        0xda,
    ]);
}

describe('browserRasterImageMetadata', () => {
    it.each([
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
    ] as const)('reads JPEG EXIF orientation %i before decode', async (orientation) => {
        expect(readBrowserRasterImageMetadata(jpegWithExifOrientation(orientation), '.jpg')).toMatchObject({
            width: 800,
            height: 1200,
            orientation,
        });
        const file = new File([jpegWithExifOrientation(orientation)], 'oriented.jpg', {type: 'image/jpeg'});
        const probed = await probeBrowserImageFile(file, PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS);
        expect(probed.width).toBe(orientation >= 5 ? 1200 : 800);
        expect(probed.height).toBe(orientation >= 5 ? 800 : 1200);
        expect(probed.orientation ?? 1).toBe(orientation);
    });

    it('reads WebP extended canvas dimensions before decode', () => {
        const bytes = new Uint8Array(30);
        bytes.set(new TextEncoder().encode('RIFF'), 0);
        bytes.set(new TextEncoder().encode('WEBP'), 8);
        bytes.set(new TextEncoder().encode('VP8X'), 12);
        bytes.set([
            0xff,
            0x03,
            0x00,
        ], 24);
        bytes.set([
            0xff,
            0x01,
            0x00,
        ], 27);
        expect(readBrowserRasterImageMetadata(bytes, '.webp')).toMatchObject({
            width: 1024,
            height: 512,
        });
    });

    it('reads rational TIFF resolution values and centimeter units', () => {
        expect(readBrowserTiffFrameDpi({
            t282: [
                300,
                2,
            ],
            t283: [[
                600,
                4,
            ]],
            t296: 3,
        })).toBe(381);
    });

    it('checks nonempty output', () => {
        expect(() => assertBrowserCombinedPdfOutputBytes(new Uint8Array())).toThrow('ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT');
        expect(() => assertBrowserCombinedPdfOutputBytes(new Uint8Array(16 * 1024 * 1024 + 1))).not.toThrow();
    });

    it('rejects a direct ICC profile before downstream embedding when it exceeds the limit', async () => {
        await expect(resolveBrowserRasterIccProfile({
            width: 1,
            height: 1,
            dpi: 72,
            orientation: 1,
            iccProfile: new Uint8Array(BROWSER_RASTER_MAX_ICC_PROFILE_BYTES + 1),
        })).rejects.toThrow('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
    });
});


describe('browser image export DPI planning', () => {
    it('samples source DPI within the selected pages and guards even unprobed page dimensions', async () => {
        const {
            createCanvas, DOMMatrix, ImageData, Path2D,
        } = await import('@napi-rs/canvas');
        vi.stubGlobal('DOMMatrix', DOMMatrix);
        vi.stubGlobal('ImageData', ImageData);
        vi.stubGlobal('Path2D', Path2D);
        const {PDFDocument} = await import('pdf-lib');
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const {browserImageExportConfig} = await import('@app/platform/browser-api/browserImageExportConfig');
        const pdf = await PDFDocument.create();
        const scan = createCanvas(96, 144);
        scan.getContext('2d').fillRect(0, 0, scan.width, scan.height);
        const image = await pdf.embedPng(scan.toBuffer('image/png'));
        for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
            const page = pdf.addPage(pageNumber === 8 ? [
                10000,
                72,
            ] : [
                72,
                108,
            ]);
            if (pageNumber !== 8) {
                // Page 3 is outside the eight evenly spread full-document probes.
                const width = pageNumber === 3 ? 5.76 : 72;
                page.drawImage(image, {
                    x: 0,
                    y: 0,
                    width,
                    height: width * 1.5,
                });
            }
        }
        const task = pdfjs.getDocument({data: await pdf.save()});
        try {
            const document = await task.promise;
            expect(await browserImageExportConfig(document, [
                1,
                2,
                3,
                4,
                5,
                6,
                7,
                8,
                9,
                10,
            ])).toBe(58);
            expect(await browserImageExportConfig(document, [
                1,
                2,
                4,
                5,
                6,
                7,
                9,
                10,
            ])).toBe(96);
            expect(await browserImageExportConfig(document, [3])).toBe(1200);
        } finally {
            await task.destroy();
            vi.unstubAllGlobals();
        }
    });
});
