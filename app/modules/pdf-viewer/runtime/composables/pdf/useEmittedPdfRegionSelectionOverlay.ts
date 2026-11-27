import {usePdfRegionSelectionOverlay} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSelectionOverlay';
import type {
    IRegionSelectionOverlayBaseProps,
    IRegionSelectionOverlayEmits,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSelectionOverlay';

export const useEmittedPdfRegionSelectionOverlay = (props: IRegionSelectionOverlayBaseProps, emit: IRegionSelectionOverlayEmits) => {
    return usePdfRegionSelectionOverlay({
        isActive: () => props.active,
        onPointerStart: (payload) => emit('pointer-start', payload),
        onPointerMove: (payload) => emit('pointer-move', payload),
        onPointerEnd: (payload) => emit('pointer-end', payload),
        onCancel: () => emit('cancel'),
    });
};
