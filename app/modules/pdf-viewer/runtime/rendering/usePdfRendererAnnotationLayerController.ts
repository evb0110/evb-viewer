import type { MaybeRefOrGetter } from 'vue';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { usePdfAnnotationLayerRenderer } from '@app/modules/pdf-viewer/runtime/rendering/usePdfAnnotationLayerRenderer';
import { PDF_PAGE_RENDER_TIMEOUT_MS } from '@app/constants/timeouts';
import { withPageStageTimeout } from '@app/modules/pdf-viewer/engine/pdf-page-render-timeout/withPageStageTimeout';
import type { IPdfRenderSupervisor } from '@app/modules/pdf-viewer/engine/pdf-render-supervisor/pdfRenderSupervisor';

type TAnnotationLayerInstance = Awaited<
    ReturnType<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>
> | null;

interface IAnnotationRenderContext {
    container: HTMLElement;
    pdfPage: PDFPageProxy;
    renderResult: {
        viewport: Parameters<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>[2];
        annotationCanvasMap: Parameters<ReturnType<typeof usePdfAnnotationLayerRenderer>['renderAnnotationLayer']>[4];
    };
    preserveCanvasOnStale?: boolean;
}

interface IUsePdfRendererAnnotationLayerControllerOptions {
    annotationLayerRenderer: ReturnType<typeof usePdfAnnotationLayerRenderer>;
    showAnnotations: MaybeRefOrGetter<boolean>;
    getRenderVersion: () => number;
    cleanupPageIfCurrentRender: (pageNumber: number, version: number, requestId?: number) => void;
    logNonCriticalStageError: (pageNumber: number, stage: string, error: unknown) => void;
    renderSupervisor?: IPdfRenderSupervisor | undefined;
}

interface IPdfRendererAnnotationLayerController {
    cancel(pageNumber: number): void;
    cancelAll(): void;
    dispose(): void;
    register(pageNumber: number, controller: AbortController): () => void;
}

export const usePdfRendererAnnotationLayerController = (options: IUsePdfRendererAnnotationLayerControllerOptions) => {
    const {
        annotationLayerRenderer,
        showAnnotations,
        getRenderVersion,
        cleanupPageIfCurrentRender,
        logNonCriticalStageError,
    } = options;
    const activeAnnotationLayerAbortControllers = new Map<number, AbortController>();
    let disposed = false;

    function register(pageNumber: number, controller: AbortController) {
        activeAnnotationLayerAbortControllers.get(pageNumber)?.abort();
        activeAnnotationLayerAbortControllers.set(pageNumber, controller);
        if (disposed) {
            controller.abort();
        }
        return () => releaseAnnotationLayerAbortController(pageNumber, controller);
    }

    function releaseAnnotationLayerAbortController(pageNumber: number, controller: AbortController) {
        if (activeAnnotationLayerAbortControllers.get(pageNumber) === controller) {
            activeAnnotationLayerAbortControllers.delete(pageNumber);
        }
    }

    function cancel(pageNumber: number) {
        const controller = activeAnnotationLayerAbortControllers.get(pageNumber);
        if (!controller) {
            return;
        }
        activeAnnotationLayerAbortControllers.delete(pageNumber);
        controller.abort();
    }

    function cancelAll() {
        for (const [
            pageNumber,
            controller,
        ] of activeAnnotationLayerAbortControllers) {
            activeAnnotationLayerAbortControllers.delete(pageNumber);
            controller.abort();
        }
    }

    function dispose() {
        disposed = true;
        cancelAll();
    }

    async function renderAnnotationLayersForPage(
        pageNumber: number,
        version: number,
        requestId: number,
        context: IAnnotationRenderContext,
        shouldContinue: () => boolean,
    ) {
        const {
            container,
            pdfPage,
            renderResult,
            preserveCanvasOnStale = false,
        } = context;
        if (disposed) {
            return {
                shouldContinue: false,
                annotationLayerInstance: null,
            };
        }
        const {
            viewport,
            annotationCanvasMap,
        } = renderResult;
        const annotationLayerDiv =
            container.querySelector<HTMLElement>('.annotation-layer');
        let annotationLayerInstance: TAnnotationLayerInstance = null;
        if (annotationLayerDiv && toValue(showAnnotations)) {
            if (getRenderVersion() !== version || !shouldContinue()) {
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }

            const annotationAbortController = new AbortController();
            const releaseAnnotationAbortController = register(pageNumber, annotationAbortController);
            try {
                annotationLayerInstance =
                    await withPageStageTimeout(
                        annotationLayerRenderer.renderAnnotationLayer(
                            pdfPage,
                            annotationLayerDiv,
                            viewport,
                            pageNumber,
                            annotationCanvasMap,
                            {
                                documentVersion: version,
                                signal: annotationAbortController.signal,
                                shouldContinue,
                            },
                        ),
                        {
                            pageNumber,
                            stage: 'annotation-layer',
                            timeoutMs: PDF_PAGE_RENDER_TIMEOUT_MS,
                        },
                        () => getRenderVersion() === version && shouldContinue(),
                        () => annotationAbortController.abort(),
                        undefined,
                        options.renderSupervisor,
                        annotationAbortController.signal,
                    );
            } catch (annotationError) {
                logNonCriticalStageError(
                    pageNumber,
                    'annotation layer',
                    annotationError,
                );
            } finally {
                releaseAnnotationAbortController();
            }

            if (getRenderVersion() !== version || !shouldContinue()) {
                if (!preserveCanvasOnStale) {
                    cleanupPageIfCurrentRender(pageNumber, version, requestId);
                }
                return {
                    shouldContinue: false,
                    annotationLayerInstance: null,
                };
            }
        }

        if (getRenderVersion() !== version || !shouldContinue()) {
            if (!preserveCanvasOnStale) {
                cleanupPageIfCurrentRender(pageNumber, version, requestId);
            }
            return {
                shouldContinue: false,
                annotationLayerInstance: null,
            };
        }

        return {
            shouldContinue: true,
            annotationLayerInstance,
        };
    }

    return Object.assign(renderAnnotationLayersForPage, {
        cancel,
        cancelAll,
        dispose,
        register,
    }) satisfies IPdfRendererAnnotationLayerController;
};
