import {describe, expect, it} from 'vitest';
import {readImageDpi, readJpegExifOrientation, readTiffFrameDpi} from '@electron/image/imageDpi';

function bytes(values: number[]) {
    return new Uint8Array(values);
}

function u16be(value: number) {
    return [(value >>> 8) & 0xff, value & 0xff];
}

function u32be(value: number) {
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function pngWithPhys(pixelsPerMeter: number, unit: number) {
    return bytes([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...u32be(9),
        0x70,
        0x48,
        0x59,
        0x73,
        ...u32be(pixelsPerMeter),
        ...u32be(pixelsPerMeter),
        unit,
        0x00,
        0x00,
        0x00,
        0x00,
    ]);
}

function jpegWithJfif(units: number, xDensity: number, yDensity: number) {
    return bytes([
        0xff,
        0xd8,
        0xff,
        0xe0,
        ...u16be(16),
        0x4a,
        0x46,
        0x49,
        0x46,
        0x00,
        0x01,
        0x02,
        units,
        ...u16be(xDensity),
        ...u16be(yDensity),
        0x00,
        0x00,
        0xff,
        0xda,
    ]);
}

describe('readImageDpi', () => {
    it('reads PNG pHYs pixels-per-meter density', () => {
        expect(readImageDpi(pngWithPhys(11811, 1), '.png')).toBe(300);
    });

    it('falls back for PNG pHYs without meter units', () => {
        expect(readImageDpi(pngWithPhys(11811, 0), '.png')).toBe(72);
    });

    it('reads JPEG JFIF inch density', () => {
        expect(readImageDpi(jpegWithJfif(1, 96, 144), '.jpg')).toBe(144);
    });

    it('reads JPEG JFIF centimeter density', () => {
        expect(readImageDpi(jpegWithJfif(2, 118, 118), '.jpeg')).toBe(300);
    });

    it('falls back for truncated PNG and JPEG data', () => {
        expect(readImageDpi(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(9), 0x70, 0x48, 0x59]), '.png')).toBe(72);
        expect(readImageDpi(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00]), '.jpg')).toBe(72);
    });
});

describe('readTiffFrameDpi', () => {
    it('extracts TIFF inch and centimeter resolution tags', () => {
        expect(
            readTiffFrameDpi({
                t282: [600, 2],
                t296: 2,
            }),
        ).toBe(300);
        expect(
            readTiffFrameDpi({
                t283: 118,
                t296: [3],
            }),
        ).toBe(300);
    });

    it('returns null for invalid TIFF resolution values', () => {
        expect(
            readTiffFrameDpi({
                t282: [0, 1],
                t283: [10, 0],
                t296: 1,
            }),
        ).toBeNull();
    });
});

describe('readJpegExifOrientation', () => {
    it.each([2, 3, 4, 5, 6, 7, 8] as const)('reads orientation %i from a little-endian EXIF IFD', (orientation) => {
        const jpeg = bytes([
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
            0xda,
        ]);
        expect(readJpegExifOrientation(jpeg)).toBe(orientation);
    });
});
