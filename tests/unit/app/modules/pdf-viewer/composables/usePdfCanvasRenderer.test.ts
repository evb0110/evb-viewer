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
import { AnnotationMode } from '@app/services/pdfjs/runtimeLib';
import { usePdfCanvasRenderer } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCanvasRenderer';
import {cast} from '@tests/helpers/cast';

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

describe('usePdfCanvasRenderer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).document;
    });

    it('requests separate annotation canvases for appearance-backed annotations', async () => {
        const {
            canvas,
            pdfPage,
            result,
        } = await renderScenario();

        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({
            annotationMode: AnnotationMode?.ENABLE_FORMS ?? AnnotationMode?.ENABLE ?? 1,
            annotationCanvasMap: expect.any(Map),
            canvas,
        }));
        expect(result?.annotationCanvasMap).toBeInstanceOf(Map);
    });

    it('renders canvas-only buffers with filtered foreign annotation appearances', async () => {
        const { canvas } = installCanvasDocument();
        const pdfPage = createPdfPage({ getOperatorList: vi.fn() });
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        const result = await renderer.renderCanvas(pdfPage as never, 1, {
            contentIntent: 'canvas-only-buffer',
            hiddenAnnotationIds: new Set(['hidden']),
        });

        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({
            annotationMode: AnnotationMode.ENABLE_FORMS,
            operationsFilter: expect.any(Function),
            canvas,
        }));
        // Vitest records PDF.js render options as an untyped mock argument.
        const renderContext = pdfPage.render.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
        expect(renderContext).not.toHaveProperty('annotationCanvasMap');
        expect(result?.annotationCanvasMap).toBeNull();
    });

    it('disables annotation appearances while the canonical projection is pending', async () => {
        const { canvas } = installCanvasDocument();
        const annotationProjectionReady = ref(false);
        const pdfPage = createPdfPage({ getOperatorList: vi.fn() });
        const renderer = usePdfCanvasRenderer({
            outputScale: 1,
            annotationProjectionReady,
        });

        const result = await renderer.renderCanvas(pdfPage as never, 1);

        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
        expect(pdfPage.render).toHaveBeenCalledWith(expect.objectContaining({
            annotationMode: AnnotationMode.DISABLE,
            canvas,
        }));
        const renderContext = cast<Array<[Record<string, unknown>]>>(pdfPage.render.mock.calls)[0]?.[0];
        expect(renderContext).not.toHaveProperty('annotationCanvasMap');
        expect(result?.annotationCanvasMap).toBeNull();
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
        const annotationCanvas = {
            width: 32,
            height: 16,
            style: {} as CSSStyleDeclaration,
            remove: vi.fn(),
        };
        const renderError = new Error('cancelled');
        const pdfPage = createPdfPage({render: vi.fn((context: { annotationCanvasMap: Map<string, HTMLCanvasElement>; }) => {
            context.annotationCanvasMap.set('annotation-1', annotationCanvas as never);
            return {
                cancel: vi.fn(),
                promise: Promise.reject(renderError),
            };
        })});

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
        expect([
            annotationCanvas.width,
            annotationCanvas.height,
        ]).toEqual([
            0,
            0,
        ]);
        expect(annotationCanvas.remove).toHaveBeenCalled();
    });

    it('filters hidden annotation appearance ops out of the page canvas render', async () => {
        installCanvasDocument();
        const standaloneOperatorList = {
            fnArray: [
                80,
                999,
                81,
                80,
                999,
                81,
            ],
            argsArray: [
                ['keep-me'],
                [],
                [],
                ['12R'],
                [],
                [],
            ],
        };
        const renderOperatorList = {
            fnArray: [
                80,
                999,
                81,
                80,
                999,
                81,
            ],
            argsArray: [
                ['12R'],
                [],
                [],
                ['keep-me'],
                [],
                [],
            ],
        };
        let filteredIndices: boolean[] | undefined;
        const render = vi.fn((context: { operationsFilter?: (index: number) => boolean; }) => {
            const task = {
                cancel: vi.fn(),
                promise: Promise.resolve().then(() => {
                    filteredIndices = renderOperatorList.fnArray.map((_, index) => context.operationsFilter?.(index) ?? true);
                }),
                _internalRenderTask: {operatorList: renderOperatorList},
            };
            return task;
        });
        const pdfPage = createPdfPage({
            pageNumber: 3,
            getOperatorList: vi.fn(async () => standaloneOperatorList),
            render,
        });

        const renderer = usePdfCanvasRenderer({ outputScale: 1 });
        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R0']) });

        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
        expect(render).toHaveBeenCalledOnce();
        expect(filteredIndices).toEqual([
            false,
            false,
            false,
            true,
            true,
            true,
        ]);
    });

    it('recomputes the hidden annotation operations filter for changed page state', async () => {
        installCanvasDocument();
        const renderedOperatorLists = [
            {
                fnArray: [
                    80,
                    999,
                    81,
                    80,
                    999,
                    81,
                ],
                argsArray: [
                    ['keep-me'],
                    [],
                    [],
                    ['12R'],
                    [],
                    [],
                ],
            },
            {
                fnArray: [
                    80,
                    999,
                    81,
                ],
                argsArray: [
                    ['12R'],
                    [],
                    [],
                ],
            },
        ];
        const filteredIndices: boolean[][] = [];
        const render = vi.fn((context: { operationsFilter?: (index: number) => boolean; }) => {
            const operatorList = renderedOperatorLists.shift();
            if (!operatorList) {
                throw new Error('Expected a render operator list');
            }
            return {
                cancel: vi.fn(),
                promise: Promise.resolve().then(() => {
                    filteredIndices.push(operatorList.fnArray.map((_, index) => context.operationsFilter?.(index) ?? true));
                }),
                _internalRenderTask: {operatorList},
            };
        });
        const pdfPage = createPdfPage({
            pageNumber: 2,
            getOperatorList: vi.fn(async () => ({
                fnArray: [],
                argsArray: [],
            })),
            render,
        });
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R0']) });
        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R']) });

        expect(pdfPage.getOperatorList).not.toHaveBeenCalled();
        expect(render).toHaveBeenCalledTimes(2);
        expect(filteredIndices).toEqual([
            [
                true,
                true,
                true,
                false,
                false,
                false,
            ],
            [
                false,
                false,
                false,
            ],
        ]);
    });

    it('cancels the guarded render and disables annotation appearances when task binding is unavailable', async () => {
        installCanvasDocument();
        let rejectGuarded!: (reason: Error) => void;
        const guardedTask = {
            cancel: vi.fn(() => rejectGuarded(new Error('Rendering cancelled'))),
            promise: new Promise<void>((_resolve, reject) => { rejectGuarded = reject; }),
        };
        const fallbackTask = {
            cancel: vi.fn(),
            promise: Promise.resolve(),
        };
        let renderCount = 0;
        const render = vi.fn((_context: {
            annotationMode: number;
            operationsFilter?: (index: number) => boolean
        }) => {
            renderCount += 1;
            return renderCount === 1 ? guardedTask : fallbackTask;
        });
        const pdfPage = createPdfPage({render});
        const renderer = usePdfCanvasRenderer({ outputScale: 1 });

        await renderer.renderCanvas(pdfPage as never, 1, { hiddenAnnotationIds: new Set(['12R']) });

        expect(render).toHaveBeenCalledTimes(2);
        expect(guardedTask.cancel).toHaveBeenCalledOnce();
        expect(render.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            annotationMode: AnnotationMode.ENABLE_FORMS,
            operationsFilter: expect.any(Function),
        }));
        expect(render.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ annotationMode: AnnotationMode.DISABLE }));
        expect(render.mock.calls[1]?.[0]).not.toHaveProperty('operationsFilter');
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
