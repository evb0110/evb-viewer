import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    renderPdfDocumentPagesForBrowserPrint,
    renderPdfPagesForBrowserPrint,
    shouldPrintPageMetricsDirectly,
} from '@app/utils/pdfPrint';
import {
    buildBrowserPrintFrameMarkup,
    parsePrintPageRangeInput,
    parsePrintPageRangeSelectionInput,
    type IBrowserPrintDocument,
} from '@app/utils/pdfPrintShared';

const pdfjsModule = vi.hoisted((): {
    version: string;
    GlobalWorkerOptions: { workerSrc?: string; };
    PDFDataRangeTransport: () => void;
    VerbosityLevel: { ERRORS: number; };
    getDocument: ReturnType<typeof vi.fn>;
} => ({
    version: '6.3.311',
    GlobalWorkerOptions: {},
    PDFDataRangeTransport: function MockPdfDataRangeTransport() {},
    VerbosityLevel: { ERRORS: 0 },
    getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);

describe('pdfPrint', () => {
    beforeEach(() => {
        delete (pdfjsModule.GlobalWorkerOptions as Partial<typeof pdfjsModule.GlobalWorkerOptions>).workerSrc;
        pdfjsModule.getDocument.mockReset();
    });

    it('parses comma-separated page ranges into unique sorted page numbers', () => {
        expect(parsePrintPageRangeInput('1-3, 7, 10-12, 3', 12)).toEqual([
            1,
            2,
            3,
            7,
            10,
            11,
            12,
        ]);
    });

    it('keeps a million-page print range compact', () => {
        expect(parsePrintPageRangeSelectionInput('1-1000000', 1_000_000)).toEqual({
            kind: 'range',
            pageCount: 1_000_000,
            startPage: 1,
            endPage: 1_000_000,
        });
    });

    it('rejects invalid page ranges', () => {
        expect(parsePrintPageRangeInput('0-3', 12)).toBeNull();
        expect(parsePrintPageRangeInput('4-20', 12)).toBeNull();
        expect(parsePrintPageRangeInput('2,a', 12)).toBeNull();
    });

    it('can decide direct-print safety from loaded page metrics without reparsing the PDF', () => {
        expect(shouldPrintPageMetricsDirectly([{
            width: 612,
            height: 792,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(true);

        expect(shouldPrintPageMetricsDirectly([{
            width: 734.4,
            height: 1113.12,
        }], {
            viewMode: 'single',
            orientation: 'auto',
        })).toBe(false);
    });

    it('renders one browser-print page per PDF page into the print document', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const firstCanvas = {
            height: 0,
            width: 0,
            style: {},
            getContext: vi.fn(),
        };
        const secondCanvas = {
            height: 0,
            width: 0,
            style: {},
            getContext: vi.fn(),
        };
        firstCanvas.getContext.mockReturnValue({ canvas: firstCanvas });
        secondCanvas.getContext.mockReturnValue({ canvas: secondCanvas });
        const createdSections: Array<{
            append: ReturnType<typeof vi.fn>;
            className: string;
            style: Record<string, string>;
        }> = [];
        const head = {appendChild: vi.fn()};
        const createdCanvases = [
            firstCanvas,
            secondCanvas,
        ];
        function createElement(tag: 'canvas' | 'section' | 'style') {
            if (tag === 'style') {
                return { textContent: '' };
            }

            if (tag === 'section') {
                const section = {
                    append: vi.fn(),
                    className: '',
                    style: {},
                };
                createdSections.push(section);
                return section;
            }

            const canvas = createdCanvases.shift();
            if (!canvas) {
                throw new Error('Unexpected extra canvas');
            }
            return canvas;
        }

        const targetDocument = {
            createElement,
            head,
            querySelector: () => root,
        } as IBrowserPrintDocument & { head: typeof head };
        const firstPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 100,
                    height: 200,
                }
                : {
                    width: 416.6666666666667,
                    height: 833.3333333333334,
                }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const secondPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 100,
                    height: 200,
                }
                : {
                    width: 416.6666666666667,
                    height: 833.3333333333334,
                }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const loadingTaskDestroy = vi.fn(async () => {});
        const pdfDocumentDestroy = vi.fn(async () => {});
        const getPage = vi.fn(async (pageNumber: number) => pageNumber === 1 ? firstPage : secondPage);
        pdfjsModule.getDocument.mockReturnValue({
            destroy: loadingTaskDestroy,
            promise: Promise.resolve({
                destroy: pdfDocumentDestroy,
                getPage,
                numPages: 2,
            }),
        });

        await renderPdfPagesForBrowserPrint(targetDocument, Uint8Array.of(1, 2, 3));

        const { getViewerAssetResolver } = await import('@app/utils/viewerAssets');
        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe(getViewerAssetResolver().pdfWorkerUrl());
        expect(root.replaceChildren).toHaveBeenCalledTimes(1);
        expect(root.append).toHaveBeenCalledTimes(2);
        expect(head.appendChild).toHaveBeenCalledTimes(2);
        expect(head.appendChild).toHaveBeenNthCalledWith(1, expect.objectContaining({textContent: expect.stringContaining('@page browser-print-page-1')}));
        expect(head.appendChild).toHaveBeenNthCalledWith(2, expect.objectContaining({textContent: expect.stringContaining('size: 100pt 200pt')}));
        expect(createdSections[0]?.className).toBe('browser-print-page browser-print-page-1');
        expect(createdSections[1]?.className).toBe('browser-print-page browser-print-page-2');
        expect(firstPage.render).toHaveBeenCalledWith(expect.objectContaining({
            canvas: firstCanvas,
            canvasContext: expect.any(Object),
            viewport: {
                width: 416.6666666666667,
                height: 833.3333333333334,
            },
        }));
        expect(secondPage.render).toHaveBeenCalledWith(expect.objectContaining({
            canvas: secondCanvas,
            canvasContext: expect.any(Object),
            viewport: {
                width: 416.6666666666667,
                height: 833.3333333333334,
            },
        }));
        expect(firstCanvas.style).toEqual({
            height: '2.7778in',
            width: '1.3889in',
        });
        expect(secondCanvas.style).toEqual({
            height: '2.7778in',
            width: '1.3889in',
        });
        expect(createdSections[0]?.style).toEqual({});
        expect(createdSections[1]?.style).toEqual({});
        expect(firstPage.cleanup).toHaveBeenCalledTimes(1);
        expect(secondPage.cleanup).toHaveBeenCalledTimes(1);
        expect(pdfDocumentDestroy).toHaveBeenCalledTimes(1);
        expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);
    });

    it('passes freshly materialized Blob bytes to pdf.js without an extra clone', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const targetDocument: IBrowserPrintDocument = {
            createElement: () => {
                throw new Error('Unexpected print element creation');
            },
            querySelector: () => root,
        };
        const pdfDocumentDestroy = vi.fn(async () => {});
        const loadingTaskDestroy = vi.fn(async () => {});
        pdfjsModule.getDocument.mockReturnValue({
            destroy: loadingTaskDestroy,
            promise: Promise.resolve({
                destroy: pdfDocumentDestroy,
                getPage: vi.fn(),
                numPages: 0,
            }),
        });

        await renderPdfPagesForBrowserPrint(targetDocument, new Blob([Uint8Array.of(1, 2, 3)]));

        const pdfData = pdfjsModule.getDocument.mock.calls[0]?.[0]?.data;
        expect(pdfData).toBeInstanceOf(Uint8Array);
        expect(pdfData).toEqual(Uint8Array.of(1, 2, 3));
        expect(pdfDocumentDestroy).toHaveBeenCalledTimes(1);
        expect(loadingTaskDestroy).toHaveBeenCalledTimes(1);
    });

    it('renders selected pages from an already loaded PDF.js document', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const canvas = {
            height: 0,
            width: 0,
            style: {
                height: '',
                width: '',
            },
            getContext: vi.fn(),
        };
        canvas.getContext.mockReturnValue({ canvas });
        const printSection = {
            append: vi.fn(),
            className: '',
            style: {},
        };
        const targetDocument: IBrowserPrintDocument = {
            createElement: vi.fn((tag: 'canvas' | 'section' | 'style') => {
                if (tag === 'style') {
                    return { textContent: '' };
                }

                if (tag === 'section') {
                    return printSection;
                }

                return canvas;
            }),
            querySelector: () => root,
        };
        const page = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 100,
                    height: 200,
                }
                : {
                    width: 416.6666666666667,
                    height: 833.3333333333334,
                }),
            render: vi.fn(() => ({
                promise: Promise.resolve(),
                cancel: vi.fn(),
            })),
        };
        const getPage = vi.fn(async () => page);
        const pdfDocument = {
            getPage,
            numPages: 9,
        };

        await renderPdfDocumentPagesForBrowserPrint(
            targetDocument,
            pdfDocument as never,
            [4],
        );

        expect(pdfjsModule.getDocument).not.toHaveBeenCalled();
        expect(getPage).toHaveBeenCalledWith(4);
        expect(root.replaceChildren).toHaveBeenCalledTimes(1);
        expect(root.append).toHaveBeenCalledWith(printSection);
        expect(page.render).toHaveBeenCalledTimes(1);
        expect(page.cleanup).toHaveBeenCalledTimes(1);
    });

    it('prints mixed page sizes and orientations with per-page rules', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const targetDocument: IBrowserPrintDocument & { head: { appendChild: ReturnType<typeof vi.fn> } } = {
            createElement: vi.fn((tag: 'canvas' | 'section' | 'style') => {
                if (tag === 'style') {
                    return { textContent: '' };
                }
                return {
                    append: vi.fn(),
                    className: '',
                    getContext: vi.fn(() => ({ canvas: {} })),
                    height: 0,
                    style: {},
                    width: 0,
                };
            }),
            head: { appendChild: vi.fn() },
            querySelector: () => root,
        };
        const firstPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(() => ({
                width: 100,
                height: 200,
            })),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const secondPage = {
            cleanup: vi.fn(),
            getViewport: vi.fn(() => ({
                width: 200,
                height: 100,
            })),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        pdfjsModule.getDocument.mockReturnValue({
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({
                destroy: vi.fn(async () => {}),
                getPage: vi.fn(async (pageNumber: number) => pageNumber === 1 ? firstPage : secondPage),
                numPages: 2,
            }),
        });

        await expect(renderPdfPagesForBrowserPrint(targetDocument, Uint8Array.of(1, 2, 3)))
            .resolves.toBeUndefined();
        expect(secondPage.render).toHaveBeenCalledTimes(1);
        expect(root.append).toHaveBeenCalledTimes(2);
        expect(targetDocument.head.appendChild).toHaveBeenNthCalledWith(1, expect.objectContaining({textContent: expect.stringContaining('size: 100pt 200pt')}));
        expect(targetDocument.head.appendChild).toHaveBeenNthCalledWith(2, expect.objectContaining({textContent: expect.stringContaining('size: 200pt 100pt')}));
    });

    it('renders print bitmaps on host-document canvases before appending them to the print frame', async () => {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const hostCanvas = {
            height: 0,
            width: 0,
            style: {},
            getContext: vi.fn(),
        };
        hostCanvas.getContext.mockReturnValue({ canvas: hostCanvas });
        const printSection = {
            append: vi.fn(),
            className: '',
            style: {},
        };
        const targetDocument: IBrowserPrintDocument = {
            createElement: vi.fn((tag: 'canvas' | 'section' | 'style') => {
                if (tag === 'style') {
                    return { textContent: '' };
                }

                if (tag === 'section') {
                    return printSection;
                }

                throw new Error('Print-frame canvases should not be used for PDF.js rendering');
            }),
            querySelector: () => root,
        };
        vi.stubGlobal('document', { createElement: vi.fn((tag: string) => {
            if (tag !== 'canvas') {
                throw new Error(`Unexpected host element: ${tag}`);
            }

            return hostCanvas;
        })});
        const page = {
            cleanup: vi.fn(),
            getViewport: vi.fn(({ scale }: { scale: number }) => scale === 1
                ? {
                    width: 100,
                    height: 200,
                }
                : {
                    width: 416.6666666666667,
                    height: 833.3333333333334,
                }),
            render: vi.fn(() => ({ promise: Promise.resolve() })),
        };
        const loadingTaskDestroy = vi.fn(async () => {});
        const pdfDocumentDestroy = vi.fn(async () => {});
        pdfjsModule.getDocument.mockReturnValue({
            destroy: loadingTaskDestroy,
            promise: Promise.resolve({
                destroy: pdfDocumentDestroy,
                getPage: vi.fn(async () => page),
                numPages: 1,
            }),
        });

        await renderPdfPagesForBrowserPrint(targetDocument, Uint8Array.of(1, 2, 3));

        expect(document.createElement).toHaveBeenCalledWith('canvas');
        expect(targetDocument.createElement).toHaveBeenCalledWith('section');
        expect(targetDocument.createElement).not.toHaveBeenCalledWith('canvas');
        expect(page.render).toHaveBeenCalledWith(expect.objectContaining({
            canvas: hostCanvas,
            canvasContext: expect.any(Object),
        }));
        expect(printSection.append).toHaveBeenCalledWith(hostCanvas);
        expect(root.append).toHaveBeenCalledWith(printSection);
    });

    it('builds a browser-print frame shell with a dedicated print root', () => {
        const markup = buildBrowserPrintFrameMarkup('report - page 4.pdf');

        expect(markup).toContain('<title>report - page 4.pdf</title>');
        expect(markup).toContain('data-browser-print-root');
        expect(markup).toContain('.browser-print-page');
        expect(markup).toContain('break-before: page');
        expect(markup).toContain('max-height: 100%');
    });

    it('escapes the browser-print title before inserting it into markup', () => {
        expect(buildBrowserPrintFrameMarkup('one & <two>.pdf')).toContain(
            '<title>one &amp; &lt;two&gt;.pdf</title>',
        );
    });
});
