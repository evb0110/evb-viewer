// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
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
        showAnnotations: ref(true),
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
    it('aborts active annotation work when a page is released', async () => {
        const harness = createHarness();
        const render = harness.controller(
            1,
            1,
            1,
            cast<Parameters<typeof harness.controller>[3]>({
                container: harness.container,
                pdfPage: cast<PDFPageProxy>({}),
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

        harness.controller.cancel(1);

        expect(harness.renderSignals[0]?.aborted).toBe(true);
        harness.renderDeferred.resolve(null);
        await expect(render).resolves.toMatchObject({shouldContinue: true});
    });

    it('registers page annotation controllers so dispose aborts direct renders', () => {
        const harness = createHarness();
        const editorController = new AbortController();

        const unregister = harness.controller.register(7, editorController);
        harness.controller.dispose();

        expect(editorController.signal.aborted).toBe(true);
        unregister();
    });

    it('aborts every registered page controller when the document is cleared', () => {
        const harness = createHarness();
        const first = new AbortController();
        const second = new AbortController();

        harness.controller.register(1, first);
        harness.controller.register(2, second);
        harness.controller.cancelAll();

        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(true);
    });
});
