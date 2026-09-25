import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS } from '@app/modules/document-viewer/public';
import { wheelZoomSessionIdleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionIdleMs';
import { zoomViewportAnchorMaxAgeMs } from '@app/modules/pdf-viewer/runtime/zoom/zoomViewportAnchorMaxAgeMs';
import type { IZoomVirtualizationLogOptions } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';

interface IZoomViewportAnchorIntent {
    id: number;
    sessionId: number;
    x: number;
    y: number;
    capturedAtMs: number;
    resizeAnchor?: IResizeAnchorContext | null;
}

interface IWheelZoomSession {
    id: number;
    anchorX: number;
    anchorY: number;
    startZoom: number;
    cumulativeDelta: number;
    lastEmittedZoom: number;
    startedAtMs: number;
    lastPacketAtMs: number;
    lastEventId: number;
    packetCount: number;
    emittedCount: number;
    resizeAnchor: IResizeAnchorContext | null;
}

interface IUsePdfViewerWheelZoomSessionOptions extends IZoomVirtualizationLogOptions {
    viewerContainer: Ref<HTMLElement | null>;
    effectiveScale: Ref<number>;
}

/**
 * A zoom is in progress while a wheel gesture is live or the zoom re-render
 * queue is busy. That one derived state suppresses scroll snapping, holds the
 * virtual window and swallows stray scroll packets; nothing else is timed.
 */
export const usePdfViewerWheelZoomSession = (options: IUsePdfViewerWheelZoomSessionOptions) => {
    const {
        effectiveScale,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
    } = options;

    const pendingZoomViewportAnchor = ref<IZoomViewportAnchorIntent | null>(null);
    const zoomSnapSuppressed = ref(false);

    let wheelZoomSessionId = 0;
    let activeWheelZoomSession: IWheelZoomSession | null = null;
    let wheelZoomSessionIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let zoomRerenderBusy = false;

    function isZoomInteractionLocked() {
        return activeWheelZoomSession !== null || zoomRerenderBusy;
    }

    function syncZoomInteractionState(reason: string) {
        const locked = isZoomInteractionLocked();
        zoomSnapSuppressed.value = locked;
        if (locked && virtualizedContinuousMode.value && !zoomVirtualizationFreeze.value) {
            zoomVirtualizationFreeze.value = {
                sessionId: activeWheelZoomSession?.id ?? null,
                capturedAtMs: Date.now(),
                windowStart: virtualWindowStart.value,
                windowEnd: virtualWindowEnd.value,
            };
        } else if (!locked && zoomVirtualizationFreeze.value) {
            zoomVirtualizationFreeze.value = null;
        }
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'zoom-interaction-state',
            wheelDetailLogThrottleMs,
            `[wheel-zoom-session] locked=${locked} reason=${reason}`,
            () => ({
                locked,
                reason,
                zoomRerenderBusy,
                sessionId: activeWheelZoomSession?.id ?? null,
                freeze: zoomVirtualizationFreeze.value,
                viewer: summarizeViewerStateForLog(),
            }),
        );
    }

    function setZoomRerenderBusy(busy: boolean, reason = busy ? 'core-rerender-busy' : 'core-rerender-idle') {
        zoomRerenderBusy = busy;
        syncZoomInteractionState(reason);
    }

    function getActiveWheelZoomSession() {
        return activeWheelZoomSession;
    }

    function endWheelZoomSession(reason: string) {
        clearTimeout(wheelZoomSessionIdleTimer);
        if (!activeWheelZoomSession) {
            return;
        }
        BrowserLogger.diagnostic('pdf-zoom-debug', `[wheel-zoom-session] end reason=${reason}`, {
            reason,
            session: activeWheelZoomSession,
            sessionDurationMs: Date.now() - activeWheelZoomSession.startedAtMs,
            viewer: summarizeViewerStateForLog(),
        });
        activeWheelZoomSession = null;
        syncZoomInteractionState(`session-end:${reason}`);
    }

    function scheduleWheelZoomSessionIdleEnd() {
        clearTimeout(wheelZoomSessionIdleTimer);
        wheelZoomSessionIdleTimer = setTimeout(() => {
            endWheelZoomSession('idle-timeout');
        }, wheelZoomSessionIdleMs);
    }

    function ensureWheelZoomSession(
        nowMs: number,
        anchorX: number,
        anchorY: number,
        eventId: number,
    ) {
        const current = activeWheelZoomSession;
        if (current && nowMs - current.lastPacketAtMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS) {
            current.lastPacketAtMs = nowMs;
            current.lastEventId = eventId;
            scheduleWheelZoomSessionIdleEnd();
            return {
                session: current,
                reused: true,
            };
        }

        wheelZoomSessionId += 1;
        activeWheelZoomSession = {
            id: wheelZoomSessionId,
            anchorX,
            anchorY,
            startZoom: effectiveScale.value,
            cumulativeDelta: 0,
            lastEmittedZoom: effectiveScale.value,
            startedAtMs: nowMs,
            lastPacketAtMs: nowMs,
            lastEventId: eventId,
            packetCount: 0,
            emittedCount: 0,
            resizeAnchor: null,
        };
        syncZoomInteractionState('session-start');
        scheduleWheelZoomSessionIdleEnd();
        return {
            session: activeWheelZoomSession,
            reused: false,
        };
    }

    function consumeZoomViewportAnchor() {
        const nowMs = Date.now();
        const pendingAnchor = pendingZoomViewportAnchor.value;
        const activeSession = activeWheelZoomSession;
        if (!pendingAnchor) {
            if (activeSession && nowMs - activeSession.lastPacketAtMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS) {
                return {
                    id: activeSession.lastEventId,
                    sessionId: activeSession.id,
                    x: activeSession.anchorX,
                    y: activeSession.anchorY,
                    capturedAtMs: activeSession.lastPacketAtMs,
                    resizeAnchor: activeSession.resizeAnchor,
                };
            }
            return null;
        }

        pendingZoomViewportAnchor.value = null;
        const stale = nowMs - pendingAnchor.capturedAtMs > zoomViewportAnchorMaxAgeMs
            && !isZoomInteractionLocked()
            && activeSession?.id !== pendingAnchor.sessionId;
        return stale ? null : pendingAnchor;
    }

    function cleanupWheelZoomSession() {
        clearTimeout(wheelZoomSessionIdleTimer);
        activeWheelZoomSession = null;
        zoomRerenderBusy = false;
        zoomSnapSuppressed.value = false;
        zoomVirtualizationFreeze.value = null;
    }

    return {
        pendingZoomViewportAnchor,
        zoomSnapSuppressed,
        getActiveWheelZoomSession,
        ensureWheelZoomSession,
        endWheelZoomSession,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
        consumeZoomViewportAnchor,
        cleanupWheelZoomSession,
    };
};
