import type { ILocalRect } from '@app/modules/document-viewer/public';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import { getEventCurrentTarget } from '@app/utils/getEventCurrentTarget';

interface IRegionSelectionOverlayOptions {
    isActive: () => boolean;
    onPointerStart: (payload: ISnipPointerPayload) => void;
    onPointerMove: (payload: ISnipPointerPayload) => void;
    onPointerEnd: (payload: ISnipPointerPayload) => void;
    onCancel: () => void;
}

export interface IRegionSelectionOverlayBaseProps {
    active: boolean;
    selectionRect: ILocalRect | null;
    hintLabel: string;
}

export interface IRegionSelectionOverlayEmits {
    (e: 'pointer-start', payload: ISnipPointerPayload): void;
    (e: 'pointer-move', payload: ISnipPointerPayload): void;
    (e: 'pointer-end', payload: ISnipPointerPayload): void;
    (e: 'cancel'): void;
}

function buildPointerPayload(event: PointerEvent): ISnipPointerPayload | null {
    const target = getEventCurrentTarget(event, HTMLElement);
    if (!target) {
        return null;
    }

    const rect = target.getBoundingClientRect();
    return {
        clientX: event.clientX,
        clientY: event.clientY,
        overlayRect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        },
    };
}

export const usePdfRegionSelectionOverlay = (options: IRegionSelectionOverlayOptions) => {
    function handlePointerDown(event: PointerEvent) {
        if (!options.isActive() || event.button !== 0) {
            return;
        }

        getEventCurrentTarget(event, HTMLElement)?.setPointerCapture(event.pointerId);
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerStart(payload);
        }
    }

    function handlePointerMove(event: PointerEvent) {
        if (!options.isActive()) {
            return;
        }
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerMove(payload);
        }
    }

    function handlePointerUp(event: PointerEvent) {
        if (!options.isActive() || event.button !== 0) {
            return;
        }
        const payload = buildPointerPayload(event);
        if (payload) {
            options.onPointerEnd(payload);
        }
    }

    function handleContextMenu(event: MouseEvent) {
        if (!options.isActive()) {
            return;
        }
        event.preventDefault();
        options.onCancel();
    }

    function handleWheel(event: WheelEvent) {
        if (!options.isActive()) {
            return;
        }
        event.preventDefault();
    }

    return {
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handleContextMenu,
        handleWheel,
    };
};
