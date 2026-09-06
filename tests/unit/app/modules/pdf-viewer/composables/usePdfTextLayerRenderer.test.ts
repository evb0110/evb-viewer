import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { cast } from '@tests/helpers/cast';
import { requirePageIndex } from '@contracts/pageNumbers';
import {requireDocumentRevisionToken} from '@contracts';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

type THighlightPageMock = (
    textLayer: HTMLElement,
    pageMatchData: unknown,
    currentMatch?: {pageMatchIndex?: number} | null,
) => {
    elements: HTMLElement[];
    currentMatchRanges: Range[];
};

const highlightPageMock = vi.fn<THighlightPageMock>(() => ({
    elements: [],
    currentMatchRanges: [],
}));
const clearHighlightsMock = vi.hoisted(() => vi.fn());
const renderPageWordBoxesMock = vi.fn();
const clearWordBoxesMock = vi.fn();
const ocrTextContentMock = vi.hoisted(() => ({
    getOcrTextContent: vi.fn(),
    hasPageOcrData: vi.fn(),
}));
const textLayerRuntimeMock = vi.hoisted(() => ({
    sources: [] as unknown[],
    updates: [] as unknown[],
}));

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight', () => ({usePdfSearchHighlight: () => ({
    clearHighlights: clearHighlightsMock,
    highlightPage: highlightPageMock,
    scrollToHighlight: vi.fn(),
    getCurrentMatchRanges: vi.fn(() => []),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfWordBoxes', () => ({usePdfWordBoxes: () => ({
    renderPageWordBoxes: renderPageWordBoxesMock,
    clearWordBoxes: clearWordBoxesMock,
    isOcrDebugEnabled: vi.fn(() => false),
    clearOcrDebugBoxes: vi.fn(),
    renderOcrDebugBoxes: vi.fn(),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ocrTextContentMock}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({TextLayer: class {
    textDivs: HTMLElement[] = [];
    textContentItemsStr: string[] = [];

    constructor(private readonly options: {
        textContentSource: {items?: Array<{str?: unknown}>};
        container: HTMLElement;
    }) {
        textLayerRuntimeMock.sources.push(options.textContentSource);
    }

    async render() {
        const items = this.options.textContentSource.items ?? [];
        for (const item of items) {
            const text = String(item.str ?? '');
            const span = document.createElement('span');
            span.textContent = text;
            this.options.container.append(span);
            this.textDivs.push(span);
            this.textContentItemsStr.push(text);
        }
    }

    update(options: {viewport: unknown}) {
        textLayerRuntimeMock.updates.push(options.viewport);
    }

    cancel() {}
}}));

vi.mock('@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss', () => ({
    getHighlightMode: () => 'dom',
    isHighlightDebugEnabled: () => false,
    isHighlightDebugVerboseEnabled: () => false,
}));

const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

const { usePdfTextLayerRenderer: usePdfTextLayerRendererProduction } = await import('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer');
const usePdfTextLayerRenderer = (
    options: Omit<Parameters<typeof usePdfTextLayerRendererProduction>[0], 'viewportWritePort'>,
) => usePdfTextLayerRendererProduction({
    ...options,
    viewportWritePort: createTestPdfViewportWritePort().port,
});

function domRectLike(options: {
    top: number;
    left?: number;
    width?: number;
    height?: number;
}) {
    const {
        top,
        left = 0,
        width = 80,
        height = 20,
    } = options;

    return cast<DOMRect>({
        top,
        left,
        width,
        height,
        bottom: top + height,
        right: left + width,
        x: left,
        y: top,
        toJSON: () => ({}),
    });
}

function textLayerViewport(scale: number) {
    return cast<ReturnType<IPdfPage['getViewport']>>({
        scale,
        rotation: 0,
        width: 100 * scale,
        height: 100 * scale,
        userUnit: 1,
        rawDims: {
            pageWidth: 100,
            pageHeight: 100,
        },
    });
}

describe('usePdfTextLayerRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ocrTextContentMock.getOcrTextContent.mockReset();
        ocrTextContentMock.hasPageOcrData.mockReset();
        ocrTextContentMock.hasPageOcrData.mockResolvedValue(false);
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(performance.now());
            return 0;
        });
        vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        textLayerRuntimeMock.sources.length = 0;
        textLayerRuntimeMock.updates.length = 0;
        highlightPageMock.mockReturnValue({
            elements: [],
            currentMatchRanges: [],
        });
        clearHighlightsMock.mockClear();
    });

    it('prefers embedded pdf.js text content over OCR sidecar text when a page already has text', async () => {
        const nativeTextContent = {
            items: [{
                str: 'native pdf text',
                hasEOL: false,
            }],
            styles: {},
        };
        const ocrTextContent = {
            items: [{
                str: 'sidecar ocr text',
                hasEOL: false,
            }],
            styles: {},
        };
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: vi.fn(async () => nativeTextContent),
            streamTextContent: vi.fn(),
        });
        ocrTextContentMock.hasPageOcrData.mockResolvedValue(true);
        ocrTextContentMock.getOcrTextContent.mockResolvedValue(ocrTextContent);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref('/tmp/ocr.pdf'),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');

        await renderer.renderTextLayer(
            pdfPage,
            textLayerDiv,
            cast({}),
            1,
            1,
            1,
        );

        expect(pdfPage.getTextContent).toHaveBeenCalledWith({
            includeMarkedContent: true,
            disableNormalization: true,
        });
        expect(ocrTextContentMock.getOcrTextContent).not.toHaveBeenCalled();
        expect(textLayerRuntimeMock.sources[0]).toBe(nativeTextContent);
        expect(textLayerDiv.textContent).toBe('native pdf text');
    });

    it('uses OCR sidecar text only when pdf.js has no usable text for that page', async () => {
        const nativeTextContent = {
            items: [{
                str: '   ',
                hasEOL: false,
            }],
            styles: {},
        };
        const ocrTextContent = {
            items: [{
                str: 'sidecar ocr text',
                hasEOL: false,
            }],
            styles: {},
        };
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: vi.fn(async () => nativeTextContent),
            streamTextContent: vi.fn(),
        });
        ocrTextContentMock.hasPageOcrData.mockResolvedValue(true);
        ocrTextContentMock.getOcrTextContent.mockResolvedValue(ocrTextContent);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref('/tmp/scanned.pdf'),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');

        await renderer.renderTextLayer(
            pdfPage,
            textLayerDiv,
            cast({}),
            1,
            1,
            1,
        );

        expect(ocrTextContentMock.getOcrTextContent).toHaveBeenCalledTimes(1);
        expect(textLayerRuntimeMock.sources[0]).toBe(ocrTextContent);
        expect(textLayerDiv.textContent).toBe('sidecar ocr text');
    });

    it('relayouts the mounted spans on a scale step instead of refetching the text content', async () => {
        const streamTextContent = vi.fn(() => ({items: [{
            str: 'page text',
            hasEOL: false,
        }]}));
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: vi.fn(),
            streamTextContent,
        });
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref('/tmp/book.pdf'),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');
        const onBeforeRebuild = vi.fn();

        await renderer.renderTextLayer(
            pdfPage, textLayerDiv, textLayerViewport(1), 1, 1, 1, undefined, onBeforeRebuild,
        );
        const spanAfterFirstRender = textLayerDiv.querySelector('span');
        const zoomedViewport = textLayerViewport(2);
        await renderer.renderTextLayer(
            pdfPage, textLayerDiv, zoomedViewport, 2, 1, 2, undefined, onBeforeRebuild,
        );

        expect(streamTextContent).toHaveBeenCalledTimes(1);
        expect(onBeforeRebuild).toHaveBeenCalledTimes(1);
        expect(textLayerRuntimeMock.updates).toEqual([zoomedViewport]);
        expect(textLayerDiv.querySelector('span')).toBe(spanAfterFirstRender);
        expect(textLayerDiv.textContent).toBe('page text');
        expect(textLayerDiv.dataset.pdfTextLayerReady).toBe('true');
    });

    it('rebuilds the text layer when the document revision moves under the same page', async () => {
        const streamTextContent = vi.fn(() => ({items: [{
            str: 'page text',
            hasEOL: false,
        }]}));
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: vi.fn(),
            streamTextContent,
        });
        const documentRevisionToken = ref(TEST_DOCUMENT_REVISION);
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref('/tmp/book.pdf'),
            documentRevisionToken,
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');
        const onBeforeRebuild = vi.fn();

        await renderer.renderTextLayer(
            pdfPage, textLayerDiv, textLayerViewport(1), 1, 1, 1, undefined, onBeforeRebuild,
        );
        const spanAfterFirstRender = textLayerDiv.querySelector('span');
        documentRevisionToken.value = requireDocumentRevisionToken('revision-token-2');
        await renderer.renderTextLayer(
            pdfPage, textLayerDiv, textLayerViewport(1), 1, 1, 1, undefined, onBeforeRebuild,
        );

        expect(streamTextContent).toHaveBeenCalledTimes(2);
        expect(onBeforeRebuild).toHaveBeenCalledTimes(2);
        expect(textLayerRuntimeMock.updates).toEqual([]);
        expect(textLayerDiv.querySelector('span')).not.toBe(spanAfterFirstRender);
    });

    it('rebuilds the text layer after its DOM has been torn down', async () => {
        const streamTextContent = vi.fn(() => ({items: [{
            str: 'page text',
            hasEOL: false,
        }]}));
        const pdfPage = cast<IPdfPage>({
            pageNumber: 1,
            getTextContent: vi.fn(),
            streamTextContent,
        });
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref('/tmp/book.pdf'),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');

        await renderer.renderTextLayer(pdfPage, textLayerDiv, textLayerViewport(1), 1, 1, 1);
        renderer.cleanupTextLayerDom(textLayerDiv);
        await renderer.renderTextLayer(pdfPage, textLayerDiv, textLayerViewport(2), 2, 1, 2);

        expect(streamTextContent).toHaveBeenCalledTimes(2);
        expect(textLayerRuntimeMock.updates).toEqual([]);
        expect(textLayerDiv.textContent).toBe('page text');
    });

    it('prefers geometry word boxes and keeps repeated words with different boxes', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'foo foo',
                searchQuery: 'foo',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 3,
                    words: [
                        {
                            text: 'foo',
                            x: 10,
                            y: 20,
                            width: 30,
                            height: 12,
                        },
                        {
                            text: 'foo',
                            x: 60,
                            y: 20,
                            width: 30,
                            height: 12,
                        },
                    ],
                    pageWidth: 100,
                    pageHeight: 100,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 4,
                endOffset: 7,
                words: [{
                    text: 'foo',
                    x: 60,
                    y: 20,
                    width: 30,
                    height: 12,
                }],
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        renderer.applyPageSearchHighlights(
            {} as HTMLElement,
            cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}}),
            1,
            {} as HTMLCanvasElement,
        );

        expect(renderPageWordBoxesMock).toHaveBeenCalledTimes(1);
        expect(highlightPageMock).not.toHaveBeenCalled();
        const words = renderPageWordBoxesMock.mock.calls[0]?.[1] as Array<{
            text: string;
            x: number;
        }>;
        expect(words).toHaveLength(2);
        expect(words[0]?.x).toBe(10);
        expect(words[1]?.x).toBe(60);
        const currentWords = renderPageWordBoxesMock.mock.calls[0]?.[4] as Set<string>;
        expect(currentWords.has('foo|10|20|30|12')).toBe(false);
        expect(currentWords.has('foo|60|20|30|12')).toBe(true);
    });

    it('maps applyAllSearchHighlights by mounted page numbers instead of DOM order', () => {
        const pageMatches = new Map([
            [
                40,
                {
                    pageIndex: requirePageIndex(40),
                    pageText: '',
                    searchQuery: 'what',
                    matches: [{
                        matchIndex: 0,
                        start: 0,
                        end: 4,
                    }],
                },
            ],
            [
                43,
                {
                    pageIndex: requirePageIndex(43),
                    pageText: '',
                    searchQuery: 'what',
                    matches: [{
                        matchIndex: 1,
                        start: 10,
                        end: 14,
                    }],
                },
            ],
        ]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        const textLayer41 = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});
        const textLayer44 = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});
        const page41 = cast<HTMLElement>({
            dataset: {page: '41'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer41 : null,
        });
        const page44 = cast<HTMLElement>({
            dataset: {page: '44'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer44 : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [
                    page41,
                    page44,
                ]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(2);
        const firstCallPageMatches = highlightPageMock.mock.calls
            .at(0)
            ?.at(1) as {pageIndex: number} | undefined;
        const secondCallPageMatches = highlightPageMock.mock.calls
            .at(1)
            ?.at(1) as {pageIndex: number} | undefined;
        expect(firstCallPageMatches?.pageIndex).toBe(40);
        expect(secondCallPageMatches?.pageIndex).toBe(43);
    });

    it('does not cache highlight refresh before the text layer is mounted', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: '',
                searchQuery: 'roma',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 4,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 0,
                endOffset: 4,
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        let textLayer: HTMLElement | null = null;
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [page]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).not.toHaveBeenCalled();

        textLayer = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(1);
    });

    it('does not cache highlight refresh while a mounted text layer is still rendering', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'roma',
                searchQuery: 'roma',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 4,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                startOffset: 0,
                endOffset: 4,
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        const renderingTextLayerDataset = {
            pdfTextLayerRendering: 'true',
            pdfTextLayerReady: 'false',
        };
        let textLayer = cast<HTMLElement>({dataset: renderingTextLayerDataset});
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [page]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).not.toHaveBeenCalled();

        textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            textContent: 'roma',
            querySelector: (selector: string) => selector === 'span' ? cast<HTMLSpanElement>({}) : null,
        });

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(1);
    });

    it('repaints geometry highlights when the page DOM loses word boxes without a signature change', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'История',
                searchQuery: 'история',
                signatureToken: 'page-0-geometry',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 7,
                    words: [{
                        text: 'История',
                        x: 10,
                        y: 20,
                        width: 90,
                        height: 24,
                    }],
                    pageWidth: 600,
                    pageHeight: 800,
                }],
            },
        ]]);
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 7,
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayer = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            querySelector: (selector: string) => selector === '.text-layer'
                ? textLayer
                : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [page]
                : []
        )});

        renderer.applyAllSearchHighlights(root);
        renderer.applyAllSearchHighlights(root);

        expect(renderPageWordBoxesMock).toHaveBeenCalledTimes(2);
        expect(highlightPageMock).not.toHaveBeenCalled();
    });

    it('refreshes same-page current highlights before measuring scroll geometry', () => {
        vi.spyOn(window, 'getComputedStyle').mockReturnValue(cast<CSSStyleDeclaration>({
            paddingTop: '20px',
            paddingBottom: '20px',
            getPropertyValue: () => '',
        }));

        const oldCurrentMarkRect = domRectLike({
            top: 189,
            height: 173,
        });
        const newCurrentMarkRect = domRectLike({
            top: 1390,
            left: 882,
            width: 79,
            height: 25,
        });
        const oldCurrentMark = cast<HTMLElement>({getBoundingClientRect: () => oldCurrentMarkRect});
        const newCurrentMark = cast<HTMLElement>({getBoundingClientRect: () => newCurrentMarkRect});
        let currentMark = oldCurrentMark;

        highlightPageMock.mockImplementation((_textLayer, _pageMatchData, currentMatch) => {
            currentMark = currentMatch?.pageMatchIndex === 1
                ? newCurrentMark
                : oldCurrentMark;
            return {
                elements: [currentMark],
                currentMatchRanges: [],
            };
        });

        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'historia historia',
                searchQuery: 'historia',
                signatureToken: 'page-0-two-matches',
                matches: [
                    {
                        matchIndex: 0,
                        start: 0,
                        end: 8,
                    },
                    {
                        matchIndex: 1,
                        start: 9,
                        end: 17,
                    },
                ],
            },
        ]]);
        const currentSearchMatch = ref({
            pageIndex: requirePageIndex(0),
            matchIndex: 0,
            pageMatchIndex: 0,
            startOffset: 0,
            endOffset: 8,
        });

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch,
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        const textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            querySelector: (selector: string) => selector === '.pdf-search-highlight--current'
                ? currentMark
                : null,
        });
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            offsetTop: 7106,
            offsetHeight: 3000,
            querySelector: (selector: string) => selector === '.text-layer'
                ? textLayer
                : null,
        });
        const root = cast<HTMLElement>({
            scrollTop: 7106,
            clientHeight: 982,
            querySelector: (selector: string) => selector === '.page_container[data-page="1"]'
                ? page
                : null,
            querySelectorAll: (selector: string) => selector === '.page_container'
                ? [page]
                : [],
            getBoundingClientRect: () => domRectLike({
                top: 94,
                width: 1200,
                height: 982,
            }),
        });

        renderer.applyPageSearchHighlights(
            page,
            textLayer,
            1,
            {} as HTMLCanvasElement,
        );
        currentSearchMatch.value = {
            pageIndex: requirePageIndex(0),
            matchIndex: 1,
            pageMatchIndex: 1,
            startOffset: 9,
            endOffset: 17,
        };

        const didScroll = renderer.scrollToCurrentMatch(root);

        expect(didScroll).toBe(true);
        expect(highlightPageMock).toHaveBeenCalledTimes(2);
        expect(root.scrollTop).toBeGreaterThan(7900);
    });

    it('reveals the current match horizontally when it is outside the viewport', () => {
        const currentMark = cast<HTMLElement>({getBoundingClientRect: () => domRectLike({
            left: 1500,
            top: 500,
            width: 80,
            height: 20,
        })});
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'История',
                searchQuery: 'история',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 7,
                }],
            },
        ]]);
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 7,
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        const textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            querySelector: (selector: string) => selector === '.pdf-search-highlight--current'
                ? currentMark
                : null,
        });
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            offsetTop: 1000,
            offsetHeight: 2000,
            querySelector: (selector: string) => selector === '.text-layer'
                ? textLayer
                : null,
        });
        const root = cast<HTMLElement>({
            scrollTop: 1000,
            scrollLeft: 0,
            clientHeight: 800,
            clientWidth: 1000,
            scrollWidth: 2200,
            querySelector: (selector: string) => selector === '.page_container[data-page="1"]'
                ? page
                : null,
            querySelectorAll: (selector: string) => selector === '.page_container'
                ? [page]
                : [],
            getBoundingClientRect: () => domRectLike({
                left: 300,
                top: 100,
                width: 1000,
                height: 800,
            }),
        });

        const didScroll = renderer.scrollToCurrentMatch(root);

        expect(didScroll).toBe(true);
        expect(root.scrollLeft).toBeGreaterThan(0);
    });

    it('scrolls from current match word geometry when the current DOM marker is not rendered yet', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: requirePageIndex(0),
                pageText: 'История',
                searchQuery: 'история',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 7,
                    words: [{
                        text: 'История',
                        x: 800,
                        y: 100,
                        width: 80,
                        height: 20,
                    }],
                    pageWidth: 1000,
                    pageHeight: 1000,
                }],
            },
        ]]);
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: requirePageIndex(0),
                matchIndex: 0,
                pageMatchIndex: 0,
                startOffset: 0,
                endOffset: 7,
            }),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });

        const canvas = cast<HTMLCanvasElement>({
            offsetWidth: 2000,
            offsetHeight: 2000,
            getBoundingClientRect: () => domRectLike({
                left: 300,
                top: 100,
                width: 2000,
                height: 2000,
            }),
        });
        const textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            querySelector: () => null,
        });
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            offsetTop: 0,
            offsetHeight: 2000,
            querySelector: (selector: string) => {
                if (selector === '.text-layer') {
                    return textLayer;
                }
                if (selector === 'canvas') {
                    return canvas;
                }
                return null;
            },
        });
        const root = cast<HTMLElement>({
            scrollTop: 0,
            scrollLeft: 0,
            clientHeight: 800,
            clientWidth: 1000,
            scrollWidth: 2400,
            querySelector: (selector: string) => selector === '.page_container[data-page="1"]'
                ? page
                : null,
            querySelectorAll: (selector: string) => selector === '.page_container'
                ? [page]
                : [],
            getBoundingClientRect: () => domRectLike({
                left: 300,
                top: 100,
                width: 1000,
                height: 800,
            }),
        });

        const didScroll = renderer.scrollToCurrentMatch(root);

        expect(didScroll).toBe(true);
        expect(root.scrollLeft).toBeGreaterThan(1000);
    });

    it('clears existing highlights before replacing text-layer DOM', async () => {
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const textLayerDiv = document.createElement('div');
        textLayerDiv.textContent = 'stale';

        await renderer.renderTextLayer(
            cast<IPdfPage>({
                pageNumber: 1,
                getTextContent: vi.fn().mockResolvedValue({items: []}),
            }),
            textLayerDiv,
            cast<ReturnType<IPdfPage['getViewport']>>({
                width: 100,
                height: 100,
                userUnit: 1,
                rawDims: {
                    pageWidth: 100,
                    pageHeight: 100,
                },
            }),
            1,
            1,
            1,
        );

        expect(clearHighlightsMock).toHaveBeenCalledWith(textLayerDiv);
    });

    it('clears highlights when search state is empty after rerender', () => {
        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            documentRevisionToken: ref(TEST_DOCUMENT_REVISION),
            effectiveScale: ref(1),
        });
        const container = document.createElement('div');
        const textLayerDiv = document.createElement('div');

        renderer.applyPageSearchHighlights(
            container,
            textLayerDiv,
            1,
            null,
        );

        expect(clearHighlightsMock).toHaveBeenCalledWith(textLayerDiv);
        expect(clearWordBoxesMock).toHaveBeenCalledWith(container);
    });
});
