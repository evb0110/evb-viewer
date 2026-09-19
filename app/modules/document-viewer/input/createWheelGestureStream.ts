/**
 * The quiet gap that separates two gestures where nothing better can. Timing is
 * the fallback here, not the rule; see `createWheelGestureStream`.
 */
export const WHEEL_GESTURE_IDLE_MS = 200;

/**
 * The stream keeps a reference to the latest packet, because whether a
 * cancelable packet was prevented is only final once its dispatch is over, and
 * that is what the next packet is judged against.
 */
export interface IWheelGesturePacket {
    readonly timeStamp: number;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly cancelable: boolean;
    readonly defaultPrevented?: boolean;
}

export interface IWheelGestureObservation {
    /** The user's intent. Changes with the sequence, and on a reversal inside one. */
    readonly gestureId: number;
    /** The browser's scroll sequence, which is what a host boundary refers to. */
    readonly sequenceId: number;
    readonly startsSequence: boolean;
    /**
     * True when a cancelable packet was joined to the sequence by timing alone.
     * Such a local sequence spans several browser sequences, so a host boundary
     * for one of them says nothing about the gesture.
     */
    readonly joinedByTiming: boolean;
}

/**
 * Groups wheel packets into sequences and gestures, so a consumer can ask when
 * the user expressed an intent instead of when its packets happened to arrive.
 *
 * A fling is expressed once, at finger lift. The platform then keeps emitting
 * packets for a second or more, and none of them carries a new decision.
 *
 * Identity is structural. Chromium sends the first wheel event of a scroll
 * sequence as cancelable and streams the rest as non-cancelable, unless a
 * handler prevented the first, in which case every later packet stays
 * cancelable. Therefore:
 *
 * - a non-cancelable packet belongs to the sequence in progress, however far
 *   apart the packets are and however late they are delivered;
 * - a cancelable packet after a non-cancelable one begins a new sequence;
 * - a cancelable packet after a cancelable one is ambiguous, and there a quiet
 *   gap decides.
 *
 * The last case is a prevented sequence, or a run of one-packet sequences. The
 * DevTools input path produces the latter: `Input.dispatchMouseEvent` sends
 * each wheel event as a complete sequence of its own, all cancelable and none
 * prevented, which is how the E2E suite and automation agents drive a fling.
 * Hardware cannot produce that run fast enough to matter. A person would have
 * to scroll one packet, issue a command and start a new gesture inside the
 * quiet gap, and a notched wheel stays latched in one sequence for longer than
 * that. So joining by timing is never wrong for a person and is required for
 * automation.
 *
 * Neither of the first two involves timing, neither the spacing of timestamps
 * nor the delay of delivery. Both are what a slow machine distorts first: a
 * busy main thread makes Chromium coalesce packets, so one fling arrives as a
 * handful of packets hundreds of milliseconds apart, and it delivers them late.
 * Delta size is no better, since coalescing inflates a tail packet exactly when
 * the viewer is under load.
 *
 * A reversal is new intent, because inertia never reverses, but it stays inside
 * its sequence. A reversal is a packet pointing against the previous one; a
 * diagonal tail whose larger axis alternates is still travelling the same way.
 */
export function createWheelGestureStream() {
    let gestureId = 0;
    let sequenceId = 0;
    let lastPacket: IWheelGesturePacket | null = null;
    let lastDelta: {
        x: number;
        y: number
    } | null = null;
    // With no non-passive wheel listener every packet is non-cancelable and
    // the flag carries no information, so timing has to decide instead.
    let cancelableSeen = false;

    function isWithinIdleGap(nowMs: number) {
        if (lastPacket === null) {
            return false;
        }
        const sinceLastPacketMs = nowMs - lastPacket.timeStamp;
        return sinceLastPacketMs >= 0 && sinceLastPacketMs < WHEEL_GESTURE_IDLE_MS;
    }

    function continuesSequence(packet: IWheelGesturePacket) {
        if (lastPacket === null) {
            return false;
        }
        if (!packet.cancelable) {
            return cancelableSeen || isWithinIdleGap(packet.timeStamp);
        }
        return lastPacket.cancelable && isWithinIdleGap(packet.timeStamp);
    }

    return {
        /** Whether packet timing alone suggests the gesture is still going. */
        isLive: isWithinIdleGap,
        hasPackets: () => lastPacket !== null,
        getGestureId: () => gestureId,
        getSequenceId: () => sequenceId,
        observe(packet: IWheelGesturePacket): IWheelGestureObservation {
            const hasDelta = packet.deltaX !== 0 || packet.deltaY !== 0;
            const startsSequence = !continuesSequence(packet);
            const joinedByTiming = !startsSequence && packet.cancelable;
            const reverses = !startsSequence
                && hasDelta
                && lastDelta !== null
                && packet.deltaX * lastDelta.x + packet.deltaY * lastDelta.y < 0;
            if (startsSequence) {
                sequenceId += 1;
                lastDelta = null;
            }
            if (startsSequence || reverses) {
                gestureId += 1;
            }
            cancelableSeen ||= packet.cancelable;
            if (hasDelta) {
                lastDelta = {
                    x: packet.deltaX,
                    y: packet.deltaY,
                };
            }
            lastPacket = packet;
            return {
                gestureId,
                sequenceId,
                startsSequence,
                joinedByTiming,
            };
        },
    };
}
