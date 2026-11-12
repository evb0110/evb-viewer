import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
} from '@app/types/pdfContracts';
import {
    FIT_WIDTH_ZOOM_STATE,
    getZoomMode,
    type TPdfZoomState,
} from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

const emptyAnnotationMatches = new Map<number, IPdfPageMatches>();

export const usePdfViewerPropModel = (props: Readonly<IPdfViewerProps>) => {
    const performanceProfile = getPerformanceProfile();
    // The zoom this viewer lays out with: the host's state, or the state the
    // viewer itself just reported to the host. The host echoes a report as
    // its prop, so the viewer never waits for that round trip.
    const zoomState = shallowRef<TPdfZoomState>(props.zoomState ?? FIT_WIDTH_ZOOM_STATE);
    watch(() => props.zoomState, (state) => {
        zoomState.value = state ?? FIT_WIDTH_ZOOM_STATE;
    }, {flush: 'sync'});
    const fitMode = computed<TFitMode>(() => zoomState.value.kind === 'fit' ? zoomState.value.axis : 'width');
    // A fit keeps the last manual scale, so leaving and re-entering custom
    // zoom does not read as a manual zoom change.
    const manualZoom = ref(1);
    watch(zoomState, (state) => {
        if (state.kind === 'custom') {
            manualZoom.value = state.scale;
        }
    }, {
        flush: 'sync',
        immediate: true,
    });
    const zoom = computed(() => manualZoom.value);

    return {
        src: computed(() => props.src),
        sourcePdfData: computed(() => props.sourcePdfData ?? null),
        rasterDisplayProfile: computed(() => props.rasterDisplayProfile ?? null),
        bufferPages: computed(() => performanceProfile.pdfBufferPages),
        isAnySaving: computed(() => props.isAnySaving ?? false),
        zoom,
        zoomState: readonly(zoomState),
        acknowledgeZoomState: (state: TPdfZoomState) => {
            zoomState.value = state;
        },
        dragMode: computed(() => props.dragMode ?? false),
        fitMode,
        zoomMode: computed(() => getZoomMode(zoomState.value)),
        viewMode: computed<TPdfViewMode>(() => props.viewMode ?? 'single'),
        viewRotation: computed<TPdfViewRotation>(() => props.viewRotation ?? 0),
        isResizing: computed(() => props.isResizing ?? false),
        annotationTool: computed<TAnnotationTool>(() => props.annotationTool ?? 'none'),
        annotationCursorMode: computed(() => props.annotationCursorMode ?? false),
        annotationKeepActive: computed(() => props.annotationKeepActive ?? true),
        annotationSettings: computed<IAnnotationSettings | null>(() => props.annotationSettings ?? null),
        searchPageMatches: computed(() => props.searchPageMatches ?? emptyAnnotationMatches),
        currentSearchMatch: computed(() => props.currentSearchMatch ?? null),
        currentSearchMatchNavigationId: computed(() => props.currentSearchMatchNavigationId ?? 0),
        workingCopyPath: computed(() => parseDocumentRef(props.workingCopyPath)),
        documentRevisionToken: computed(() => props.documentRevisionToken ?? null),
        continuousScroll: computed(() => props.continuousScroll ?? true),
        isActive: computed(() => props.isActive ?? true),
        authorName: computed(() => props.authorName),
    };
};
