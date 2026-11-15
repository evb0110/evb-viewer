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
    DETACHED_ZOOM_ACCESS,
    getZoomMode,
} from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

const emptyAnnotationMatches = new Map<number, IPdfPageMatches>();

export const usePdfViewerPropModel = (props: Readonly<IPdfViewerProps>) => {
    const performanceProfile = getPerformanceProfile();
    // The view's zoom owner: the viewer lays out with its state and writes
    // it directly, so a write is read back at once.
    const readZoom = () => props.zoom ?? DETACHED_ZOOM_ACCESS;
    const zoomState = computed(() => readZoom().state);
    const fitMode = computed<TFitMode>(() => zoomState.value.kind === 'fit' ? zoomState.value.axis : 'width');
    // A fit keeps the owner's last manual scale, so leaving and re-entering
    // custom zoom does not read as a manual zoom change.
    const zoom = computed(() => readZoom().manualScale);

    return {
        src: computed(() => props.src),
        sourcePdfData: computed(() => props.sourcePdfData ?? null),
        rasterDisplayProfile: computed(() => props.rasterDisplayProfile ?? null),
        bufferPages: computed(() => performanceProfile.pdfBufferPages),
        isAnySaving: computed(() => props.isAnySaving ?? false),
        zoom,
        readZoom,
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
