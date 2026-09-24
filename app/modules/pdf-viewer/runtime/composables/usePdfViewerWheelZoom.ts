import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import { summarizeViewerMetrics } from '@app/modules/pdf-viewer/engine/pdf-viewer-metrics/summarizeViewerMetrics';
import type { TPdfZoomState } from '@contracts/shared';
import type { TPdfSource } from '@app/types/pdfUi';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IZoomVirtualizationFreeze } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { wheelZoomExpectedScrollWindowMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomExpectedScrollWindowMs';
import { wheelZoomSessionIdleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionIdleMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';
import { usePdfViewerWheelZoomSession } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerWheelZoomSession';
import {
    DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
    resolveDocumentWheelZoomTarget,
    type IDocumentWheelInteraction,
    type IDocumentWheelSourceEvent,
} from '@app/modules/document-viewer/public';
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';

const WHEEL_DISPATCH_LOG_THROTTLE_MS = 420;

interface IViewerRange {
    start: number;
    end: number;
}

interface IWheelEmit {
    (event: 'update:effectiveZoom', value: number): void;
    (event: 'update:zoomState', state: TPdfZoomState): void;
}

interface IUsePdfViewerWheelZoomOptions {
    viewerContainer: Ref<HTMLElement | null>;
    src: ComputedRef<TPdfSource | null>;
    isLoading: Ref<boolean>;
    zoom: ComputedRef<number>;
    effectiveScale: Ref<number>;
    currentPage: Ref<number>;
    visibleRange: Ref<IViewerRange>;
    virtualizedContinuousMode: Ref<boolean>;
    virtualWindowStart: Ref<number>;
    virtualWindowEnd: Ref<number>;
    zoomVirtualizationFreeze: Ref<IZoomVirtualizationFreeze | null>;
    singlePageScroll: {
        handleWheel: (event: IDocumentWheelSourceEvent) => boolean;
        cancelProgrammaticNavigation: (reason?: string) => void;
    };
    cancelPendingSearchScroll: () => void;
    markUserViewportInteraction?: (() => void) | undefined;
    captureZoomVisualSnapshots?: (() => IResizeAnchorContext | null | undefined) | undefined;
    submitZoomIntent: (intent: {
        zoom: number;
        x: number;
        y: number
    }) => void;
    isSnipActive: () => boolean;
    emit: IWheelEmit;
}

type TWheelZoomSessionApi = ReturnType<typeof usePdfViewerWheelZoomSession>;
type TWheelZoomAnchor = TWheelZoomSessionApi['pendingZoomViewportAnchor']['value'];
type TWheelZoomActiveSession = ReturnType<TWheelZoomSessionApi['getActiveWheelZoomSession']>;

interface IWheelDispatchContext {
    nowMs: number;
    recentZoomAnchor: TWheelZoomAnchor;
    recentZoomAgeMs: number | null;
    modifierZoomAgeMs: number | null;
    isWithinModifierZoomGraceWindow: boolean;
    activeSession: TWheelZoomActiveSession;
    zoomInteractionLocked: boolean;
}

export const usePdfViewerWheelZoom = (options: IUsePdfViewerWheelZoomOptions) => {
    const {
        viewerContainer,
        src,
        isLoading,
        zoom,
        effectiveScale,
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        singlePageScroll,
        cancelPendingSearchScroll,
        markUserViewportInteraction,
        captureZoomVisualSnapshots,
        submitZoomIntent,
        isSnipActive,
        emit,
    } = options;

    let zoomDebugWheelEventId = 0;
    let lastModifierWheelZoomAtMs = 0;
    let lastModifierWheelZoomEventId = 0;

    function summarizeViewerStateForLog() {
        return summarizeViewerMetrics(viewerContainer.value);
    }
    const {
        pendingZoomViewportAnchor,
        zoomSnapSuppressed,
        getActiveWheelZoomSession,
        ensureWheelZoomSession,
        markExpectedZoomScroll,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
        consumeZoomViewportAnchor,
        cleanupWheelZoomSession,
        getIsZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs,
    } = usePdfViewerWheelZoomSession({
        viewerContainer,
        effectiveScale,
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
    });

    function summarizeWheelEventForDebug(event: IDocumentWheelSourceEvent) {
        return {
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
        };
    }

    function getModifierWheelIntent(interaction: IDocumentWheelInteraction, nowMs: number) {
        const activeSession = getActiveWheelZoomSession(nowMs);
        const isContinuationPacket = Boolean(
            activeSession
            && nowMs - activeSession.lastPacketAtMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
        );
        const hasModifierZoomSignal = interaction.intent === 'zoom';

        return {
            activeSession,
            hasModifierZoomSignal,
            isContinuationPacket,
            shouldTreatAsZoomSignal: hasModifierZoomSignal || isContinuationPacket,
        };
    }

    function getWheelZoomEventAnchor(event: IDocumentWheelSourceEvent, container: HTMLElement) {
        const containerRect = container.getBoundingClientRect();

        return {
            x: clamp(
                event.clientX - containerRect.left,
                0,
                Math.max(container.clientWidth, 0),
            ),
            y: clamp(
                event.clientY - containerRect.top,
                0,
                Math.max(container.clientHeight, 0),
            ),
        };
    }

    function resolveWheelZoomTarget(
        delta: number,
        session: ReturnType<typeof ensureWheelZoomSession>['session'],
    ) {
        const target = resolveDocumentWheelZoomTarget(
            session.startZoom,
            session.cumulativeDelta,
            delta,
        );
        session.cumulativeDelta = target.cumulativeDelta;
        if (!target.valid && target.reason === 'below-manual-min-zoom-out') {
            session.lastEmittedZoom = session.startZoom;
        }
        return target;
    }

    function updateWheelZoomSessionAfterEmit(
        session: ReturnType<typeof ensureWheelZoomSession>['session'],
        nextEffectiveZoom: number,
        nowMs: number,
    ) {
        session.lastEmittedZoom = nextEffectiveZoom;
        session.lastPacketAtMs = nowMs;
        session.lockUntilMs = nowMs + wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs;
        session.emittedCount += 1;
    }

    function setPendingZoomAnchors(
        debugId: number,
        sessionId: number,
        zoomLockOperationId: number | null,
        anchorX: number,
        anchorY: number,
        nowMs: number,
        resizeAnchor: IResizeAnchorContext | null,
    ) {
        pendingZoomViewportAnchor.value = {
            id: debugId,
            sessionId,
            zoomLockOperationId,
            x: anchorX,
            y: anchorY,
            capturedAtMs: nowMs,
            resizeAnchor,
        };
    }

    function createWheelDispatchContext(): IWheelDispatchContext {
        const nowMs = Date.now();
        const recentZoomAnchor = pendingZoomViewportAnchor.value;
        const recentZoomAgeMs = recentZoomAnchor
            ? nowMs - recentZoomAnchor.capturedAtMs
            : null;
        const modifierZoomAgeMs = lastModifierWheelZoomAtMs > 0
            ? nowMs - lastModifierWheelZoomAtMs
            : null;
        const isWithinModifierZoomGraceWindow = modifierZoomAgeMs !== null
            && modifierZoomAgeMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS;

        return {
            nowMs,
            recentZoomAnchor,
            recentZoomAgeMs,
            modifierZoomAgeMs,
            isWithinModifierZoomGraceWindow,
            activeSession: getActiveWheelZoomSession(nowMs),
            zoomInteractionLocked: isZoomInteractionLocked(nowMs),
        };
    }

    function logWheelDispatch(event: IDocumentWheelSourceEvent, context: IWheelDispatchContext) {
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-dispatch', WHEEL_DISPATCH_LOG_THROTTLE_MS, '[wheel] dispatch', () => ({
            recentZoomIntentId: context.recentZoomAnchor?.id ?? null,
            recentZoomAgeMs: context.recentZoomAgeMs,
            recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
            modifierZoomAgeMs: context.modifierZoomAgeMs,
            withinModifierZoomGraceWindow: context.isWithinModifierZoomGraceWindow,
            activeSessionId: context.activeSession?.id ?? null,
            zoomInteractionLocked: context.zoomInteractionLocked,
            coreZoomRerenderBusy: getIsZoomRerenderBusyFromCore(),
            coreZoomRerenderLockAgeMs: getZoomRerenderBusyLockUntilMs() > context.nowMs
                ? getZoomRerenderBusyLockUntilMs() - context.nowMs
                : 0,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        }));
    }

    function blockWheelForSnipMode(event: IDocumentWheelSourceEvent) {
        if (!isSnipActive()) {
            return false;
        }

        event.preventDefault();
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-blocked-snip', wheelDetailLogThrottleMs, '[wheel] blocked by snip mode');
        return true;
    }

    function routePlatformModifiedWheelToScroll(interaction: IDocumentWheelInteraction) {
        if (interaction.intent !== 'platform-scroll') {
            return false;
        }

        cleanupWheelZoomSession();
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'wheel-routed-platform-modifier-to-scroll',
            wheelDetailLogThrottleMs,
            '[wheel] allowed platform-modified wheel to scroll',
            () => ({
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(interaction.event),
            }),
        );
        cancelPendingSearchScroll();
        return true;
    }

    function routeModifierWheelZoom(interaction: IDocumentWheelInteraction) {
        if (!handleViewerModifierWheelZoom(interaction)) {
            return false;
        }

        cancelPendingSearchScroll();
        return true;
    }

    function hasWheelZoomSuppressionContext(context: IWheelDispatchContext) {
        const withinExpectedModifierWindow = context.modifierZoomAgeMs !== null
            && context.modifierZoomAgeMs <= wheelZoomExpectedScrollWindowMs;
        const hasRecentZoomAnchor = context.recentZoomAgeMs !== null
            && context.recentZoomAgeMs <= wheelZoomExpectedScrollWindowMs;

        return (
            context.activeSession !== null
            || context.isWithinModifierZoomGraceWindow
            || withinExpectedModifierWindow
            || hasRecentZoomAnchor
        );
    }

    function suppressWheelDuringActiveZoom(event: IDocumentWheelSourceEvent, context: IWheelDispatchContext) {
        if (!hasWheelZoomSuppressionContext(context)) {
            return false;
        }

        if (!context.zoomInteractionLocked && !context.isWithinModifierZoomGraceWindow) {
            return false;
        }

        event.preventDefault();
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'wheel-suppressed-non-modifier',
            wheelDetailLogThrottleMs,
            '[wheel] suppressed non-modifier packet during active zoom lock',
            () => ({
                zoomInteractionLocked: context.zoomInteractionLocked,
                graceWindowMs: DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
                recentModifierZoomEventId: lastModifierWheelZoomEventId || null,
                modifierZoomAgeMs: context.modifierZoomAgeMs,
                activeSessionId: context.activeSession?.id ?? null,
                viewer: summarizeViewerStateForLog(),
                wheel: summarizeWheelEventForDebug(event),
            }),
        );
        cancelPendingSearchScroll();
        return true;
    }

    function handleViewerModifierWheelZoom(interaction: IDocumentWheelInteraction) {
        const { event } = interaction;
        const nowMs = Date.now();
        const debugId = ++zoomDebugWheelEventId;
        const wheelIntent = getModifierWheelIntent(interaction, nowMs);
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-zoom-received', wheelDetailLogThrottleMs, `[wheel-zoom] received id=${debugId}`, () => ({
            id: debugId,
            hasModifierZoomSignal: wheelIntent.hasModifierZoomSignal,
            shouldTreatAsZoomSignal: wheelIntent.shouldTreatAsZoomSignal,
            isContinuationPacket: wheelIntent.isContinuationPacket,
            activeSessionId: wheelIntent.activeSession?.id ?? null,
            viewer: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        }));
        if (!wheelIntent.shouldTreatAsZoomSignal) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-modifier',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-signal`,
            );
            return false;
        }

        lastModifierWheelZoomAtMs = nowMs;
        lastModifierWheelZoomEventId = debugId;
        const zoomLockOperationId = markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs);

        event.preventDefault();
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'wheel-zoom-prevent-default',
            wheelDetailLogThrottleMs,
            `[wheel-zoom] prevent-default id=${debugId}`,
            () => ({
                id: debugId,
                cancelable: event.cancelable,
                defaultPrevented: event.defaultPrevented,
            }),
        );
        const container = viewerContainer.value;
        if (!container || !src.value || isLoading.value) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-not-ready',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=viewer-not-ready`,
                () => ({
                    id: debugId,
                    hasContainer: Boolean(container),
                    hasSrc: Boolean(src.value),
                    isLoading: isLoading.value,
                    viewer: summarizeViewerStateForLog(),
                }),
            );
            return true;
        }
        if (markUserViewportInteraction) {
            markUserViewportInteraction();
        } else {
            singlePageScroll.cancelProgrammaticNavigation('wheel-zoom-interaction');
        }

        const eventAnchor = getWheelZoomEventAnchor(event, container);
        const {
            session,
            reused: reusedGestureAnchor,
        } = ensureWheelZoomSession(nowMs, eventAnchor.x, eventAnchor.y, debugId, zoomLockOperationId);
        session.packetCount += 1;
        const anchorX = session.anchorX;
        const anchorY = session.anchorY;

        const delta = interaction.deltaPx;
        if (Math.abs(delta) < Number.EPSILON) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-zero-delta',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=zero-delta`,
                () => ({
                    id: debugId,
                    wheel: summarizeWheelEventForDebug(event),
                }),
            );
            return true;
        }

        const zoomTarget = resolveWheelZoomTarget(delta, session);
        if (!zoomTarget.valid) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-invalid-factor',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=invalid-factor`,
                () => ({
                    id: debugId,
                    deltaCumulative: session.cumulativeDelta,
                    zoomFactor: zoomTarget.zoomFactor,
                    sessionId: session.id,
                }),
            );
            return true;
        }

        const previousEmittedZoom = session.lastEmittedZoom;
        if (Math.abs(zoomTarget.nextEffectiveZoom - previousEmittedZoom) < 0.001) {
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'wheel-zoom-ignored-no-change',
                wheelDetailLogThrottleMs,
                `[wheel-zoom] ignored id=${debugId} reason=no-zoom-change`,
                () => ({
                    id: debugId,
                    sessionId: session.id,
                    currentZoomMultiplier: zoom.value,
                    currentEffectiveZoom: effectiveScale.value,
                    previousEmittedZoom,
                    nextEffectiveZoom: zoomTarget.nextEffectiveZoom,
                    delta,
                    zoomFactor: zoomTarget.zoomFactor,
                    cumulativeDelta: session.cumulativeDelta,
                }),
            );
            return true;
        }
        updateWheelZoomSessionAfterEmit(session, zoomTarget.nextEffectiveZoom, nowMs);
        const capturedResizeAnchor = captureZoomVisualSnapshots?.() ?? null;
        session.resizeAnchor ??= capturedResizeAnchor;
        setPendingZoomAnchors(
            debugId,
            session.id,
            zoomLockOperationId,
            anchorX,
            anchorY,
            nowMs,
            session.resizeAnchor,
        );
        BrowserLogger.diagnosticThrottled('pdf-zoom-debug', 'wheel-zoom-emit', wheelDetailLogThrottleMs, `[wheel-zoom] emit id=${debugId}`, () => ({
            id: debugId,
            sessionId: session.id,
            gestureAnchorReused: reusedGestureAnchor,
            sessionStartZoom: session.startZoom,
            sessionCumulativeDelta: session.cumulativeDelta,
            eventAnchorX: eventAnchor.x,
            eventAnchorY: eventAnchor.y,
            delta,
            zoomFactor: zoomTarget.zoomFactor,
            currentZoomMultiplier: zoom.value,
            currentEffectiveZoom: effectiveScale.value,
            previousEmittedZoom,
            nextEffectiveZoom: zoomTarget.nextEffectiveZoom,
            nextZoom: zoomTarget.nextZoom,
            anchor: pendingZoomViewportAnchor.value,
            viewerBeforeEmit: summarizeViewerStateForLog(),
            wheel: summarizeWheelEventForDebug(event),
        }));

        // Capture committed pixels before the reactive scale mutation can
        // clear or replace renderer canvases. The rerender coordinator also
        // captures at its boundary, but that is intentionally downstream of
        // this synchronous wheel packet and is too late to cover the first
        // geometry frame of a rapid modifier-wheel gesture.
        // Establish the semantic viewport owner while the DOM still describes
        // the committed scale. Once the reactive zoom emits below patch page
        // geometry, the same pixel scroll offset can resolve to an earlier
        // page and must not become the new gesture anchor.
        submitZoomIntent({
            zoom: zoomTarget.nextZoom,
            x: anchorX,
            y: anchorY,
        });
        emit('update:effectiveZoom', zoomTarget.nextEffectiveZoom);
        emit('update:zoomState', {
            kind: 'custom',
            scale: zoomTarget.nextZoom,
        });
        markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs, {
            operationId: zoomLockOperationId,
            reason: 'wheel-zoom-emitted',
        });
        return true;
    }

    function handleViewerWheel(interaction: IDocumentWheelInteraction) {
        const { event } = interaction;
        const context = createWheelDispatchContext();
        logWheelDispatch(event, context);

        if (blockWheelForSnipMode(event)) {
            return;
        }

        function markWheelViewportInteraction() {
            if (markUserViewportInteraction) {
                markUserViewportInteraction();
                return;
            }
            singlePageScroll.cancelProgrammaticNavigation('wheel-interaction');
        }

        if (routePlatformModifiedWheelToScroll(interaction)) {
            markWheelViewportInteraction();
            return;
        }
        if (
            routeModifierWheelZoom(interaction)
            || suppressWheelDuringActiveZoom(event, context)
        ) {
            return;
        }

        cancelPendingSearchScroll();
        if (singlePageScroll.handleWheel(event)) {
            return;
        }

        markWheelViewportInteraction();
    }

    onScopeDispose(() => {
        cleanupWheelZoomSession();
    });

    return {
        zoomSnapSuppressed,
        handleViewerWheel,
        consumeZoomViewportAnchor,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
    };
};
