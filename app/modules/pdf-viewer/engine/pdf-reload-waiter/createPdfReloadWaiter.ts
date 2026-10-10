import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type { Ref } from 'vue';
import { until } from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IPdfReloadWaiterViewer } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
import { BrowserLogger } from '@app/utils/browserLogger';

const PDF_DOCUMENT_RELOAD_TIMEOUT_MS = 8000;
const PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS = 30000;
const PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS = 30000;

interface ICreatePdfReloadWaiterOptions {
    pdfDocument: Ref<IPdfDocument | null>;
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    openSurface?: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
    resetSearchCache: () => void;
    pageToRestore: number;
    restoreScroll?: boolean;
}

function logReloadWaiterRecovery(step: string, error: unknown) {
    BrowserLogger.warn('loader', `Recovered from PDF reload waiter ${step} failure`, { error });
}

function restoreReloadScroll(
    viewer: IPdfReloadWaiterViewer | null,
    pageToRestore: number,
) {
    try {
        viewer?.scrollToPage(pageToRestore);
    } catch (error) {
        logReloadWaiterRecovery('page restore', error);
    }
}

function readUserViewportInteractionEpoch(viewer: IPdfReloadWaiterViewer | null) {
    try {
        const epoch = viewer?.getUserViewportInteractionEpoch?.();
        return typeof epoch === 'number' && Number.isFinite(epoch)
            ? epoch
            : null;
    } catch (error) {
        logReloadWaiterRecovery('viewport interaction epoch read', error);
        return null;
    }
}

export function createPdfReloadWaiter(options: ICreatePdfReloadWaiterOptions) {
    const initialDoc = options.pdfDocument.value;
    const isCancelled = ref(false);
    const shouldRestoreScroll = options.restoreScroll !== false;
    const initialViewportInteractionEpoch = readUserViewportInteractionEpoch(options.pdfViewerRef.value);
    const initialOpenSurfaceState = options.openSurface?.snapshot.value ?? null;

    async function waitForOpenSurfaceVisualSettle(isCurrentReload: () => boolean) {
        const openSurface = options.openSurface;
        if (!openSurface) {
            return true;
        }

        try {
            const settled = await until(() => {
                const snapshot = openSurface.snapshot.value;
                const viewport = openSurface.viewportSession.value;
                return {
                    cancelled: isCancelled.value,
                    current: isCurrentReload(),
                    ready: snapshot.phase === 'ready'
                        && snapshot.presentation === 'committed'
                        && viewport.lifecycle === 'ready',
                };
            }).toMatch(
                ({
                    cancelled,
                    current,
                    ready,
                }) => cancelled || !current || ready,
                {timeout: PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS},
            );
            return !settled.cancelled && settled.current && settled.ready;
        } catch (error) {
            if (!isCancelled.value) {
                BrowserLogger.warn('loader', 'Timed out waiting for the PDF open surface to settle after reload; skipping page restore', {
                    timeoutMs: PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS,
                    error,
                });
            }
            return false;
        }
    }

    const promise = until(() => {
        const surface = options.openSurface?.snapshot.value ?? null;
        const doc = surface ? null : options.pdfDocument.value;
        return {
            doc,
            surface,
            cancelled: isCancelled.value,
            reloaded: surface
                ? Boolean(surface.identity && !surface.identity.provisional && (
                    surface.generation !== initialOpenSurfaceState?.generation
                    || surface.identity.documentId !== initialOpenSurfaceState?.identity?.documentId
                    || surface.identity.documentRevision !== initialOpenSurfaceState?.identity?.documentRevision
                ))
                : Boolean(doc && doc !== initialDoc),
        };
    })
        .toMatch(({
            cancelled,
            reloaded,
        }) => cancelled || reloaded, { timeout: PDF_DOCUMENT_RELOAD_TIMEOUT_MS })
        .then(async ({
            doc,
            surface,
            cancelled,
            reloaded,
        }) => {
            if (cancelled || !reloaded) {
                return;
            }

            // The owner that admitted the reload also fences its placement.
            // A later document, generation or revision cannot inherit it.
            const isCurrentReload = () => surface
                ? options.openSurface?.snapshot.value.generation === surface.generation
                    && options.openSurface.snapshot.value.identity?.documentId === surface.identity?.documentId
                    && options.openSurface.snapshot.value.identity?.documentRevision === surface.identity?.documentRevision
                : options.pdfDocument.value === doc;
            if (options.openSurface) {
                if (!await waitForOpenSurfaceVisualSettle(isCurrentReload)) {
                    return;
                }
            } else if (options.pdfViewerRef.value?.waitForViewerLoadSettled) {
                const timeoutController = new AbortController();
                try {
                    const didSettle = await Promise.race([
                        options.pdfViewerRef.value.waitForViewerLoadSettled().then(() => true),
                        delay(PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS, { signal: timeoutController.signal }).then(() => false),
                    ]);
                    if (!didSettle) {
                        BrowserLogger.warn('loader', 'Timed out waiting for viewer load to settle after PDF reload; continuing', { timeoutMs: PDF_VIEWER_LOAD_SETTLE_TIMEOUT_MS });
                    }
                } catch (error) {
                    BrowserLogger.warn('loader', 'Viewer load settle hook failed after PDF reload; continuing', { error });
                } finally {
                    timeoutController.abort();
                }
            }
            if (isCancelled.value || !isCurrentReload()) {
                return;
            }
            try {
                options.resetSearchCache();
            } catch (error) {
                logReloadWaiterRecovery('search cache reset', error);
            }
            try {
                await nextTick();
            } catch (error) {
                logReloadWaiterRecovery('post-reload tick', error);
            }
            if (Boolean(isCancelled.value) || !isCurrentReload()) {
                return;
            }
            if (!shouldRestoreScroll) {
                return;
            }
            if (
                options.openSurface
                && options.openSurface.viewportSession.value.lifecycle === 'ready'
                && options.openSurface.snapshot.value.committedViewport?.pageNumber === options.pageToRestore
            ) {
                BrowserLogger.diagnostic('loader', 'Skipped redundant PDF reload page restore', {pageToRestore: options.pageToRestore});
                return;
            }
            const viewer = options.pdfViewerRef.value;
            const currentViewportInteractionEpoch = readUserViewportInteractionEpoch(viewer);
            if (
                initialViewportInteractionEpoch !== null
                && currentViewportInteractionEpoch !== null
                && currentViewportInteractionEpoch !== initialViewportInteractionEpoch
            ) {
                BrowserLogger.diagnostic('loader', 'Skipped PDF reload scroll restore after user viewport interaction', {
                    initialViewportInteractionEpoch,
                    currentViewportInteractionEpoch,
                    pageToRestore: options.pageToRestore,
                });
                return;
            }
            restoreReloadScroll(viewer, options.pageToRestore);
        });

    return {
        promise,
        cancel: () => {
            isCancelled.value = true;
        },
    };
}
