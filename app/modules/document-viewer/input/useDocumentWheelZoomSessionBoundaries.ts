import { useEventListener } from '@vueuse/core';
import type { Ref } from 'vue';
import { shouldResetDocumentWheelZoomSession } from '@app/modules/document-viewer/input/documentWheelInteraction';

export const useDocumentWheelZoomSessionBoundaries = (options: {
    isInteractionActive: Readonly<Ref<boolean>>;
    reset: () => void;
}) => {
    const resetForInteraction = (event?: Event) => {
        if (shouldResetDocumentWheelZoomSession(options.isInteractionActive.value, event)) {
            options.reset();
        }
    };
    useEventListener(import.meta.client ? document : null, 'pointerdown', resetForInteraction, {capture: true});
    useEventListener(import.meta.client ? document : null, 'keydown', resetForInteraction, {capture: true});
    watch(options.isInteractionActive, (active) => {
        if (!active) options.reset();
    });
    return resetForInteraction;
};
