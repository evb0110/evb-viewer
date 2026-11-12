import type { Ref } from 'vue';
import { until } from '@vueuse/core';
import type { IDocumentOpenSurfaceSession } from '@app/modules/document-viewer/public';
import type { IPdfReloadWaiterViewer } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
import { BrowserLogger } from '@app/utils/browserLogger';

const PDF_DOCUMENT_RELOAD_TIMEOUT_MS = 8000;
const PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS = 30000;

interface ICreatePdfReloadWaiterOptions {
    pdfViewerRef: Ref<IPdfReloadWaiterViewer | null>;
    /** The view's open surface: the reload is its next generation or revision, settled. */
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
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
    const isCancelled = ref(false);
    const shouldRestoreScroll = options.restoreScroll !== false;
    const initialViewportInteractionEpoch = readUserViewportInteractionEpoch(options.pdfViewerRef.value);
    const initialOpenSurfaceState = options.openSurface.snapshot.value;

    async function waitForOpenSurfaceVisualSettle(isCurrentReload: () => boolean) {
        const openSurface = options.openSurface;
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
        const surface = options.openSurface.snapshot.value;
        return {
            surface,
            cancelled: isCancelled.value,
            reloaded: Boolean(surface.identity && !surface.identity.provisional && (
                surface.generation !== initialOpenSurfaceState.generation
                || surface.identity.documentId !== initialOpenSurfaceState.identity?.documentId
                || surface.identity.documentRevision !== initialOpenSurfaceState.identity?.documentRevision
            )),
        };
    })
        .toMatch(({
            cancelled,
            reloaded,
        }) => cancelled || reloaded, { timeout: PDF_DOCUMENT_RELOAD_TIMEOUT_MS })
        .then(async ({
            surface,
            cancelled,
            reloaded,
        }) => {
            if (cancelled || !reloaded) {
                return;
            }

            // The owner that admitted the reload also fences its placement.
            // A later document, generation or revision cannot inherit it.
            const isCurrentReload = () => {
                const current = options.openSurface.snapshot.value;
                return current.generation === surface.generation
                    && current.identity?.documentId === surface.identity?.documentId
                    && current.identity?.documentRevision === surface.identity?.documentRevision;
            };
            if (!await waitForOpenSurfaceVisualSettle(isCurrentReload)) {
                return;
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
                options.openSurface.viewportSession.value.lifecycle === 'ready'
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
