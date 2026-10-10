import {createCanvas as createRasterCanvas} from '@napi-rs/canvas';
import {
    PDFDocument, degrees,
} from 'pdf-lib';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    type Ref,
} from 'vue';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';

vi.mock('@app/services/pdfjs/runtimeLib', () => ({ AnnotationMode: {
    DISABLE: 0,
    ENABLE: 1,
    ENABLE_FORMS: 2,
} }));

const DEFAULT_VIEWPORT = {
    width: 200,
    height: 100,
    userUnit: 1,
    rawDims: {
        pageWidth: 200,
        pageHeight: 100,
    },
};

function createCanvas() {
    return {
        width: 0,
        height: 0,
        style: {} as CSSStyleDeclaration,
        getContext: vi.fn(() => ({})),
        remove: vi.fn(),
    };
}

function installCanvasDocument(canvas = createCanvas()) {
    const createElement = vi.fn(() => canvas);
    (globalThis as Record<string, unknown>).document = { createElement };
    return {
        canvas,
        createElement,
    };
}

function createPdfPage<T extends Record<string, unknown>>(overrides?: T) {
    const renderTask = {
        cancel: vi.fn(),
        promise: Promise.resolve(),
    };
    return {
        pageNumber: 1,
        getViewport: vi.fn(() => DEFAULT_VIEWPORT),
        getOperatorList: vi.fn(async () => ({
            fnArray: [],
            argsArray: [],
        })),
        render: vi.fn((_context: Record<string, unknown>) => renderTask),
        ...overrides,
    };
}

async function renderScenario({
    outputScale = 1,
    rendererOptions = {},
    renderOptions,
    viewport = DEFAULT_VIEWPORT,
    zoom = 1,
}: {
    outputScale?: number | Ref<number>;
    rendererOptions?: Omit<Parameters<typeof usePdfCanvasRenderer>[0], 'outputScale'>;
    renderOptions?: Parameters<ReturnType<typeof usePdfCanvasRenderer>['renderCanvas']>[2];
    viewport?: typeof DEFAULT_VIEWPORT;
    zoom?: number;
} = {}) {
    const { canvas } = installCanvasDocument();
    const pdfPage = createPdfPage({ getViewport: vi.fn(() => viewport) });
    const renderer = usePdfCanvasRenderer({
        outputScale,
        ...rendererOptions,
    });
    const result = await renderer.renderCanvas(pdfPage as never, zoom, renderOptions);
    return {
        canvas,
        pdfPage,
        renderer,
        result,
    };
}

async function renderedAppearancePixels({
    contentIntent = 'full-visible', projectionReady = true, flags = 16, subtype = 'FreeText', hidden = false,
}: {
    contentIntent?: 'full-visible' | 'canvas-only-buffer' | 'canvas-only-refine';
    projectionReady?: boolean;
    flags?: number;
    subtype?: string;
    hidden?: boolean;
} = {}) {
    const canvas = Object.assign(createRasterCanvas(1, 1), {
        style: {},
        remove: () => {},
    });
    (globalThis as Record<string, unknown>).document = {createElement: () => canvas};
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([
        200,
        100,
    ]);
    page.setRotation(degrees(90));
    const appearance = pdf.context.register(pdf.context.stream('0 0 1 rg 0 0 80 20 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [
            0,
            0,
            80,
            20,
        ],
    }));
    page.node.set(pdf.context.obj('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
        Type: 'Annot',
        Subtype: subtype,
        Rect: [
            20,
            20,
            100,
            40,
        ],
        F: flags,
        AP: {N: appearance},
        P: page.ref,
        ...(subtype === 'Widget' ? {FT: 'Tx'} : {}),
    }))]));
    const loading = getDocument({data: await pdf.save()});
    try {
        const document = await loading.promise;
        const pdfPage = await document.getPage(1);
        const [annotation] = await pdfPage.getAnnotations();
        const renderer = usePdfCanvasRenderer({
            outputScale: 1,
            annotationProjectionReady: ref(projectionReady),
        });
        await renderer.renderCanvas(pdfPage as never, 1, {
            contentIntent,
            ...(hidden ? {hiddenAnnotationIds: new Set([annotation!.id])} : {}),
        });
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let bluePixels = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] === 0 && pixels[offset + 1] === 0 && pixels[offset + 2] === 255) bluePixels += 1;
        }
        return bluePixels;
    } finally {
        await loading.destroy();
    }
}

describe('usePdfCanvasRenderer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).document;
    });

    it('holds the raster until the canonical projection is ready', async () => {
        installCanvasDocument();
        const annotationProjectionReady = ref(false);
        const pdfPage = createPdfPage();
        const renderer = usePdfCanvasRenderer({
            outputScale: 1,
            annotationProjectionReady,
        });
        const rendering = renderer.renderCanvas(pdfPage as never, 1);
        await Promise.resolve();

        expect(pdfPage.render).not.toHaveBeenCalled();
        annotationProjectionReady.value = true;
        await rendering;
        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({annotationMode: AnnotationMode.ENABLE}));
    });

    it.each([
        {
            contentIntent: 'full-visible' as const,
            projectionReady: true,
            flags: 16,
            subtype: 'FreeText',
        },
        {
            contentIntent: 'canvas-only-buffer' as const,
            projectionReady: true,
            flags: 16,
            subtype: 'FreeText',
        },
        {
            contentIntent: 'canvas-only-refine' as const,
            projectionReady: true,
            flags: 16,
            subtype: 'FreeText',
        },
        {
            contentIntent: 'full-visible' as const,
            projectionReady: true,
            flags: 4,
            subtype: 'Widget',
        },
    ])('keeps $subtype appearance pixels in $contentIntent (ready=$projectionReady, flags=$flags)', async (scenario) => {
        expect(await renderedAppearancePixels(scenario)).toBeGreaterThan(100);
    });

    it('leaves an owned annotation out of the page raster', async () => {
        expect(await renderedAppearancePixels({hidden: true})).toBe(0);
    });

    it('applies the settled-render default canvas pixel budget', async () => {
        const {
            canvas,
            result,
        } = await renderScenario({
            outputScale: 2,
            rendererOptions: { defaultMaxCanvasPixels: 20_000 },
        });

        expect(canvas.width).toBe(200);
        expect(canvas.height).toBe(100);
        expect(canvas.style.width).toBe('200px');
        expect(canvas.style.height).toBe('100px');
        expect(result).toMatchObject({
            requestedPixels: 80_000,
            grantedPixels: 20_000,
            pixelScaleFactor: 0.5,
            wasClamped: true,
        });
    });

    it('lets explicit render options override the settled default canvas budget', async () => {
        const {
            canvas,
            result,
        } = await renderScenario({
            outputScale: 2,
            rendererOptions: { defaultMaxCanvasPixels: 80_000 },
            renderOptions: { maxCanvasPixels: 20_000 },
        });

        expect(canvas.width).toBe(200);
        expect(canvas.height).toBe(100);
        expect(result?.wasClamped).toBe(true);
    });

    it('never exceeds a strict canvas budget after axis rounding', async () => {
        const {
            canvas,
            result,
        } = await renderScenario({
            viewport: {
                width: 1_690,
                height: 2_187,
                userUnit: 1,
                rawDims: {
                    pageWidth: 1_690,
                    pageHeight: 2_187,
                },
            },
            renderOptions: { maxCanvasPixels: 2_500_000 },
        });

        expect(result?.grantedPixels).toBeLessThanOrEqual(2_500_000);
        expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_500_000);
    });

    it.each([
        {
            name: 'trusted raster source renders',
            rendererOptions: { defaultMaxCanvasPixels: 80_000 },
            renderOptions: {
                maxCanvasPixels: 50_000,
                sourceMaxPixels: 5_000,
            },
            outputScale: 2,
            zoom: 1,
            viewport: DEFAULT_VIEWPORT,
            expectedCanvas: [
                100,
                50,
            ],
            expectedResult: {
                requestedPixels: 80_000,
                grantedPixels: 5_000,
                wasClamped: true,
            },
        },
        {
            name: 'the Georgievsky raster page under high zoom and DPR',
            rendererOptions: { defaultMaxCanvasPixels: 64_000_000 },
            renderOptions: { sourceMaxPixels: 1293 * 1966 },
            outputScale: 2,
            zoom: 6,
            viewport: {
                width: 1861.92,
                height: 2831.04,
                userUnit: 1,
                rawDims: {
                    pageWidth: 310.32,
                    pageHeight: 471.84,
                },
            },
            expectedCanvas: [
                1293,
                1966,
            ],
            expectedResult: {
                requestedPixels: 21_085_288,
                grantedPixels: 2_542_038,
                wasClamped: true,
            },
        },
    ])('caps $name at source pixels', async ({
        expectedCanvas,
        expectedResult,
        ...scenario
    }) => {
        const {
            canvas,
            result,
        } = await renderScenario(scenario);

        expect([
            canvas.width,
            canvas.height,
        ]).toEqual(expectedCanvas);
        expect(result).toMatchObject(expectedResult);
    });

    it('uses the latest reactive output scale for future canvas sizing', async () => {
        const outputScale = ref(1);
        const { canvas } = installCanvasDocument();
        const pdfPage = createPdfPage();
        const renderer = usePdfCanvasRenderer({ outputScale });
        outputScale.value = 2;
        const result = await renderer.renderCanvas(pdfPage as never, 1);

        expect(canvas.width).toBe(400);
        expect(canvas.height).toBe(200);
        expect(result?.requestedPixels).toBe(80_000);
    });

    it('passes the effective page and view rotation to PDF.js', async () => {
        installCanvasDocument();
        const pdfPage = createPdfPage({rotate: 90});
        const renderer = usePdfCanvasRenderer({
            outputScale: 1,
            viewRotation: 90,
        });
        await renderer.renderCanvas(pdfPage as never, 1);

        expect(pdfPage.getViewport).toHaveBeenLastCalledWith({
            scale: 1,
            rotation: 180,
        });
    });

    it('replaces the existing page canvas without clearing sibling overlay layers', () => {
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        const nextCanvas = {} as HTMLCanvasElement;
        // This host models only the DOM methods used by mountCanvas.
        const canvasHost = Object.assign(Object.create(null), {
            prepend: vi.fn(),
            querySelector: vi.fn(() => null),
        });
        const previousCanvas = Object.assign(Object.create(null), {
            parentElement: canvasHost,
            replaceWith: vi.fn(),
        });
        renderer.mountCanvas(canvasHost, nextCanvas, previousCanvas);

        expect(previousCanvas.replaceWith).toHaveBeenCalledWith(nextCanvas);
        expect(canvasHost.prepend).not.toHaveBeenCalled();
    });

    it('cleans prepared canvases when renderCanvas fails before mounting', async () => {
        const { canvas } = installCanvasDocument();
        const renderError = new Error('cancelled');
        const pdfPage = createPdfPage({render: vi.fn(() => ({
            cancel: vi.fn(),
            promise: Promise.reject(renderError),
        }))});

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await expect(renderer.renderCanvas(pdfPage as never, 1)).rejects.toBe(renderError);
        expect([
            canvas.width,
            canvas.height,
        ]).toEqual([
            0,
            0,
        ]);
        expect(canvas.remove).toHaveBeenCalled();
    });

    it('does not allocate a canvas when preparation is aborted', async () => {
        const { createElement } = installCanvasDocument();
        const abortController = new AbortController();
        const pdfPage = createPdfPage({
            pageNumber: 4,
            render: vi.fn(),
        });
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        const preparePromise = renderer.prepareCanvasRender(pdfPage as never, 1, {
            hiddenAnnotationIds: new Set(['12R0']),
            pageRenderCoordination: {
                owner: 'viewer',
                priority: 100,
                signal: abortController.signal,
                shouldContinue: () => !abortController.signal.aborted,
            },
        });

        await Promise.resolve();
        abortController.abort();

        await expect(preparePromise).resolves.toBeNull();
        expect(createElement).not.toHaveBeenCalled();
        expect(pdfPage.render).not.toHaveBeenCalled();
        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
    });

    it('does not block canvas preparation on a separate operator-list request', async () => {
        const { createElement } = installCanvasDocument();
        const pdfPage = createPdfPage({
            pageNumber: 5,
            getOperatorList: vi.fn(() => new Promise(() => undefined)),
            render: vi.fn(),
        });
        const renderer = usePdfCanvasRenderer({outputScale: 1});
        const prepared = await renderer.prepareCanvasRender(pdfPage as never, 1, {hiddenAnnotationIds: new Set(['12R0'])});
        expect(prepared).toBeDefined();
        expect(createElement).toHaveBeenCalledOnce();
        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
        expect(pdfPage.render).not.toHaveBeenCalled();
    });
});
