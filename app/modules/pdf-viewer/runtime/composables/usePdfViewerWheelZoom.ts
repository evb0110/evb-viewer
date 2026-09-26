import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import type {
    TPdfZoomState,
    TZoomMode,
} from '@contracts/shared';
import {
    createDocumentWheelZoomHandler,
    type IDocumentWheelInteraction,
    type IDocumentWheelSourceEvent,
} from '@app/modules/document-viewer/public';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';

// Trackpad momentum keeps sending plain packets after a pinch ends.
const WHEEL_ZOOM_MOMENTUM_WINDOW_MS = 1400;

interface IUsePdfViewerWheelZoomOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isReady: () => boolean;
    effectiveScale: Readonly<Ref<number>>;
    zoomMode: Readonly<Ref<TZoomMode>>;
    handlePagedWheel: (event: IDocumentWheelSourceEvent) => boolean;
    cancelPendingSearchScroll: () => void;
    markUserViewportInteraction: () => void;
    captureRelayoutAnchor: (point: {
        x: number;
        y: number;
    }) => IPdfSemanticAnchor | null;
    relayout: (change?: () => void, anchor?: IPdfSemanticAnchor | null) => void;
    isSnipActive: () => boolean;
    emit: (event: 'update:zoomState', state: TPdfZoomState) => void;
}

/**
 * Ctrl+wheel and pinch zoom through the shared document wheel policy. Each
 * zoom step is one relayout anchored at the pointer.
 */
export const usePdfViewerWheelZoom = (options: IUsePdfViewerWheelZoomOptions) => {
    let lastZoomPacketAt = Number.NEGATIVE_INFINITY;
    const handleWheelZoom = createDocumentWheelZoomHandler(options.effectiveScale, options.zoomMode, options.emit, {beforeZoom: ({event}) => {
        const container = options.viewerContainer.value;
        if (!container) {
            return;
        }
        const rect = container.getBoundingClientRect();
        options.markUserViewportInteraction();
        options.relayout(undefined, options.captureRelayoutAnchor({
            x: clamp(event.clientX - rect.left, 0, Math.max(container.clientWidth, 0)),
            y: clamp(event.clientY - rect.top, 0, Math.max(container.clientHeight, 0)),
        }));
    }});

    function handleViewerWheel(interaction: IDocumentWheelInteraction) {
        const {event} = interaction;
        if (options.isSnipActive()) {
            event.preventDefault();
            return;
        }
        options.cancelPendingSearchScroll();
        if (interaction.intent === 'zoom') {
            lastZoomPacketAt = performance.now();
            if (options.isReady()) {
                handleWheelZoom(interaction);
            } else {
                event.preventDefault();
            }
            return;
        }
        handleWheelZoom.reset();
        if (interaction.intent === 'scroll') {
            if (performance.now() - lastZoomPacketAt <= WHEEL_ZOOM_MOMENTUM_WINDOW_MS) {
                event.preventDefault();
                return;
            }
            if (options.handlePagedWheel(event)) {
                return;
            }
        }
        options.markUserViewportInteraction();
    }

    return {handleViewerWheel};
};
