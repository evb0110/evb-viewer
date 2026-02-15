import {
    computed,
    onUnmounted,
    ref,
    type Ref,
} from 'vue';
import { BrowserLogger } from '@app/utils/browser-logger';

export type TSnipState = 'idle' | 'selecting' | 'copying' | 'success' | 'error';

export interface IClientRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface ILocalRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IOverlayRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface ISnipPointerPayload {
    clientX: number;
    clientY: number;
    overlayRect: IOverlayRect;
}

interface ICanvasSource {
    canvas: HTMLCanvasElement;
    rect: IClientRect;
}

interface ICaptureFragment {
    canvas: HTMLCanvasElement;
    intersection: IClientRect;
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    scaleX: number;
    scaleY: number;
}

interface ICapturePlan {
    outputRect: IClientRect | null;
    fragments: ICaptureFragment[];
}

interface IUsePdfRegionSnipOptions {viewerContainer: Ref<HTMLElement | null>;}

interface IBadgePosition {
    x: number;
    y: number;
}

export function getRectWidth(rect: IClientRect) {
    return Math.max(0, rect.right - rect.left);
}

export function getRectHeight(rect: IClientRect) {
    return Math.max(0, rect.bottom - rect.top);
}

export function normalizeClientRect(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
): IClientRect {
    return {
        left: Math.min(startX, endX),
        top: Math.min(startY, endY),
        right: Math.max(startX, endX),
        bottom: Math.max(startY, endY),
    };
}

export function intersectClientRects(a: IClientRect, b: IClientRect): IClientRect | null {
    const intersection: IClientRect = {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };

    return getRectWidth(intersection) > 0 && getRectHeight(intersection) > 0
        ? intersection
        : null;
}

function unionClientRects(a: IClientRect, b: IClientRect): IClientRect {
    return {
        left: Math.min(a.left, b.left),
        top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
    };
}

export function toLocalRect(rect: IClientRect, overlayRect: IOverlayRect): ILocalRect {
    return {
        x: rect.left - overlayRect.left,
        y: rect.top - overlayRect.top,
        width: getRectWidth(rect),
        height: getRectHeight(rect),
    };
}

function toClientRect(rect: DOMRect): IClientRect {
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function collectCanvasSources(viewerContainer: HTMLElement): ICanvasSource[] {
    const renderedCanvases = Array.from(
        viewerContainer.querySelectorAll<HTMLCanvasElement>('.page_container--rendered .page_canvas canvas'),
    );
    const fallbackCanvases = renderedCanvases.length > 0
        ? renderedCanvases
        : Array.from(viewerContainer.querySelectorAll<HTMLCanvasElement>('.page_canvas canvas'));

    return fallbackCanvases
        .map((canvas) => {
            const rect = toClientRect(canvas.getBoundingClientRect());
            return {
                canvas,
                rect,
            };
        })
        .filter((source) =>
            source.canvas.width > 0
            && source.canvas.height > 0
            && getRectWidth(source.rect) > 0
            && getRectHeight(source.rect) > 0);
}

export function buildCanvasCapturePlan(selectionRect: IClientRect, sources: readonly ICanvasSource[]): ICapturePlan {
    let outputRect: IClientRect | null = null;
    const fragments: ICaptureFragment[] = [];

    for (const source of sources) {
        const intersection = intersectClientRects(selectionRect, source.rect);
        if (!intersection) {
            continue;
        }

        const canvasCssWidth = getRectWidth(source.rect);
        const canvasCssHeight = getRectHeight(source.rect);
        if (canvasCssWidth <= 0 || canvasCssHeight <= 0) {
            continue;
        }

        const scaleX = source.canvas.width / canvasCssWidth;
        const scaleY = source.canvas.height / canvasCssHeight;
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
            continue;
        }

        const sourceX = clamp((intersection.left - source.rect.left) * scaleX, 0, source.canvas.width);
        const sourceY = clamp((intersection.top - source.rect.top) * scaleY, 0, source.canvas.height);
        const sourceWidth = clamp(getRectWidth(intersection) * scaleX, 0, source.canvas.width - sourceX);
        const sourceHeight = clamp(getRectHeight(intersection) * scaleY, 0, source.canvas.height - sourceY);
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            continue;
        }

        fragments.push({
            canvas: source.canvas,
            intersection,
            sourceX,
            sourceY,
            sourceWidth,
            sourceHeight,
            scaleX,
            scaleY,
        });
        outputRect = outputRect
            ? unionClientRects(outputRect, intersection)
            : intersection;
    }

    return {
        outputRect,
        fragments,
    };
}

function resolveOutputScale(fragments: readonly ICaptureFragment[]) {
    if (fragments.length === 0) {
        return 1;
    }

    return Math.max(
        1,
        ...fragments.map(fragment => Math.min(fragment.scaleX, fragment.scaleY)),
    );
}

function renderCapturePlan(plan: ICapturePlan): HTMLCanvasElement | null {
    if (!plan.outputRect || plan.fragments.length === 0) {
        return null;
    }

    const outputScale = resolveOutputScale(plan.fragments);
    const outputWidth = Math.max(1, Math.round(getRectWidth(plan.outputRect) * outputScale));
    const outputHeight = Math.max(1, Math.round(getRectHeight(plan.outputRect) * outputScale));

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    const context = outputCanvas.getContext('2d');
    if (!context) {
        return null;
    }

    for (const fragment of plan.fragments) {
        const destinationX = (fragment.intersection.left - plan.outputRect.left) * outputScale;
        const destinationY = (fragment.intersection.top - plan.outputRect.top) * outputScale;
        const destinationWidth = getRectWidth(fragment.intersection) * outputScale;
        const destinationHeight = getRectHeight(fragment.intersection) * outputScale;

        context.drawImage(
            fragment.canvas,
            fragment.sourceX,
            fragment.sourceY,
            fragment.sourceWidth,
            fragment.sourceHeight,
            destinationX,
            destinationY,
            destinationWidth,
            destinationHeight,
        );
    }

    return outputCanvas;
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => {
            resolve(blob);
        }, 'image/png');
    });
}

export async function writePngBlobToClipboard(blob: Blob) {
    if (typeof ClipboardItem !== 'function') {
        throw new Error('ClipboardItem API is unavailable');
    }
    if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.write !== 'function') {
        throw new Error('Clipboard write API is unavailable');
    }

    const clipboardItem = new ClipboardItem({ 'image/png': blob });
    await globalThis.navigator.clipboard.write([clipboardItem]);
}

export function usePdfRegionSnip(options: IUsePdfRegionSnipOptions) {
    const state = ref<TSnipState>('idle');
    const selectionRect = ref<ILocalRect | null>(null);
    const flashRect = ref<ILocalRect | null>(null);
    const badgePosition = ref<IBadgePosition | null>(null);

    const isActive = computed(() => state.value === 'selecting' || state.value === 'copying');

    let dragStartPoint: {
        clientX: number;
        clientY: number 
    } | null = null;
    let pendingResolver: ((result: boolean) => void) | null = null;
    let cleanupEscapeListener: (() => void) | null = null;
    let successTimer: ReturnType<typeof setTimeout> | null = null;

    function clearSuccessTimer() {
        if (successTimer) {
            clearTimeout(successTimer);
            successTimer = null;
        }
    }

    function detachEscapeListener() {
        cleanupEscapeListener?.();
        cleanupEscapeListener = null;
    }

    function resolveSession(result: boolean) {
        detachEscapeListener();
        dragStartPoint = null;
        state.value = 'idle';

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

    function attachEscapeCancel() {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') {
                return;
            }
            event.preventDefault();
            cancelCapture();
        };

        window.addEventListener('keydown', onKeyDown, true);
        cleanupEscapeListener = () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }

    function updateSelectionFromPointer(
        payload: ISnipPointerPayload,
        startPoint: {
            clientX: number;
            clientY: number 
        },
    ) {
        const selection = normalizeClientRect(
            startPoint.clientX,
            startPoint.clientY,
            payload.clientX,
            payload.clientY,
        );
        selectionRect.value = toLocalRect(selection, payload.overlayRect);
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

    async function completeSelection(payload: ISnipPointerPayload) {
        const viewerContainer = options.viewerContainer.value;
        if (!dragStartPoint || !viewerContainer) {
            cancelCapture();
            return;
        }

        const selection = updateSelectionFromPointer(payload, dragStartPoint);
        const selectionWidth = getRectWidth(selection);
        const selectionHeight = getRectHeight(selection);
        if (selectionWidth < 2 || selectionHeight < 2) {
            cancelCapture();
            return;
        }

        state.value = 'copying';
        try {
            const sources = collectCanvasSources(viewerContainer);
            const capturePlan = buildCanvasCapturePlan(selection, sources);
            const outputRect = capturePlan.outputRect;
            if (!outputRect || capturePlan.fragments.length === 0) {
                cancelCapture();
                return;
            }

            const outputCanvas = renderCapturePlan(capturePlan);
            if (!outputCanvas) {
                throw new Error('Failed to render capture image');
            }

            const blob = await canvasToPngBlob(outputCanvas);
            outputCanvas.width = 0;
            outputCanvas.height = 0;

            if (!blob) {
                throw new Error('Failed to serialize capture image');
            }

            await writePngBlobToClipboard(blob);

            selectionRect.value = null;
            state.value = 'success';
            setSuccessVisuals(outputRect, payload.overlayRect);

            clearSuccessTimer();
            successTimer = setTimeout(() => {
                resetOverlayVisuals();
                resolveSession(true);
            }, 850);
        } catch (error) {
            BrowserLogger.debug('pdf-snip', 'Failed to copy selected PDF region', error);
            state.value = 'error';
            resetOverlayVisuals();
            resolveSession(false);
        }
    }

    function onPointerStart(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting') {
            return;
        }

        dragStartPoint = {
            clientX: payload.clientX,
            clientY: payload.clientY,
        };
        updateSelectionFromPointer(payload, dragStartPoint);
    }

    function onPointerMove(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting' || !dragStartPoint) {
            return;
        }

        updateSelectionFromPointer(payload, dragStartPoint);
    }

    function onPointerEnd(payload: ISnipPointerPayload) {
        if (state.value !== 'selecting' || !dragStartPoint) {
            return;
        }

        void completeSelection(payload);
    }

    function startCaptureSession() {
        if (!options.viewerContainer.value) {
            return Promise.resolve(false);
        }
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
        state.value = 'selecting';
        attachEscapeCancel();

        return new Promise<boolean>((resolve) => {
            pendingResolver = resolve;
        });
    }

    onUnmounted(() => {
        clearSuccessTimer();
        detachEscapeListener();
    });

    return {
        state,
        isActive,
        selectionRect,
        flashRect,
        badgePosition,
        startCaptureSession,
        onPointerStart,
        onPointerMove,
        onPointerEnd,
        cancelCapture,
    };
}
