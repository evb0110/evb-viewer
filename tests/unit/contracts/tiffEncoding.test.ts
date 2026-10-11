import {
    describe,
    expect,
    it,
} from 'vitest';
import * as utifModule from 'utif';
import {
    buildTiffImageIfd,
    encodeTiffIfds,
} from '@pdf-core';
import {
    encode as encodePng, decode as decodePng,
} from 'fast-png';
import {addPngPhysicalResolution} from '@pdf-core/addPngPhysicalResolution';
import {addJpegJfifDensity} from '@pdf-core/addJpegJfifDensity';

interface IUtifEncoderModule {
    _binBE: {
        writeUint(buffer: Uint8Array, offset: number, value: number): void;
        writeUshort(buffer: Uint8Array, offset: number, value: number): void;
    };
    _writeIFD(
        bin: IUtifEncoderModule['_binBE'],
        data: Uint8Array,
        offset: number,
        ifd: Record<string, unknown>,
    ): [number, number];
    ttypes: Record<number, number | undefined>;
}

const UTIF = utifModule as typeof utifModule & IUtifEncoderModule;

describe('tiff encoding helpers', () => {
    it('encodes a multi-page TIFF header', () => {
        const ifds = [
            buildTiffImageIfd({
                width: 1,
                height: 1,
                dataLength: 4,
            }, 8),
            buildTiffImageIfd({
                width: 2,
                height: 1,
                dataLength: 8,
            }, 12),
        ];

        const bytes = encodeTiffIfds(ifds, UTIF);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const firstIfdOffset = view.getUint32(4, false);
        const firstIfdEntryCount = view.getUint16(firstIfdOffset, false);
        const firstNextIfdOffset = view.getUint32(
            firstIfdOffset + 2 + (firstIfdEntryCount * 12),
            false,
        );
        const secondIfdEntryCount = view.getUint16(firstNextIfdOffset, false);
        const secondNextIfdOffset = view.getUint32(
            firstNextIfdOffset + 2 + (secondIfdEntryCount * 12),
            false,
        );

        expect(bytes[0]).toBe(77);
        expect(bytes[1]).toBe(77);
        expect(firstIfdOffset).toBeGreaterThan(0);
        expect(firstIfdEntryCount).toBeGreaterThan(0);
        expect(firstNextIfdOffset).toBeGreaterThan(firstIfdOffset);
        expect(secondIfdEntryCount).toBeGreaterThan(0);
        expect(secondNextIfdOffset).toBe(0);
    });

    it('writes each page density into its resolution tags', () => {
        const ifds = [
            buildTiffImageIfd({
                width: 1,
                height: 1,
                dataLength: 4,
                dpiX: 300,
                dpiY: 150,
            }, 8),
            buildTiffImageIfd({
                width: 2,
                height: 1,
                dataLength: 8,
            }, 12),
        ];

        const frames = UTIF.decode(encodeTiffIfds(ifds, UTIF));

        // ResolutionUnit 2 is inches; a page without a density keeps the 72 DPI default.
        expect(frames.map(frame => [
            frame.t282,
            frame.t283,
            frame.t296,
        ])).toEqual([
            [
                [300],
                [150],
                [2],
            ],
            [
                [72],
                [72],
                [2],
            ],
        ]);
    });

});

describe('JFIF density helper', () => {
    // SOI, then an APP0 "JFIF\0" segment with units 0 and 1x1 densities, then EOI.
    const jfifJpeg = Uint8Array.of(
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10,
        0x4a, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00,
        0x00, 0x01,
        0x00, 0x01,
        0x00, 0x00,
        0xff, 0xd9,
    );

    it('records a valid density in units of dots per inch', () => {
        const output = addJpegJfifDensity(jfifJpeg, 300);

        // Units 1 is dots per inch; the X and Y densities follow as big-endian 16-bit values.
        expect(Array.from(output.subarray(13, 18))).toEqual([
            1,
            0x01,
            0x2c,
            0x01,
            0x2c,
        ]);
    });

    // An APP1 Exif segment in place of the APP0 JFIF segment, then EOI.
    const exifJpeg = Uint8Array.of(
        0xff, 0xd8,
        0xff, 0xe1, 0x00, 0x10,
        0x45, 0x78, 0x69, 0x66, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xff, 0xd9,
    );
    const pngBytes = Uint8Array.of(
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
    );

    it.each([
        [
            'an APP1 Exif header',
            exifJpeg,
        ],
        [
            'a PNG signature',
            pngBytes,
        ],
        [
            'a header shorter than the density fields',
            jfifJpeg.subarray(0, 17),
        ],
    ])('returns %s unchanged even with a valid density', (_label, input) => {
        expect(addJpegJfifDensity(input, 300)).toEqual(input);
    });

    it.each([
        0,
        -300,
        Number.NaN,
        Number.POSITIVE_INFINITY,
    ])('ignores the invalid density %s and returns the JFIF bytes unchanged', (dpi) => {
        expect(addJpegJfifDensity(jfifJpeg, dpi)).toEqual(jfifJpeg);
    });
});

describe('PNG density', () => {
    it.each([
        false,
        true,
    ])('writes one density before image data, replacing existing density (%s)', (existing) => {
        const encoded = encodePng({
            width: 1,
            height: 1,
            channels: 3,
            data: Uint8Array.of(17, 33, 55),

        });
        // fast-png encodes no pHYs; insert a valid 96 DPI chunk after IHDR.
        const density = Uint8Array.of(
            0x00, 0x00, 0x00, 0x09, 0x70, 0x48, 0x59,
            0x73, 0x00, 0x00, 0x0e, 0xc4, 0x00, 0x00,
            0x0e, 0xc4, 0x01, 0x95, 0x2b, 0x0e, 0x1b,
        );
        const png = existing
            ? Uint8Array.from([
                ...encoded.subarray(0, 33),
                ...density,
                ...encoded.subarray(33),
            ])
            : encoded;
        expect(decodePng(png).resolution?.x).toBe(existing ? 3780 : undefined);
        const bytes = addPngPhysicalResolution(png, 300);
        const chunks: string[] = [];
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let offset = 8; offset < bytes.byteLength; offset += view.getUint32(offset) + 12) {
            chunks.push(String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)));
        }
        expect(chunks.filter(type => type === 'pHYs')).toHaveLength(1);
        expect(chunks.indexOf('pHYs')).toBeLessThan(chunks.indexOf('IDAT'));
        const decoded = decodePng(bytes);
        expect(decoded.resolution).toEqual({
            x: 11811,
            y: 11811,
            unit: 1,
        });
        expect(Array.from(decoded.data)).toEqual([
            17,
            33,
            55,
        ]);
    });
});
