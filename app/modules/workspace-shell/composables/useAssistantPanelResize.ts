import {
    useEventListener,
    useStorage,
} from '@vueuse/core';
import { useClamp } from '@vueuse/math';
import { createRafCoalescedCallback } from '@app/utils/createRafCoalescedCallback';
import { getLocalStorageForVueUse } from '@app/utils/localStorage';

const ASSISTANT_PANEL = {
    DEFAULT_WIDTH: 384,
    MIN_WIDTH: 320,
    MAX_WIDTH: 560,
    RESIZER_WIDTH: 6,
} as const;

const ASSISTANT_PANEL_WIDTH_STORAGE_KEY = 'evb-viewer:assistant:panel-width';

function normalizePanelWidth(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : ASSISTANT_PANEL.DEFAULT_WIDTH;
}

export const useAssistantPanelResize = () => {
    const persistedPanelWidth = useStorage(
        ASSISTANT_PANEL_WIDTH_STORAGE_KEY,
        ASSISTANT_PANEL.DEFAULT_WIDTH,
        getLocalStorageForVueUse(),
    );
    const initialPanelWidth = normalizePanelWidth(persistedPanelWidth.value);
    if (persistedPanelWidth.value !== initialPanelWidth) {
        persistedPanelWidth.value = initialPanelWidth;
    }
    const panelWidth = useClamp(
        persistedPanelWidth,
        ASSISTANT_PANEL.MIN_WIDTH,
        ASSISTANT_PANEL.MAX_WIDTH,
    );
    const isResizingPanel = ref(false);

    let resizeStartX = 0;
    let resizeStartWidth = 0;

    function applyClampedWidth(width: number) {
        panelWidth.value = Math.round(normalizePanelWidth(width));
    }

    function handlePanelResize(event: PointerEvent) {
        if (!isResizingPanel.value) {
            return;
        }
        // The panel is docked to the right edge, so dragging its left-edge handle
        // toward the viewer (negative delta) must grow the panel.
        const deltaX = event.clientX - resizeStartX;
        applyClampedWidth(resizeStartWidth - deltaX);
    }

    const panelResize = createRafCoalescedCallback(handlePanelResize);

    let detachDragListeners: (() => void) | null = null;

    function cleanupPanelResize() {
        panelResize.cancel();
        detachDragListeners?.();
        detachDragListeners = null;
    }

    // Window-level pointer listeners exist only for the duration of a drag so idle
    // mouse movement does not schedule a frame callback for every pointermove.
    function attachDragListeners() {
        const target = typeof window !== 'undefined' ? window : undefined;
        const stops = [
            useEventListener(target, 'pointermove', panelResize.schedule),
            useEventListener(target, 'pointerup', stopPanelResize),
            useEventListener(target, 'pointercancel', stopPanelResize),
        ];
        detachDragListeners = () => {
            for (const stop of stops) {
                stop();
            }
        };
    }

    function stopPanelResize(event: PointerEvent) {
        if (!isResizingPanel.value) {
            return;
        }
        panelResize.flush(event);
        isResizingPanel.value = false;
        cleanupPanelResize();
    }

    function startPanelResize(event: PointerEvent) {
        event.preventDefault();
        isResizingPanel.value = true;
        resizeStartX = event.clientX;
        resizeStartWidth = panelWidth.value;
        cleanupPanelResize();
        attachDragListeners();
    }

    onMounted(() => {
        // Normalize any previously persisted value that falls outside the bounds.
        applyClampedWidth(persistedPanelWidth.value);
    });
    onScopeDispose(cleanupPanelResize);

    return {
        panelWidth,
        isResizingPanel,
        startPanelResize,
    };
};
