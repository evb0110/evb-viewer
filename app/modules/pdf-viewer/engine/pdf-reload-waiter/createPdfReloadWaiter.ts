import {until} from '@vueuse/core';
import type {IDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';
import type {IPdfReloadAdmission, TPdfReloadOutcome} from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/pdfReloadWaiterViewer';
import {BrowserLogger} from '@app/utils/browserLogger';

const PDF_DOCUMENT_RELOAD_TIMEOUT_MS = 8000;
const PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS = 30000;

interface ICreatePdfReloadWaiterOptions {
    /** The view's open surface: the reload is its next generation or revision, settled. */
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession' | 'navigationTicket'>;
    resetSearchCache: () => void;
    /**
     * The view's placement of the reload, admitted before the operation runs.
     * A view without one (no viewer is mounted yet) only waits for the reload.
     */
    admission: IPdfReloadAdmission | null;
    /**
     * Places a view without an admission once it settles on the new
     * document: a view that opens a document at a page navigates there. A
     * reader's command on the new document is newer and wins (R2).
     */
    place?: () => PromiseLike<unknown> | null | undefined;
}

/**
 * Waits for the reload of the document in one view: the view shows the new
 * bytes, and the viewer has placed the reading point it admitted or been
 * superseded first. Cancelling withdraws the admission and ends the wait; an
 * admission that ends otherwise, or a reload that fails, ends it too.
 */
export function createPdfReloadWaiter(options: ICreatePdfReloadWaiterOptions) {
    const {openSurface, admission} = options;
    const initial = openSurface.snapshot.value;
    const outcome = shallowRef<TPdfReloadOutcome | null>(null);
    void admission?.finished.then((value) => {
        outcome.value = value;
    });
    let readerCommanded = false;
    const stopCommandWatch = options.place
        ? watch(
              () => openSurface.navigationTicket.value,
              (ticket) => {
                  readerCommanded ||= ticket !== null && ticket.generation !== initial.generation && ticket.request.source !== 'restore';
              },
              {flush: 'sync'},
          )
        : null;

    async function settle(): Promise<void> {
        const reload = await until(() => {
            const surface = openSurface.snapshot.value;
            return {
                surface,
                reloaded: Boolean(
                    surface.identity &&
                    !surface.identity.provisional &&
                    (surface.generation !== initial.generation ||
                        surface.identity.documentId !== initial.identity?.documentId ||
                        surface.identity.documentRevision !== initial.identity?.documentRevision),
                ),
                ended: outcome.value !== null,
            };
        }).toMatch(({reloaded, ended}) => reloaded || ended, {timeout: PDF_DOCUMENT_RELOAD_TIMEOUT_MS});
        if (!reload.reloaded) {
            // The operation never reloaded this view, or the view went away first.
            admission?.withdraw();
            return;
        }
        // The owner that admitted the reload also fences its placement.
        // A later document, generation or revision cannot inherit it.
        // An admitted reload ends on surface failure; a moved-tab open (`admission === null`)
        // waits through a first-page raster error so a superseding open still cancels the transfer.
        const isCurrentReload = () => {
            const current = openSurface.snapshot.value;
            return (
                current.generation === reload.surface.generation &&
                current.identity?.documentId === reload.surface.identity?.documentId &&
                current.identity?.documentRevision === reload.surface.identity?.documentRevision &&
                current.phase !== 'idle' &&
                (admission === null || current.phase !== 'failed')
            );
        };
        const settled = await until(() => {
            const snapshot = openSurface.snapshot.value;
            return {
                current: isCurrentReload(),
                ready:
                    snapshot.phase === 'ready' &&
                    snapshot.presentation === 'committed' &&
                    openSurface.viewportSession.value.lifecycle === 'ready' &&
                    (admission === null || outcome.value !== null),
                // Superseded: the reader or a navigation took the view, which shows the new bytes.
                ended: outcome.value === 'withdrawn' || outcome.value === 'superseded',
            };
        }).toMatch(({current, ready, ended}) => !current || ready || ended, {timeout: PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS});
        if (!settled.ready && !settled.ended && settled.current) {
            BrowserLogger.warn('loader', 'Timed out waiting for the PDF reload to settle', {
                timeoutMs: PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS,
                outcome: outcome.value,
            });
        }
        if (outcome.value === 'withdrawn' || !isCurrentReload() || (!settled.ready && !settled.ended)) {
            admission?.withdraw();
            return;
        }
        try {
            options.resetSearchCache();
        } catch (error) {
            BrowserLogger.warn('loader', 'Recovered from PDF reload waiter search cache reset failure', {error});
        }
        if (!admission && options.place && !readerCommanded) {
            await whileCurrent(options.place(), isCurrentReload);
        }
    }

    /** Ends with `work`, or once the view leaves the reload, is cancelled, or the bound passes. */
    function whileCurrent(work: PromiseLike<unknown> | null | undefined, isCurrentReload: () => boolean) {
        let stop = () => {};
        const left = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, PDF_OPEN_SURFACE_SETTLE_TIMEOUT_MS);
            const unwatch = watch(
                () => outcome.value === 'withdrawn' || !isCurrentReload(),
                (gone) => {
                    if (gone) {
                        resolve();
                    }
                },
                {immediate: true},
            );
            stop = () => {
                clearTimeout(timer);
                unwatch();
            };
        });
        return Promise.race([Promise.resolve(work), left]).finally(() => stop());
    }

    return {
        promise: settle().finally(() => stopCommandWatch?.()),
        cancel: () => {
            if (admission) {
                admission.withdraw();
            } else {
                outcome.value = 'withdrawn';
            }
        },
    };
}
