import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { getEventCurrentTarget } from '@app/utils/getEventCurrentTarget';

export interface IListDragSlot {
    top: number;
    height: number;
    centerY: number;
}

const THRESHOLD = 5;

export function clampListDragDeltaToDropSlots(
    deltaY: number,
    dragIndex: number,
    slots: readonly IListDragSlot[],
) {
    const dragSlot = slots[dragIndex];
    const firstSlot = slots[0];
    const lastSlot = slots[slots.length - 1];
    if (!dragSlot || !firstSlot || !lastSlot) {
        return deltaY;
    }

    const minDelta = firstSlot.top - dragSlot.top;
    const maxDelta = lastSlot.top - dragSlot.top;
    return Math.min(Math.max(deltaY, minDelta), maxDelta);
}

export const useListDragReorder = (
    containerRef: Ref<HTMLElement | null>,
    rowSelector: string,
    onReorder: (fromIndex: number, toIndex: number) => void,
    onDragStart?: (index: number) => void,
) => {
    const isDragging = ref(false);
    const dragIndex = ref(-1);

    let slots: IListDragSlot[] = [];
    let rowStride = 0;
    let targetIndex = -1;
    let pointerStartY = 0;
    let rowElements: HTMLElement[] = [];
    const activePointerTarget = ref<HTMLElement | null>(null);

    function captureSlots() {
        const el = containerRef.value;
        if (!el) {
            rowElements = [];
            slots = [];
            rowStride = 0;
            return;
        }
        rowElements = Array.from(el.querySelectorAll<HTMLElement>(rowSelector));
        slots = rowElements.map((row) => {
            const rect = row.getBoundingClientRect();
            return {
                top: rect.top,
                height: rect.height,
                centerY: rect.top + rect.height / 2,
            };
        });
        if (slots.length > 1) {
            const firstSlot = slots[0];
            const lastSlot = slots[slots.length - 1];
            if (!firstSlot || !lastSlot) {
                rowStride = 0;
                return;
            }
            rowStride = (lastSlot.top - firstSlot.top) / (slots.length - 1);
        } else {
            rowStride = slots[0]?.height ?? 0;
        }
    }

    function isBetween(i: number, from: number, to: number) {
        if (from < to) {
            return i > from && i <= to;
        }
        if (from > to) {
            return i >= to && i < from;
        }
        return false;
    }

    function calcTargetIndex(deltaY: number) {
        const dragSlot = slots[dragIndex.value];
        if (!dragSlot) {
            return dragIndex.value;
        }

        const visualTop = dragSlot.top + deltaY;
        const visualBottom = visualTop + dragSlot.height;

        if (deltaY > 0) {
            let target = dragIndex.value;
            for (let i = dragIndex.value + 1; i < slots.length; i++) {
                const slot = slots[i];
                if (slot && visualBottom > slot.centerY) {
                    target = i;
                }
            }
            return target;
        }

        if (deltaY < 0) {
            let target = dragIndex.value;
            for (let i = dragIndex.value - 1; i >= 0; i--) {
                const slot = slots[i];
                if (slot && visualTop < slot.centerY) {
                    target = i;
                }
            }
            return target;
        }

        return dragIndex.value;
    }

    function applyShifts() {
        if (!slots[dragIndex.value]) {
            return;
        }

        for (let i = 0; i < rowElements.length; i++) {
            if (i === dragIndex.value) continue;

            const el = rowElements[i];
            if (!el) {
                continue;
            }
            el.style.transition = 'transform var(--app-transition-reorder)';
            if (isBetween(i, dragIndex.value, targetIndex)) {
                const direction = targetIndex > dragIndex.value ? -1 : 1;
                el.style.transform = `translateY(${direction * rowStride}px)`;
            } else {
                el.style.transform = '';
            }
        }
    }

    function onPointerMove(e: PointerEvent) {
        const rawDeltaY = e.clientY - pointerStartY;

        if (!isDragging.value) {
            if (Math.abs(rawDeltaY) < THRESHOLD) {
                return;
            }
            isDragging.value = true;
            onDragStart?.(dragIndex.value);
            document.body.style.cursor = 'grabbing';
        }

        const deltaY = clampListDragDeltaToDropSlots(rawDeltaY, dragIndex.value, slots);
        const draggedEl = rowElements[dragIndex.value];
        if (draggedEl) {
            draggedEl.style.transition = '';
            draggedEl.style.transform = `translateY(${deltaY}px)`;
        }

        const newTarget = calcTargetIndex(deltaY);
        if (newTarget !== targetIndex) {
            targetIndex = newTarget;
            applyShifts();
        }
    }

    function clearAllTransforms() {
        for (const el of rowElements) {
            el.style.transform = '';
            el.style.transition = '';
        }
    }

    function resetDragState() {
        clearAllTransforms();
        isDragging.value = false;
        dragIndex.value = -1;
        targetIndex = -1;
        document.body.style.cursor = '';
        rowElements = [];
        slots = [];
        rowStride = 0;
        activePointerTarget.value = null;
    }

    function finishDrag() {
        if (dragIndex.value < 0) {
            return;
        }

        const wasDragging = isDragging.value;
        const from = dragIndex.value;
        const to = targetIndex;

        resetDragState();

        if (wasDragging && from !== to && from >= 0 && to >= 0) {
            onReorder(from, to);
        }
    }

    function onPointerDown(e: PointerEvent, index: number) {
        if (e.button !== 0) {
            return;
        }

        const el = getEventCurrentTarget(e, HTMLElement);
        if (!el) {
            return;
        }
        el.setPointerCapture(e.pointerId);

        pointerStartY = e.clientY;
        dragIndex.value = index;
        targetIndex = index;

        captureSlots();

        activePointerTarget.value = el;
    }

    useEventListener(activePointerTarget, 'pointermove', onPointerMove);
    useEventListener(activePointerTarget, 'pointerup', finishDrag);
    useEventListener(activePointerTarget, 'lostpointercapture', finishDrag);

    onUnmounted(resetDragState);

    return {
        isDragging: readonly(isDragging),
        dragIndex: readonly(dragIndex),
        onPointerDown,
        cancel: resetDragState,
    };
};
