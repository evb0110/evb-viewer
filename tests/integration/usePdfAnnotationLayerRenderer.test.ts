import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

const loggerWarn = vi.fn();
const loggerDebug = vi.fn();

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {
    warn: loggerWarn,
    debug: loggerDebug,
    error: vi.fn(),
}}));

const annotationEditorLayerCtor = vi.fn();
const editorLayerInstances: MockAnnotationEditorLayer[] = [];
const drawLayerInstances: MockDrawLayer[] = [];

class MockAnnotationLayer {
    async render() {
        return;
    }
}

class MockDrawLayer {
    public setParent = vi.fn();
    public destroy = vi.fn();

    constructor(_params: { pageIndex: number }) {
        drawLayerInstances.push(this);
    }
}

class MockAnnotationEditorLayer {
    public div: HTMLDivElement | null;
    public isInvisible = false;
    public textLayer: unknown;
    public uiManager: {
        addLayer: (layer: MockAnnotationEditorLayer) => void;
        removeLayer?: (layer: MockAnnotationEditorLayer) => void;
    };
    public update = vi.fn();
    public render = vi.fn();
    public pause = vi.fn();

    constructor(params: {
        div: HTMLDivElement;
        textLayer?: unknown;
        uiManager: {
            addLayer: (layer: MockAnnotationEditorLayer) => void;
            removeLayer?: (layer: MockAnnotationEditorLayer) => void;
        };
    }) {
        this.div = params.div;
        this.textLayer = params.textLayer;
        this.uiManager = params.uiManager;
        annotationEditorLayerCtor(params);
        editorLayerInstances.push(this);
        params.uiManager.addLayer(this);
    }

    disable() {
        const textLayer = this.textLayer as
      | { div?: { addEventListener?: (...args: unknown[]) => unknown } }
      | undefined;
        textLayer?.div?.addEventListener?.('pointerdown', () => {});
        if (!textLayer?.div) {
            throw new TypeError(
                'Cannot read properties of undefined (reading addEventListener)',
            );
        }
    }

    enable() {
        return;
    }

    destroy() {
        this.div = null;
        this.uiManager.removeLayer?.(this);
    }
}

vi.mock('pdfjs-dist', () => ({
    AnnotationLayer: MockAnnotationLayer,
    AnnotationEditorLayer: MockAnnotationEditorLayer,
    AnnotationEditorType: {NONE: 0},
    DrawLayer: MockDrawLayer,
}));

const { usePdfAnnotationLayerRenderer } =
    await import('@app/composables/pdf/usePdfAnnotationLayerRenderer');

interface IFakeDivElement {
    innerHTML: string;
    dir: string;
    hidden: boolean;
    style: Record<string, string>;
    setAttribute: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
}

interface IFakeContainerElement {querySelector: ReturnType<typeof vi.fn>;}

interface IViewportLike {
    clone: ReturnType<typeof vi.fn>;
    rawDims?: Record<string, unknown>;
}

function createDiv(): HTMLDivElement {
    const fakeDiv: IFakeDivElement = {
        innerHTML: '',
        dir: 'ltr',
        hidden: false,
        style: {},
        setAttribute: vi.fn(),
        addEventListener: vi.fn(),
    };
    return fakeDiv as HTMLDivElement;
}

function createContainer(pageCanvas: HTMLDivElement): HTMLElement {
    const querySelector = vi.fn((selector: string) => {
        if (selector === '.page_canvas') {
            return pageCanvas;
        }
        return null;
    });
    const fakeContainer: IFakeContainerElement = { querySelector };
    return fakeContainer as HTMLElement;
}

function createViewport(): ReturnType<PDFPageProxy['getViewport']> {
    const viewport: IViewportLike = { clone: vi.fn(() => ({ rawDims: {} })) };
    return viewport as ReturnType<PDFPageProxy['getViewport']>;
}

function createUiManager(enabled = false) {
    return {
        direction: 'ltr',
        addLayer: vi.fn((layer: MockAnnotationEditorLayer) => {
            if (enabled) {
                layer.enable();
                return;
            }
            layer.disable();
        }),
        removeLayer: vi.fn(),
    };
}

describe('usePdfAnnotationLayerRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        editorLayerInstances.length = 0;
        drawLayerInstances.length = 0;
    });

    it('passes a PDF.js-compatible text layer object to AnnotationEditorLayer', () => {
        const uiManager = createUiManager(false);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument: ref(null),
            showAnnotations: ref(true),
            annotationUiManager: ref(uiManager),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();
        const textLayerDiv = createDiv();

        const result = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(result).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        const ctorArg = annotationEditorLayerCtor.mock.calls[0][0] as {textLayer?: { div?: HTMLDivElement };};
        expect(ctorArg.textLayer?.div).toBe(textLayerDiv);
        expect(uiManager.addLayer).toHaveBeenCalledTimes(1);
        expect(loggerWarn).not.toHaveBeenCalled();

        const secondResult = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            textLayerDiv,
            createViewport(),
            1,
            null,
        );

        expect(secondResult).toBe(true);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(editorLayerInstances[0]?.update).toHaveBeenCalledTimes(1);
    });

    it('disables the annotation editor layer for the current document after a render crash', () => {
        const firstDocument = { annotationStorage: {} } as PDFDocumentProxy;
        const secondDocument = { annotationStorage: {} } as PDFDocumentProxy;
        const pdfDocument = ref<PDFDocumentProxy | null>(firstDocument);
        const uiManager = createUiManager(false);
        const renderer = usePdfAnnotationLayerRenderer({
            numPages: ref(1),
            currentPage: ref(1),
            pdfDocument,
            showAnnotations: ref(true),
            annotationUiManager: ref(uiManager),
            annotationL10n: ref(null),
        });

        const pageCanvas = createDiv();
        const container = createContainer(pageCanvas);
        const annotationEditorLayerDiv = createDiv();

        const firstResult = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            null,
            createViewport(),
            1,
            null,
        );

        expect(firstResult).toBe(false);
        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(drawLayerInstances[0]?.destroy).toHaveBeenCalledTimes(1);

        const secondResult = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(secondResult).toBe(false);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerDiv.hidden).toBe(true);

        pdfDocument.value = secondDocument;

        const thirdResult = renderer.renderAnnotationEditorLayer(
            container,
            annotationEditorLayerDiv,
            createDiv(),
            createViewport(),
            1,
            null,
        );

        expect(thirdResult).toBe(true);
        expect(loggerWarn).toHaveBeenCalledTimes(1);
        expect(annotationEditorLayerCtor).toHaveBeenCalledTimes(2);
    });
});
