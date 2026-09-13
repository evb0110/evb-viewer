import {
    describe,
    expect,
    it,
} from 'vitest';
import {requireEpochMs} from '@contracts/timestamps';
import {
    PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT,
    parsePdfInfoPageSizes,
    parsePdfOpeningGeometryMetadata,
    parseNativePdfPageLabelRanges,
    readJpegDimensions,
} from '@electron/features/documents/main/nativePdfPreview';

describe('native PDF preview metadata parsing', () => {
    it('converts bounded native catalog page-label ranges to renderer ranges', () => {
        expect(parseNativePdfPageLabelRanges({pageLabels: [
            {
                pageIndex: 0,
                style: 'r',
            },
            {
                pageIndex: 2,
                prefix: 'Appendix ',
                start: 4,
            },
        ]})).toEqual([
            {
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 3,
                style: null,
                prefix: 'Appendix ',
                startNumber: 4,
            },
        ]);
    });

    it('reads dimensions from the final JPEG raster', () => {
        const bytes = Uint8Array.of(
            0xff, 0xd8,
            0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
            0xff, 0xc2, 0x00, 0x0b, 0x08, 0x04, 0x38, 0x07, 0x80, 0x01, 0x01, 0x11, 0x00,
            0xff, 0xd9,
        );

        expect(readJpegDimensions(bytes)).toEqual({
            width: 1_920,
            height: 1_080,
        });
    });

    it('rejects a malformed native preview JPEG', () => {
        expect(() => readJpegDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)))
            .toThrow('invalid JPEG');
    });

    it('parses per-page sizes from pdfinfo -box output', () => {
        expect(parsePdfInfoPageSizes(`
Pages:           3
Page    1 size:  595.32 x 838.68 pts
Page    2 size:  595.32 x 838.68 pts
Page    3 size:  595.32 x 820.32 pts
`, 3, null)).toEqual([
            {
                width: 595.32,
                height: 838.68,
            },
            {
                width: 595.32,
                height: 838.68,
            },
            {
                width: 595.32,
                height: 820.32,
            },
        ]);
    });

    it('fills missing page sizes with the default size', () => {
        expect(parsePdfInfoPageSizes(`
Pages:           3
Page size:       612 x 792 pts (letter)
Page    2 size:  400 x 500 pts
`, 3, {
            width: 612,
            height: 792,
        })).toEqual([
            {
                width: 612,
                height: 792,
            },
            {
                width: 400,
                height: 500,
            },
            {
                width: 612,
                height: 792,
            },
        ]);
    });

    it('keeps large page-size metadata compact instead of allocating one entry per page', () => {
        const result = parsePdfInfoPageSizes(`
Pages:           100001
Page size:       612 x 792 pts (letter)
Page    100000 size:  400 x 500 pts
`, 100_001, {
            width: 612,
            height: 792,
        });

        expect(Array.isArray(result)).toBe(false);
        expect(result).toEqual({
            pageCount: 100_001,
            defaultPageSize: {
                width: 612,
                height: 792,
            },
            overrides: [{
                pageNumber: 100_000,
                width: 400,
                height: 500,
            }],
        });
    });

    it('gates the dense compatibility array at the documented page-count limit', () => {
        const dense = parsePdfInfoPageSizes(
            `Pages: ${String(PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT)}\nPage size: 612 x 792 pts (letter)`,
            PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT,
            {
                width: 612,
                height: 792,
            },
        );
        const compact = parsePdfInfoPageSizes(
            `Pages: ${String(PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT + 1)}\nPage size: 612 x 792 pts (letter)`,
            PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT + 1,
            {
                width: 612,
                height: 792,
            },
        );

        expect(dense).toHaveLength(PDFINFO_SMALL_PAGE_SIZE_ARRAY_LIMIT);
        expect(Array.isArray(compact)).toBe(false);
    });

    it('accepts a very large safe-integer page count without materializing page sizes', () => {
        const pageCount = Number.MAX_SAFE_INTEGER;

        const result = parsePdfInfoPageSizes(`
Pages:           ${String(pageCount)}
Page size:       612 x 792 pts (letter)
`, pageCount, {
            width: 612,
            height: 792,
        });

        expect(Array.isArray(result)).toBe(false);
        expect(result).toEqual({
            pageCount,
            defaultPageSize: {
                width: 612,
                height: 792,
            },
            overrides: [],
        });
    });

    it('parses normalized first-page geometry without allocating all page sizes', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           431
Optimized:       no
Page    1 size:  612 x 792 pts (letter)
Page    1 rot:   -90
`, {
            size: 28_000_000,
            modifiedAt: requireEpochMs(1_720_000_000_000),
        })).toEqual({
            pageNumber: 1,
            pageCount: 431,
            width: 612,
            height: 792,
            rotation: 270,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
            linearized: false,
        });
    });

    it('accepts the largest safe-integer page count in opening geometry metadata', () => {
        const pageCount = Number.MAX_SAFE_INTEGER;

        expect(parsePdfOpeningGeometryMetadata(`
Pages:           ${String(pageCount)}
Page    1 size:  612 x 792 pts (letter)
`, {
            size: 1,
            modifiedAt: requireEpochMs(0),
        })).toMatchObject({
            pageCount,
            width: 612,
            height: 792,
        });
    });
});
