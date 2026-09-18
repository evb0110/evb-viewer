/**
 * Packets closer together than this belong to one gesture. Wheel input has no
 * end event, and an inertial tail keeps its packet cadence until it stops, so a
 * quiet gap is the only boundary the platform exposes.
 */
export const WHEEL_GESTURE_IDLE_MS = 200;

export interface IWheelGesturePacket {
    readonly timeStamp: number;
    readonly deltaX: number;
    readonly deltaY: number;
}

/**
 * Groups wheel packets into gestures, so a consumer can ask when the user
 * expressed an intent instead of when its packets happened to arrive.
 *
 * A fling is expressed once, at finger lift. The platform then keeps emitting
 * packets for a second or more, and none of them carries a new decision. Delta
 * size cannot separate the two: Chromium coalesces packets while the main
 * thread is busy, which inflates a tail packet exactly when the viewer is under
 * load. Only a quiet gap or a reversal proves a new gesture. A reversal is a
 * packet pointing against the previous one; a diagonal tail whose larger axis
 * alternates is still travelling the same way.
 */
export function createWheelGestureStream() {
    let gestureId = 0;
    let lastPacketAtMs: number | null = null;
    let lastDelta: {
        x: number;
        y: number
    } | null = null;

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
            if (!isLive(packet.timeStamp) || reverses) {
                gestureId += 1;
                lastDelta = null;
            }
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
