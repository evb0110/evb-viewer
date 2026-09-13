import { parsePageNumber } from '@contracts/pageNumbers';
import type { TPageNumber } from '@contracts/pageNumbers';

import type {
    InjectionKey,
    Ref,
} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { ICropSelectionResult } from '@app/types/crop';
import type {
    IClientPoint,
    IClientRect,
    ILocalRect,
    IOverlayRect,
} from '@app/modules/document-viewer/public';
import {
    getRectHeight, getRectWidth , toClientRect , toLocalRect ,
    clampKeyboardSelection,
    createKeyboardSelection as createKeyboardSelectionInBounds,
    updateKeyboardSelection as updateKeyboardSelectionInBounds, 
} from '@app/modules/document-viewer/public';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import { createSelectionPointerDragHandlers } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionPointerDragHandlers';
import { createSelectionRectFromPointerDrag } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionRectFromPointerDrag';

type TCropSelectionState = 'idle' | 'selecting';

interface IUsePdfCropSelectionOptions {viewerContainer: Ref<HTMLElement | null>;}

interface IPageTarget {
    pageNumber: TPageNumber;
    clientRect: IClientRect;
}

export interface IPdfCropSelectionKeyboardController {handleKeyboardKey: (event: KeyboardEvent) => boolean;}

export const pdfCropSelectionKeyboardKey: InjectionKey<IPdfCropSelectionKeyboardController> = Symbol(
    'pdf-crop-selection-keyboard',
);

const MIN_SELECTION_SIZE = 5;

export const usePdfCropSelection = (options: IUsePdfCropSelectionOptions) => {
    const state = ref<TCropSelectionState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const isSelecting = computed(() => state.value === 'selecting');

    let dragStartPoint: IClientPoint | null = null;
    let pendingResolver: ((result: ICropSelectionResult | null) => void) | null = null;
    const isEscapeCancelActive = ref(false);
    let activePageTarget: IPageTarget | null = null;
    let keyboardSelection: IClientRect | null = null;
    let previousKeyboardPageRect: IClientRect | null = null;
    const escapeKeyTarget = computed(() => (
        isEscapeCancelActive.value && typeof window !== 'undefined'
            ? window
            : null
    ));

    function toOverlayRect(rect: IClientRect): IOverlayRect {
        return {
            left: rect.left,
            top: rect.top,
            width: getRectWidth(rect),
            height: getRectHeight(rect),
        };
    }

    function containsClientPoint(rect: IClientRect, clientX: number, clientY: number) {
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    function toPageTarget(element: HTMLElement, clientRect: IClientRect): IPageTarget | null {
        const pageNumber = parsePageNumber(parseInt(element.dataset.page ?? '', 10));
        return pageNumber !== null
            ? {
                pageNumber,
                clientRect,
            }
            : null;
    }

    function findPageTargetAtPoint(clientX: number, clientY: number): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container[data-page]');
        for (const el of pageContainers) {
            const rect = toClientRect(el.getBoundingClientRect());
            if (containsClientPoint(rect, clientX, clientY)) {
                return toPageTarget(el, rect);
            }
        }
        return null;
    }

    function findKeyboardPageTarget(): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }

        const containerRect = toClientRect(container.getBoundingClientRect());
        let bestTarget: IPageTarget | null = null;
        let bestVisibleArea = 0;
        for (const el of container.querySelectorAll<HTMLElement>('.page_container[data-page]')) {
            const clientRect = toClientRect(el.getBoundingClientRect());
            const visibleWidth = Math.max(
                0,
                Math.min(clientRect.right, containerRect.right) - Math.max(clientRect.left, containerRect.left),
            );
            const visibleHeight = Math.max(
                0,
                Math.min(clientRect.bottom, containerRect.bottom) - Math.max(clientRect.top, containerRect.top),
            );
            const visibleArea = visibleWidth * visibleHeight;
            if (visibleArea > bestVisibleArea) {
                bestTarget = toPageTarget(el, clientRect);
                bestVisibleArea = visibleArea;
            }
            if (!bestTarget && getRectWidth(clientRect) > 0 && getRectHeight(clientRect) > 0) {
                bestTarget = toPageTarget(el, clientRect);
            }
        }
        return bestTarget;
    }

    function findPageTargetByNumber(pageNumber: TPageNumber): IPageTarget | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }

        for (const element of container.querySelectorAll<HTMLElement>('.page_container[data-page]')) {
            if (Number(element.dataset.page) === pageNumber) {
                return toPageTarget(element, toClientRect(element.getBoundingClientRect()));
            }
        }
        return null;
    }

    function getOverlayRect(): IOverlayRect | null {
        const container = options.viewerContainer.value;
        if (!container) {
            return null;
        }
        const rect = toClientRect(container.getBoundingClientRect());
        return {
            left: rect.left,
            top: rect.top,
            width: getRectWidth(rect),
            height: getRectHeight(rect),
        };
    }

    function createKeyboardSelection(pageTarget: IPageTarget, overlayRect: IOverlayRect) {
        const selection = createKeyboardSelectionInBounds(pageTarget.clientRect, MIN_SELECTION_SIZE);
        keyboardSelection = selection;
        previousKeyboardPageRect = pageTarget.clientRect;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function rebaseKeyboardSelection(pageRect: IClientRect) {
        if (keyboardSelection && previousKeyboardPageRect) {
            const previousWidth = getRectWidth(previousKeyboardPageRect);
            const previousHeight = getRectHeight(previousKeyboardPageRect);
            const nextWidth = getRectWidth(pageRect);
            const nextHeight = getRectHeight(pageRect);
            const rebased = previousWidth > 0 && previousHeight > 0 && nextWidth > 0 && nextHeight > 0
                ? {
                    left: pageRect.left + (keyboardSelection.left - previousKeyboardPageRect.left) * nextWidth / previousWidth,
                    right: pageRect.left + (keyboardSelection.right - previousKeyboardPageRect.left) * nextWidth / previousWidth,
                    top: pageRect.top + (keyboardSelection.top - previousKeyboardPageRect.top) * nextHeight / previousHeight,
                    bottom: pageRect.top + (keyboardSelection.bottom - previousKeyboardPageRect.top) * nextHeight / previousHeight,
                }
                : {
                    left: keyboardSelection.left + pageRect.left - previousKeyboardPageRect.left,
                    right: keyboardSelection.right + pageRect.left - previousKeyboardPageRect.left,
                    top: keyboardSelection.top + pageRect.top - previousKeyboardPageRect.top,
                    bottom: keyboardSelection.bottom + pageRect.top - previousKeyboardPageRect.top,
                };
            keyboardSelection = clampKeyboardSelection(rebased, pageRect);
        }
        previousKeyboardPageRect = pageRect;
    }

    function updateKeyboardSelection(event: KeyboardEvent) {
        const pageTarget = activePageTarget
            ? findPageTargetByNumber(activePageTarget.pageNumber) ?? findKeyboardPageTarget()
            : findKeyboardPageTarget();
        const overlayRect = getOverlayRect();
        if (!pageTarget || !overlayRect) {
            return null;
        }
        activePageTarget = pageTarget;
        rebaseKeyboardSelection(pageTarget.clientRect);
        let selection = keyboardSelection ?? createKeyboardSelection(pageTarget, overlayRect);
        selection = updateKeyboardSelectionInBounds(
            selection,
            pageTarget.clientRect,
            event,
            MIN_SELECTION_SIZE,
        );
        keyboardSelection = selection;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function detachEscapeListener() {
        isEscapeCancelActive.value = false;
    }

    function resolveSession(result: ICropSelectionResult | null) {
        detachEscapeListener();
        dragStartPoint = null;
        activePageTarget = null;
        keyboardSelection = null;
        selectionRect.value = null;
        state.value = 'idle';

        const resolver = pendingResolver;
        pendingResolver = null;
        resolver?.(result);
    }

    function cancelSelection() {
        if (state.value === 'idle') {
            return;
        }
        resolveSession(null);
    }

    function abortPendingSession() {
        if (!pendingResolver) {
            return;
        }
        resolveSession(null);
    }

    function attachEscapeCancel() {
        detachEscapeListener();
        isEscapeCancelActive.value = true;
    }

    function handleEscapeKey(event: KeyboardEvent) {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        cancelSelection();
    }

    useEventListener(escapeKeyTarget, 'keydown', handleEscapeKey, { capture: true });

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        start: IClientPoint,
    ) {
        if (!activePageTarget) {
            selectionRect.value = null;
            return null;
        }

        const selection = createSelectionRectFromPointerDrag(
            payload,
            start,
            activePageTarget.clientRect,
        );
        selectionRect.value = selection.localRect;
        return selection.clientRect;
    }

    function prepareSelectionStart(payload: ISnipPointerPayload) {
        const pageTarget = findPageTargetAtPoint(payload.clientX, payload.clientY);
        activePageTarget = pageTarget;
    }

    function completeSelection(
        payload: ISnipPointerPayload,
        startPoint: IClientPoint,
    ) {
        const selection = updateSelectionFromPointer(payload, startPoint);
        const pageTarget = activePageTarget;

        if (!selection || !pageTarget) {
            resolveSession(null);
            return;
        }

        const pageLocalRect = toLocalRect(selection, toOverlayRect(pageTarget.clientRect));
        if (pageLocalRect.width < MIN_SELECTION_SIZE || pageLocalRect.height < MIN_SELECTION_SIZE) {
            resolveSession(null);
            return;
        }

        resolveSession({
            pageNumber: pageTarget.pageNumber,
            pageRect: {
                width: getRectWidth(pageTarget.clientRect),
                height: getRectHeight(pageTarget.clientRect),
            },
            pageLocalRect,
        });
    }

    function completeKeyboardSelection() {
        const pageTarget = activePageTarget
            ? findPageTargetByNumber(activePageTarget.pageNumber) ?? findKeyboardPageTarget()
            : findKeyboardPageTarget();
        const overlayRect = getOverlayRect();
        if (!pageTarget || !overlayRect) {
            cancelSelection();
            return;
        }
        activePageTarget = pageTarget;
        rebaseKeyboardSelection(pageTarget.clientRect);
        const selection = keyboardSelection ?? createKeyboardSelection(pageTarget, overlayRect);

        const pageLocalRect = toLocalRect(
            selection,
            toOverlayRect(pageTarget.clientRect),
        );
        if (pageLocalRect.width < MIN_SELECTION_SIZE || pageLocalRect.height < MIN_SELECTION_SIZE) {
            cancelSelection();
            return;
        }

        resolveSession({
            pageNumber: pageTarget.pageNumber,
            pageRect: {
                width: getRectWidth(pageTarget.clientRect),
                height: getRectHeight(pageTarget.clientRect),
            },
            pageLocalRect,
        });
    }

    function handleKeyboardKey(event: KeyboardEvent) {
        if (state.value !== 'selecting') {
            return false;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelSelection();
            return true;
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            completeKeyboardSelection();
            return true;
        }
        if (![
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
        ].includes(event.key)) {
            return false;
        }
        event.preventDefault();
        updateKeyboardSelection(event);
        return true;
    }

    const pointerDragHandlers = createSelectionPointerDragHandlers({
        getState: () => state.value,
        getStartPoint: () => dragStartPoint,
        setStartPoint: (point) => {
            dragStartPoint = point;
        },
        updateSelection: updateSelectionFromPointer,
        onStart: prepareSelectionStart,
        onEnd: completeSelection,
    });

    function startCropSelection() {
        if (!options.viewerContainer.value) {
            return Promise.resolve(null);
        }

        abortPendingSession();
        if (state.value === 'selecting') {
            cancelSelection();
            return Promise.resolve(null);
        }

        selectionRect.value = null;
        dragStartPoint = null;
        activePageTarget = null;
        keyboardSelection = null;
        previousKeyboardPageRect = null;
        state.value = 'selecting';
        attachEscapeCancel();

        return new Promise<ICropSelectionResult | null>((resolve) => {
            pendingResolver = resolve;
        });
    }

    onUnmounted(() => {
        abortPendingSession();
        detachEscapeListener();
    });

    provide(pdfCropSelectionKeyboardKey, {handleKeyboardKey});

    return {
        state,
        isSelecting,
        selectionRect,
        startCropSelection,
        onPointerStart: pointerDragHandlers.onPointerStart,
        onPointerMove: pointerDragHandlers.onPointerMove,
        onPointerEnd: pointerDragHandlers.onPointerEnd,
        cancelSelection,
        handleKeyboardKey,
    };
};
