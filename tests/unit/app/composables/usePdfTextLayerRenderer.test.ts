import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

const highlightPageMock = vi.fn(() => ({
    elements: [],
    currentMatchRanges: [],
}));
const renderPageWordBoxesMock = vi.fn();
const clearWordBoxesMock = vi.fn();

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

vi.mock('@app/composables/usePdfSearchHighlight', () => ({usePdfSearchHighlight: () => ({
    clearHighlights: vi.fn(),
    highlightPage: highlightPageMock,
    scrollToHighlight: vi.fn(),
    getCurrentMatchRanges: vi.fn(() => []),
})}));

vi.mock('@app/composables/usePdfWordBoxes', () => ({usePdfWordBoxes: () => ({
    renderPageWordBoxes: renderPageWordBoxesMock,
    clearWordBoxes: clearWordBoxesMock,
    isOcrDebugEnabled: vi.fn(() => false),
    clearOcrDebugBoxes: vi.fn(),
    renderOcrDebugBoxes: vi.fn(),
})}));

vi.mock('@app/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({getOcrTextContent: vi.fn()})}));

vi.mock('@app/composables/pdfSearchHighlightCss', () => ({
    getHighlightMode: () => 'dom',
    isHighlightDebugEnabled: () => false,
    isHighlightDebugVerboseEnabled: () => false,
}));

const { usePdfTextLayerRenderer } = await import('@app/composables/pdf/usePdfTextLayerRenderer');

describe('usePdfTextLayerRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        highlightPageMock.mockReturnValue({
            elements: [],
            currentMatchRanges: [],
        });
    });

    it('keeps repeated words with different geometry in fallback word-box rendering', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: 0,
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
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        renderer.applyPageSearchHighlights(
            {} as HTMLElement,
            {} as HTMLElement,
            1,
            {} as HTMLCanvasElement,
        );

        expect(renderPageWordBoxesMock).toHaveBeenCalledTimes(1);
        const words = renderPageWordBoxesMock.mock.calls[0]?.[1] as Array<{
            text: string;
            x: number;
        }>;
        expect(words).toHaveLength(2);
        expect(words[0]?.x).toBe(10);
        expect(words[1]?.x).toBe(60);
    });
});
