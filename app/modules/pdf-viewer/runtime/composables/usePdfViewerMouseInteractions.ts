import type {ComputedRef} from 'vue';
import {pdfViewportScrollActivity} from '@app/modules/pdf-viewer/runtime/composables/pdf/pdfViewportScrollActivity';

interface IUsePdfViewerMouseInteractionsOptions {
    isSnipActive: () => boolean;
    isViewerPanDragModeActive: ComputedRef<boolean>;
    markUserViewportInteraction?: (() => void) | undefined;
    cancelPendingSearchScroll: () => void;
    handleDragStart: (event: MouseEvent) => void;
    handleDragMove: (event: MouseEvent) => void;
    stopDrag: () => void;
    handleViewerClickAnnotation: (event: MouseEvent) => void | Promise<void>;
    handleViewerDblClickAnnotation: (event: MouseEvent) => void;
    handleViewerContextMenuAnnotation: (event: MouseEvent) => void;
}

const COMMENT_TARGET_SELECTOR = [
    '.pdf-inline-comment-anchor-marker',
    '.pdf-inline-comment-marker',
    '.pdf-annotation-has-note-target',
    '.pdf-annotation-has-comment',
    '.pdf-annotation-editor-layer [data-annotation-id]',
    '.annotationLayer .popupTriggerArea',
    '.annotation-layer .popupTriggerArea',
].join(', ');

function isImagePlacementTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest('.pdf-image-placement'));
}

function isCommentTarget(target: EventTarget | null) {
    return target instanceof Element && Boolean(target.closest(COMMENT_TARGET_SELECTOR));
}

export const usePdfViewerMouseInteractions = (options: IUsePdfViewerMouseInteractionsOptions) => {
    const {
        isSnipActive,
        isViewerPanDragModeActive,
        markUserViewportInteraction,
        cancelPendingSearchScroll,
        handleDragStart,
        handleDragMove,
        stopDrag,
        handleViewerClickAnnotation,
        handleViewerDblClickAnnotation,
        handleViewerContextMenuAnnotation,
    } = options;

    function handleViewerMouseDown(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        if (!isViewerPanDragModeActive.value && event.target instanceof Element && event.target.closest('.page_container')) {
            pdfViewportScrollActivity.flushSettled(event.target.closest<HTMLElement>('.pdfViewer'));
        }
        markUserViewportInteraction?.();
        if (isCommentTarget(event.target)) {
            event.preventDefault();
            return;
        }
        cancelPendingSearchScroll();
        handleDragStart(event);
    }

    function handleViewerMouseMove(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleDragMove(event);
    }

    function handleViewerMouseUp(event: MouseEvent) {
        const snipActive = isSnipActive();
        if (!snipActive) {
            stopDrag();
        }
        if (snipActive || isImagePlacementTarget(event.target)) {
            return;
        }
    }

    function handleViewerMouseLeave() {
        if (isSnipActive()) {
            return;
        }
        stopDrag();
    }

    function handleSelectStart(event: Event) {
        if (isViewerPanDragModeActive.value) {
            event.preventDefault();
            return;
        }
        const targetElement =
            event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
        if (targetElement) {
            pdfViewportScrollActivity.flushSettled(targetElement.closest<HTMLElement>('.pdfViewer'));
        }
    }

    function handleViewerClick(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        void handleViewerClickAnnotation(event);
    }

    function handleViewerDblClick(event: MouseEvent) {
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleViewerDblClickAnnotation(event);
    }

    function handleViewerContextMenu(event: MouseEvent) {
        event.preventDefault();
        if (isSnipActive() || isImagePlacementTarget(event.target)) {
            return;
        }
        handleViewerContextMenuAnnotation(event);
    }

    return {
        handleViewerMouseDown,
        handleViewerMouseMove,
        handleViewerMouseUp,
        handleViewerMouseLeave,
        handleSelectStart,
        handleViewerClick,
        handleViewerDblClick,
        handleViewerContextMenu,
    };
};
