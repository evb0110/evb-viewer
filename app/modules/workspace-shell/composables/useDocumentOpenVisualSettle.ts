import type { Ref } from 'vue';
import type {IDocumentOpenSurfaceSession} from '@app/modules/document-viewer/public';

interface IUseDocumentOpenVisualSettleOptions {
    pdfSrc: Ref<unknown>;
    pdfDocument: Ref<unknown>;
    totalPages: Ref<number>;
    isLoading: Ref<boolean>;
    pdfError: Ref<unknown>;
    djvuError: Ref<unknown>;
    showDjvuSource: Ref<boolean>;
    openSurface: Pick<IDocumentOpenSurfaceSession, 'snapshot' | 'viewportSession'>;
}

/**
 * The viewer's view of an open: `documentOpenAccepted` once the document's
 * pages are loaded, `documentOpenSettled` once its first page is on screen.
 * An error settles both. The workspace reports these to the tab controller.
 */
export const useDocumentOpenVisualSettle = (options: IUseDocumentOpenVisualSettleOptions) => {
    const committedInitialVisualIdentity = shallowRef<{
        documentId: string;
        documentRevision: string;
        generation: number;
    } | null>(null);
    watch(
        [
            options.openSurface.snapshot,
            options.openSurface.viewportSession,
        ],
        ([
            surface,
            viewport,
        ]) => {
            const identity = surface.identity;
            if (
                identity === null
                || surface.phase !== 'ready'
                || surface.presentation !== 'committed'
                || viewport.lifecycle !== 'ready'
            ) {
                return;
            }
            committedInitialVisualIdentity.value = {
                generation: surface.generation,
                documentId: identity.documentId,
                documentRevision: identity.documentRevision,
            };
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );
    const initialDocumentVisualReady = computed(() => {
        const surface = options.openSurface.snapshot.value;
        const identity = surface.identity;
        const committed = committedInitialVisualIdentity.value;
        // Readiness belongs to the document generation, not to every viewport
        // transition: a page command moves the viewport to `transitioning`
        // without making the document unready. It drops only when the
        // committed page's own visual degrades to a skeleton (a budget
        // eviction of the on-screen canvas), until the replacement paints.
        const viewport = options.openSurface.viewportSession.value;
        const visual = viewport.visual;
        const residentVisualLost = visual.kind === 'page'
            && visual.presentation === 'skeleton'
            && (viewport.committedPage === null || visual.pageNumber === viewport.committedPage);
        return identity !== null
            && committed?.generation === surface.generation
            && committed.documentId === identity.documentId
            && committed.documentRevision === identity.documentRevision
            && !residentVisualLost;
    });
    const hasOpenError = computed(() => Boolean(options.pdfError.value) || Boolean(options.djvuError.value));
    const documentOpenAccepted = computed(() => hasOpenError.value || (
        options.showDjvuSource.value
            ? !options.isLoading.value && options.totalPages.value > 0
            : Boolean(
                options.pdfSrc.value
                && options.pdfDocument.value
                && options.totalPages.value > 0
                && !options.isLoading.value,
            )
    ));
    const documentOpenSettled = computed(() => hasOpenError.value || (
        options.showDjvuSource.value
            ? !options.isLoading.value && initialDocumentVisualReady.value
            : documentOpenAccepted.value && initialDocumentVisualReady.value
    ));

    return {
        documentOpenAccepted,
        documentOpenSettled,
        initialDocumentVisualReady,
    };
};
