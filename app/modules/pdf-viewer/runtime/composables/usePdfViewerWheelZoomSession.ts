import type { Ref } from 'vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS } from '@app/modules/document-viewer/public';
import { wheelZoomSessionIdleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionIdleMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';
import { zoomViewportAnchorMaxAgeMs } from '@app/modules/pdf-viewer/runtime/zoom/zoomViewportAnchorMaxAgeMs';
import { usePdfViewerZoomInteractionLock } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomInteractionLock';
import type {
    IZoomVirtualizationLogOptions,
    TZoomInteractionLockOperationId,
} from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';
import type { IResizeAnchorContext } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync';

interface IZoomViewportAnchorIntent {
    id: number;
    sessionId: number;
    zoomLockOperationId: TZoomInteractionLockOperationId | null;
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
    lockUntilMs: number;
    lastEventId: number;
    zoomLockOperationId: TZoomInteractionLockOperationId | null;
    packetCount: number;
    emittedCount: number;
    startScrollTop: number | null;
    startScrollLeft: number | null;
    resizeAnchor: IResizeAnchorContext | null;
}

interface IUsePdfViewerWheelZoomSessionOptions extends IZoomVirtualizationLogOptions {
    viewerContainer: Ref<HTMLElement | null>;
    effectiveScale: Ref<number>;
}

export const usePdfViewerWheelZoomSession = (options: IUsePdfViewerWheelZoomSessionOptions) => {
    const {
        viewerContainer,
        effectiveScale,
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
    } = options;

    const pendingZoomViewportAnchor = ref<IZoomViewportAnchorIntent | null>(null);

    let wheelZoomSessionId = 0;
    let activeWheelZoomSession: IWheelZoomSession | null = null;
    let wheelZoomSessionIdleTimer: ReturnType<typeof setTimeout> | null = null;

    function clearWheelZoomSessionIdleTimer() {
        if (wheelZoomSessionIdleTimer !== null) {
            clearTimeout(wheelZoomSessionIdleTimer);
            wheelZoomSessionIdleTimer = null;
        }
    }

    function getActiveWheelZoomSession(nowMs = Date.now()) {
        if (!activeWheelZoomSession) {
            return null;
        }
        if (nowMs > activeWheelZoomSession.lockUntilMs) {
            endWheelZoomSession('lock-expired');
            return null;
        }
        return activeWheelZoomSession;
    }

    function isWheelZoomGestureLocked(nowMs = Date.now()) {
        const session = getActiveWheelZoomSession(nowMs);
        return Boolean(session && nowMs <= session.lockUntilMs);
    }

    const {
        zoomSnapSuppressed,
        captureZoomVirtualizationFreeze,
        maybeReleaseZoomVirtualizationFreeze,
        markExpectedZoomScroll,
        completeExpectedZoomScroll,
        setZoomRerenderBusy,
        isZoomInteractionLocked,
        cleanupZoomInteractionLock,
        getIsZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs,
    } = usePdfViewerZoomInteractionLock({
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
        getActiveSessionId: () => activeWheelZoomSession?.id ?? null,
        isWheelZoomGestureLocked,
    });

    function endWheelZoomSession(reason: string) {
        clearWheelZoomSessionIdleTimer();
        const finishedSession = activeWheelZoomSession;
        if (!finishedSession) {
            return;
        }
        const viewerState = summarizeViewerStateForLog();
        BrowserLogger.diagnostic('pdf-zoom-debug', `[wheel-zoom-session] end reason=${reason}`, {
            reason,
            session: finishedSession,
            viewer: viewerState,
            sessionDurationMs: Date.now() - finishedSession.startedAtMs,
            packetCount: finishedSession.packetCount,
            emittedCount: finishedSession.emittedCount,
            scrollDriftFromSessionStart: {
                top: viewerState && finishedSession.startScrollTop !== null
                    ? viewerState.scrollTop - finishedSession.startScrollTop
                    : null,
                left: viewerState && finishedSession.startScrollLeft !== null
                    ? viewerState.scrollLeft - finishedSession.startScrollLeft
                    : null,
            },
        });
        activeWheelZoomSession = null;
        maybeReleaseZoomVirtualizationFreeze(`session-end:${reason}`);
    }

    function scheduleWheelZoomSessionIdleTimeout(sessionId: number) {
        clearWheelZoomSessionIdleTimer();
        wheelZoomSessionIdleTimer = setTimeout(() => {
            if (!activeWheelZoomSession || activeWheelZoomSession.id !== sessionId) {
                return;
            }
            const idleMs = Date.now() - activeWheelZoomSession.lastPacketAtMs;
            if (idleMs < wheelZoomSessionIdleMs) {
                scheduleWheelZoomSessionIdleTimeout(sessionId);
                return;
            }
            endWheelZoomSession('idle-timeout');
        }, wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs);
    }

    function ensureWheelZoomSession(
        nowMs: number,
        anchorX: number,
        anchorY: number,
        eventId: number,
        zoomLockOperationId: TZoomInteractionLockOperationId | null,
    ) {
        const current = activeWheelZoomSession;
        const shouldReuseCurrent = Boolean(
            current
            && nowMs - current.lastPacketAtMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
        );
        if (shouldReuseCurrent && current) {
            if (!zoomVirtualizationFreeze.value) {
                captureZoomVirtualizationFreeze(current.id, 'session-reuse');
            }
            current.lastPacketAtMs = nowMs;
            current.lockUntilMs = nowMs + wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs;
            current.lastEventId = eventId;
            current.zoomLockOperationId = zoomLockOperationId;
            scheduleWheelZoomSessionIdleTimeout(current.id);
            return {
                session: current,
                reused: true,
            };
        }

        wheelZoomSessionId += 1;
        const nextSession: IWheelZoomSession = {
            id: wheelZoomSessionId,
            anchorX,
            anchorY,
            startZoom: effectiveScale.value,
            cumulativeDelta: 0,
            lastEmittedZoom: effectiveScale.value,
            startedAtMs: nowMs,
            lastPacketAtMs: nowMs,
            lockUntilMs: nowMs + wheelZoomSessionIdleMs + wheelZoomSessionLockExtensionMs,
            lastEventId: eventId,
            zoomLockOperationId,
            packetCount: 0,
            emittedCount: 0,
            startScrollTop: viewerContainer.value ? Math.round(viewerContainer.value.scrollTop) : null,
            startScrollLeft: viewerContainer.value ? Math.round(viewerContainer.value.scrollLeft) : null,
            resizeAnchor: null,
        };
        activeWheelZoomSession = nextSession;
        captureZoomVirtualizationFreeze(nextSession.id, 'session-start');
        BrowserLogger.diagnostic('pdf-zoom-debug', '[wheel-zoom-session] start', {
            session: nextSession,
            viewer: summarizeViewerStateForLog(),
        });
        scheduleWheelZoomSessionIdleTimeout(nextSession.id);
        return {
            session: nextSession,
            reused: false,
        };
    }

    function consumeZoomViewportAnchor() {
        const nowMs = Date.now();
        const pendingAnchor = pendingZoomViewportAnchor.value;
        if (!pendingAnchor) {
            const activeSession = getActiveWheelZoomSession(nowMs);
            const canUseSessionFallback = Boolean(
                activeSession
                && nowMs - activeSession.lastPacketAtMs < DOCUMENT_WHEEL_ZOOM_GESTURE_GRACE_MS,
            );
            if (canUseSessionFallback && activeSession) {
                const fallbackAnchor: IZoomViewportAnchorIntent = {
                    id: activeSession.lastEventId,
                    sessionId: activeSession.id,
                    zoomLockOperationId: activeSession.zoomLockOperationId,
                    x: activeSession.anchorX,
                    y: activeSession.anchorY,
                    capturedAtMs: activeSession.lastPacketAtMs,
                    resizeAnchor: activeSession.resizeAnchor,
                };
                BrowserLogger.diagnosticThrottled(
                    'pdf-zoom-debug',
                    'anchor-consume-session-fallback',
                    wheelDetailLogThrottleMs,
                    `[anchor-consume] session-fallback id=${fallbackAnchor.id}`,
                    {
                        id: fallbackAnchor.id,
                        sessionId: fallbackAnchor.sessionId,
                        anchor: fallbackAnchor,
                        viewer: summarizeViewerStateForLog(),
                    },
                );
                return fallbackAnchor;
            }
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'anchor-consume-none',
                wheelDetailLogThrottleMs,
                '[anchor-consume] none',
            );
            return null;
        }

        const ageMs = nowMs - pendingAnchor.capturedAtMs;
        const zoomLockActive = isZoomInteractionLocked(nowMs);
        const activeSession = getActiveWheelZoomSession(nowMs);
        const belongsToActiveSession = activeSession?.id === pendingAnchor.sessionId;
        const staleWithoutZoomContext =
            ageMs > zoomViewportAnchorMaxAgeMs
            && !zoomLockActive
            && !belongsToActiveSession;
        if (staleWithoutZoomContext) {
            pendingZoomViewportAnchor.value = null;
            BrowserLogger.diagnosticThrottled(
                'pdf-zoom-debug',
                'anchor-consume-stale',
                wheelDetailLogThrottleMs,
                `[anchor-consume] stale id=${pendingAnchor.id}`,
                {
                    id: pendingAnchor.id,
                    sessionId: pendingAnchor.sessionId,
                    ageMs,
                    anchor: pendingAnchor,
                    viewer: summarizeViewerStateForLog(),
                },
            );
            return null;
        }

        pendingZoomViewportAnchor.value = null;
        BrowserLogger.diagnosticThrottled(
            'pdf-zoom-debug',
            'anchor-consume',
            wheelDetailLogThrottleMs,
            `[anchor-consume] id=${pendingAnchor.id}`,
            {
                id: pendingAnchor.id,
                sessionId: pendingAnchor.sessionId,
                ageMs,
                zoomLockActive,
                anchor: pendingAnchor,
                viewer: summarizeViewerStateForLog(),
            },
        );
        return pendingAnchor;
    }

    function cleanupWheelZoomSession() {
        clearWheelZoomSessionIdleTimer();
        activeWheelZoomSession = null;
        cleanupZoomInteractionLock();
    }

    return {
        pendingZoomViewportAnchor,
        zoomSnapSuppressed,
        getActiveWheelZoomSession,
        ensureWheelZoomSession,
        markExpectedZoomScroll,
        completeExpectedZoomScroll,
        isZoomInteractionLocked,
        setZoomRerenderBusy,
        consumeZoomViewportAnchor,
        cleanupWheelZoomSession,
        getIsZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs,
    };
};
