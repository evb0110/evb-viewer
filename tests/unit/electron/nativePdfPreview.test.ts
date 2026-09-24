import {
    describe,
    expect,
    it,
} from 'vitest';
import {requireEpochMs} from '@contracts/timestamps';
import {
    parsePdfOpeningGeometryMetadata,
    parseNativePdfPageLabelRanges,
} from '@electron/features/documents/main/nativePdfMetadata';

describe('native PDF metadata parsing', () => {
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

    it('parses normalized first-page geometry', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           431
Page    1 size:  612 x 792 pts (letter)
Page    1 rot:   -90
`, {
            size: 28_000_000,
            modifiedAt: requireEpochMs(1_720_000_000_000),
        })).toEqual({
            pageNumber: 1,
            pageCount: 431,
            width: 792,
            height: 612,
            rotation: 270,
            widestPageWidth: 792,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });
    });

    it('reports the widest displayed page so the opening skeleton uses the document-wide Fit Width', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           882
Page    1 size:  481.92 x 765.36 pts
Page    1 rot:   0
Page    2 size:  481.92 x 765.36 pts
Page    2 rot:   90
Page  135 size:  765.36 x 481.92 pts
Page  135 rot:   0
`, {
            size: 722_720_719,
            modifiedAt: requireEpochMs(1_720_000_000_000),
        })).toMatchObject({
            width: 481.92,
            height: 765.36,
            widestPageWidth: 765.36,
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
