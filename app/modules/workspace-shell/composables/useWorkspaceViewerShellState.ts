import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TPdfZoomState,
    TZoomMode,
} from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { useDropdownManager } from '@app/modules/workspace-shell/composables/useDropdownManager';
import type {
    IDocumentViewerExpose,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import type { TPageSelection } from '@contracts/pageNumbers';
import {
    createExplicitPageSelection,
    materializePageSelection,
    pageSelectionCount,
} from '@contracts/pageNumbers';

const LEGACY_SELECTION_MATERIALIZATION_LIMIT = 100_000;

export const useWorkspaceViewerShellState = (initialState?: ITabViewSessionState | null) => {
    const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
    const nativePdfViewerRef = ref<IDocumentViewerExpose | null>(null);
    const djvuViewerRef = ref<IDocumentViewerExpose | null>(null);
    const documentViewerRef = computed<IDocumentViewerExpose | null>(() => (
        pdfViewerRef.value ?? nativePdfViewerRef.value ?? djvuViewerRef.value
    ));
    const zoomDropdownOpen = ref(false);
    const pageDropdownOpen = ref(false);
    const ocrPopupOpen = ref(false);
    const overflowMenuOpen = ref(false);
    const appMenuOpen = ref(false);

    const selectedThumbnailPages = ref<number[]>([]);
    const selectedPageSelection = shallowRef<TPageSelection | null>(null);
    const thumbnailInvalidationRequest = ref<{
        id: number;
        pages: number[];
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

    function requestThumbnailInvalidation(pages: number[]) {
        thumbnailInvalidationRequestId += 1;
        thumbnailInvalidationRequest.value = {
            id: thumbnailInvalidationRequestId,
            pages: [...pages],
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
        overflowOpen: overflowMenuOpen,
        appMenuOpen,
    });

    const zoom = ref(initialState?.zoom ?? 1);
    const effectiveZoom = ref(initialState?.effectiveZoom ?? 1);
    const rememberedFitAxis = ref<TFitMode>(initialState?.zoomMode === 'fit-height'
        ? 'height'
        : initialState?.zoomMode === 'fit-width' ? 'width' : initialState?.fitMode ?? 'width');
    const initialZoomMode = initialState?.zoomMode ?? 'fit-width';
    const zoomState = ref<TPdfZoomState>(initialZoomMode === 'custom'
        ? {
            kind: 'custom',
            scale: zoom.value,
        }
        : {
            kind: 'fit',
            axis: initialZoomMode === 'fit-height' ? 'height' : 'width',
        });
    const zoomMode = computed<TZoomMode>({
        get: () => zoomState.value.kind === 'custom'
            ? 'custom'
            : zoomState.value.axis === 'height' ? 'fit-height' : 'fit-width',
        set: (mode) => {
            if (mode === 'custom') {
                zoomState.value = {
                    kind: 'custom',
                    scale: zoom.value,
                };
                return;
            }
            rememberedFitAxis.value = mode === 'fit-height' ? 'height' : 'width';
            zoomState.value = {
                kind: 'fit',
                axis: rememberedFitAxis.value,
            };
        },
    });
    const fitMode = computed<TFitMode>({
        get: () => zoomState.value.kind === 'fit' ? zoomState.value.axis : rememberedFitAxis.value,
        set: (axis) => {
            rememberedFitAxis.value = axis;
            if (zoomState.value.kind === 'fit') {
                zoomState.value = {
                    kind: 'fit',
                    axis,
                };
            }
        },
    });
    watch(zoom, (scale) => {
        if (zoomState.value.kind === 'custom') {
            zoomState.value = {
                kind: 'custom',
                scale,
            };
        }
    }, {flush: 'sync'});
    const viewMode = ref<TPdfViewMode>(initialState?.viewMode ?? 'single');
    const viewRotation = ref<TPdfViewRotation>(initialState?.viewRotation ?? 0);
    const currentPage = ref(Math.max(1, Math.trunc(initialState?.currentPage ?? 1)));
    const totalPages = ref(0);
    const pdfDocument = shallowRef<IPdfDocument | null>(null);

    watch(totalPages, (pageCount) => {
        if (selectedPageSelection.value?.pageCount === pageCount) {
            return;
        }
        const pages = selectedThumbnailPages.value.filter(page => page >= 1 && page <= pageCount);
        selectedPageSelection.value = createExplicitPageSelection(pageCount, pages);
        if (pages.length !== selectedThumbnailPages.value.length) {
            setSelectedThumbnailPages(pages);
        }
    });

    const isLoading = ref(false);
    // Default to text selection so reopened annotations remain immediately
    // discoverable and interactable without an extra mode switch.
    const dragMode = ref(false);
    const continuousScroll = ref(initialState?.continuousScroll ?? true);
    const showSidebar = ref(initialState?.showSidebar ?? false);
    const showSettings = ref(false);
    const sidebarTab = ref<TDocumentSidebarTab>(initialState?.sidebarTab ?? 'thumbnails');

    return {
        pdfViewerRef,
        nativePdfViewerRef,
        djvuViewerRef,
        documentViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        appMenuOpen,
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
        zoomMode,
        fitMode,
        viewMode,
        viewRotation,
        currentPage,
        totalPages,
        pdfDocument,
        isLoading,
        dragMode,
        continuousScroll,
        showSidebar,
        showSettings,
        sidebarTab,
    };
};
