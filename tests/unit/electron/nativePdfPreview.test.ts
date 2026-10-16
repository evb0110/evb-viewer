import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    dirname, join,
} from 'node:path';
import {webContents} from 'electron';
import {markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {
    setWorkingCopyOriginalPath, forgetWorkingCopyOriginalPath,
} from '@electron/file-access/workingCopyStore';
import type * as TAppTempDir from '@electron/utils/appTempDir';
import {
    requirePageIndex, requirePageNumber,
} from '@contracts/pageNumbers';
import {requireEpochMs} from '@contracts/timestamps';
import {
    answerPdfPageShape,
    handlePdfOpeningGeometry,
    parseNativePdfPageLabelRanges,
} from '@electron/features/documents/main/nativePdfMetadata';
import { NativeProcessError } from '@electron/native-tools/processResult';
import { readNativePdfCatalogPart } from '@electron/features/page-ops/main/readNativePdfCatalog';

const mocks = vi.hoisted(() => ({
    resolveExistingReadablePdfPath: vi.fn(),
    resolveOriginalBackedReadTransport: vi.fn(),
    runNativeToolCommand: vi.fn(),
    readPdfNativePageGeometry: vi.fn(),
    appTempDir: '',
}));

vi.mock('@electron/pdf/pdfPageSizes', () => ({readPdfNativePageGeometry: mocks.readPdfNativePageGeometry}));
vi.mock('@electron/recentReadingViews', () => ({readRecentReadingViewOf: async () => null}));

vi.mock('@electron/utils/appTempDir', async importOriginal => ({
    ...(await importOriginal<typeof TAppTempDir>()),
    getAppTempDir: () => mocks.appTempDir,
}));
vi.mock('electron', () => ({
    app: {getPath: () => mocks.appTempDir},
    webContents: {fromId: () => ({id: 7})},
}));
vi.mock('@electron/features/page-ops/main/resolveNativePageOpsPath', () => ({resolveNativePageOpsPath: () => '/tools/evb-pdf-page-ops'}));
vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadablePdfPath: mocks.resolveExistingReadablePdfPath}));
vi.mock('@electron/features/documents/main/documentFileReadHandlers', () => ({resolveOriginalBackedReadTransport: mocks.resolveOriginalBackedReadTransport}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));
vi.mock('@electron/native-tools/buildPopplerEnv', () => ({buildPopplerEnv: () => undefined}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({
    pdfinfo: '/tools/pdfinfo',
    qpdf: '/tools/qpdf',
})}));

beforeEach(() => {
    mocks.readPdfNativePageGeometry.mockReset().mockRejectedValue(new Error('Exact native geometry unavailable'));
});

describe('native PDF metadata parsing', () => {
    it('converts bounded native catalog page-label ranges to renderer ranges', () => {
        expect(parseNativePdfPageLabelRanges([
            {
                pageIndex: 0,
                style: 'r',
            },
            {
                pageIndex: 2,
                prefix: 'Appendix ',
                start: 4,
            },
        ])).toEqual([
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

    it('reads one catalog part whatever happened to the other, and reports its own failure', async () => {
        mocks.runNativeToolCommand.mockResolvedValue({
            stderr: '{"level":"warning","event":"outline_action_not_kept"}\n',
            stdout: JSON.stringify({
                bookmarksError: 'PDF catalog /Outlines must be a dictionary',
                pageLabels: [{
                    pageIndex: 0,
                    style: 'r',
                }],
            }),
        });
        await expect(readNativePdfCatalogPart('/tools/evb-pdf-page-ops', '/tmp/a.pdf', 'pageLabels', {commandLabel: 'test'}))
            .resolves.toEqual([{
                pageIndex: 0,
                style: 'r',
            }]);
        await expect(readNativePdfCatalogPart('/tools/evb-pdf-page-ops', '/tmp/a.pdf', 'bookmarks', {commandLabel: 'test'}))
            .rejects.toThrow('PDF catalog /Outlines must be a dictionary');
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith('/tools/evb-pdf-page-ops', [
            'read-document-catalog',
            '--input',
            '/tmp/a.pdf',
            '--qpdf',
            '/tools/qpdf',
        ], expect.anything());
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
        pages: Array.from({length: 3}, (_, index) => ({
            pageNumber: requirePageNumber(index + 1, 3),
            xPoints: 0,
            yPoints: 0,
            widthPoints: width,
            heightPoints: 792,
            rotation: 0 as const,
            userUnit: 1,
        })),
        ...identity,
    });

    it('replaces a first-open shape without page metrics with a complete reopen shape', async () => {
        const path = '/books/first-open-then-reopen.pdf';
        await answerPdfPageShape(path, revision, async () => ({
            ...shapeAt(revision, 612),
            pages: null,
        }));

        await expect(answerPdfPageShape(path, revision, async () => shapeAt(revision, 500))).resolves.toMatchObject({
            width: 500,
            pages: [
                {widthPoints: 500},
                {widthPoints: 500},
                {widthPoints: 500},
            ],
        });
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

describe('complete PDF opening geometry', () => {
    it('leaves an original without a remembered view unshaped while admitted geometry is unavailable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'opening-original-'));
        const input = join(directory, 'original.pdf');
        await writeFile(input, '%PDF-1.7\n');
        mocks.resolveExistingReadablePdfPath.mockResolvedValue(input);
        mocks.resolveOriginalBackedReadTransport.mockReturnValue(null);
        mocks.readPdfNativePageGeometry.mockImplementation(() => new Promise(() => {}));
        try {
            await expect(handlePdfOpeningGeometry({senderId: 7}, input)).resolves.toBeNull();
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps complete geometry available to admit a materialized working copy', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'pdf-work-opening-'));
        const input = join(directory, 'document.pdf');
        await writeFile(input, '%PDF-1.7\n');
        await setWorkingCopyOriginalPath(input, '/books/original.pdf', 7, {deferOriginalFileExpectation: true});
        mocks.resolveExistingReadablePdfPath.mockResolvedValue(input);
        mocks.resolveOriginalBackedReadTransport.mockReturnValue(null);
        mocks.readPdfNativePageGeometry.mockResolvedValue(Array.from({length: 3}, (_, index) => ({
            pageNumber: index + 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
            userUnit: 1,
        })));
        try {
            const geometry = await handlePdfOpeningGeometry({senderId: 7}, input);
            expect(geometry).toMatchObject({
                pageCount: 3,
                width: 612,
            });
            expect(geometry?.pages).toHaveLength(3);
        } finally {
            forgetWorkingCopyOriginalPath(input);
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses exact deep-page crop, rotation and UserUnit to size a first-open skeleton', async () => {
        const pageCount = 21_601;
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/evb-working-copies/full-geometry.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue({
            identity: {
                size: 5_000_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: async <T>(read: (path: string) => Promise<T>) => read('/books/full-geometry.pdf'),
        });
        mocks.runNativeToolCommand.mockResolvedValue({stdout: `Pages: ${String(pageCount)}
Page 1 size: 600 x 780 pts
Page 1 rot: 0`});
        mocks.readPdfNativePageGeometry.mockResolvedValue(Array.from({length: pageCount}, (_, index) => ({
            pageNumber: index + 1,
            xPoints: 12,
            yPoints: 24,
            widthPoints: index === 10_800 ? 880 : index === pageCount - 1 ? 720 : 600,
            heightPoints: index === 10_800 ? 580 : 780,
            rotation: index === 10_800 ? 90 : 0,
            userUnit: index === 10_800 ? 1.25 : 1,
        })));

        const geometry = await handlePdfOpeningGeometry({senderId: 7}, '/books/full-geometry.pdf');

        expect(geometry).toMatchObject({
            pageNumber: 1,
            pageCount,
            width: 600,
            height: 780,
            widestPageWidth: 725,
            tallestPageHeight: 1100,
        });
        expect(geometry?.pages).toHaveLength(pageCount);
        expect(geometry?.pages?.[10_800]).toMatchObject({
            widthPoints: 880,
            heightPoints: 580,
            rotation: 90,
            userUnit: 1.25,
        });
    });

    it('leaves repairable native-reader failures to the loaded renderer without an uncertain shape', async () => {
        mocks.resolveExistingReadablePdfPath.mockResolvedValue('/tmp/evb-working-copies/recovered.pdf');
        mocks.resolveOriginalBackedReadTransport.mockReturnValue({
            identity: {
                size: 3_000,
                modifiedAt: 1_720_000_000_000,
            },
            read: async <T>(read: (path: string) => Promise<T>) => read('/books/recovered.pdf'),
        });
        mocks.runNativeToolCommand.mockResolvedValue({stdout: `Pages: 3
Page 1 size: 612 x 792 pts
Page 1 rot: 0`});

        await expect(handlePdfOpeningGeometry({senderId: 7}, '/books/recovered.pdf')).resolves.toBeNull();
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
        mocks.readPdfNativePageGeometry.mockResolvedValue(Array.from({length: 3}, (_, index) => ({
            pageNumber: index + 1,
            xPoints: 0,
            yPoints: 0,
            widthPoints: 612,
            heightPoints: 792,
            rotation: 0,
            userUnit: 1,
        })));
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


describe('native text-box appearance scratch ownership', () => {
    const request = {
        page: {
            view: [
                0,
                0,
                200,
                100,
            ] as [number, number, number, number],
            rotation: 0 as const,
            userUnit: 1,
        },
        textBoxes: [{textBox: {
            pageIndex: requirePageIndex(0),
            stableKey: 'preview',
            text: 'Text',
            rect: [
                10,
                20,
                100,
                60,
            ] as [number, number, number, number],
            rotation: 0 as const,
            fontSize: 18,
            color: [
                0,
                0,
                0,
            ] as [number, number, number],
        }}],
    };

    it.each([
        false,
        true,
    ])('keeps bytes only while native termination is unproven: %s', async (unproven) => {
        mocks.appTempDir = await mkdtemp(join(tmpdir(), 'appearance-scratch-test-'));
        const workingPath = join(mocks.appTempDir, 'managed-copy.pdf');
        await setWorkingCopyOriginalPath(workingPath, '/original.pdf', 7, {
            backingState: 'lazy-original',
            deferOriginalFileExpectation: true,
        });
        let input = '';
        const failure = new Error('Native appearance failed');
        if (unproven) markUnprovenNativeTermination(failure, 'writer remains unconfirmed');
        mocks.runNativeToolCommand.mockImplementationOnce(async (_binary: string, args: string[]) => {
            input = args[args.indexOf('--input') + 1]!;
            throw failure;
        });
        try {
            const {pageOpsMainBindings} = await import('@electron/features/page-ops/main/pageOpsMainBindings');
            await expect(pageOpsMainBindings.renderTextBoxAppearance({
                senderId: 7,
                sender: webContents.fromId(7)!,
            }, workingPath, request)).rejects.toBe(failure);
            expect(dirname(dirname(input))).toBe(mocks.appTempDir);
            const directories = await readdir(mocks.appTempDir);
            expect(directories.length).toBe(unproven ? 1 : 0);
            if (unproven) {
                expect(JSON.parse(await readFile(input, 'utf8'))).toEqual(request);
                expect(JSON.parse(await readFile(join(dirname(input), '.evb-managed-scratch.json'), 'utf8'))).toMatchObject({prefix: 'pdf-page-ops-'});
            }
        } finally {
            forgetWorkingCopyOriginalPath(workingPath);
            await rm(mocks.appTempDir, {
                recursive: true,
                force: true,
            });
        }
    });
});
