import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { getEventCurrentTarget } from '@app/utils/getEventCurrentTarget';

interface ISlot {
    left: number;
    width: number;
    centerX: number;
}

interface IRectSnapshot {
    left: number;
    right: number;
}

interface ITabSlotSnapshot extends ISlot { element: HTMLElement; }

interface ITabListSnapshot {
    tabList: HTMLElement;
    rect: IRectSnapshot;
    tabs: ITabSlotSnapshot[];
}

interface IOutsideMoveTarget {
    insertionIndex: number | null;
    tabElements: HTMLElement[];
}

const THRESHOLD = 5;
const CLICK_SUPPRESS_MS = 300;
const OUTSIDE_MOVE_THRESHOLD = 16;
const DRAG_PREVIEW_Z_INDEX = '2147483647';

export const useTabDragReorder = (
    containerRef: Ref<HTMLElement | null>,
    onReorder: (fromIndex: number, toIndex: number) => void,
    onDragStart?: (index: number) => void,
    onMoveToDirection?: (
        fromIndex: number,
        direction: 'left' | 'right',
        targetIndex: number | null,
    ) => void,
) => {
    const isDragging = ref(false);
    const dragIndex = ref(-1);

    let slots: ISlot[] = [];
    let targetIndex = -1;
    let pointerStartX = 0;
    let tabElements: HTMLElement[] = [];
    const activePointerTarget = ref<HTMLElement | null>(null);
    let lastDragEndTime = 0;
    let dragPreviewEl: HTMLElement | null = null;
    let draggedSourceEl: HTMLElement | null = null;
    let draggedSourceVisibility = '';
    let externalShiftElements: HTMLElement[] = [];
    let externalShiftDistance = 0;
    let sourceTabList: HTMLElement | null = null;
    let sourceTabListRect: IRectSnapshot | null = null;
    let tabListSnapshots: ITabListSnapshot[] = [];

    function toRectSnapshot(rect: Pick<DOMRect, 'left' | 'right'>) {
        return {
            left: rect.left,
            right: rect.right,
        };
    }

    function captureSlots() {
        const el = containerRef.value;
        if (!el) {
            tabElements = [];
            slots = [];
            sourceTabList = null;
            sourceTabListRect = null;
            tabListSnapshots = [];
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
        sourceTabList = getSourceTabList();
        sourceTabListRect = sourceTabList
            ? toRectSnapshot(sourceTabList.getBoundingClientRect())
            : null;
        tabListSnapshots = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-list]'))
            .map((tabList) => {
                const rect = tabList.getBoundingClientRect();
                return {
                    tabList,
                    rect: toRectSnapshot(rect),
                    tabs: Array.from(tabList.querySelectorAll<HTMLElement>('[data-tab-id]'))
                        .map((tab) => {
                            const tabRect = tab.getBoundingClientRect();
                            return {
                                element: tab,
                                left: tabRect.left,
                                width: tabRect.width,
                                centerX: tabRect.left + tabRect.width / 2,
                            };
                        }),
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
                const slot = slots[i];
                if (slot && visualRight > slot.centerX) {
                    target = i;
                }
            }
            return target;
        }

        if (deltaX < 0) {
            let target = dragIndex.value;
            for (let i = dragIndex.value - 1; i >= 0; i--) {
                const slot = slots[i];
                if (slot && visualLeft < slot.centerX) {
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
            if (i === dragIndex.value) {continue;}

            const el = tabElements[i];
            if (!el) {continue;}
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

    function clearExternalShifts() {
        for (const el of externalShiftElements) {
            el.style.transform = '';
            el.style.transition = '';
        }
        externalShiftElements = [];
        externalShiftDistance = 0;
    }

    function getSourceTabList() {
        return containerRef.value?.querySelector<HTMLElement>('[data-tab-list]') ?? containerRef.value;
    }

    function resolveInsertionIndex(snapshot: ITabListSnapshot, pointerX: number) {
        for (let i = 0; i < snapshot.tabs.length; i++) {
            const tab = snapshot.tabs[i];
            if (tab && pointerX < tab.centerX) {
                return i;
            }
        }
        return snapshot.tabs.length;
    }

    function resolveOutsideMoveTarget(direction: 'left' | 'right', pointerX: number): IOutsideMoveTarget {
        const sourceList = sourceTabList;
        const sourceRect = sourceTabListRect;
        if (!sourceList || !sourceRect) {
            return {
                insertionIndex: null,
                tabElements: [],
            };
        }

        const candidateLists = tabListSnapshots
            .filter(snapshot => snapshot.tabList !== sourceList)
            .filter(candidate => direction === 'right'
                ? candidate.rect.left >= sourceRect.right - 1
                : candidate.rect.right <= sourceRect.left + 1);

        const containingList = candidateLists.find(candidate => (
            pointerX >= candidate.rect.left && pointerX <= candidate.rect.right
        ));
        const nearestList = containingList ?? [...candidateLists]
            .sort((a, b) => {
                const aDistance = direction === 'right'
                    ? Math.abs(a.rect.left - pointerX)
                    : Math.abs(a.rect.right - pointerX);
                const bDistance = direction === 'right'
                    ? Math.abs(b.rect.left - pointerX)
                    : Math.abs(b.rect.right - pointerX);
                return aDistance - bDistance;
            })[0] ?? null;

        if (!nearestList) {
            return {
                insertionIndex: null,
                tabElements: [],
            };
        }

        return {
            insertionIndex: resolveInsertionIndex(nearestList, pointerX),
            tabElements: nearestList.tabs.map(tab => tab.element),
        };
    }

    function areSameElements(left: HTMLElement[], right: HTMLElement[]) {
        return left.length === right.length
            && left.every((element, index) => element === right[index]);
    }

    function applyExternalShifts(elements: HTMLElement[], shiftDistance: number) {
        if (externalShiftDistance === shiftDistance && areSameElements(externalShiftElements, elements)) {
            return;
        }

        clearExternalShifts();
        externalShiftElements = elements;
        externalShiftDistance = shiftDistance;

        for (const el of externalShiftElements) {
            el.style.transform = `translateX(${shiftDistance}px)`;
            el.style.transition = 'transform 200ms ease';
        }
    }

    function applyExternalTargetShifts(pointerX: number) {
        const moveDirection = resolveOutsideMoveDirection(pointerX, isDragging.value);
        const dragSlot = slots[dragIndex.value];
        if (!moveDirection || !dragSlot) {
            clearExternalShifts();
            return;
        }

        const target = resolveOutsideMoveTarget(moveDirection, pointerX);
        if (target.insertionIndex === null) {
            clearExternalShifts();
            return;
        }

        applyExternalShifts(target.tabElements.slice(target.insertionIndex), dragSlot.width);
    }

    function restoreDraggedSourceVisibility() {
        if (!draggedSourceEl) {
            return;
        }

        draggedSourceEl.style.visibility = draggedSourceVisibility;
        draggedSourceEl = null;
        draggedSourceVisibility = '';
    }

    function hideDraggedSource(el: HTMLElement) {
        if (draggedSourceEl === el) {
            return;
        }

        restoreDraggedSourceVisibility();
        draggedSourceEl = el;
        draggedSourceVisibility = el.style.visibility;
        el.style.visibility = 'hidden';
    }

    function createDragPreview(el: HTMLElement) {
        const rect = el.getBoundingClientRect();
        const preview = el.cloneNode(true) as HTMLElement;
        preview.removeAttribute('data-tab-id');
        preview.setAttribute('data-tab-drag-preview', 'true');
        preview.setAttribute('aria-hidden', 'true');
        preview.style.position = 'fixed';
        preview.style.left = `${rect.left}px`;
        preview.style.top = `${rect.top}px`;
        preview.style.width = `${rect.width}px`;
        preview.style.height = `${rect.height}px`;
        preview.style.margin = '0';
        preview.style.pointerEvents = 'none';
        preview.style.transition = 'none';
        preview.style.zIndex = DRAG_PREVIEW_Z_INDEX;
        preview.style.boxSizing = 'border-box';
        preview.style.setProperty('-webkit-app-region', 'no-drag');
        document.body.append(preview);
        dragPreviewEl = preview;
    }

    function updateDragPreview(deltaX: number) {
        const draggedEl = tabElements[dragIndex.value];
        if (!draggedEl) {
            return false;
        }

        if (!dragPreviewEl) {
            createDragPreview(draggedEl);
            hideDraggedSource(draggedEl);
        }

        if (!dragPreviewEl) {
            return false;
        }

        dragPreviewEl.style.transform = `translate3d(${deltaX}px, 0, 0)`;
        return true;
    }

    function clearDragPreview() {
        dragPreviewEl?.remove();
        dragPreviewEl = null;
        restoreDraggedSourceVisibility();
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
        if (draggedEl && !updateDragPreview(deltaX)) {
            draggedEl.style.transform = `translateX(${deltaX}px)`;
        }

        const newTarget = calcTargetIndex(deltaX);
        if (newTarget !== targetIndex) {
            targetIndex = newTarget;
            applyShifts();
        }
        applyExternalTargetShifts(e.clientX);
    }

    function clearAllTransforms() {
        for (const el of tabElements) {
            el.style.transform = '';
            el.style.transition = '';
        }
        clearExternalShifts();
    }

    function detachListeners() {
        activePointerTarget.value = null;
    }

    function resolveOutsideMoveDirection(pointerX: number | null, wasDragging: boolean) {
        const containerRect = containerRef.value?.getBoundingClientRect() ?? null;
        if (!wasDragging || pointerX === null || !containerRect) {
            return null;
        }

        if (pointerX < containerRect.left - OUTSIDE_MOVE_THRESHOLD) {
            return 'left';
        }

        if (pointerX > containerRect.right + OUTSIDE_MOVE_THRESHOLD) {
            return 'right';
        }

        return null;
    }

    function resetDragState() {
        clearAllTransforms();
        clearDragPreview();
        isDragging.value = false;
        dragIndex.value = -1;
        targetIndex = -1;
        document.body.style.cursor = '';
        tabElements = [];
        slots = [];
        sourceTabList = null;
        sourceTabListRect = null;
        tabListSnapshots = [];
        detachListeners();
    }

    function completeMoveToDirection(
        wasDragging: boolean,
        from: number,
        moveDirection: 'left' | 'right' | null,
        targetInsertionIndex: number | null,
    ) {
        if (wasDragging && moveDirection && from >= 0) {
            lastDragEndTime = Date.now();
            onMoveToDirection?.(from, moveDirection, targetInsertionIndex);
            return true;
        }

        return false;
    }

    function completeReorder(wasDragging: boolean, from: number, to: number) {
        if (wasDragging && from !== to && from >= 0 && to >= 0) {
            lastDragEndTime = Date.now();
            onReorder(from, to);
        }
    }

    function finishDrag(pointerX: number | null) {
        const wasDragging = isDragging.value;
        const from = dragIndex.value;
        const to = targetIndex;
        const moveDirection = resolveOutsideMoveDirection(pointerX, wasDragging);
        const targetInsertionIndex = moveDirection && pointerX !== null
            ? resolveOutsideMoveTarget(moveDirection, pointerX).insertionIndex
            : null;

        resetDragState();

        if (!completeMoveToDirection(wasDragging, from, moveDirection, targetInsertionIndex)) {
            completeReorder(wasDragging, from, to);
        }
    }

    function onPointerUp(event: PointerEvent) {
        if (isDragging.value) {
            lastDragEndTime = Date.now();
        }
        finishDrag(event.clientX);
    }

    function onLostCapture(event: PointerEvent) {
        if (isDragging.value) {
            lastDragEndTime = Date.now();
        }
        finishDrag(event.clientX);
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

        pointerStartX = e.clientX;
        dragIndex.value = index;
        targetIndex = index;

        captureSlots();

        activePointerTarget.value = el;
    }

    useEventListener(activePointerTarget, 'pointermove', onPointerMove);
    useEventListener(activePointerTarget, 'pointerup', onPointerUp);
    useEventListener(activePointerTarget, 'lostpointercapture', onLostCapture);

    function shouldSuppressClick() {
        return Date.now() - lastDragEndTime < CLICK_SUPPRESS_MS;
    }

    onUnmounted(() => {
        clearAllTransforms();
        clearDragPreview();
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
