import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { IDocumentOpenSurfaceSnapshot } from '@app/modules/document-viewer/public';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IUseWorkspaceSidebarOpenGenerationOptions {
    sidebarPresentationEnabled: TReadableRef<boolean>;
    isOpeningDocumentForToolbar: TReadableRef<boolean>;
    initialDocumentVisualReady: TReadableRef<boolean>;
    hasDocumentOpenError: TReadableRef<boolean>;
    openSurfaceSnapshot: TReadableRef<IDocumentOpenSurfaceSnapshot>;
    openingPreviewReady?: TReadableRef<boolean>;
}

/**
 * Sidebar content belongs to one document generation. The moment a staged open
 * claims the title/open surface, the previous document's outline, thumbnails,
 * and bookmarks stop being a true description of what the centre surface shows,
 * so presentation is suspended until the claiming generation owns a committed
 * visual surface of its own.
 *
 * Suspension is released - not cleared - so an invalid staged open leaves the
 * previous document, its page, and its sidebar exactly as they were. The
 * persisted `showSidebar` preference is never written here.
 */
export const useWorkspaceSidebarOpenGeneration = (
    options: IUseWorkspaceSidebarOpenGenerationOptions,
) => {
    const sidebarSuspendedForDocumentOpen = ref(false);
    let activeOpeningGeneration: number | null = null;
    let nativePreviewReleasedGeneration: number | null = null;
    let wasOpening = false;

    watch(
        () => ({
            failed: options.hasDocumentOpenError.value
                || options.openSurfaceSnapshot.value.phase === 'failed',
            generationVisualReady: options.openSurfaceSnapshot.value.openingPageFrame?.preview !== undefined
                || options.openSurfaceSnapshot.value.phase === 'viewport-committed'
                || options.openSurfaceSnapshot.value.phase === 'ready',
            idle: options.openSurfaceSnapshot.value.phase === 'idle',
            opening: options.isOpeningDocumentForToolbar.value,
            openingPreviewReady: options.openingPreviewReady?.value === true,
            presentationEnabled: options.sidebarPresentationEnabled.value,
            ready: options.initialDocumentVisualReady.value,
            generation: options.openSurfaceSnapshot.value.generation,
        }),
        (next, previous) => {
            if (next.openingPreviewReady) {
                nativePreviewReleasedGeneration = next.generation;
            }
            const resumedViewableGeneration = previous === undefined
                && next.opening
                && next.generationVisualReady;
            const startsOpeningGeneration = next.opening && (
                !wasOpening
                || activeOpeningGeneration !== next.generation
            );
            wasOpening = next.opening;
            if (!next.opening) {
                activeOpeningGeneration = null;
            } else if (startsOpeningGeneration) {
                activeOpeningGeneration = next.generation;
                if (
                    !next.openingPreviewReady
                    && !resumedViewableGeneration
                    && nativePreviewReleasedGeneration !== next.generation
                ) {
                    sidebarSuspendedForDocumentOpen.value = true;
                }
            }
            const explicitlyOpenedSidebar = previous?.presentationEnabled === false
                && next.presentationEnabled;
            if (explicitlyOpenedSidebar) {
                sidebarSuspendedForDocumentOpen.value = false;
            }
            if (!sidebarSuspendedForDocumentOpen.value) {
                return;
            }
            // The claiming generation either committed its own pixels, failed
            // and handed the surface back to the previous document, or was
            // abandoned before it ever owned one.
            if (
                next.openingPreviewReady
                || next.ready && !next.opening
                || next.failed
                || next.idle
            ) {
                sidebarSuspendedForDocumentOpen.value = false;
            }
        },
        {
            flush: 'sync',
            immediate: true,
        },
    );

    const openingPreviewPresented = computed(() => (
        options.openSurfaceSnapshot.value.openingPageFrame?.preview !== undefined
    ));
    const toolbarShowSidebarForDisplay = computed(() => (
        options.sidebarPresentationEnabled.value
        && (
            !sidebarSuspendedForDocumentOpen.value
            || openingPreviewPresented.value
        )
    ));
    watch(toolbarShowSidebarForDisplay, (shown) => {
        logPdfRenderTrace('workspace-sidebar-presentation', () => ({
            shown,
            presentationEnabled: options.sidebarPresentationEnabled.value,
            suspendedForDocumentOpen: sidebarSuspendedForDocumentOpen.value,
            opening: options.isOpeningDocumentForToolbar.value,
            phase: options.openSurfaceSnapshot.value.phase,
            generation: options.openSurfaceSnapshot.value.generation,
            ready: options.initialDocumentVisualReady.value,
        }));
    }, {flush: 'sync'});

    return {
        sidebarSuspendedForDocumentOpen,
        toolbarShowSidebarForDisplay,
    };
};
