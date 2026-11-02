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
import {cast} from '@tests/helpers/cast';

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

    // A fake print frame: canvases hold pixels up to `maxCanvasPixels`, as a
    // browser past its canvas limit hands out a context that draws nothing.
    function createPrintEnvironment({maxCanvasPixels = Number.POSITIVE_INFINITY} = {}) {
        const root = {
            append: vi.fn(),
            replaceChildren: vi.fn(),
        };
        const head = {appendChild: vi.fn()};
        const sections: Array<{
            children: unknown[];
            className: string
        }> = [];
        const images: Array<{
            src: string;
            style: Record<string, string>;
            loaded: boolean
        }> = [];
        const canvases: Array<{
            width: number;
            height: number
        }> = [];
        let peakCanvasesHoldingPixels = 0;
        const renderedCanvasSizes: Array<{
            width: number;
            height: number
        }> = [];
        function createCanvas() {
            let corner: number[] = [
                0,
                0,
                0,
                255,
            ];
            const canvas = {
                width: 0,
                height: 0,
                style: {},
                toBlob: (callback: (blob: Blob | null) => void) => queueMicrotask(() => callback(new Blob([`${canvas.width}x${canvas.height}`], {type: 'image/png'}))),
                getContext: () => ({
                    canvas,
                    fillRect: () => {
                        if (canvas.width * canvas.height <= maxCanvasPixels) corner = [
                            255,
                            0,
                            0,
                            255,
                        ];
                    },
                    getImageData: () => ({data: Uint8ClampedArray.from(corner)}),
                }),
            };
            canvases.push(canvas);
            return canvas;
        }
        const targetDocument = cast<IBrowserPrintDocument & {head: typeof head}>({
            defaultView: {URL: {createObjectURL: (blob: Blob) => `blob:print-page-${images.length}-${blob.size}`}},
            head,
            querySelector: () => root,
            createElement: (tag: 'canvas' | 'section' | 'img' | 'style') => {
                if (tag === 'style') return {textContent: ''};
                if (tag === 'canvas') return createCanvas();
                if (tag === 'img') {
                    const image = {
                        loaded: false,
                        style: {} as Record<string, string>,
                        onload: null as null | (() => void),
                        onerror: null as null | (() => void),
                        get src() { return this._src; },
                        set src(value: string) {
                            this._src = value;
                            queueMicrotask(() => {
                                this.loaded = true;
                                this.onload?.();
                            });
                        },
                        _src: '',
                    };
                    images.push(image);
                    return image;
                }
                const section = {
                    children: [] as unknown[],
                    className: '',
                    append: (...nodes: unknown[]) => section.children.push(...nodes),
                };
                sections.push(section);
                return section;
            },
        });
        const createPage = (width: number, height: number) => ({
            cleanup: vi.fn(),
            getViewport: ({scale}: {scale: number}) => ({
                width: width * scale,
                height: height * scale,
                scale,
            }),
            render: vi.fn(({canvas}: {canvas: {
                width: number;
                height: number
            }}) => {
                renderedCanvasSizes.push({
                    width: canvas.width,
                    height: canvas.height,
                });
                peakCanvasesHoldingPixels = Math.max(
                    peakCanvasesHoldingPixels,
                    canvases.filter(candidate => candidate.width > 0 && candidate.height > 0).length,
                );
                return {
                    promise: Promise.resolve(),
                    cancel: vi.fn(),
                };
            }),
        });
        return {
            root,
            head,
            sections,
            images,
            targetDocument,
            createPage,
            renderedCanvasSizes,
            peakCanvasesHoldingPixels: () => peakCanvasesHoldingPixels,
        };
    }

    it('puts every page into the print document as a loaded image while one canvas at a time holds pixels', async () => {
        vi.stubGlobal('document', undefined);
        const environment = createPrintEnvironment();
        // Forty letter pages at 300 DPI: 1.3 GB of RGBA if every canvas stayed resident.
        const pages = Array.from({length: 40}, () => environment.createPage(612, 792));
        pdfjsModule.getDocument.mockReturnValue({
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({
                getPage: async (pageNumber: number) => pages[pageNumber - 1],
                numPages: pages.length,
            }),
        });

        await renderPdfPagesForBrowserPrint(environment.targetDocument, Uint8Array.of(1, 2, 3));

        expect(environment.sections).toHaveLength(40);
        expect(environment.sections.map(section => section.className)).toEqual(
            pages.map((_page, index) => `browser-print-page browser-print-page-${index + 1}`),
        );
        expect(environment.sections.every((section, index) => section.children[0] === environment.images[index])).toBe(true);
        expect(environment.images.every(image => image.loaded && image.src.startsWith('blob:print-page-'))).toBe(true);
        expect(environment.images[0]?.style).toEqual({
            width: '8.5in',
            height: '11in',
        });
        expect(environment.renderedCanvasSizes[0]).toEqual({
            width: Math.ceil(612 * (300 / 72)),
            height: Math.ceil(792 * (300 / 72)),
        });
        expect(environment.peakCanvasesHoldingPixels()).toBe(1);
        vi.unstubAllGlobals();
    });

    it('prints a page larger than the browser can back at the largest scale it holds', async () => {
        vi.stubGlobal('document', undefined);
        const maxCanvasPixels = 64 * 1024 * 1024;
        const environment = createPrintEnvironment({maxCanvasPixels});
        // A 100-inch square page needs 30,000 px per edge at 300 DPI.
        const page = environment.createPage(7200, 7200);

        await renderPdfDocumentPagesForBrowserPrint(
            environment.targetDocument,
            {
                getPage: async () => page,
                numPages: 1,
            } as never,
            [1],
        );

        expect(environment.images).toHaveLength(1);
        expect(environment.images[0]?.style).toEqual({
            width: '100in',
            height: '100in',
        });
        const [rendered] = environment.renderedCanvasSizes;
        expect(rendered!.width * rendered!.height).toBeLessThanOrEqual(maxCanvasPixels);
        expect(rendered!.width * rendered!.height).toBeGreaterThan(maxCanvasPixels * 0.75 * 0.75);
        vi.unstubAllGlobals();
    });

    it('prints mixed page sizes and orientations with per-page rules', async () => {
        vi.stubGlobal('document', undefined);
        const environment = createPrintEnvironment();
        const pages = [
            environment.createPage(100, 200),
            environment.createPage(200, 100),
        ];
        pdfjsModule.getDocument.mockReturnValue({
            destroy: vi.fn(async () => {}),
            promise: Promise.resolve({
                getPage: async (pageNumber: number) => pages[pageNumber - 1],
                numPages: 2,
            }),
        });

        await renderPdfPagesForBrowserPrint(environment.targetDocument, new Blob([Uint8Array.of(1, 2, 3)]));

        expect(pdfjsModule.getDocument.mock.calls[0]?.[0]?.data).toEqual(Uint8Array.of(1, 2, 3));
        expect(environment.head.appendChild).toHaveBeenNthCalledWith(1, expect.objectContaining({textContent: expect.stringContaining('size: 100pt 200pt')}));
        expect(environment.head.appendChild).toHaveBeenNthCalledWith(2, expect.objectContaining({textContent: expect.stringContaining('size: 200pt 100pt')}));
        expect(environment.images.map(image => image.style)).toEqual([
            {
                width: '1.3889in',
                height: '2.7778in',
            },
            {
                width: '2.7778in',
                height: '1.3889in',
            },
        ]);
        vi.unstubAllGlobals();
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
