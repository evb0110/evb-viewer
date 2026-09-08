import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    BROWSER_RASTER_MAX_ICC_PROFILE_BYTES,
    readBrowserRasterImageMetadata,
    readBrowserTiffFrameDpi,
    resolveBrowserRasterIccProfile,
} from '@app/platform/browser-api/browserRasterImageMetadata';
import {
    assertBrowserCombinedPdfOutputBytes,
    assertBrowserCombinedPdfPageCount,
    consumeBrowserDecodedWorkingSet,
} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {
    probeBrowserImageFile,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
} from '@app/platform/browser-api/browserImageResourcePolicy';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

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

    it('enforces fallback page, output, and aggregate decoded-working-set limits', () => {
        expect(() => assertBrowserCombinedPdfPageCount(501)).toThrow('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
        expect(() => assertBrowserCombinedPdfOutputBytes(new Uint8Array())).toThrow('ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT');
        expect(() => assertBrowserCombinedPdfOutputBytes(new Uint8Array(BROWSER_MAX_FULL_READ_BYTES))).not.toThrow();
        expect(() => assertBrowserCombinedPdfOutputBytes(new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1)))
            .toThrow('ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT');
        try {
            assertBrowserCombinedPdfOutputBytes(new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1));
        } catch (error) {
            expect(error).toMatchObject({
                name: 'SerializableError',
                code: 'too-large',
                errorEnvelope: {code: 'too-large'},
            });
        }
        const budget = {
            usedBytes: 250,
            maxBytes: 300,
        };
        expect(() => consumeBrowserDecodedWorkingSet(budget, 4, 4, 'next.png'))
            .toThrow('ERR_BROWSER_PDF_COMBINE_DECODED_WORKING_SET_TOO_LARGE:next.png');
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
