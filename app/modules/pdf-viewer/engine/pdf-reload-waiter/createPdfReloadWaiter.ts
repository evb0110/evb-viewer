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
    const initialOpenSurfaceState = options.openSurface
        ? {
            generation: options.openSurface.snapshot.value.generation,
            documentRevision: options.openSurface.snapshot.value.identity?.documentRevision ?? null,
        }
        : null;

    async function waitForOpenSurfaceVisualSettle() {
        const openSurface = options.openSurface;
        if (!openSurface) {
            return true;
        }

        try {
            await until(() => {
                const snapshot = openSurface.snapshot.value;
                const viewport = openSurface.viewportSession.value;
                const identityChanged = snapshot.generation !== initialOpenSurfaceState?.generation
                    || snapshot.identity?.documentRevision !== initialOpenSurfaceState?.documentRevision;
                return {
                    cancelled: isCancelled.value,
                    identityChanged,
                    ready: snapshot.phase === 'ready'
                        && snapshot.presentation === 'committed'
                        && viewport.lifecycle === 'ready',
                };
            }).toMatch(
                ({
                    cancelled,
                    identityChanged,
                    ready,
                }) => cancelled || (identityChanged && ready),
                {timeout: PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS},
            );
            return !isCancelled.value;
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

    const promise = until(() => ({
        doc: options.pdfDocument.value,
        cancelled: isCancelled.value,
    }))
        .toMatch(({
            doc,
            cancelled,
        }) => cancelled || Boolean(doc && doc !== initialDoc), { timeout: PDF_DOCUMENT_RELOAD_TIMEOUT_MS })
        .then(async ({
            doc,
            cancelled,
        }) => {
            if (cancelled || !doc || doc === initialDoc) {
                return;
            }

            const matchedDoc = doc;
            const viewer = options.pdfViewerRef.value;
            if (options.openSurface) {
                if (!await waitForOpenSurfaceVisualSettle()) {
                    return;
                }
            } else if (viewer?.waitForViewerLoadSettled) {
                const timeoutController = new AbortController();
                try {
                    const didSettle = await Promise.race([
                        viewer.waitForViewerLoadSettled().then(() => true),
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
            if (isCancelled.value) {
                return;
            }

            if (options.pdfDocument.value !== matchedDoc) {
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
            if (Boolean(isCancelled.value) || options.pdfDocument.value !== matchedDoc) {
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
            const currentViewportInteractionEpoch = readUserViewportInteractionEpoch(viewer ?? null);
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
            restoreReloadScroll(viewer ?? null, options.pageToRestore);
        });

    return {
        promise,
        cancel: () => {
            isCancelled.value = true;
        },
    };
}
