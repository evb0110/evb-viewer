import type {
    ComputedRef, InjectionKey, Ref,
} from 'vue';
import {
    useEventListener, useTimeoutFn,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';
import type {
    IClientPoint, IClientRect, ILocalRect, IOverlayRect,
} from '@app/modules/document-viewer/public';
import {
    getRectHeight, getRectWidth, toClientRect, toLocalRect, clampKeyboardSelection, createKeyboardSelection as createKeyboardSelectionInBounds, updateKeyboardSelection as updateKeyboardSelectionInBounds,
} from '@app/modules/document-viewer/public';
import type { ISnipPointerPayload } from '@app/modules/pdf-viewer/engine/pdf-region-drag/snipPointerPayload';
import { createSelectionPointerDragHandlers } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionPointerDragHandlers';
import { createSelectionRectFromPointerDrag } from '@app/modules/pdf-viewer/engine/pdf-region-drag/createSelectionRectFromPointerDrag';
import {
    capturePdfRegionAsPngBlob, freezePdfRegionCapture,
} from '@app/modules/pdf-viewer/engine/pdf-region-capture/capturePdfRegionAsPngBlob';
import type { ICapturePlan } from '@app/modules/pdf-viewer/engine/pdf-region-capture/pdfRegionCaptureTypes';
import { writePngBlobToClipboard } from '@app/modules/pdf-viewer/engine/pdf-region-clipboard/writePngBlobToClipboard';
import { getImageExportCapability } from '@app/utils/platformDocuments';
import { hasElectronAPI } from '@app/utils/platform';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';
import type { TPdfDocumentView } from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import {
    useFailureToast, isFailurePresentation,
} from '@app/composables/useFailureToast';
import { getFailureReceipt } from '@contracts/diagnostics/failureReceipt';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

type TSnipState = 'idle' | 'selecting' | 'preparing' | 'confirming' | 'permission' | 'capturing' | 'copying' | 'success';
interface IUsePdfRegionSnipOptions {
    viewerContainer: Ref<HTMLElement | null>;
    document: Pick<TPdfDocumentView, 'captureFence' | 'isCurrent' | 'subscribe' | 'registerDisposable'>;
    prepare: () => void | Promise<void>;
    viewState: Pick<IPdfViewerProps, 'zoomState' | 'viewRotation' | 'isInteractionActive' | 'isActive' | 'isResizing' | 'viewMode'>;
}
interface ISnipSession {
    state: Exclude<TSnipState, 'idle'>;
    completion: PromiseWithResolvers<boolean>;
    abort: AbortController;
    fence: ReturnType<TPdfDocumentView['captureFence']>;
    preparation: Promise<void>;
    work?: Promise<void>;
    plan?: ICapturePlan;
    target?: Element | undefined;
    assertCurrent?: () => void;
    overlay?: IOverlayRect;
}
interface IBadgePosition {
    x: number;
    y: number;
}
export interface IPdfRegionSnipKeyboardController {
    handleKeyboardKey: (event: KeyboardEvent) => boolean;
    state: ComputedRef<TSnipState>;
    confirmCapture: () => void;
    setCropTarget: (element: Element | null) => void;
}
export const pdfRegionSnipKeyboardKey: InjectionKey<IPdfRegionSnipKeyboardController> = Symbol('pdf-region-snip-keyboard');
const MIN_KEYBOARD_SELECTION_SIZE = 8;

export const usePdfRegionSnip = (options: IUsePdfRegionSnipOptions) => {
    const session = shallowRef<ISnipSession | null>(null);
    const getViewState = () => [
        JSON.stringify(options.viewState.zoomState),
        options.viewState.viewRotation,
        options.viewState.isInteractionActive,
        options.viewState.isActive,
        options.viewState.isResizing,
        options.viewState.viewMode,
    ];
    const state = computed(() => session.value?.state ?? 'idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const flashRect = ref<ILocalRect | null>(null);
    const badgePosition = ref<IBadgePosition | null>(null);
    const isActive = computed(() => state.value !== 'idle' && state.value !== 'success');
    const isCleanPaint = computed(() => state.value === 'capturing');
    const {t} = useTypedI18n();
    const {
        presentFailureToast, presentNoticeToast,
    } = useFailureToast();
    let dragStartPoint: IClientPoint | null = null;
    let keyboardSelection: IClientRect | null = null;
    let keyboardOverlayRect: IOverlayRect | null = null;
    const {
        start: startSuccessTimer, stop: stopSuccessTimer,
    } = useTimeoutFn(() => {
        if (session.value?.state === 'success') finish(session.value, true);
    }, 850, {immediate: false});
    const current = (value: ISnipSession) => session.value === value && !value.abort.signal.aborted;
    function setState(value: ISnipSession, next: ISnipSession['state']) {
        value.state = next;
        triggerRef(session);
    }
    function resetOverlayVisuals() {
        selectionRect.value = null;
        flashRect.value = null;
        badgePosition.value = null;
    }
    function finish(value: ISnipSession, copied: boolean, cause?: unknown) {
        value.abort.abort(cause);
        value.completion.resolve(copied);
        if (session.value !== value) return;
        stopSuccessTimer();
        session.value = null;
        dragStartPoint = null;
        keyboardSelection = null;
        keyboardOverlayRect = null;
        resetOverlayVisuals();
    }
    function cancelCapture(retiring = false) {
        const value = session.value;
        if (!value || value.state === 'copying' && !retiring) return;
        const work = value.state === 'capturing' || value.state === 'copying' ? value.work : undefined;
        finish(value, value.state === 'success');
        return work;
    }
    function fail(value: ISnipSession, error: unknown) {
        if (!current(value)) return;
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
            if (isFailurePresentation(error)) presentFailureToast(error);
            else if (error instanceof DOMException && (error.name === 'NotSupportedError' || error.name === 'SecurityError')) {
                presentNoticeToast({
                    tone: 'warning',
                    title: t('toolbar.captureFailed'),
                    description: t(error.name === 'NotSupportedError' ? 'toolbar.captureUnsupported' : 'toolbar.captureSourceRefused'),
                });
            } else presentFailureToast({
                failure: getFailureReceipt(error) ?? BrowserLogger.error('pdf-snip', 'Failed to capture the current PDF view', error, {code: 'RENDERER_WORKSPACE_OPERATION_FAILED'}),
                title: t('toolbar.captureFailed'),
                description: t('toolbar.captureFailureReason', {message: getErrorMessage(error)}),
                technicalDetails: getErrorMessage(error),
            });
        }
        finish(value, false, error);
    }
    useEventListener(() => isActive.value ? window : null, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {event.preventDefault(); void cancelCapture();}
    }, {capture: true});
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

    async function completeSelectionRect(selection: IClientRect, overlay: IOverlayRect) {
        const value = session.value;
        const container = options.viewerContainer.value;
        if (!value || !container || getRectWidth(selection) < 2 || getRectHeight(selection) < 2) {void cancelCapture(); return;}
        try {
            const plan = freezePdfRegionCapture(container, selection);
            if (!plan.outputRect) {finish(value, false); return;}
            value.plan = plan;
            value.overlay = overlay;
            const rect = toClientRect(container.getBoundingClientRect());
            const scroll = [
                container.scrollLeft,
                container.scrollTop,
            ];
            const viewport = [
                window.innerWidth,
                window.innerHeight,
                window.devicePixelRatio,
            ];
            const view = getViewState();
            const pages = plan.fragments.map(fragment => ({
                canvas: fragment.canvas,
                rect: toClientRect(fragment.canvas.getBoundingClientRect()),
                width: fragment.canvas.width,
                height: fragment.canvas.height,
            }));
            value.assertCurrent = () => {
                value.abort.signal.throwIfAborted();
                if (!current(value) || !container.isConnected || options.viewerContainer.value !== container || !options.document.isCurrent(value.fence)
                    || JSON.stringify(toClientRect(container.getBoundingClientRect())) !== JSON.stringify(rect)
                    || container.scrollLeft !== scroll[0] || container.scrollTop !== scroll[1]
                    || JSON.stringify([
                        window.innerWidth,
                        window.innerHeight,
                        window.devicePixelRatio,
                    ]) !== JSON.stringify(viewport)
                    || JSON.stringify(getViewState()) !== JSON.stringify(view)
                    || pages.some(page => !page.canvas.isConnected || page.canvas.width !== page.width || page.canvas.height !== page.height || JSON.stringify(toClientRect(page.canvas.getBoundingClientRect())) !== JSON.stringify(page.rect))) {
                    throw new DOMException('The initiating capture view changed', 'AbortError');
                }
            };
            selectionRect.value = toLocalRect(plan.outputRect, overlay);
            setState(value, 'preparing');
            await value.preparation;
            if (!current(value)) return;
            value.assertCurrent();
            setState(value, 'confirming');
        } catch (error) {fail(value, error);}
    }
    async function readSelection(value: ISnipSession, assertRequestCurrent: () => void = () => {}) {
        const {
            plan, overlay, target,
        } = value;
        if (!options.viewerContainer.value || !plan?.outputRect || !overlay || !target || !value.assertCurrent) throw new Error('The current capture target is unavailable');
        const rect = plan.outputRect;
        const assertCurrent = () => {
            value.assertCurrent?.();
            assertRequestCurrent();
            const targetRect = target.getBoundingClientRect();
            if (!target.isConnected || targetRect.left !== rect.left || targetRect.top !== rect.top || targetRect.width !== getRectWidth(rect) || targetRect.height !== getRectHeight(rect)) {
                throw new DOMException('The capture target changed', 'AbortError');
            }
        };
        const prepareFrame = async () => {
            assertCurrent();
            setState(value, 'capturing');
            await nextTick();
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            assertCurrent();

        };
        try {
            assertCurrent();
            setState(value, hasElectronAPI() ? 'capturing' : 'permission');
            const read = () => {
                const region = {
                    x: rect.left,
                    y: rect.top,
                    width: getRectWidth(rect),
                    height: getRectHeight(rect),
                    viewportWidth: window.innerWidth,
                    viewportHeight: window.innerHeight,
                    pixelRatio: window.devicePixelRatio,
                };
                const capability = getImageExportCapability();
                return hasElectronAPI()
                    ? prepareFrame().then(() => {assertCurrent(); return capability.captureCurrentView(region);})
                    : capability.captureCurrentView(region, {
                        target,
                        signal: value.abort.signal,
                        prepareFrame,
                        assertCurrent,
                        cancel: () => {void cancelCapture();},
                    });
            };
            return await capturePdfRegionAsPngBlob({
                plan,
                read,
                assertCurrent,
            });
        } finally {
            if (current(value) && value.state === 'capturing') setState(value, 'preparing');
        }
    }
    async function copySelection(value: ISnipSession) {
        try {
            const capture = await readSelection(value);
            value.assertCurrent?.();
            if (!capture) {finish(value, false); return;}
            // Clipboard publication is atomic; pending Cancel cannot enter it early.
            setState(value, 'copying');
            await writePngBlobToClipboard(capture.blob);
            if (!current(value) || !options.document.isCurrent(value.fence)) {finish(value, false); return;}
            selectionRect.value = null;
            setSuccessVisuals(capture.outputRect, value.overlay!);
            setState(value, 'success');
            value.completion.resolve(true);
            startSuccessTimer();
        } catch (error) {fail(value, error);}
    }
    function confirmCapture() {
        const value = session.value;
        if (value?.state !== 'confirming') return;
        value.work = copySelection(value);
    }
    function handleKeyboardKey(event: KeyboardEvent) {
        if (!isActive.value) return false;
        if (event.key === 'Escape') {event.preventDefault(); void cancelCapture(); return true;}
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
            event.preventDefault();
            if (state.value === 'confirming') confirmCapture();
            else if (state.value === 'selecting') {
                const overlay = getOverlayRect();
                if (overlay) {rebaseKeyboardSelection(overlay); void completeSelectionRect(keyboardSelection ?? createKeyboardSelection(overlay), overlay);}
                else void cancelCapture();
            }
            return true;
        }
        if (state.value !== 'selecting' || ![
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
        ].includes(event.key)) return false;
        event.preventDefault();
        updateKeyboardSelection(event);
        return true;
    }
    const pointerDragHandlers = createSelectionPointerDragHandlers({
        getState: () => state.value,
        getStartPoint: () => dragStartPoint,
        setStartPoint: point => {dragStartPoint = point;},
        updateSelection: updateSelectionFromPointer,
        onEnd: payload => {
            if (!dragStartPoint) {void cancelCapture(); return;}
            const selection = updateSelectionFromPointer(payload, dragStartPoint);
            dragStartPoint = null;
            void completeSelectionRect(selection, payload.overlayRect);
        },
    });
    function createSession() {
        resetOverlayVisuals();
        const value: ISnipSession = {
            state: 'selecting',
            completion: Promise.withResolvers<boolean>(),
            abort: new AbortController(),
            fence: options.document.captureFence(),
            preparation: Promise.resolve(),
        };
        session.value = value;
        value.preparation = Promise.resolve().then(options.prepare).catch(error => {fail(value, error);});
        return value;
    }
    function startCaptureSession() {
        if (!options.viewerContainer.value) return Promise.resolve(false);
        if (session.value) {void cancelCapture(); return Promise.resolve(false);}
        return createSession().completion.promise;
    }
    async function captureVisibleRegionAsPng(selection: IClientRect, assertRequestCurrent: () => void = () => {}) {
        if (!hasElectronAPI()) throw new DOMException('Assistant view capture is unavailable in the browser', 'NotSupportedError');
        if (session.value) throw new Error('An image capture is already in progress');
        assertRequestCurrent();
        const overlay = getOverlayRect();
        if (!overlay) throw new Error('The initiating capture view is unavailable');
        const value = createSession();
        const operation = (async () => {
            await completeSelectionRect(selection, overlay);
            value.abort.signal.throwIfAborted();
            await nextTick();
            assertRequestCurrent();
            const capture = await readSelection(value, assertRequestCurrent);
            value.abort.signal.throwIfAborted();
            assertRequestCurrent();
            return capture;
        })();
        value.work = operation.then(() => undefined, () => undefined);
        try {return await operation;} finally {finish(value, false);}
    }
    useEventListener(options.viewerContainer, 'scroll', () => {if (session.value?.plan) void cancelCapture();}, {passive: true});
    useEventListener(window, 'resize', () => {if (session.value?.plan) void cancelCapture();});
    watch(getViewState, () => {if (session.value?.plan) void cancelCapture();});
    const unsubscribe = options.document.subscribe(transition => {
        return transition.phase === 'invalidated' ? cancelCapture(true) : undefined;
    });
    options.document.registerDisposable(() => {unsubscribe(); return cancelCapture(true);});
    onBeforeUnmount(() => {unsubscribe(); void cancelCapture(true); stopSuccessTimer();});
    const setCropTarget = (element: Element | null) => {if (session.value) session.value.target = element ?? undefined;};
    provide(pdfRegionSnipKeyboardKey, {
        handleKeyboardKey,
        state,
        confirmCapture,
        setCropTarget,
    });
    return {
        state,
        isActive,
        isCleanPaint,
        captureApi: {
            captureVisibleRegionAsPng,
            captureRegionToClipboard: startCaptureSession,
            isCapturingRegion: isActive,
        },
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
