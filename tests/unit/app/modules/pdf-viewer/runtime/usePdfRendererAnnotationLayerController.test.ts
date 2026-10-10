import type {IPdfPage} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
// @vitest-environment happy-dom

import {PDF_PAGE_RENDER_TIMEOUT_MS} from '@app/constants/timeouts';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { cast } from '@tests/helpers/cast';
import { usePdfRendererAnnotationLayerController } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRendererAnnotationLayerController';

function createHarness() {
    const container = document.createElement('div');
    const annotationLayerDiv = document.createElement('div');
    annotationLayerDiv.className = 'annotation-layer';
    container.append(annotationLayerDiv);

    const renderDeferred = Promise.withResolvers<null>();
    const renderSignals: AbortSignal[] = [];
    const annotationLayerRenderer = cast<Parameters<typeof usePdfRendererAnnotationLayerController>[0]['annotationLayerRenderer']>({renderAnnotationLayer: vi.fn((_page, _layer, _viewport, _pageNumber, _canvasMap, renderOptions) => {
        if (renderOptions?.signal) {
            renderSignals.push(renderOptions.signal);
        }
        return renderDeferred.promise;
    })});
    const controller = usePdfRendererAnnotationLayerController({
        annotationLayerRenderer,
        getRenderVersion: () => 1,
        cleanupPageIfCurrentRender: vi.fn(),
        logNonCriticalStageError: vi.fn(),
    });

    return {
        annotationLayerRenderer,
        container,
        controller,
        renderDeferred,
        renderSignals,
    };
}

describe('usePdfRendererAnnotationLayerController', () => {
    it('reports genuine rejected interaction without committing a successful continuation', async () => {
        const harness = createHarness();
        const error = new Error('annotation interaction failed');
        const render = harness.controller(requirePageNumber(1), 1, 1,
            cast<Parameters<typeof harness.controller>[3]>({
                container: harness.container,
                pdfPage: cast<IPdfPage>({}),
                renderResult: {
                    viewport: {
                        width: 100,
                        height: 100,
                        rotation: 0,
                    },
                    annotationCanvasMap: null,
                },
            }), () => true);
        harness.renderDeferred.reject(error);
        await expect(render).resolves.toMatchObject({
            shouldContinue: false,
            error,
        });
        expect(harness.container.querySelector('.annotation-layer')?.childElementCount).toBe(0);
    });

    it('settles a timed-out current annotation stage as failed interaction', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        try {
            const render = harness.controller(requirePageNumber(1), 1, 1,
                cast<Parameters<typeof harness.controller>[3]>({
                    container: harness.container,
                    pdfPage: cast<IPdfPage>({}),
                    renderResult: {
                        viewport: {
                            width: 100,
                            height: 100,
                            rotation: 0,
                        },
                        annotationCanvasMap: null,
                    },
                }), () => true);
            await vi.advanceTimersByTimeAsync(PDF_PAGE_RENDER_TIMEOUT_MS);
            const outcome = await render;
            expect(outcome.shouldContinue).toBe(false);
            expect(outcome.error).toBeInstanceOf(Error);
            expect(outcome.annotationLayerInstance).toBeNull();
        } finally {
            harness.renderDeferred.resolve(null);
            vi.useRealTimers();
        }
    });

    it('does not report a rejected annotation stage after its document is superseded', async () => {
        const harness = createHarness();
        let current = true;
        const render = harness.controller(requirePageNumber(1), 1, 1,
            cast<Parameters<typeof harness.controller>[3]>({
                container: harness.container,
                pdfPage: cast<IPdfPage>({}),
                renderResult: {
                    viewport: {
                        width: 100,
                        height: 100,
                        rotation: 0,
                    },
                    annotationCanvasMap: null,
                },
            }), () => current);
        current = false;
        harness.renderDeferred.reject(new Error('late old document failure'));
        await expect(render).resolves.toMatchObject({shouldContinue: false});
        expect(await render).not.toHaveProperty('error');
    });

    it('aborts active annotation work when a page is released', async () => {
        const harness = createHarness();
        const render = harness.controller(
            requirePageNumber(1),
            1,
            1,
            cast<Parameters<typeof harness.controller>[3]>({
                container: harness.container,
                pdfPage: cast<IPdfPage>({}),
                renderResult: {
                    viewport: {
                        width: 100,
                        height: 100,
                        rotation: 0,
                    },
                    annotationCanvasMap: null,
                },
                textLayerDiv: null,
            }),
            () => true,
        );

        await vi.waitFor(() => {
            expect(harness.annotationLayerRenderer.renderAnnotationLayer).toHaveBeenCalledOnce();
        });
        expect(harness.renderSignals[0]?.aborted).toBe(false);

        harness.controller.cancel(requirePageNumber(1));

        expect(harness.renderSignals[0]?.aborted).toBe(true);
        harness.renderDeferred.resolve(null);
        await expect(render).resolves.toMatchObject({shouldContinue: true});
    });

    it('registers page annotation controllers so dispose aborts direct renders', () => {
        const harness = createHarness();
        const editorController = new AbortController();

        const unregister = harness.controller.register(requirePageNumber(7), editorController);
        harness.controller.dispose();

        expect(editorController.signal.aborted).toBe(true);
        unregister();
    });

    it('aborts every registered page controller when the document is cleared', () => {
        const harness = createHarness();
        const first = new AbortController();
        const second = new AbortController();

        harness.controller.register(requirePageNumber(1), first);
        harness.controller.register(requirePageNumber(2), second);
        harness.controller.cancelAll();

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
    });
});
