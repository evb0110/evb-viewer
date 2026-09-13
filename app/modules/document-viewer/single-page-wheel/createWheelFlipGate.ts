import type { TWheelDirection } from '@app/modules/document-viewer/single-page-wheel/singlePageWheelTypes';

const SAME_DIRECTION_FLIP_COOLDOWN_MS = 180;
const SAME_DIRECTION_GESTURE_IDLE_MS = 200;
const SAME_DIRECTION_GESTURE_MAX_BLOCK_MS = 420;
const SAME_DIRECTION_GESTURE_HARD_RELEASE_MS = 700;
const SAME_DIRECTION_TRACKPAD_DELTA_MAX_PX = 40;
const SAME_DIRECTION_TRACKPAD_MAX_BLOCK_MS = 220;
const SAME_DIRECTION_RENEWED_DELTA_MIN_PX = 40;
const SAME_DIRECTION_RENEWED_DELTA_RATIO = 0.75;
const SAME_DIRECTION_RENEWED_PREVIOUS_DELTA_RATIO = 0.9;

interface IShouldBlockFlipOptions {
    delta?: number;
    requireGestureIdle?: boolean;
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

function isTrackpadScaleFlipDelta(deltaMagnitude: number) {
    return deltaMagnitude > 0
        && deltaMagnitude < SAME_DIRECTION_TRACKPAD_DELTA_MAX_PX;
}

function resolveSameDirectionGestureMaxBlockMs(lastFlipDeltaMagnitude: number) {
    return isTrackpadScaleFlipDelta(lastFlipDeltaMagnitude)
        ? SAME_DIRECTION_TRACKPAD_MAX_BLOCK_MS
        : SAME_DIRECTION_GESTURE_MAX_BLOCK_MS;
}

function resolveRenewedDeltaFloor(lastFlipDeltaMagnitude: number) {
    if (isTrackpadScaleFlipDelta(lastFlipDeltaMagnitude)) {
        return Math.max(
            1,
            lastFlipDeltaMagnitude * SAME_DIRECTION_RENEWED_DELTA_RATIO,
        );
    }

    return Math.max(
        SAME_DIRECTION_RENEWED_DELTA_MIN_PX,
        lastFlipDeltaMagnitude * SAME_DIRECTION_RENEWED_DELTA_RATIO,
    );
}

function isInSameDirectionGesture(
    eventTimeMs: number,
    direction: TWheelDirection,
    deltaMagnitude: number,
    lastFlipAtMs: number,
    lastFlipDirection: TWheelDirection | 0,
    lastFlipDeltaMagnitude: number,
    lastWheelPacketAtMs: number,
    lastWheelPacketDeltaMagnitude: number,
    hasInteriorScrollSinceLastFlip: boolean,
) {
    const sinceLastWheelPacketMs = eventTimeMs - lastWheelPacketAtMs;
    const sinceLastFlipMs = eventTimeMs - lastFlipAtMs;
    const isSameGesture = (
        lastFlipAtMs > 0
        && lastWheelPacketAtMs > 0
        && lastFlipDirection === direction
        && !hasInteriorScrollSinceLastFlip
        && sinceLastWheelPacketMs >= 0
        && sinceLastWheelPacketMs < SAME_DIRECTION_GESTURE_IDLE_MS
        && sinceLastFlipMs >= 0
    );
    if (!isSameGesture) {
        return false;
    }

    const isTrackpadScaleFlip = isTrackpadScaleFlipDelta(lastFlipDeltaMagnitude);
    if (sinceLastFlipMs < resolveSameDirectionGestureMaxBlockMs(lastFlipDeltaMagnitude)) {
        return true;
    }
    if (isTrackpadScaleFlip) {
        return false;
    }
    if (sinceLastFlipMs >= SAME_DIRECTION_GESTURE_HARD_RELEASE_MS) {
        return false;
    }

    const renewedDeltaFloor = resolveRenewedDeltaFloor(lastFlipDeltaMagnitude);
    const isRenewedInput = deltaMagnitude >= renewedDeltaFloor
        && (
            lastWheelPacketDeltaMagnitude <= 0
            || deltaMagnitude >= lastWheelPacketDeltaMagnitude * SAME_DIRECTION_RENEWED_PREVIOUS_DELTA_RATIO
        );
    return !isRenewedInput;
}

export function createWheelFlipGate() {
    let lastWheelFlipAtMs = 0;
    let lastWheelFlipDirection: TWheelDirection | 0 = 0;
    let lastWheelFlipDeltaMagnitude = 0;
    let lastWheelPacketAtMs = 0;
    let lastWheelPacketDeltaMagnitude = 0;
    let interiorScrollSinceLastFlip = false;

    function shouldBlockFlip(
        direction: TWheelDirection,
        nowMs: number,
        options?: IShouldBlockFlipOptions,
    ) {
        if (isInSameDirectionFlipCooldown(
            nowMs,
            direction,
            lastWheelFlipAtMs,
            lastWheelFlipDirection,
            interiorScrollSinceLastFlip,
        )) {
            return true;
        }

        return options?.requireGestureIdle === true
            && isInSameDirectionGesture(
                nowMs,
                direction,
                Math.abs(options.delta ?? 0),
                lastWheelFlipAtMs,
                lastWheelFlipDirection,
                lastWheelFlipDeltaMagnitude,
                lastWheelPacketAtMs,
                lastWheelPacketDeltaMagnitude,
                interiorScrollSinceLastFlip,
            );
    }

    function recordFlip(direction: TWheelDirection, nowMs: number, delta?: number) {
        lastWheelFlipAtMs = nowMs;
        lastWheelFlipDirection = direction;
        lastWheelFlipDeltaMagnitude = Math.abs(delta ?? 0);
        lastWheelPacketAtMs = nowMs;
        lastWheelPacketDeltaMagnitude = lastWheelFlipDeltaMagnitude;
        interiorScrollSinceLastFlip = false;
    }

    function recordWheelPacket(nowMs: number, delta?: number) {
        lastWheelPacketAtMs = nowMs;
        lastWheelPacketDeltaMagnitude = Math.abs(delta ?? 0);
    }

    function recordInteriorScroll() {
        interiorScrollSinceLastFlip = true;
    }

    function reset() {
        lastWheelFlipAtMs = 0;
        lastWheelFlipDirection = 0;
        lastWheelFlipDeltaMagnitude = 0;
        lastWheelPacketAtMs = 0;
        lastWheelPacketDeltaMagnitude = 0;
        interiorScrollSinceLastFlip = false;
    }

    return {
        shouldBlockFlip,
        recordFlip,
        recordWheelPacket,
        recordInteriorScroll,
        reset,
    };
}
