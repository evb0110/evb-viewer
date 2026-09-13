import type { IClientPoint } from '@app/modules/document-viewer/public';
import { hasActiveSelectionDrag } from '@app/modules/pdf-viewer/engine/pdf-region-drag/hasActiveSelectionDrag';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import { toClientPoint } from '@app/modules/pdf-viewer/engine/pdf-region-drag/toClientPoint';

interface ISelectionPointerDragHandlersOptions {
    getState: () => string;
    getStartPoint: () => IClientPoint | null;
    setStartPoint: (point: IClientPoint) => void;
    updateSelection: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
    onStart?: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
    onEnd: (payload: ISnipPointerPayload, startPoint: IClientPoint) => void;
}

export function createSelectionPointerDragHandlers(
    options: ISelectionPointerDragHandlersOptions,
) {
    function getActiveStartPoint() {
        const startPoint = options.getStartPoint();
        return hasActiveSelectionDrag(options.getState(), startPoint)
            ? startPoint
            : null;
    }

    return {
        onPointerStart(payload: ISnipPointerPayload) {
            if (options.getState() !== 'selecting') {
                return;
            }

            const startPoint = toClientPoint(payload);
            options.setStartPoint(startPoint);
            options.onStart?.(payload, startPoint);
            options.updateSelection(payload, startPoint);
        },
        onPointerMove(payload: ISnipPointerPayload) {
            const startPoint = getActiveStartPoint();
            if (!startPoint) {
                return;
            }

            options.updateSelection(payload, startPoint);
        },
        onPointerEnd(payload: ISnipPointerPayload) {
            const startPoint = getActiveStartPoint();
            if (!startPoint) {
                return;
            }

            options.onEnd(payload, startPoint);
        },
    };
}
