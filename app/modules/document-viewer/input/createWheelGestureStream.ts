/**
 * Packets closer together than this belong to one gesture. Wheel input has no
 * end event, and an inertial tail keeps its packet cadence until it stops, so a
 * quiet gap is the only way to see a gesture end.
 */
export const WHEEL_GESTURE_IDLE_MS = 200;

export interface IWheelGesturePacket {
    readonly timeStamp: number;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly cancelable: boolean;
}

/**
 * How stale a sequence may be before a non-cancelable packet stops counting as
 * its continuation. Generous on purpose: under load one fling arrives as a few
 * packets several hundred milliseconds apart.
 */
const WHEEL_SEQUENCE_STALL_MS = 1500;

/**
 * Groups wheel packets into gestures, so a consumer can ask when the user
 * expressed an intent instead of when its packets happened to arrive.
 *
 * A fling is expressed once, at finger lift. The platform then keeps emitting
 * packets for a second or more, and none of them carries a new decision.
 *
 * Chromium marks where a gesture begins. It sends the first wheel event of a
 * scroll sequence as cancelable and streams the rest as non-cancelable. So a
 * non-cancelable packet can only belong to the sequence already in progress,
 * and a cancelable packet after a non-cancelable one begins a new sequence.
 * Neither conclusion involves timing, which matters because timing is the
 * first thing a slow machine distorts: a busy main thread makes Chromium
 * coalesce packets, and one fling then arrives as a handful of packets several
 * hundred milliseconds apart. Delta size is no better, since coalescing
 * inflates a tail packet exactly when the viewer is under load.
 *
 * The flag says nothing between two cancelable packets, which is what a
 * sequence looks like once a handler prevented it, so there a quiet gap
 * decides. A reversal always starts a new gesture, because inertia never
 * reverses. A reversal is a packet pointing against the previous one; a
 * diagonal tail whose larger axis alternates is still travelling the same way.
 */
export function createWheelGestureStream() {
    let gestureId = 0;
    let lastPacketAtMs: number | null = null;
    let lastDelta: {
        x: number;
        y: number
    } | null = null;
    let lastPacketCancelable = true;
    // With no non-passive wheel listener every packet is non-cancelable and
    // the flag carries no information, so timing has to decide instead.
    let cancelableSeen = false;

    function isWithin(nowMs: number, windowMs: number) {
        if (lastPacketAtMs === null) {
            return false;
        }
        const sinceLastPacketMs = nowMs - lastPacketAtMs;
        return sinceLastPacketMs >= 0 && sinceLastPacketMs < windowMs;
    }

    return {
        /** Whether packet timing alone suggests the gesture is still going. */
        isLive: (nowMs: number) => isWithin(nowMs, WHEEL_GESTURE_IDLE_MS),
        getGestureId: () => gestureId,
        /** Records a packet and returns the id of the gesture it belongs to. */
        observe(packet: IWheelGesturePacket) {
            const hasDelta = packet.deltaX !== 0 || packet.deltaY !== 0;
            const reverses = hasDelta
                && lastDelta !== null
                && packet.deltaX * lastDelta.x + packet.deltaY * lastDelta.y < 0;
            const continuesSequence = packet.cancelable
                ? lastPacketCancelable && isWithin(packet.timeStamp, WHEEL_GESTURE_IDLE_MS)
                : isWithin(packet.timeStamp, cancelableSeen ? WHEEL_SEQUENCE_STALL_MS : WHEEL_GESTURE_IDLE_MS);
            cancelableSeen ||= packet.cancelable;
            if (!continuesSequence || reverses) {
                gestureId += 1;
                lastDelta = null;
            }
            lastPacketCancelable = packet.cancelable;
            if (hasDelta) {
                lastDelta = {
                    x: packet.deltaX,
                    y: packet.deltaY,
                };
            }
            lastPacketAtMs = packet.timeStamp;
            return gestureId;
        },
    };
}
