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
    handlePdfOpeningGeometry,
    parsePdfOpeningGeometryMetadata,
    parseNativePdfPageLabelRanges,
} from '@electron/features/documents/main/nativePdfMetadata';
import { NativeProcessError } from '@electron/native-tools/processResult';

const mocks = vi.hoisted(() => ({
    resolveExistingReadablePdfPath: vi.fn(),
    resolveOriginalBackedReadTransport: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadablePdfPath: mocks.resolveExistingReadablePdfPath}));
vi.mock('@electron/features/documents/main/documentFileReadHandlers', () => ({resolveOriginalBackedReadTransport: mocks.resolveOriginalBackedReadTransport}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({pdfinfo: '/tools/pdfinfo'})}));

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
            tallestPageHeight: 612,
            size: 28_000_000,
            modifiedAt: 1_720_000_000_000,
        });
    });

    it('reads the shape of the page an open starts at, keeping the document-wide widest page', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           40
Page    1 size:  612 x 792 pts (letter)
Page    4 size:  500 x 700 pts
Page    4 rot:   90
Page    9 size:  900 x 792 pts
`, {
            size: 1,
            modifiedAt: requireEpochMs(0),
        }, 4)).toMatchObject({
            pageNumber: 4,
            width: 700,
            height: 500,
            rotation: 90,
            widestPageWidth: 900,
            tallestPageHeight: 792,
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
            tallestPageHeight: 765.36,
        });
    });

    it('reports the tallest displayed page from another page, after its own rotation', () => {
        expect(parsePdfOpeningGeometryMetadata(`
Pages:           3
Page    1 size:  612 x 900 pts
Page    2 size:  612 x 792 pts
Page    2 rot:   90
Page    3 size:  612 x 820 pts
Page    3 rot:   0
`, {
            size: 1,
            modifiedAt: requireEpochMs(0),
        }, 3)).toMatchObject({
            width: 612,
            height: 820,
            widestPageWidth: 792,
            tallestPageHeight: 900,
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
        tallestPageHeight: 792,
        ...identity,
    });

    it('answers a file it has read from memory while the file is unchanged', async () => {
        const read = vi.fn(async () => shapeAt(revision, 612));

        await expect(answerPdfPageShape('/books/unchanged.pdf', revision, read)).resolves.toMatchObject({width: 612});
        await expect(answerPdfPageShape('/books/unchanged.pdf', revision, read)).resolves.toMatchObject({width: 612});

        expect(read).toHaveBeenCalledTimes(1);
    });

    it('reads again when an open needs another page\'s shape of an unchanged file', async () => {
        await answerPdfPageShape('/books/reread.pdf', revision, async () => shapeAt(revision, 612));

        await expect(answerPdfPageShape('/books/reread.pdf', revision, async () => ({
            ...shapeAt(revision, 500),
            pageNumber: requirePageNumber(3),
        }), 3)).resolves.toMatchObject({
            pageNumber: 3,
            width: 500,
        });
    });

    it('evicts the file read longest ago, not the one answered most', async () => {
        const hot = '/books/hot.pdf';
        await answerPdfPageShape(hot, revision, async () => shapeAt(revision, 612));
        for (let index = 0; index < 255; index += 1) {
            await answerPdfPageShape(`/books/fill-${String(index)}.pdf`, revision, async () => shapeAt(revision, 612));
        }
        await answerPdfPageShape(hot, revision, async () => shapeAt(revision, 700));
        await answerPdfPageShape('/books/one-more.pdf', revision, async () => shapeAt(revision, 612));
        const reread = vi.fn(async () => shapeAt(revision, 800));

        await expect(answerPdfPageShape(hot, revision, reread)).resolves.toMatchObject({width: 612});
        expect(reread).not.toHaveBeenCalled();
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

describe('PDF opening geometry of a working copy that reads its original', () => {
    it('does not answer a changed original with the shape read before the change', async () => {
        // Opening a file that is already open resolves to that open's lazy
        // working copy, whose admission identity stays the same however the
        // original changes; only the checked original backing can tell.
        let originalChanged = false;
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/evb-working-copies/lazy-open.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue({
            identity: {
                size: 2_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: async <T>(reader: (physicalPath: string) => Promise<T>) => {
                if (originalChanged) {
                    throw Object.assign(new Error('The original document changed after it was opened'), {code: 'SOURCE_BACKING_CHANGED'});
                }
                return reader('/books/open-twice.pdf');
            },
        });
        mocks.runNativeToolCommand.mockResolvedValue({stdout: `
Pages:           3
Page    1 size:  612 x 792 pts (letter)
Page    1 rot:   0
`});

        await expect(handlePdfOpeningGeometry({senderId: 7}, '/books/open-twice.pdf')).resolves.toMatchObject({width: 612});
        originalChanged = true;

        await expect(handlePdfOpeningGeometry({senderId: 7}, '/books/open-twice.pdf'))
            .rejects.toMatchObject({code: 'SOURCE_BACKING_CHANGED'});
    });
});

describe('PDF opening geometry of an encrypted PDF before its password', () => {
    function pdfinfoFailure(stderr: string) {
        return new NativeProcessError('exit-code', 1, null, `pdfinfo-opening-geometry failed with exit code 1. ${stderr}`);
    }

    it('answers no geometry when pdfinfo needs the password', async () => {
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/evb-working-copies/locked.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue({
            identity: {
                size: 3_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: async <T>(reader: (physicalPath: string) => Promise<T>) => reader('/books/locked.pdf'),
        });
        mocks.runNativeToolCommand.mockRejectedValue(pdfinfoFailure('Command Line Error: Incorrect password'));

        await expect(handlePdfOpeningGeometry({senderId: 7}, '/books/locked.pdf')).resolves.toBeNull();
    });

    it('still rejects a malformed PDF', async () => {
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/evb-working-copies/broken.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue({
            identity: {
                size: 3_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: async <T>(reader: (physicalPath: string) => Promise<T>) => reader('/books/broken.pdf'),
        });
        mocks.runNativeToolCommand.mockRejectedValue(pdfinfoFailure('Syntax Error: Couldn\'t find trailer dictionary'));

        await expect(handlePdfOpeningGeometry({senderId: 7}, '/books/broken.pdf'))
            .rejects.toBeInstanceOf(NativeProcessError);
    });
});
