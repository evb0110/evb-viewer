import type {IScanCleanupPreviewResult} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {Ref} from 'vue';
import {clamp} from 'es-toolkit/math';
import {ZOOM} from '@app/constants/pdfLayout';
import {
    DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
    resolveDocumentWheelInteraction,
    resolveDocumentWheelZoomTarget,
} from '@app/modules/document-viewer/public';
import type {IScanCleanupDragRect} from '@app/modules/scan-cleanup/composables/useScanCleanupDragTransaction';

interface IPreviewPanGesture {
    panX: number;
    panY: number;
    pointerId: number;
    pointerX: number;
    pointerY: number;
}

interface IPreviewStageSize {
    height: number;
    width: number;
}

interface IPreviewWheelZoomSession {
    anchorX: number;
    anchorY: number;
    cumulativeDelta: number;
    lastPacketAtMs: number;
    startZoom: number;
}

interface IUseScanCleanupPreviewZoomOptions {
    disabled: () => boolean;
    dragActive: Readonly<Ref<boolean>>;
    formatFitLabel: () => string;
    formatZoomLabel: (zoom: number) => string;
    overlayBounds: IScanCleanupDragRect;
    result: () => Pick<IScanCleanupPreviewResult, 'rawWidthPx' | 'rawHeightPx'> | null;
    stageSize: IPreviewStageSize;
    surface: Ref<HTMLElement | null>;
    updateGeometry: () => void;
}

type TPreviewZoomMode = 'fit' | 'custom';

const PREVIEW_ZOOM_EPSILON = 0.001;

export const useScanCleanupPreviewZoom = (options: IUseScanCleanupPreviewZoomOptions) => {
    const previewZoomMode = ref<TPreviewZoomMode>('fit');
    const previewCustomZoom = ref(1);
    const previewPan = reactive({
        x: 0,
        y: 0,
    });
    const panGesture = shallowRef<IPreviewPanGesture | null>(null);
    let wheelZoomSession: IPreviewWheelZoomSession | null = null;
    const previewFitZoom = computed(() => {
        const result = options.result();
        if (!result || options.stageSize.width <= 0 || options.stageSize.height <= 0) {
            return 1;
        }
        const fit = Math.min(
            options.stageSize.width / Math.max(1, result.rawWidthPx),
            options.stageSize.height / Math.max(1, result.rawHeightPx),
        );
        return Number.isFinite(fit) && fit > 0 ? Math.min(ZOOM.MAX, fit) : 1;
    });
    // Fit is a presentation mode, not the lower zoom bound. When the fitted
    // page is larger than the viewer's manual minimum, both step buttons must
    // remain usable: minus leaves Fit for the next smaller manual level just
    // as plus leaves it for the next larger one.
    const previewMinimumZoom = computed(() => Math.min(ZOOM.MIN, previewFitZoom.value));
    const previewEffectiveZoom = computed(() => previewZoomMode.value === 'fit'
        ? previewFitZoom.value
        : clamp(previewCustomZoom.value, previewMinimumZoom.value, ZOOM.MAX));
    const previewTransformScale = computed(() => previewEffectiveZoom.value / previewFitZoom.value);
    const previewTransformStyle = computed(() => (
        {transform: `translate3d(${previewPan.x}px, ${previewPan.y}px, 0) scale(${previewTransformScale.value})`}
    ));
    const previewZoomLabel = computed(() => previewZoomMode.value === 'fit'
        ? options.formatFitLabel()
        : options.formatZoomLabel(Math.round(previewEffectiveZoom.value * 100)));
    const canZoomOut = computed(() => previewEffectiveZoom.value
        > previewMinimumZoom.value + PREVIEW_ZOOM_EPSILON);
    const canZoomIn = computed(() => previewEffectiveZoom.value < ZOOM.MAX - PREVIEW_ZOOM_EPSILON);
    const canPanPreview = computed(() => !options.disabled()
        && previewTransformScale.value > 1 + PREVIEW_ZOOM_EPSILON);

    function previewPanBounds(scale = previewTransformScale.value) {
        return {
            x: Math.max(0, options.stageSize.width * (scale - 1) / 2),
            y: Math.max(0, options.stageSize.height * (scale - 1) / 2),
        };
    }

    function clampPreviewPan() {
        const bounds = previewPanBounds();
        previewPan.x = clamp(previewPan.x, -bounds.x, bounds.x);
        previewPan.y = clamp(previewPan.y, -bounds.y, bounds.y);
    }

    function setPreviewZoom(nextZoom: number, clientX?: number, clientY?: number) {
        options.updateGeometry();
        const currentZoom = previewEffectiveZoom.value;
        const normalizedZoom = clamp(nextZoom, previewMinimumZoom.value, ZOOM.MAX);
        if (Math.abs(normalizedZoom - currentZoom) < PREVIEW_ZOOM_EPSILON) {
            return;
        }
        const previousScale = previewTransformScale.value;
        const surfaceRect = options.surface.value?.getBoundingClientRect();
        const hasCursorAnchor = clientX !== undefined
            && clientY !== undefined
            && surfaceRect !== undefined;
        const anchorX = hasCursorAnchor
            ? clientX - surfaceRect.left - options.overlayBounds.x - options.stageSize.width / 2
            : 0;
        const anchorY = hasCursorAnchor
            ? clientY - surfaceRect.top - options.overlayBounds.y - options.stageSize.height / 2
            : 0;
        const previousPanX = previewPan.x;
        const previousPanY = previewPan.y;
        previewCustomZoom.value = normalizedZoom;
        previewZoomMode.value = 'custom';
        const nextScale = previewTransformScale.value;
        previewPan.x = anchorX - (anchorX - previousPanX) * nextScale / previousScale;
        previewPan.y = anchorY - (anchorY - previousPanY) * nextScale / previousScale;
        clampPreviewPan();
    }

    function fitPreview() {
        wheelZoomSession = null;
        previewZoomMode.value = 'fit';
        previewPan.x = 0;
        previewPan.y = 0;
        panGesture.value = null;
    }

    function toggleFitAndActualSize(event?: MouseEvent) {
        wheelZoomSession = null;
        if (previewZoomMode.value !== 'fit') {
            fitPreview();
            return;
        }
        const eventTarget = event?.target;
        const usePointerAnchor = eventTarget instanceof Node && options.surface.value?.contains(eventTarget);
        setPreviewZoom(
            1,
            usePointerAnchor ? event?.clientX : undefined,
            usePointerAnchor ? event?.clientY : undefined,
        );
    }

    function stepPreviewZoom(direction: -1 | 1) {
        wheelZoomSession = null;
        setPreviewZoom(previewEffectiveZoom.value + direction * ZOOM.STEP);
    }

    function handlePreviewWheel(event: WheelEvent) {
        if (options.disabled() || !options.result() || options.dragActive.value) {
            return;
        }
        const surface = options.surface.value;
        if (!surface) {
            return;
        }
        const interaction = resolveDocumentWheelInteraction(event, surface);
        const nowMs = Date.now();
        const continuation = wheelZoomSession !== null
            && nowMs - wheelZoomSession.lastPacketAtMs <= DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS;
        if (interaction.intent !== 'zoom' && !continuation) {
            return;
        }
        const delta = interaction.deltaPx;
        if (Math.abs(delta) < Number.EPSILON) {
            return;
        }
        event.preventDefault();
        if (!continuation || !wheelZoomSession) {
            wheelZoomSession = {
                anchorX: event.clientX,
                anchorY: event.clientY,
                cumulativeDelta: 0,
                lastPacketAtMs: nowMs,
                startZoom: previewEffectiveZoom.value,
            };
        }
        const target = resolveDocumentWheelZoomTarget(
            wheelZoomSession.startZoom,
            wheelZoomSession.cumulativeDelta,
            delta,
            {
                minimumZoom: previewMinimumZoom.value,
                maximumZoom: ZOOM.MAX,
            },
        );
        wheelZoomSession.cumulativeDelta = target.cumulativeDelta;
        wheelZoomSession.lastPacketAtMs = nowMs;
        if (target.valid) {
            setPreviewZoom(
                target.nextEffectiveZoom,
                wheelZoomSession.anchorX,
                wheelZoomSession.anchorY,
            );
        }
    }

    // Full-surface overlays (placement control, content box) intentionally stay
    // pannable: they cover the whole cleaned page, so blocking them would make
    // navigation impossible at zoom. Their editing affordances are the discrete
    // handles and controls matched here.
    function pointerTargetIsInteractive(target: EventTarget | null) {
        return target instanceof Element && target.closest([
            'button',
            'input',
            'select',
            'textarea',
            '.cutter-control',
        ].join(',')) !== null;
    }

    function startPreviewPan(event: PointerEvent) {
        if (
            options.disabled()
            || !canPanPreview.value
            || event.button !== 0
            || event.defaultPrevented
            || options.dragActive.value
            || pointerTargetIsInteractive(event.target)
        ) {
            return;
        }
        panGesture.value = {
            panX: previewPan.x,
            panY: previewPan.y,
            pointerId: event.pointerId,
            pointerX: event.clientX,
            pointerY: event.clientY,
        };
        options.surface.value?.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function movePreviewPan(event: PointerEvent) {
        const gesture = panGesture.value;
        if (!gesture || gesture.pointerId !== event.pointerId) {
            return;
        }
        previewPan.x = gesture.panX + event.clientX - gesture.pointerX;
        previewPan.y = gesture.panY + event.clientY - gesture.pointerY;
        clampPreviewPan();
        event.preventDefault();
    }

    function finishPreviewPan(event: PointerEvent) {
        const gesture = panGesture.value;
        if (!gesture || gesture.pointerId !== event.pointerId) {
            return;
        }
        const surface = options.surface.value;
        if (surface?.hasPointerCapture(event.pointerId)) {
            surface.releasePointerCapture(event.pointerId);
        }
        panGesture.value = null;
    }

    function handlePreviewDoubleClick(event: MouseEvent) {
        if (options.disabled() || !options.result() || pointerTargetIsInteractive(event.target)) {
            return;
        }
        event.preventDefault();
        toggleFitAndActualSize(event);
    }

    watch(options.disabled, disabled => {
        if (!disabled) {
            return;
        }
        wheelZoomSession = null;
        const gesture = panGesture.value;
        if (!gesture) {
            return;
        }
        const surface = options.surface.value;
        if (surface?.hasPointerCapture(gesture.pointerId)) {
            surface.releasePointerCapture(gesture.pointerId);
        }
        panGesture.value = null;
    });

    return {
        canPanPreview,
        canZoomIn,
        canZoomOut,
        clampPreviewPan,
        finishPreviewPan,
        fitPreview,
        handlePreviewDoubleClick,
        handlePreviewWheel,
        movePreviewPan,
        panGesture,
        previewEffectiveZoom,
        previewPan,
        previewTransformScale,
        previewTransformStyle,
        previewZoomLabel,
        previewZoomMode,
        startPreviewPan,
        stepPreviewZoom,
        toggleFitAndActualSize,
    };
};
