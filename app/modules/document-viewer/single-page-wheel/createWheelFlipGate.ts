import type { TWheelDirection } from '@app/modules/document-viewer/single-page-wheel/singlePageWheelTypes';
import { createWheelGestureStream } from '@app/modules/document-viewer/input/createWheelGestureStream';

const SAME_DIRECTION_FLIP_COOLDOWN_MS = 180;
const SAME_DIRECTION_RENEWED_FLIP_INTERVAL_MS = 260;
const SAME_DIRECTION_RENEWED_DELTA_MIN_PX = 40;
const SAME_DIRECTION_RENEWED_DELTA_RATIO = 0.75;
const SAME_DIRECTION_RENEWED_STEADY_PEAK_RATIO = 0.9;

interface IWheelFlipGatePacket {
    readonly timeStamp: number;
    readonly deltaY: number;
    readonly cancelable?: boolean | undefined;
}

function isInSameDirectionFlipCooldown(
    eventTimeMs: number,
    direction: TWheelDirection,
    lastFlipAtMs: number,
    lastFlipDirection: TWheelDirection | 0,
    hasInteriorScrollSinceLastFlip: boolean,
) {
    const sinceLastFlipMs = eventTimeMs - lastFlipAtMs;
    return (
        lastFlipAtMs > 0
        && lastFlipDirection === direction
        && !hasInteriorScrollSinceLastFlip
        && sinceLastFlipMs >= 0
        && sinceLastFlipMs < SAME_DIRECTION_FLIP_COOLDOWN_MS
    );
}

/**
 * Prevents one wheel gesture's inertial tail or mid-gesture jitter from
 * flipping more than one page in non-continuous mode, while still allowing
 * distinct gestures, immediate direction reversals, and sustained full-strength
 * notched-wheel spinning.
 */
export function createWheelFlipGate() {
    let wheelGestures = createWheelGestureStream();
    let lastObservedPacket: IWheelFlipGatePacket | null = null;
    let lastFlippedGestureId: number | null = null;
    let lastFlipAtMs = 0;
    let lastFlipDirection: TWheelDirection | 0 = 0;
    let gesturePeakDeltaMagnitude = 0;
    let lastVerticalDeltaMagnitude = 0;
    let interiorScrollSinceLastFlip = false;

    function observeVerticalGesture(packet: IWheelFlipGatePacket, deltaY = packet.deltaY) {
        const observation = wheelGestures.observe({
            timeStamp: packet.timeStamp,
            deltaX: 0,
            deltaY,
            cancelable: packet.cancelable ?? true,
        });
        lastObservedPacket = packet;
        if (observation.gestureId !== lastFlippedGestureId) {
            lastFlippedGestureId = null;
            gesturePeakDeltaMagnitude = 0;
            lastVerticalDeltaMagnitude = 0;
        }
        return observation;
    }

    /**
     * Records a horizontal-dominant or zero-delta packet so mid-gesture jitter
     * keeps the active flip gesture alive without causing a false reversal or
     * wiping the gate. Returns true while the packet belongs to an active
     * flipped gesture.
     */
    function consumeGestureJitter(packet: IWheelFlipGatePacket) {
        const observation = observeVerticalGesture(packet, 0);
        return lastFlippedGestureId !== null && observation.gestureId === lastFlippedGestureId;
    }

    function shouldBlockFlip(
        direction: TWheelDirection,
        packet: IWheelFlipGatePacket,
    ) {
        const nowMs = packet.timeStamp;
        const deltaMagnitude = Math.abs(packet.deltaY);
        const previousVerticalDeltaMagnitude = lastVerticalDeltaMagnitude;
        const observation = observeVerticalGesture(packet);
        const isSameDirectionCooldown = isInSameDirectionFlipCooldown(
            nowMs,
            direction,
            lastFlipAtMs,
            lastFlipDirection,
            interiorScrollSinceLastFlip,
        );
        const isSameFlippedGesture = (
            lastFlippedGestureId !== null
            && observation.gestureId === lastFlippedGestureId
            && lastFlipDirection === direction
            && !interiorScrollSinceLastFlip
        );

        if (isSameFlippedGesture) {
            gesturePeakDeltaMagnitude = Math.max(gesturePeakDeltaMagnitude, deltaMagnitude);
            lastVerticalDeltaMagnitude = deltaMagnitude;
        }

        if (isSameDirectionCooldown) {
            return true;
        }

        if (!isSameFlippedGesture) {
            return false;
        }

        // A non-cancelable packet belongs to a browser-streamed native scroll
        // sequence (such as inertia after an unprevented packet) and is never a
        // renewed discrete wheel notch.
        if (packet.cancelable === false) {
            return true;
        }

        const sinceLastFlipMs = nowMs - lastFlipAtMs;
        if (sinceLastFlipMs < SAME_DIRECTION_RENEWED_FLIP_INTERVAL_MS) {
            return true;
        }

        // Allow rapid sustained notched-wheel spinning (repeated full-strength
        // cancelable impulses that are not decaying) to advance steadily, while
        // keeping decaying inertia tails of any duration bounded to one page.
        const renewedDeltaFloor = Math.max(
            SAME_DIRECTION_RENEWED_DELTA_MIN_PX,
            gesturePeakDeltaMagnitude * SAME_DIRECTION_RENEWED_DELTA_RATIO,
        );
        const isRenewedImpulse = deltaMagnitude >= renewedDeltaFloor
            && (
                previousVerticalDeltaMagnitude <= 0
                || deltaMagnitude > previousVerticalDeltaMagnitude
                || deltaMagnitude >= gesturePeakDeltaMagnitude * SAME_DIRECTION_RENEWED_STEADY_PEAK_RATIO
            );
        return !isRenewedImpulse;
    }

    function recordFlip(direction: TWheelDirection, packet: IWheelFlipGatePacket) {
        const observation = lastObservedPacket === packet && wheelGestures.hasPackets()
            ? { gestureId: wheelGestures.getGestureId() }
            : observeVerticalGesture(packet);
        const deltaMagnitude = Math.abs(packet.deltaY);
        lastFlippedGestureId = observation.gestureId;
        lastFlipAtMs = packet.timeStamp;
        lastFlipDirection = direction;
        gesturePeakDeltaMagnitude = deltaMagnitude;
        lastVerticalDeltaMagnitude = deltaMagnitude;
        interiorScrollSinceLastFlip = false;
    }

    function recordInteriorScroll(packet?: IWheelFlipGatePacket) {
        if (packet) {
            observeVerticalGesture(packet);
        }
        interiorScrollSinceLastFlip = true;
        lastFlippedGestureId = null;
    }

    function reset() {
        wheelGestures = createWheelGestureStream();
        lastObservedPacket = null;
        lastFlippedGestureId = null;
        lastFlipAtMs = 0;
        lastFlipDirection = 0;
        gesturePeakDeltaMagnitude = 0;
        lastVerticalDeltaMagnitude = 0;
        interiorScrollSinceLastFlip = false;
    }

    return {
        consumeGestureJitter,
        shouldBlockFlip,
        recordFlip,
        recordInteriorScroll,
        reset,
    };
}
