import type {
    InjectionKey,
    Ref,
} from 'vue';
import {
    useEventListener,
    useTimeoutFn,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';
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
import { capturePdfRegionAsPngBlob } from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import { writePngBlobToClipboard } from '@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard';

type TSnipState = 'idle' | 'selecting' | 'copying' | 'success' | 'error';

interface IUsePdfRegionSnipOptions {viewerContainer: Ref<HTMLElement | null>;}

interface IBadgePosition {
    x: number;
    y: number;
}

export interface IPdfRegionSnipKeyboardController {handleKeyboardKey: (event: KeyboardEvent) => boolean;}

export const pdfRegionSnipKeyboardKey: InjectionKey<IPdfRegionSnipKeyboardController> = Symbol(
    'pdf-region-snip-keyboard',
);

const MIN_KEYBOARD_SELECTION_SIZE = 8;

export const usePdfRegionSnip = (options: IUsePdfRegionSnipOptions) => {
    const state = ref<TSnipState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const flashRect = ref<ILocalRect | null>(null);
    const badgePosition = ref<IBadgePosition | null>(null);

    const isActive = computed(() => state.value === 'selecting' || state.value === 'copying');

    let dragStartPoint: IClientPoint | null = null;
    let pendingResolver: ((result: boolean) => void) | null = null;
    let captureSessionEpoch = 0;
    const isEscapeCancelActive = ref(false);
    let keyboardSelection: IClientRect | null = null;
    let keyboardOverlayRect: IOverlayRect | null = null;
    const escapeKeyTarget = computed(() => (
        isEscapeCancelActive.value && typeof window !== 'undefined'
            ? window
            : null
    ));
    const {
        start: startSuccessTimer,
        stop: stopSuccessTimer,
    } = useTimeoutFn(() => {
        resetOverlayVisuals();
        resolveSession(true);
    }, 850, { immediate: false });

    function clearSuccessTimer() {
        stopSuccessTimer();
    }

    function detachEscapeListener() {
        isEscapeCancelActive.value = false;
    }

    function resolveSession(result: boolean, options: { nextState?: TSnipState } = {}) {
        captureSessionEpoch += 1;
        detachEscapeListener();
        dragStartPoint = null;
        keyboardSelection = null;
        keyboardOverlayRect = null;
        state.value = options.nextState ?? 'idle';

        const resolver = pendingResolver;
        pendingResolver = null;
        resolver?.(result);
    }

    function resetOverlayVisuals() {
        selectionRect.value = null;
        flashRect.value = null;
        badgePosition.value = null;
    }

    function cancelCapture() {
        if (state.value === 'idle') {
            return;
        }

        clearSuccessTimer();
        resetOverlayVisuals();
        resolveSession(false);
    }

    function abortPendingSession() {
        if (!pendingResolver) {
            return;
        }
        clearSuccessTimer();
        resetOverlayVisuals();
        resolveSession(false);
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
        cancelCapture();
    }

    useEventListener(escapeKeyTarget, 'keydown', handleEscapeKey, { capture: true });

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        startPoint: IClientPoint,
    ) {
        const selection = createSelectionRectFromPointerDrag(payload, startPoint);
        selectionRect.value = selection.localRect;
        return selection.clientRect;
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

    function toOverlayClientRect(overlayRect: IOverlayRect): IClientRect {
        return {
            left: overlayRect.left,
            top: overlayRect.top,
            right: overlayRect.left + overlayRect.width,
            bottom: overlayRect.top + overlayRect.height,
        };
    }

    function createKeyboardSelection(overlayRect: IOverlayRect) {
        const selection = createKeyboardSelectionInBounds(
            toOverlayClientRect(overlayRect),
            MIN_KEYBOARD_SELECTION_SIZE,
        );
        keyboardSelection = selection;
        keyboardOverlayRect = overlayRect;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function rebaseKeyboardSelection(overlayRect: IOverlayRect) {
        if (keyboardSelection && keyboardOverlayRect) {
            const previousOverlayRect = toOverlayClientRect(keyboardOverlayRect);
            const nextOverlayRect = toOverlayClientRect(overlayRect);
            const previousWidth = getRectWidth(previousOverlayRect);
            const previousHeight = getRectHeight(previousOverlayRect);
            const nextWidth = getRectWidth(nextOverlayRect);
            const nextHeight = getRectHeight(nextOverlayRect);
            const rebased = previousWidth > 0 && previousHeight > 0 && nextWidth > 0 && nextHeight > 0
                ? {
                    left: nextOverlayRect.left + (keyboardSelection.left - previousOverlayRect.left) * nextWidth / previousWidth,
                    right: nextOverlayRect.left + (keyboardSelection.right - previousOverlayRect.left) * nextWidth / previousWidth,
                    top: nextOverlayRect.top + (keyboardSelection.top - previousOverlayRect.top) * nextHeight / previousHeight,
                    bottom: nextOverlayRect.top + (keyboardSelection.bottom - previousOverlayRect.top) * nextHeight / previousHeight,
                }
                : {
                    left: keyboardSelection.left + nextOverlayRect.left - previousOverlayRect.left,
                    right: keyboardSelection.right + nextOverlayRect.left - previousOverlayRect.left,
                    top: keyboardSelection.top + nextOverlayRect.top - previousOverlayRect.top,
                    bottom: keyboardSelection.bottom + nextOverlayRect.top - previousOverlayRect.top,
                };
            keyboardSelection = clampKeyboardSelection(rebased, nextOverlayRect);
        }
        keyboardOverlayRect = overlayRect;
    }

    function updateKeyboardSelection(event: KeyboardEvent) {
        const overlayRect = getOverlayRect();
        if (!overlayRect) {
            return null;
        }
        rebaseKeyboardSelection(overlayRect);
        let selection = keyboardSelection ?? createKeyboardSelection(overlayRect);
        selection = updateKeyboardSelectionInBounds(
            selection,
            toOverlayClientRect(overlayRect),
            event,
            MIN_KEYBOARD_SELECTION_SIZE,
        );
        keyboardSelection = selection;
        keyboardOverlayRect = overlayRect;
        selectionRect.value = toLocalRect(selection, overlayRect);
        return selection;
    }

    function setSuccessVisuals(outputRect: IClientRect, overlayRect: IOverlayRect) {
        const localRect = toLocalRect(outputRect, overlayRect);
        const badgeHeight = 28;
        const margin = 8;

        flashRect.value = localRect;
        badgePosition.value = {
            x: clamp(localRect.x + localRect.width / 2, margin, Math.max(margin, overlayRect.width - margin)),
            y: clamp(localRect.y + localRect.height + margin, margin, Math.max(margin, overlayRect.height - badgeHeight - margin)),
        };
    }

    async function completeSelectionRect(selection: IClientRect, overlayRect: IOverlayRect) {
        const sessionEpoch = captureSessionEpoch;
        const isCurrentSession = () => captureSessionEpoch === sessionEpoch;
        const viewerContainer = options.viewerContainer.value;
        if (!viewerContainer) {
            cancelCapture();
            return;
        }

        const selectionWidth = getRectWidth(selection);
        const selectionHeight = getRectHeight(selection);
        if (selectionWidth < 2 || selectionHeight < 2) {
            cancelCapture();
            return;
        }

        state.value = 'copying';
        try {
            const capture = await capturePdfRegionAsPngBlob(viewerContainer, selection);
            if (!isCurrentSession()) {
                return;
            }
            if (!capture) {
                cancelCapture();
                return;
            }

            await writePngBlobToClipboard(capture.blob);
            if (!isCurrentSession()) {
                return;
            }

            selectionRect.value = null;
            state.value = 'success';
            setSuccessVisuals(capture.outputRect, overlayRect);

            clearSuccessTimer();
            startSuccessTimer();
        } catch (error) {
            if (!isCurrentSession()) {
                return;
            }
            BrowserLogger.debug('pdf-snip', 'Failed to copy selected PDF region', error);
            resetOverlayVisuals();
            resolveSession(false, { nextState: 'error' });
        }
    }

    async function completeSelection(payload: ISnipPointerPayload) {
        if (!dragStartPoint) {
            cancelCapture();
            return;
        }
        const selection = updateSelectionFromPointer(payload, dragStartPoint);
        await completeSelectionRect(selection, payload.overlayRect);
    }

    function handleKeyboardKey(event: KeyboardEvent) {
        if (state.value !== 'selecting') {
            return false;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelCapture();
            return true;
        }
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            const overlayRect = getOverlayRect();
            if (overlayRect) {
                rebaseKeyboardSelection(overlayRect);
                const selection = keyboardSelection ?? createKeyboardSelection(overlayRect);
                void completeSelectionRect(selection, overlayRect);
            } else {
                cancelCapture();
            }
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
        onEnd: (payload) => {
            void completeSelection(payload);
        },
    });

    function startCaptureSession() {
        if (!options.viewerContainer.value) {
            return Promise.resolve(false);
        }
        // Starting a new session must settle any previous awaiter to avoid
        // retaining stale resolvers across quick repeated captures.
        abortPendingSession();
        if (state.value === 'selecting') {
            cancelCapture();
            return Promise.resolve(false);
        }
        if (state.value === 'copying') {
            return Promise.resolve(false);
        }

        clearSuccessTimer();
        resetOverlayVisuals();
        dragStartPoint = null;
        keyboardSelection = null;
        keyboardOverlayRect = null;
        captureSessionEpoch += 1;
        state.value = 'selecting';
        attachEscapeCancel();

        return new Promise<boolean>((resolve) => {
            pendingResolver = resolve;
        });
    }

    onUnmounted(() => {
        abortPendingSession();
        clearSuccessTimer();
        detachEscapeListener();
    });

    provide(pdfRegionSnipKeyboardKey, {handleKeyboardKey});

    return {
        state,
        isActive,
        selectionRect,
        flashRect,
        badgePosition,
        startCaptureSession,
        onPointerStart: pointerDragHandlers.onPointerStart,
        onPointerMove: pointerDragHandlers.onPointerMove,
        onPointerEnd: pointerDragHandlers.onPointerEnd,
        cancelCapture,
        handleKeyboardKey,
    };
};
