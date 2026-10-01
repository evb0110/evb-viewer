import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireEpochMs} from '@contracts/timestamps';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    answerPdfPageShape,
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

describe('PDF page-shape store', () => {
    const revision = {
        size: 1_000,
        modifiedAt: requireEpochMs(1_720_000_000_000),
    };
    const shapeAt = (identity: typeof revision, width: number) => ({
        pageNumber: requirePageNumber(1),
        pageCount: 3,
        width,
        height: 792,
        rotation: 0 as const,
        widestPageWidth: width,
        ...identity,
    });

    it('answers a file it has read from memory while the file is unchanged', async () => {
        const read = vi.fn(async () => shapeAt(revision, 612));

        await expect(answerPdfPageShape('/books/unchanged.pdf', revision, read)).resolves.toMatchObject({width: 612});
        await expect(answerPdfPageShape('/books/unchanged.pdf', revision, read)).resolves.toMatchObject({width: 612});

        expect(read).toHaveBeenCalledTimes(1);
    });

    it.each([
        [
            'size',
            {
                ...revision,
                size: 1_001,
            },
        ],
        [
            'modification time',
            {
                ...revision,
                modifiedAt: requireEpochMs(1_720_000_000_001),
            },
        ],
    ])('reads the file again once its %s changes', async (_change, changed) => {
        const path = `/books/changed-${String(changed.size)}-${String(changed.modifiedAt)}.pdf`;
        await answerPdfPageShape(path, revision, async () => shapeAt(revision, 612));
        const reread = vi.fn(async () => shapeAt(changed, 842));

        await expect(answerPdfPageShape(path, changed, reread)).resolves.toMatchObject({width: 842});
        // The new revision replaces the old one.
        await expect(answerPdfPageShape(path, changed, reread)).resolves.toMatchObject({width: 842});

        expect(reread).toHaveBeenCalledTimes(1);
    });
});
