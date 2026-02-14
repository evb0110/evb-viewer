import {
    ref,
    readonly,
    onUnmounted,
    type Ref,
} from 'vue';

interface ISlot {
    left: number;
    width: number;
    centerX: number;
}

const THRESHOLD = 5;
const CLICK_SUPPRESS_MS = 300;

export const useTabDragReorder = (
    containerRef: Ref<HTMLElement | null>,
    onReorder: (fromIndex: number, toIndex: number) => void,
    onDragStart?: (index: number) => void,
) => {
    const isDragging = ref(false);
    const dragIndex = ref(-1);

    let slots: ISlot[] = [];
    let targetIndex = -1;
    let pointerStartX = 0;
    let tabElements: HTMLElement[] = [];
    let activeElement: HTMLElement | null = null;
    let lastDragEndTime = 0;

    function captureSlots() {
        const el = containerRef.value;
        if (!el) {
            tabElements = [];
            slots = [];
            return;
        }
        tabElements = Array.from(el.querySelectorAll<HTMLElement>('[data-tab-id]'));
        slots = tabElements.map((tab) => {
            const rect = tab.getBoundingClientRect();
            return {
                left: rect.left,
                width: rect.width,
                centerX: rect.left + rect.width / 2,
            };
        });
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

    function calcTargetIndex(deltaX: number) {
        const dragSlot = slots[dragIndex.value];
        if (!dragSlot) {
            return dragIndex.value;
        }

        const visualLeft = dragSlot.left + deltaX;
        const visualRight = visualLeft + dragSlot.width;

        if (deltaX > 0) {
            let target = dragIndex.value;
            for (let i = dragIndex.value + 1; i < slots.length; i++) {
                if (visualRight > slots[i]!.centerX) {
                    target = i;
                }
            }
            return target;
        }

        if (deltaX < 0) {
            let target = dragIndex.value;
            for (let i = dragIndex.value - 1; i >= 0; i--) {
                if (visualLeft < slots[i]!.centerX) {
                    target = i;
                }
            }
            return target;
        }

        return dragIndex.value;
    }

    function applyShifts() {
        const dragSlot = slots[dragIndex.value];
        if (!dragSlot) {
            return;
        }

        for (let i = 0; i < tabElements.length; i++) {
            if (i === dragIndex.value) continue;

            const el = tabElements[i]!;
            if (isBetween(i, dragIndex.value, targetIndex)) {
                const direction = targetIndex > dragIndex.value ? -1 : 1;
                el.style.transform = `translateX(${direction * dragSlot.width}px)`;
                el.style.transition = 'transform 200ms ease';
            } else {
                el.style.transition = 'transform 200ms ease';
                el.style.transform = '';
            }
        }
    }

    function onPointerMove(e: PointerEvent) {
        const deltaX = e.clientX - pointerStartX;

        if (!isDragging.value) {
            if (Math.abs(deltaX) < THRESHOLD) {
                return;
            }
            isDragging.value = true;
            onDragStart?.(dragIndex.value);
            document.body.style.cursor = 'grabbing';
        }

        const draggedEl = tabElements[dragIndex.value];
        if (draggedEl) {
            draggedEl.style.transform = `translateX(${deltaX}px)`;
        }

        const newTarget = calcTargetIndex(deltaX);
        if (newTarget !== targetIndex) {
            targetIndex = newTarget;
            applyShifts();
        }
    }

    function clearAllTransforms() {
        for (const el of tabElements) {
            el.style.transform = '';
            el.style.transition = '';
        }
    }

    function detachListeners() {
        if (activeElement) {
            activeElement.removeEventListener('pointermove', onPointerMove);
            activeElement.removeEventListener('pointerup', onPointerUp);
            activeElement.removeEventListener('lostpointercapture', onLostCapture);
            activeElement = null;
        }
    }

    function finishDrag() {
        const wasDragging = isDragging.value;
        const from = dragIndex.value;
        const to = targetIndex;

        clearAllTransforms();
        isDragging.value = false;
        dragIndex.value = -1;
        targetIndex = -1;
        document.body.style.cursor = '';
        tabElements = [];
        slots = [];
        detachListeners();

        if (wasDragging && from !== to && from >= 0 && to >= 0) {
            lastDragEndTime = Date.now();
            onReorder(from, to);
        }
    }

    function onPointerUp() {
        if (isDragging.value) {
            lastDragEndTime = Date.now();
        }
        finishDrag();
    }

    function onLostCapture() {
        if (isDragging.value) {
            lastDragEndTime = Date.now();
        }
        finishDrag();
    }

    function onPointerDown(e: PointerEvent, index: number) {
        if (e.button !== 0) {
            return;
        }

        const el = e.currentTarget as HTMLElement;
        el.setPointerCapture(e.pointerId);

        activeElement = el;
        pointerStartX = e.clientX;
        dragIndex.value = index;
        targetIndex = index;

        captureSlots();

        el.addEventListener('pointermove', onPointerMove);
        el.addEventListener('pointerup', onPointerUp);
        el.addEventListener('lostpointercapture', onLostCapture);
    }

    function shouldSuppressClick() {
        return Date.now() - lastDragEndTime < CLICK_SUPPRESS_MS;
    }

    onUnmounted(() => {
        clearAllTransforms();
        detachListeners();
        document.body.style.cursor = '';
    });

    return {
        isDragging: readonly(isDragging),
        dragIndex: readonly(dragIndex),
        onPointerDown,
        shouldSuppressClick,
    };
};
