import {
    createZoomState,
    getZoomMode,
    type IZoomStateAccess,
    type TFitMode,
    type TPdfViewRotation,
    type TPdfViewMode,
    type TPdfZoomState,
    type TZoomMode,
} from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { useDropdownManager } from '@app/modules/workspace-shell/composables/useDropdownManager';
import type {
    IDocumentViewerExpose,
    IPdfDocument,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import {
    resolveDocumentViewportCurrentPage,
    type IDocumentOpenSurfaceSession,
    type IDocumentPageSource,
    type TDocumentSidebarTab,
} from '@app/modules/document-viewer/public';
import type { TPageSelection } from '@pdf-core/pdfPageSelection';
import {
    createExplicitPageSelection,
    materializePageSelection,
    pageSelectionCount,
} from '@pdf-core/pdfPageSelection';

const LEGACY_SELECTION_MATERIALIZATION_LIMIT = 100_000;

/**
 * One view's presentation in the shell. Its page is the page its open
 * surface reports; the shell sends navigation and restores through that
 * surface and keeps no page of its own.
 */
export const useWorkspaceViewerShellState = (
    initialState: ITabViewSessionState | null | undefined,
    openSurface: Pick<IDocumentOpenSurfaceSession, 'viewportSession'>,
) => {
    const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
    const djvuViewerRef = ref<IDocumentViewerExpose | null>(null);
    const documentViewerRef = computed<IDocumentViewerExpose | null>(() => (
        pdfViewerRef.value ?? djvuViewerRef.value
    ));
    const zoomDropdownOpen = ref(false);
    const pageDropdownOpen = ref(false);
    const ocrPopupOpen = ref(false);

    const selectedThumbnailPages = ref<number[]>([]);
    const selectedPageSelection = shallowRef<TPageSelection | null>(null);
    const thumbnailInvalidationRequest = ref<{
        id: number;
        pages: number[];
        expectedDocumentRevision?: string;
        rotationOnly?: boolean;
    } | null>(null);
    let thumbnailInvalidationRequestId = 0;

    function setSelectedThumbnailPages(pages: number[]) {
        selectedThumbnailPages.value = [...pages];
    }

    function setSelectedPageSelection(selection: TPageSelection) {
        selectedPageSelection.value = selection;
        if (pageSelectionCount(selection) <= LEGACY_SELECTION_MATERIALIZATION_LIMIT) {
            setSelectedThumbnailPages(materializePageSelection(selection));
        }
        // An empty legacy array means "all pages" to older consumers. Keep
        // the last bounded mirror when the compact model cannot fit there.
    }

    function requestThumbnailInvalidation(
        pages: number[],
        expectedDocumentRevision?: string,
        options: {rotationOnly?: boolean} = {},
    ) {
        thumbnailInvalidationRequestId += 1;
        thumbnailInvalidationRequest.value = {
            id: thumbnailInvalidationRequestId,
            pages: [...pages],
            ...(expectedDocumentRevision === undefined ? {} : {expectedDocumentRevision}),
            ...(options.rotationOnly ? {rotationOnly: true} : {}),
        };
    }

    function handleSelectedThumbnailPagesUpdate(pages: number[]) {
        setSelectedThumbnailPages(pages);
        selectedPageSelection.value = createExplicitPageSelection(totalPages.value, pages);
    }

    const {
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
    } = useDropdownManager({
        zoomOpen: zoomDropdownOpen,
        pageOpen: pageDropdownOpen,
        ocrOpen: ocrPopupOpen,
    });

    const effectiveZoom = computed(() => documentViewerRef.value?.getEffectiveZoom?.() ?? 1);
    // The view's one requested zoom. Beside it is history: the last manual
    // scale and the last fit axis outlive a request of the other kind.
    const zoomState = shallowRef<TPdfZoomState>(createZoomState(initialState?.zoomMode ?? 'fit-width', initialState?.zoom ?? 1));
    const manualScale = ref(initialState?.zoom ?? 1);
    const rememberedFitAxis = ref<TFitMode>(initialState?.zoomMode === 'fit-height'
        ? 'height'
        : initialState?.zoomMode === 'fit-width' ? 'width' : initialState?.fitMode ?? 'width');
    /** The one write path for zoom: commands, wheel and the viewer's own fit snaps. */
    function setZoomState(state: TPdfZoomState) {
        // The request first: projections of both change with this one write.
        zoomState.value = state;
        if (state.kind === 'custom') {
            manualScale.value = state.scale;
        } else {
            rememberedFitAxis.value = state.axis;
        }
    }
    const zoom = computed(() => zoomState.value.kind === 'custom' ? zoomState.value.scale : manualScale.value);
    const zoomMode = computed<TZoomMode>(() => getZoomMode(zoomState.value));
    const fitMode = computed<TFitMode>(() => zoomState.value.kind === 'fit' ? zoomState.value.axis : rememberedFitAxis.value);
    const zoomAccess: IZoomStateAccess = {
        get state() {
            return zoomState.value;
        },
        get manualScale() {
            return zoom.value;
        },
        set: setZoomState,
    };
    const viewMode = ref<TPdfViewMode>(initialState?.viewMode ?? 'single');
    const viewRotation = ref<TPdfViewRotation>(initialState?.viewRotation ?? 0);
    const currentPage = computed(() => resolveDocumentViewportCurrentPage(openSurface.viewportSession.value));
    const pageCount = ref(0);
    /** The view's page count; a new count keeps the selected pages that still exist. */
    const totalPages = computed({
        get: () => pageCount.value,
        set: (count: number) => {
            if (count === pageCount.value) {
                return;
            }
            pageCount.value = count;
            if (selectedPageSelection.value?.pageCount === count) {
                return;
            }
            const pages = selectedThumbnailPages.value.filter(page => page >= 1 && page <= count);
            selectedPageSelection.value = createExplicitPageSelection(count, pages);
            if (pages.length !== selectedThumbnailPages.value.length) {
                setSelectedThumbnailPages(pages);
            }
        },
    });
    const pdfDocument = shallowRef<IPdfDocument | null>(null);
    const documentPageSource = shallowRef<IDocumentPageSource | null>(null);

    const isLoading = ref(false);
    // Default to text selection so reopened annotations remain immediately
    // discoverable and interactable without an extra mode switch.
    const dragMode = ref(false);
    const continuousScroll = ref(initialState?.continuousScroll ?? true);
    const showSidebar = ref(initialState?.showSidebar ?? false);
    const sidebarTab = ref<TDocumentSidebarTab>(initialState?.sidebarTab ?? 'thumbnails');

    return {
        pdfViewerRef,
        djvuViewerRef,
        documentViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
        selectedThumbnailPages,
        selectedPageSelection,
        thumbnailInvalidationRequest,
        setSelectedThumbnailPages,
        setSelectedPageSelection,
        requestThumbnailInvalidation,
        handleSelectedThumbnailPagesUpdate,
        zoom,
        effectiveZoom,
        zoomState,
        setZoomState,
        zoomAccess,
        zoomMode,
        fitMode,
        viewMode,
        viewRotation,
        currentPage,
        totalPages,
        pdfDocument,
        documentPageSource,
        isLoading,
        dragMode,
        continuousScroll,
        showSidebar,
        sidebarTab,
    };
};
