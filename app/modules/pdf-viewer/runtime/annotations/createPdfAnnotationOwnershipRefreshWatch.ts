import type {Ref} from 'vue';
import type {TPdfRenderingSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import type {TPdfViewportSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {runGuardedTask} from '@app/utils/asyncGuard';
import {tryOnScopeDispose} from '@vueuse/core';

export function createPdfAnnotationOwnershipRefreshWatch(options: {
    documentSession: TPdfDocumentSession;
    viewport: TPdfViewportSession;
    rendering: TPdfRenderingSession;
    storeOwnedPdfAnnotationIds: Ref<ReadonlySet<string>>;
    annotationProjectionReady: Ref<boolean>;
    nextTick: () => Promise<void>;
}) {
    let refreshQueued = false;
    let refreshRunning = false;
    let disposed = false;

    tryOnScopeDispose(() => {
        disposed = true;
        refreshQueued = false;
    });

    function scheduleRefresh() {
        if (disposed) {
            return;
        }
        refreshQueued = true;
        if (refreshRunning) {
            return;
        }

        refreshRunning = true;
        runGuardedTask(async () => {
            try {
                while (refreshQueued && !disposed) {
                    refreshQueued = false;
                    const pdfDocument = options.documentSession.pdfDocument.value;
                    if (!pdfDocument) {
                        continue;
                    }
                    await options.nextTick();
                    if (disposed || options.documentSession.pdfDocument.value !== pdfDocument) {
                        continue;
                    }
                    const range = options.viewport.visibleRange.value;
                    if (range.start > range.end) {
                        continue;
                    }
                    await options.rendering.renderVisiblePages(range, {
                        preserveRenderedPages: true,
                        forceRerender: true,
                        bufferOverride: 0,
                    });
                    if (disposed || options.documentSession.pdfDocument.value !== pdfDocument) {
                        continue;
                    }
                }
            } finally {
                refreshRunning = false;
                if (!disposed && refreshQueued) {
                    scheduleRefresh();
                }
            }
        }, {
            category: 'background-diagnostic',
            scope: 'pdf-annotations',
            message: 'Failed to refresh PDF annotation ownership projection',
        });
    }

    return watch(
        [
            options.storeOwnedPdfAnnotationIds,
            options.annotationProjectionReady,
        ],
        scheduleRefresh,
        {
            flush: 'post',
            immediate: true,
        },
    );
}
