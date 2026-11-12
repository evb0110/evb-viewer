// @vitest-environment happy-dom

import { requirePageNumber } from '@contracts/pageNumbers';
import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    nextTick,
    ref,
    render,
} from 'vue';
import {
    createPdfPageResources,
    isPdfPageBusy,
    type IPdfPublicationReceipt,
    type IPdfRasterJob,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfPageResources';
import { cast } from '@tests/helpers/cast';
import type { TPdfViewRotation } from '@contracts/shared';
import type {
    IPdfLayerRenderResult,
    IUsePdfPageRendererOptions,
} from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { TPdfDocumentView } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { createPdfDocumentProxy } from '@tests/helpers/createPdfDocumentProxy';

const rendererFixture = vi.hoisted(() => ({
    canReuseTextLayer: vi.fn(() => false),
    renderTextLayer: vi.fn(),
    applyPageSearchHighlights: vi.fn(),
    cleanupTextLayerDom: vi.fn(),
    clearOcrDebug: vi.fn(),
    scheduleOcrDebugForPage: vi.fn(),
}));
const annotationLayerFixture = vi.hoisted(() => ({render: vi.fn()}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer', () => ({usePdfTextLayerRenderer: () => rendererFixture}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer', () => ({
    getParsedPageAnnotations: vi.fn(async () => []),
    isLinkAnnotation: (annotation: {annotationType: number}) => annotation.annotationType === 2,
    usePdfAnnotationLayerRenderer: () => ({
        cleanupEditorLayer: vi.fn(),
        clearAllLayers: vi.fn(),
        hideHiddenManagedEditors: vi.fn(),
        renderAnnotationEditorLayer: vi.fn(async () => undefined),
        renderAnnotationLayer: annotationLayerFixture.render,
    }),
}));
vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfRendererSearchController', () => ({usePdfRendererSearchController: () => ({
    applySearchHighlights: vi.fn(),
    invalidatePendingRequests: vi.fn(),
    requestScrollToCurrentResult: vi.fn(),
})}));

const toastAdd = vi.fn();
vi.stubGlobal('useToast', () => ({add: toastAdd}));
vi.stubGlobal('useTypedI18n', () => ({t: (key: string) => key}));
afterAll(() => vi.unstubAllGlobals());

const { usePdfPageRenderer } = await import(
    '@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer'
);

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}

type TPdfLeasedPage = Awaited<
    ReturnType<IUsePdfPageRendererOptions['document']['leasePage']>
>['page'];

function createPage(): TPdfLeasedPage {
    const page = {
        rotate: 0,
        getViewport: () => ({
            width: 600,
            height: 800,
            userUnit: 1,
            rawDims: {
                pageWidth: 600,
                pageHeight: 800,
            },
        }),
    };
    // PDF.js supplies the remaining page proxy methods outside this layer test.
    return Object.assign(Object.create(null), page);
}

function createDocumentFixture(page: TPdfLeasedPage, release: () => void): TPdfDocumentView {
    const fixture = {
        pdfDocument: computed(() => createPdfDocumentProxy()),
        numPages: ref(1),
        isLoading: ref(false),
        captureFence: () => ({
            loadToken: 1,
            documentVersion: 1,
            documentRevision: null,
            openSurfaceGeneration: 0,
        }),
        isCurrent: () => true,
        registerDisposable: vi.fn<(dispose: () => void | Promise<void>) => void>(),
        leasePage: vi.fn(async () => ({
            page,
            release,
        })),
    };
    // Rendering owns the page lease; this fixture omits unrelated session APIs.
    return Object.assign(Object.create(null), fixture);
}

function createViewportFixture(): TPdfViewportSession {
    const fixture = {
        scale: {effectiveScale: ref(1)},
        currentPage: ref(1),
        cancelPendingSearchRevision: ref(0),
        viewportWritePort: {},
        singlePageScroll: {
            viewportAuthority: {
                phase: ref('idle'),
                activeIntent: ref(null),
            },
            scrollToPage: vi.fn(),
            beginSearchNavigation: vi.fn(),
            revealSearchNavigationTarget: vi.fn(),
            endSearchNavigation: vi.fn(),
        },
        markUserViewportInteraction: vi.fn(),
        viewportWork: {
            beginWork: vi.fn(() => null),
            isWorkCurrent: vi.fn(() => false),
            settleWork: vi.fn(),
            cancelWork: vi.fn(),
        },
    };
    // The page renderer reads only these viewport controls.
    return Object.assign(Object.create(null), fixture);
}

function createHarness() {
    const root = document.createElement('div');
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    pageContainer.dataset.page = '1';
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    const annotationLayer = document.createElement('div');
    annotationLayer.className = 'annotation-layer';
    const canvas = document.createElement('canvas');
    pageContainer.append(canvas, textLayer, annotationLayer);
    root.append(pageContainer);
    document.body.append(root);

    const page = createPage();
    const release = vi.fn();
    const documentSession = createDocumentFixture(page, release);
    const pageResources = createPdfPageResources();
    const onRenderedPageStateChanged = vi.fn();
    const onPageLayersCommitted = vi.fn(() => textLayer.textContent);
    const rendererOptions: IUsePdfPageRendererOptions = {
        container: ref(root),
        document: documentSession,
        viewport: createViewportFixture(),
        pageResources,
        getCommittedRender: () => committedRender,
        onRenderedPageStateChanged,
        onPageLayersCommitted,
        requestSearchPageRaster: vi.fn(async () => undefined),
    };
    const renderer = usePdfPageRenderer(rendererOptions);
    const renderResult = {
        canvas,
        viewport: page.getViewport({scale: 1}),
        annotationCanvasMap: null,
        annotationOutput: Object.freeze({
            annotationMode: 1,
            requestedSeparateCanvas: false,
            separateAnnots: false,
            ownCanvases: Object.freeze([]),
        }),
        scaleX: 1,
        scaleY: 1,
        rawDims: {
            pageWidth: 600,
            pageHeight: 800,
        },
        userUnit: 1,
        totalScaleFactor: 1,
    };
    let committedRender = renderResult;
    return {
        setCommittedRender: (value: typeof renderResult) => { committedRender = value; },
        canvas,
        document: documentSession,
        onRenderedPageStateChanged,
        onPageLayersCommitted,
        pageContainer,
        pageResources,
        page,
        release,
        renderer,
        renderResult,
        root,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    annotationLayerFixture.render.mockResolvedValue(null);
});

const page1 = requirePageNumber(1);

function createJob(): IPdfRasterJob {
    return {
        requestId: 11,
        demand: cast<IPdfRasterJob['demand']>({pageNumber: page1, renderKey: String(Math.random())}),
        rasterIdentity: 'identity',
        rasterState: 'in-flight',
        renderOptions: {},
        targetOutputScale: 1,
        targetScale: 1,
        targetViewRotation: 0,
    };
}

function publication(harness: ReturnType<typeof createHarness>, layers: IPdfPublicationReceipt['layers'], render: IPdfLayerRenderResult = harness.renderResult): IPdfPublicationReceipt {
    return {
        render,
        quality: {requestedPixels: 1, grantedPixels: 1, pixelScaleFactor: 1, wasClamped: false, intent: 'settled'},
        container: harness.pageContainer,
        documentToken: 'document-a',
        version: 1,
        layers,
    };
}

/** Shows the harness raster on page 1 with canvas-only layers, as a buffered raster does. */
function showRaster(harness: ReturnType<typeof createHarness>) {
    const job = createJob();
    harness.pageResources.want(page1, job);
    harness.pageResources.beginRaster(page1, job, harness.pageContainer);
    harness.pageResources.publish(page1, job, publication(harness, 'canvas-only'));
    return job;
}

describe('usePdfPageRenderer layer hydration ownership', () => {
    it.each([
        false,
        true,
    ])('keeps failed annotation interaction readable and out of automatic promotion (text-first=%s)', async (textFirst) => {
        annotationLayerFixture.render.mockRejectedValueOnce(new Error('annotation failure'));
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        try {
            showRaster(harness);
            await harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {prioritizeTextLayer: textFirst},
            });
            expect(harness.canvas.isConnected).toBe(true);
            expect(harness.pageResources.get(page1).layers).toBe('failed');
            expect(harness.pageResources.get(page1).text?.dataset.pdfTextLayerReady).toBe('true');
            expect(harness.pageContainer.dataset.pageLayerReadiness).toBe('failed');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
            // A quality refinement can replace the raster while this failure
            // remains current. Retry belongs to the document, not that old canvas.
            const currentCanvas = document.createElement('canvas');
            harness.canvas.replaceWith(currentCanvas);
            harness.setCommittedRender({
                ...harness.renderResult,
                canvas: currentCanvas,
            });
            const retry = toastAdd.mock.calls[0]?.[0].actions.find((action: {label: string}) => action.label === 'common.retry');
            expect(retry).toBeDefined();
            retry.onClick();
            await vi.waitFor(() => expect(harness.pageResources.get(page1).layers).toBe('ready'));
            expect(currentCanvas.isConnected).toBe(true);
            expect(harness.pageResources.get(page1).layers).toBe('ready');
            expect(harness.pageContainer.dataset.pageLayerReadiness).toBe('ready');
        } finally {harness.root.remove();}
    });

    it('tells a page whose raster failed for good, with a Retry that redraws it', async () => {
        const harness = createHarness();
        const isCurrent = vi.fn(() => true);
        harness.document.isCurrent = isCurrent;
        const retry = vi.fn(async () => undefined);
        try {
            harness.renderer.presentPageRenderFailure(requirePageNumber(1), new Error('canvas render failed'), retry);
            const cancelled = Object.assign(new Error('cancelled'), {name: 'RenderingCancelledException'});
            harness.renderer.presentPageRenderFailure(requirePageNumber(1), cancelled, retry);

            expect(toastAdd).toHaveBeenCalledOnce();
            const toast = toastAdd.mock.calls[0]?.[0];
            expect(toast.title).toBe('common.pdfPage:{"page":1}');
            const description = document.createElement('div');
            render(toast.description(), description);
            expect(description.textContent).toContain('common.pageRenderFailed');
            const retryAction = toast.actions.find((action: {label: string}) => action.label === 'common.retry');
            retryAction.onClick();
            await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());

            // Another document is open now: its pages are not this failure's to redraw.
            isCurrent.mockReturnValue(false);
            retryAction.onClick();
            await Promise.resolve();
            expect(retry).toHaveBeenCalledOnce();
        } finally {harness.root.remove();}
    });

    it.each([
        false,
        true,
    ])('delays a buffered raster failure until it is visible and still current (superseded: %s)', async (superseded) => {
        const harness = createHarness();
        const visible = ref(false);
        const retry = vi.fn(async () => undefined);
        const pageNumber = requirePageNumber(1);
        const job = createJob();
        harness.pageResources.want(pageNumber, job);
        harness.pageResources.setJobState(pageNumber, job, 'failed');
        try {
            harness.renderer.presentPageRenderFailure(pageNumber, new Error('buffer preparation failed'), retry, () => visible.value);
            expect(toastAdd).not.toHaveBeenCalled();
            if (superseded) harness.pageResources.release(pageNumber);
            visible.value = true;
            await nextTick();
            if (superseded) {
                expect(toastAdd).not.toHaveBeenCalled();
            } else {
                expect(toastAdd).toHaveBeenCalledOnce();
                const toast = toastAdd.mock.calls[0]![0];
                const description = document.createElement('div');
                render(toast.description(), description);
                expect(description.textContent).toContain('common.pageRenderFailed');
                toast.actions.find((action: {label: string}) => action.label === 'common.retry').onClick();
                await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
                visible.value = false;
                await nextTick();
                visible.value = true;
                await nextTick();
                expect(toastAdd).toHaveBeenCalledOnce();
            }
        } finally {
            for (const [dispose] of vi.mocked(harness.document.registerDisposable).mock.calls) await dispose();
            harness.root.remove();
        }
    });

    it('publishes a page layer commit with its selectable text already present', async () => {
        const text = createDeferred();
        const harness = createHarness();
        rendererFixture.renderTextLayer.mockImplementation(async () => {
            await text.promise;
            harness.pageContainer.querySelector('.text-layer')!.textContent = 'Selectable rotation text';
        });
        let hydration: Promise<void> | null = null;
        try {
            showRaster(harness);
            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
            });
            await vi.waitFor(() => expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce());
            expect(harness.onPageLayersCommitted).not.toHaveBeenCalled();
            text.resolve();
            await hydration;
            expect(harness.onPageLayersCommitted.mock.results.map(result => result.value)).toEqual(['Selectable rotation text']);
        } finally {
            text.resolve();
            await hydration;
            harness.root.remove();
        }
    });

    it('retains outgoing text and canvas while replacement text is in flight', async () => {
        const deferred = createDeferred();
        let activeSignal: AbortSignal | undefined;
        rendererFixture.renderTextLayer.mockImplementation(async (...args: unknown[]) => {
            const target = args[1] as HTMLElement;
            target.textContent = '';
            activeSignal = args[3] as AbortSignal;
            await deferred.promise;
            target.textContent = 'Replacement selectable text';
        });
        const harness = createHarness();
        const replacementCanvas = document.createElement('canvas');
        harness.pageContainer.querySelector('.text-layer')!.textContent = 'Outgoing selectable text';
        let hydration: Promise<void> | null = null;
        try {
            showRaster(harness);
            const ready = harness.pageResources.beginHydration(page1);
            harness.pageResources.beginLayers(page1, ready);
            harness.pageResources.markText(page1, ready, harness.pageContainer.querySelector<HTMLElement>('.text-layer')!);
            harness.pageResources.settleHydration(page1, ready, 'ready');
            const replacement = createJob();
            harness.pageResources.want(page1, replacement);
            harness.pageResources.beginRaster(page1, replacement, harness.pageContainer);
            const replacementRender = {
                ...harness.renderResult,
                canvas: replacementCanvas,
            };

            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: replacementRender,
                renderOptions: {},
            }, (layers) => {
                if (!harness.pageResources.publish(page1, replacement, publication(harness, layers, replacementRender))) return false;
                harness.canvas.replaceWith(replacementCanvas);
                return true;
            });
            await vi.waitFor(() => {
                expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce();
            });

            expect(harness.pageContainer.querySelector('canvas')).toBe(harness.canvas);
            expect(harness.pageContainer.querySelector('.text-layer')?.textContent).toBe('Outgoing selectable text');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
            await harness.renderer.renderLayerPromotions({
                start: 1,
                end: 1,
            }, {
                contentIntent: 'layers-only-promotion',
                rasterDemandPages: [1],
                prioritizeTextLayer: true,
            });
            expect(activeSignal?.aborted).toBe(false);

            deferred.resolve();
            await hydration;
            expect(harness.pageContainer.querySelector('canvas')).toBe(replacementCanvas);
            expect(harness.pageContainer.querySelector('.text-layer')?.textContent).toBe('Replacement selectable text');
            expect(harness.pageResources.get(page1).text?.dataset.pdfTextLayerReady).toBe('true');
            expect(harness.pageResources.get(page1).layers).toBe('ready');
            expect(harness.pageContainer.dataset.pageLayerReadiness).toBe('ready');
        } finally {
            deferred.resolve();
            await hydration?.catch(() => undefined);
            harness.root.remove();
        }
    });

    it('publishes text readiness before text-first annotation hydration settles', async () => {
        const annotation = createDeferred();
        annotationLayerFixture.render.mockImplementationOnce(async () => {
            await annotation.promise;
            return null;
        });
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        let hydration: Promise<void> | null = null;
        try {
            showRaster(harness);

            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {prioritizeTextLayer: true},
            });

            await vi.waitFor(() => expect(
                harness.pageResources.get(page1).text?.dataset.pdfTextLayerReady,
            ).toBe('true'));
            expect(harness.pageResources.get(page1).layers).toBe('hydrating');

            annotation.resolve();
            await hydration;
            expect(harness.pageResources.get(page1).layers).toBe('ready');
        } finally {
            annotation.resolve();
            await hydration?.catch(() => undefined);
            harness.root.remove();
        }
    });

    it.each([
        false,
        true,
    ])('keeps PDF links readable after text failure and restores text on Retry (staged=%s)', async (staged) => {
        rendererFixture.renderTextLayer
            .mockRejectedValueOnce(new Error('text extraction failed'))
            .mockResolvedValue(undefined);
        const harness = createHarness();
        const appearance = document.createElement('canvas');
        const renderResult = {
            ...harness.renderResult,
            annotationOutput: {
                ...harness.renderResult.annotationOutput,
                ownCanvases: staged ? [[
                    'link',
                    appearance,
                ] as const] : [],
            },
        };
        annotationLayerFixture.render.mockImplementation(async (_page, layer: HTMLElement) => {
            const link = document.createElement('a');
            link.href = 'https://example.test/';
            link.textContent = 'PDF link';
            layer.append(link, appearance);
            return null;
        });
        try {
            const job = showRaster(harness);

            await harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult,
                renderOptions: {prioritizeTextLayer: true},
            }, staged ? layers => harness.pageResources.publish(page1, job, publication(harness, layers, renderResult)) : undefined);

            const link = harness.pageContainer.querySelector('a');
            expect(link?.textContent).toBe('PDF link');
            expect(link?.getAttribute('href')).toBe('https://example.test/');
            expect(link?.isConnected).toBe(true);

            // The failure is settled: the canvas stays, and no frame promotes
            // the page again by itself.
            expect(harness.canvas.isConnected).toBe(true);
            expect(harness.pageResources.get(page1).layers).toBe('failed');
            expect(harness.pageContainer.dataset.pageLayerReadiness).toBe('failed');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
            expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce();

            const retry = toastAdd.mock.calls[0]?.[0].actions.find((action: {label: string}) => action.label === 'common.retry');
            expect(retry).toBeDefined();
            retry.onClick();
            await vi.waitFor(() => expect(harness.pageResources.get(page1).layers).toBe('ready'));
            expect(harness.pageResources.get(page1).text?.dataset.pdfTextLayerReady).toBe('true');
        } finally {
            harness.root.remove();
        }
    });

    it('does not redo readable text after annotation hydration is cancelled', async () => {
        const annotation = createDeferred();
        annotationLayerFixture.render.mockImplementationOnce(async () => {
            await annotation.promise;
            return null;
        });
        const cancellation = new AbortController();
        // Each text render replaces the layer's spans, so a redo would drop the selectable nodes.
        rendererFixture.renderTextLayer.mockImplementation(async (...args: unknown[]) => {
            const span = document.createElement('span');
            span.textContent = 'Readable selectable text';
            (args[1] as HTMLElement).replaceChildren(span);
        });
        const harness = createHarness();
        let hydration: Promise<void> | null = null;
        try {
            showRaster(harness);
            hydration = harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
                signal: cancellation.signal,
            });
            await vi.waitFor(() => expect(annotationLayerFixture.render).toHaveBeenCalledOnce());
            const readable = harness.pageContainer.querySelector('.text-layer span');
            await harness.renderer.promoteTextLayers([1]);
            cancellation.abort();
            annotation.resolve();
            await hydration;
            for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
            expect(readable?.textContent).toBe('Readable selectable text');
            expect(harness.pageContainer.querySelector('.text-layer span')).toBe(readable);
        } finally {
            annotation.resolve();
            await hydration;
            harness.root.remove();
        }
    });

    it('promotes a settled canvas-only page exactly once with text-first priority', async () => {
        rendererFixture.renderTextLayer.mockResolvedValue(undefined);
        const harness = createHarness();
        try {
            showRaster(harness);

            const promotion = harness.renderer.resolveLayerPromotionDemand([1]);
            expect(promotion).not.toBeNull();
            await harness.renderer.renderLayerPromotions(promotion!.range, {
                ...promotion!.options,
                prioritizeTextLayer: true,
            });

            expect(rendererFixture.renderTextLayer).toHaveBeenCalledOnce();
            expect(harness.pageResources.get(page1).layers).toBe('ready');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).toBeNull();
        } finally {
            harness.root.remove();
        }
    });

    it('does not strand a page when lease acquisition rejects', async () => {
        const harness = createHarness();
        vi.mocked(harness.document.leasePage).mockRejectedValueOnce(new Error('stale document'));
        try {
            showRaster(harness);

            await expect(harness.renderer.renderLayerPromotions({
                start: 1,
                end: 1,
            }, {
                contentIntent: 'layers-only-promotion',
                rasterDemandPages: [1],
                prioritizeTextLayer: true,
            })).rejects.toThrow('stale document');

            expect(harness.pageResources.get(page1).layers).toBe('canvas-only');
            expect(harness.renderer.resolveLayerPromotionDemand([1])).not.toBeNull();
        } finally {
            harness.root.remove();
        }
    });
    it.each([
        'Rendering cancelled: PDF page lease became stale',
        'Rendering cancelled: PDF page request became stale',
    ])('settles a committed page without layers when its layer lease is cancelled: %s', async (message) => {
        const harness = createHarness();
        const cancelled = new Error(message);
        cancelled.name = 'RenderingCancelledException';
        vi.mocked(harness.document.leasePage).mockRejectedValueOnce(cancelled);
        try {
            showRaster(harness);

            await expect(harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
            })).resolves.toBeUndefined();

            expect(harness.pageResources.get(page1).layers).not.toBe('hydrating');
            expect(isPdfPageBusy(harness.pageResources.get(page1))).toBe(false);
            expect(harness.renderer.resolveLayerPromotionDemand([1])).not.toBeNull();
        } finally {
            harness.root.remove();
        }
    });

    it('still rejects committed layer hydration when the lease fails for another reason', async () => {
        const harness = createHarness();
        vi.mocked(harness.document.leasePage).mockRejectedValueOnce(new Error('page proxy destroyed'));
        try {
            showRaster(harness);

            await expect(harness.renderer.renderCommittedPageLayers({
                pageNumber: requirePageNumber(1),
                container: harness.pageContainer,
                renderResult: harness.renderResult,
                renderOptions: {},
            })).rejects.toThrow('page proxy destroyed');
            expect(isPdfPageBusy(harness.pageResources.get(page1))).toBe(false);
        } finally {
            harness.root.remove();
        }
    });
});

const resourcePage = requirePageNumber(4);

function createResourceJob(targetScale = 1, targetViewRotation: TPdfViewRotation = 0): IPdfRasterJob {
    return {
        requestId: Math.random(),
        demand: cast<IPdfRasterJob['demand']>({pageNumber: resourcePage, renderKey: String(Math.random())}),
        rasterIdentity: 'identity',
        rasterState: 'in-flight',
        renderOptions: {},
        targetOutputScale: 1,
        targetScale,
        targetViewRotation,
    };
}

function resourceReceipt(container: HTMLElement, overrides: Partial<IPdfPublicationReceipt> = {}): IPdfPublicationReceipt {
    return {
        render: cast<IPdfLayerRenderResult>({canvas: document.createElement('canvas')}),
        quality: {requestedPixels: 4, grantedPixels: 4, pixelScaleFactor: 1, wasClamped: false, intent: 'settled'},
        container,
        documentToken: 'document-a',
        version: 1,
        layers: 'hydrating',
        ...overrides,
    };
}

function showResourcePage(resources: ReturnType<typeof createPdfPageResources>, container: HTMLElement, job = createResourceJob()) {
    resources.want(resourcePage, job);
    resources.beginRaster(resourcePage, job, container);
    resources.publish(resourcePage, job, resourceReceipt(container));
    return job;
}

describe('pdf page resources', () => {
    it('keeps old pixels while a same-container replacement renders and blanks a remounted page', () => {
        const resources = createPdfPageResources();
        const container = document.createElement('div');
        showResourcePage(resources, container, createResourceJob(1, 0));
        const rotated = createResourceJob(1, 90);
        resources.want(resourcePage, rotated);
        resources.beginRaster(resourcePage, rotated, container);
        expect(resources.get(resourcePage).shown?.targetViewRotation).toBe(0);
        expect(resources.publish(resourcePage, rotated, resourceReceipt(container))).toBe(true);
        expect(resources.get(resourcePage).shown?.targetViewRotation).toBe(90);

        const remounted = createResourceJob();
        resources.want(resourcePage, remounted);
        resources.beginRaster(resourcePage, remounted, document.createElement('div'));
        expect(resources.get(resourcePage).shown).toBeNull();
    });

    it('publishes only the wanted job and keeps old pixels through a failed replacement', () => {
        const resources = createPdfPageResources();
        const container = document.createElement('div');
        const first = showResourcePage(resources, container);
        const shown = resources.get(resourcePage).shown;
        const successor = createResourceJob(2);
        resources.want(resourcePage, successor);
        expect(resources.publish(resourcePage, first, resourceReceipt(container))).toBe(false);
        resources.beginRaster(resourcePage, successor, container);
        resources.setJobState(resourcePage, successor, 'failed');
        expect(resources.get(resourcePage).shown).toBe(shown);
        expect(resources.get(resourcePage).job?.rasterState).toBe('failed');
    });

    it('lets a quality refine keep ready layers and a buffer raster start canvas-only', () => {
        const resources = createPdfPageResources();
        const container = document.createElement('div');
        const job = createResourceJob();
        resources.want(resourcePage, job);
        resources.publish(resourcePage, job, resourceReceipt(container, {layers: 'canvas-only'}));
        expect(resources.get(resourcePage)).toMatchObject({layers: 'canvas-only', text: null});
        expect(container.dataset.pageLayerReadiness).toBe('canvas-only');

        const hydration = resources.beginHydration(resourcePage);
        resources.beginLayers(resourcePage, hydration);
        const textLayer = document.createElement('div');
        resources.markText(resourcePage, hydration, textLayer);
        resources.settleHydration(resourcePage, hydration, 'ready');
        expect(resources.get(resourcePage)).toMatchObject({layers: 'ready', text: textLayer, hydration: null});
        expect(textLayer.dataset.pdfTextLayerReady).toBe('true');

        const refine = createResourceJob();
        resources.want(resourcePage, refine);
        resources.publish(resourcePage, refine, resourceReceipt(container, {layers: 'retain'}));
        expect(resources.get(resourcePage)).toMatchObject({layers: 'ready', text: textLayer});
        expect(container.dataset.pageLayerReadiness).toBe('ready');
    });

    it('gives layer work one owner and leaves unsettled layers canvas-only when it ends', () => {
        const resources = createPdfPageResources();
        const container = document.createElement('div');
        showResourcePage(resources, container);
        const first = resources.beginHydration(resourcePage);
        expect(isPdfPageBusy(resources.get(resourcePage))).toBe(true);
        const second = resources.beginHydration(resourcePage);
        expect(first.controller.signal.aborted).toBe(true);
        expect(resources.markText(resourcePage, first, document.createElement('div'))).toBe(false);
        expect(resources.settleHydration(resourcePage, first, 'ready')).toBe(false);
        expect(resources.get(resourcePage).hydration).toBe(second);

        expect(resources.settleHydration(resourcePage, second, 'ready')).toBe(true);
        // Ready layers need ready text; without it the page stays promotable.
        expect(resources.get(resourcePage).layers).toBe('canvas-only');
        expect(isPdfPageBusy(resources.get(resourcePage))).toBe(false);
    });

    it('re-authorizes shown pixels on a new version, except the pages it excludes', () => {
        const resources = createPdfPageResources();
        const container = document.createElement('div');
        showResourcePage(resources, container);
        const other = requirePageNumber(5);
        const otherJob = {...createResourceJob(), demand: cast<IPdfRasterJob['demand']>({pageNumber: other, renderKey: 'other'})};
        resources.want(other, otherJob);
        resources.publish(other, otherJob, resourceReceipt(document.createElement('div')));
        const hydration = resources.beginHydration(resourcePage);

        resources.reauthorize(2, 'document-b', new Set([other]), true);

        expect(hydration.controller.signal.aborted).toBe(true);
        expect(resources.get(resourcePage)).toMatchObject({job: null, hydration: null, layers: 'canvas-only'});
        expect(resources.get(resourcePage).shown).toMatchObject({version: 2, documentToken: 'document-b'});
        expect(resources.get(other).shown).toMatchObject({version: 1, documentToken: 'document-a'});
    });

    it('drops a released page with its layer owner', () => {
        const resources = createPdfPageResources();
        showResourcePage(resources, document.createElement('div'));
        const hydration = resources.beginHydration(resourcePage);
        resources.release(resourcePage);
        expect(hydration.controller.signal.aborted).toBe(true);
        expect(resources.resources.has(resourcePage)).toBe(false);
        resources.want(resourcePage, createResourceJob());
        resources.want(resourcePage, null);
        expect(resources.resources.has(resourcePage)).toBe(false);
    });
});
