import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    TFitMode,
    TPdfViewRotation,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdfContracts';
import type {TPdfZoomState} from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import type { IPdfPageMatches } from '@app/types/pdfUi';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import { getPerformanceProfile } from '@app/utils/performanceProfile';

const emptyAnnotationMatches = new Map<number, IPdfPageMatches>();

function isPropProvided(...names: string[]) {
    const vnodeProps = getCurrentInstance()?.vnode.props;
    if (!vnodeProps) {
        return false;
    }
    return names.some(name => Object.prototype.hasOwnProperty.call(vnodeProps, name));
}

export const usePdfViewerPropModel = (props: Readonly<IPdfViewerProps>) => {
    const performanceProfile = getPerformanceProfile();
    const zoomState = computed<TPdfZoomState>(() => {
        const zoomMode = props.zoomMode ?? (props.fitMode === 'height' ? 'fit-height' : 'fit-width');
        if (zoomMode === 'custom') {
            return {
                kind: 'custom',
                scale: props.zoom ?? 1,
            };
        }
        return {
            kind: 'fit',
            axis: zoomMode === 'fit-height' ? 'height' : 'width',
        };
    });
    const fitMode = computed<TFitMode>(() => zoomState.value.kind === 'fit'
        ? zoomState.value.axis
        : props.fitMode ?? 'width');
    const hasShowAnnotationsProp = isPropProvided('showAnnotations', 'show-annotations');

    return {
        src: computed(() => props.src),
        reloadSrc: computed(() => props.reloadSrc ?? null),
        sourcePdfData: computed(() => props.sourcePdfData ?? null),
        rasterDisplayProfile: computed(() => props.rasterDisplayProfile ?? null),
        suppressLoadingOverlay: computed(() => props.suppressLoadingOverlay === true),
        bufferPages: computed(() => props.bufferPages ?? performanceProfile.pdfBufferPages),
        isAnySaving: computed(() => props.isAnySaving ?? false),
        zoom: computed(() => props.zoom ?? 1),
        zoomState,
        dragMode: computed(() => props.dragMode ?? false),
        fitMode,
        zoomMode: computed<TZoomMode>(() => zoomState.value.kind === 'custom'
            ? 'custom'
            : zoomState.value.axis === 'height' ? 'fit-height' : 'fit-width'),
        viewMode: computed<TPdfViewMode>(() => props.viewMode ?? 'single'),
        viewRotation: computed<TPdfViewRotation>(() => props.viewRotation ?? 0),
        isResizing: computed(() => props.isResizing ?? false),
        showAnnotations: computed(() => !hasShowAnnotationsProp || props.showAnnotations !== false),
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
