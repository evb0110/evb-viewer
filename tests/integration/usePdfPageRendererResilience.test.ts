import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    ref,
    shallowRef,
    type Ref,
} from 'vue';

function cast<T>(obj: unknown): T {
    return obj as T;
}

const loggerError = vi.fn();

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {
    error: loggerError,
    warn: vi.fn(),
    debug: vi.fn(),
}}));

interface IClassList {
    add: (...args: string[]) => void;
    remove: (...args: string[]) => void;
}

interface INodeLike {
    style: Record<string, string>;
    classList: IClassList;
    innerHTML?: string;
    hidden?: boolean;
    dir?: string;
    appendChild?: (...args: unknown[]) => void;
    querySelector?: (selector: string) => unknown;
}

interface ICanvasLike extends INodeLike {
    width: number;
    height: number;
    remove: () => void;
}

interface IRenderContext {
    canvasContext: unknown;
    canvas?: unknown;
    transform?: unknown;
    viewport: {
        width: number;
        height: number;
    };
}

const canvasRendererMock = {
    cleanupCanvas: vi.fn(),
    renderCanvas: vi.fn(),
    applyContainerDimensions: vi.fn(),
    mountCanvas: vi.fn((_host: unknown, _canvas: unknown, container: INodeLike, className: string) => {
        container.classList.add(className);
    }),
};

const textLayerRendererMock = {
    renderTextLayer: vi.fn(),
    setupTextLayerInteraction: vi.fn(),
    applyPageSearchHighlights: vi.fn(),
    applyAllSearchHighlights: vi.fn(),
    scrollToCurrentMatch: vi.fn(() => false),
    cleanupTextLayerDom: vi.fn(),
    clearOcrDebug: vi.fn(),
    isOcrDebugEnabled: vi.fn(() => false),
    renderOcrDebugBoxes: vi.fn(async () => {}),
    getCurrentMatchRanges: vi.fn(() => []),
};

const annotationLayerRendererMock = {
    renderAnnotationLayer: vi.fn(),
    renderAnnotationEditorLayer: vi.fn(() => true),
    cleanupEditorLayer: vi.fn(),
    clearAllLayers: vi.fn(),
};

vi.mock('@app/composables/pdf/usePdfCanvasRenderer', () => ({usePdfCanvasRenderer: () => canvasRendererMock}));

vi.mock('@app/composables/pdf/usePdfTextLayerRenderer', () => ({usePdfTextLayerRenderer: () => textLayerRendererMock}));

vi.mock('@app/composables/pdf/usePdfAnnotationLayerRenderer', () => ({usePdfAnnotationLayerRenderer: () => annotationLayerRendererMock}));

const { usePdfPageRenderer } = await import('@app/composables/pdf/usePdfPageRenderer');

function createClassList(): IClassList {
    return {
        add: vi.fn(),
        remove: vi.fn(),
    };
}

function createCanvas(): ICanvasLike {
    return {
        width: 0,
        height: 0,
        remove: vi.fn(),
        style: {},
        classList: createClassList(),
    };
}

function createPageContainer(overrides?: {
    textLayerDiv?: INodeLike | null;
    annotationLayerDiv?: INodeLike | null;
    annotationEditorLayerDiv?: INodeLike | null;
}) {
    const canvasHost: INodeLike = {
        innerHTML: '',
        style: {},
        classList: createClassList(),
        appendChild: vi.fn(),
    };
    const skeleton: INodeLike = {
        style: {display: ''},
        classList: createClassList(),
    };
    const textLayerDiv = overrides?.textLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createClassList(),
    };
    const annotationLayerDiv = overrides?.annotationLayerDiv ?? {
        innerHTML: '',
        style: {},
        classList: createClassList(),
    };
    const annotationEditorLayerDiv = overrides?.annotationEditorLayerDiv ?? {
        innerHTML: '',
        hidden: false,
        dir: 'ltr',
        style: {},
        classList: createClassList(),
    };

    const selectorMap = new Map<string, unknown>([
        [
            '.page_canvas',
            canvasHost,
        ],
        [
            '.pdf-page-skeleton',
            skeleton,
        ],
        [
            '.text-layer',
            textLayerDiv,
        ],
        [
            '.annotation-layer',
            annotationLayerDiv,
        ],
        [
            '.annotation-editor-layer',
            annotationEditorLayerDiv,
        ],
    ]);

    const pageContainer: INodeLike = {
        style: {},
        classList: createClassList(),
        querySelector: vi.fn((selector: string) => selectorMap.get(selector) ?? null),
    };

    return {
        pageContainer,
        canvasHost,
        textLayerDiv,
    };
}

function createContainerRoot(pageContainer: INodeLike) {
    return cast<HTMLElement>({
        querySelectorAll: vi.fn((selector: string) => (
            selector === '.page_container'
                ? [pageContainer]
                : []
        )),
        querySelector: vi.fn((selector: string) => (
            selector === '.page_container[data-page="1"]'
                ? pageContainer
                : null
        )),
    });
}

function createRenderResult() {
    return {
        canvas: cast<HTMLCanvasElement>(createCanvas()),
        viewport: {
            width: 120,
            height: 180,
            rawDims: {
                pageWidth: 120,
                pageHeight: 180,
            },
        },
        scaleX: 1,
        scaleY: 1,
        rawDims: {
            pageWidth: 120,
            pageHeight: 180,
        },
        userUnit: 1,
        totalScaleFactor: 1,
    };
}

describe('usePdfPageRenderer resilience', () => {
    it('keeps page rendered when text layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockRejectedValue(new Error('text layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: ref(null),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(documentState.evictPage).not.toHaveBeenCalled();
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render text layer for page 1'),
            expect.any(Error),
        );
    });

    it('keeps page rendered when annotation layer rendering fails', async () => {
        const { pageContainer } = createPageContainer();
        const containerRoot = createContainerRoot(pageContainer);

        const documentState = {
            pdfDocument: shallowRef({} as object),
            numPages: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            isLoading: ref(false),
            getPage: vi.fn(async () => ({render: vi.fn((_ctx: IRenderContext) => ({ promise: Promise.resolve() }))})),
            evictPage: vi.fn(),
            cleanupPageCache: vi.fn(),
        };

        canvasRendererMock.renderCanvas.mockResolvedValue(createRenderResult());
        textLayerRendererMock.renderTextLayer.mockResolvedValue(undefined);
        annotationLayerRendererMock.renderAnnotationLayer.mockRejectedValue(new Error('annotation layer failed'));

        const renderer = usePdfPageRenderer({
            container: ref(containerRoot),
            document: documentState as never,
            currentPage: ref(1),
            effectiveScale: ref(1),
            bufferPages: ref(0),
            showAnnotations: ref(true),
            annotationUiManager: cast<Ref<AnnotationEditorUIManager | null>>(ref({ direction: 'ltr' })),
            annotationL10n: ref(null),
            searchPageMatches: ref(new Map()),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
        });

        await renderer.renderVisiblePages({
            start: 1,
            end: 1,
        });

        expect(renderer.isPageRendered(1)).toBe(true);
        expect(documentState.evictPage).not.toHaveBeenCalled();
        expect(loggerError).toHaveBeenCalledWith(
            'pdf-renderer',
            expect.stringContaining('Failed to render annotation layer for page 1'),
            expect.any(Error),
        );
    });
});
