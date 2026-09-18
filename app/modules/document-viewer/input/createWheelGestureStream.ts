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
 * Groups wheel packets into gestures, so a consumer can ask when the user
 * expressed an intent instead of when its packets happened to arrive.
 *
 * A fling is expressed once, at finger lift. The platform then keeps emitting
 * packets for a second or more, and none of them carries a new decision. Delta
 * size cannot separate the two: Chromium coalesces packets while the main
 * thread is busy, which inflates a tail packet exactly when the viewer is under
 * load.
 *
 * Chromium marks where a gesture begins. It sends the first wheel event of a
 * scroll sequence as cancelable and streams the rest as non-cancelable, so a
 * cancelable packet after a non-cancelable one is a new sequence, exactly and
 * with no timing involved. That matters because a sequence that begins while
 * the viewport is not user-scrollable stays dead until it ends; the consumer
 * has to learn of it inside that first event. The flag says nothing when a
 * handler prevented the sequence, since every later packet then stays
 * cancelable, so a quiet gap or a reversal remains the fallback. A reversal is
 * a packet pointing against the previous one; a diagonal tail whose larger
 * axis alternates is still travelling the same way.
 */
export function createWheelGestureStream() {
    let gestureId = 0;
    let lastPacketAtMs: number | null = null;
    let lastDelta: {
        x: number;
        y: number
    } | null = null;
    let lastPacketCancelable = true;

    function isLive(nowMs: number) {
        if (lastPacketAtMs === null) {
            return false;
        }
        const sinceLastPacketMs = nowMs - lastPacketAtMs;
        return sinceLastPacketMs >= 0 && sinceLastPacketMs < WHEEL_GESTURE_IDLE_MS;
    }

    return {
        isLive,
        getGestureId: () => gestureId,
        /** Records a packet and returns the id of the gesture it belongs to. */
        observe(packet: IWheelGesturePacket) {
            const hasDelta = packet.deltaX !== 0 || packet.deltaY !== 0;
            const reverses = hasDelta
                && lastDelta !== null
                && packet.deltaX * lastDelta.x + packet.deltaY * lastDelta.y < 0;
            const beginsSequence = packet.cancelable && !lastPacketCancelable;
            if (!isLive(packet.timeStamp) || reverses || beginsSequence) {
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
