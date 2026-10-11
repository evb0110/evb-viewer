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
