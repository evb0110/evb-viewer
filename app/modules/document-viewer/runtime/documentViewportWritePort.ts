import type { Ref } from 'vue';
import type { TDocumentWheelIntent } from '@app/modules/document-viewer/input/documentWheelInteraction';
import {
    createWheelGestureStream,
    WHEEL_GESTURE_IDLE_MS,
    type IWheelGesturePacket,
} from '@app/modules/document-viewer/input/createWheelGestureStream';

export interface IDocumentViewportIntentFence {
    readonly intentId: string;
    readonly documentRevision: number;
    readonly interactionEpoch: number;
    readonly sequence: number;
}

export interface IDocumentViewportWrite {
    intent: IDocumentViewportIntentFence;
    reason: string;
    left?: number;
    top?: number;
}

export interface IDocumentViewportWritePort {
    beginIntent(intentId: string): IDocumentViewportIntentFence;
    apply(container: HTMLElement, write: IDocumentViewportWrite): boolean;
    advanceDocumentRevision(): number;
    consumeAuthorityScroll(container: HTMLElement): boolean;
    getInteractionEpoch(): number;
    observeUserInteraction(container?: HTMLElement): void;
    observeUserScroll(container: HTMLElement): void;
    /**
     * Declares an explicit command newer than any wheel gesture still emitting
     * packets. That gesture becomes residue: it can neither cancel the command
     * nor move the viewport.
     */
    fenceCommandAgainstLiveGesture(nowMs?: number): void;
    /** Classifies a scroll-intent wheel packet against the command fence. */
    observeWheelPacket(packet: IWheelGesturePacket): TDocumentWheelPacketOwner;
    isCommandResidueLive(): boolean;
    /** The host reports that the browser began or ended a wheel scroll sequence. */
    observeWheelScrollSequence(boundary: 'begin' | 'end'): void;
    /** True while residue must not scroll the viewport. */
    readonly userScrollSuppressed: Readonly<Ref<boolean>>;
}

/**
 * `adopted-user-input` is user input the viewer has to scroll by hand, because
 * its sequence began while user scrolling was suppressed.
 */
export type TDocumentWheelPacketOwner = 'command-residue' | 'user-input' | 'adopted-user-input';

const DOCUMENT_VIEWPORT_PANE_RELOCATION_SCROLL_FENCE_ATTRIBUTE =
    'data-document-viewport-pane-relocation-scroll-fence';

/**
 * Marks a pane before its persistent DOM subtree is moved by Teleport.
 * Browsers can emit a trusted scroll event for the native offset reset caused
 * by that move, before the workspace can restore the semantic position.
 */
export function fenceDocumentViewportPaneRelocationScroll(element: HTMLElement) {
    element.setAttribute(DOCUMENT_VIEWPORT_PANE_RELOCATION_SCROLL_FENCE_ATTRIBUTE, '');
}

export function clearDocumentViewportPaneRelocationScrollFence(element: HTMLElement) {
    element.removeAttribute(DOCUMENT_VIEWPORT_PANE_RELOCATION_SCROLL_FENCE_ATTRIBUTE);
}

export function consumeDocumentViewportPaneRelocationScrollFence(element: HTMLElement) {
    const fence = element.closest<HTMLElement>(
        `[${DOCUMENT_VIEWPORT_PANE_RELOCATION_SCROLL_FENCE_ATTRIBUTE}]`,
    );
    if (!fence) {
        return false;
    }
    clearDocumentViewportPaneRelocationScrollFence(fence);
    return true;
}

function resolveAuthoredOffset(
    value: number | undefined,
    current: number,
    scrollSize: number,
    clientSize: number,
) {
    if (value === undefined) {
        return current;
    }
    const maxOffset = scrollSize - clientSize;
    if (!Number.isFinite(maxOffset)) {
        return value;
    }
    return Math.min(Math.max(0, value), Math.max(0, maxOffset));
}

/**
 * The sole programmatic viewport writer shared by every document source and
 * rendering feature pack mounted in DocumentViewerChassis.
 */
/**
 * How long a restored viewport is still treated as not natively scrollable,
 * on top of two animation frames. No event reports when the compositor has
 * applied the style, and adopting a gesture needlessly only costs smoothness,
 * while missing one leaves it dead.
 */
const SCROLL_RESTORE_SETTLE_FLOOR_MS = 120;

/** How long an open host sequence may go without any wheel activity before it is presumed lost. */
const HOST_SEQUENCE_STALL_MS = 2000;

export function createDocumentViewportWritePort(): IDocumentViewportWritePort {
    let documentRevision = 0;
    let interactionEpoch = 0;
    let sequence = 0;
    let activeIntent: IDocumentViewportIntentFence | null = null;
    const authorityWrites = new WeakMap<HTMLElement, {
        intentId: string;
        left: number;
        top: number;
    }>();
    // Intent is ordered by when the user expressed it, not by when its packets
    // arrive. A fling is expressed at finger lift, so a command issued during
    // its inertial tail is the newer intent even though tail packets keep
    // arriving after it. Wheel packets stop being cancelable after the first
    // of a sequence, so the tail cannot be swallowed; suppressing user
    // scrolling is the only way to stop it from displacing the command.
    const wheelGestures = createWheelGestureStream();
    const userScrollSuppressed = ref(false);
    // Ownership: packets of this gesture are residue of a superseded intent.
    // It ends when a packet of another gesture arrives, never on a timer. Late
    // delivery and sparse timestamps are both unbounded on a busy machine, and
    // a residue packet that outlived its ownership would cancel a command that
    // has not landed yet.
    let fencedGestureId: number | null = null;
    let fencedSequenceId: number | null = null;
    // A scroll sequence that begins while the viewport is not user-scrollable
    // is bound to nothing and stays dead until it ends. Restoring scrolling
    // inside its first event is already too late, because the compositor
    // judges the sequence against a copy that learns of the change a frame
    // later. That first event is cancelable, though, and preventing it keeps
    // the whole sequence cancelable, so the viewer scrolls this one by hand.
    let adoptedGestureId: number | null = null;
    // Restoring scrolling only changes a style. The compositor picks it up a
    // frame or more later, longer on a slow machine, and a sequence that begins
    // before then is as dead as one that began while suppressed.
    let scrollRestoreSettling = false;
    let scrollRestoreToken = 0;
    let residueReleaseTimer: ReturnType<typeof setTimeout> | null = null;
    // The host reports scroll sequence boundaries for the whole window, and the
    // packets define identity, so a boundary only ever annotates a sequence
    // this viewport saw start. Both streams are ordered, and a `begin` cannot
    // exist before the renderer has handled its sequence's first packet, so
    // the oldest unclaimed local start is the one a `begin` refers to. A
    // viewport with no unclaimed start claims nothing: a fling in a sidebar
    // or another pane is not a live gesture here.
    let hostReportsSequences = false;
    let hostOpenSequenceId: number | null = null;
    // A `begin` this viewport declined belongs to another scroller, and so
    // does the `end` that follows it. An `end` with no `begin` at all means
    // the viewport started listening mid-sequence.
    let declinedHostBegin = false;
    let endedThroughSequenceId = 0;
    const unclaimedSequenceStarts: Array<{
        sequenceId: number;
        packet: IWheelGesturePacket
    }> = [];
    let currentSequenceHasNonCancelable = false;
    // A local sequence joined by timing spans several browser sequences, so
    // the host's boundaries for its members are not the gesture's. Only
    // packet timing can speak for it.
    let currentSequenceJoinedByTiming = false;
    let lastWheelActivityAtMs = 0;

    function isHostSilentAbout(sequenceId: number) {
        return currentSequenceJoinedByTiming && sequenceId === wheelGestures.getSequenceId();
    }

    function isSequenceKnownEnded(sequenceId: number) {
        return hostReportsSequences
            && sequenceId <= endedThroughSequenceId
            && !isHostSilentAbout(sequenceId);
    }

    /**
     * Whether the host still has this sequence open. Packet timing cannot say:
     * the last packet of a live fling can be hundreds of milliseconds old. A
     * non-cancelable packet proves a native sequence before its `begin` has
     * arrived, for as long as that `begin` is still owed.
     */
    function isSequenceOpen(sequenceId: number) {
        if (!hostReportsSequences || sequenceId <= endedThroughSequenceId || isHostSilentAbout(sequenceId)) {
            return false;
        }
        return hostOpenSequenceId === sequenceId
            || (
                currentSequenceHasNonCancelable
                && sequenceId === wheelGestures.getSequenceId()
                && unclaimedSequenceStarts.some(start => start.sequenceId === sequenceId)
            );
    }

    function suppressUserScroll() {
        if (userScrollSuppressed.value) {
            return;
        }
        scrollRestoreToken += 1;
        scrollRestoreSettling = false;
        userScrollSuppressed.value = true;
    }

    function restoreUserScroll() {
        if (!userScrollSuppressed.value) {
            return;
        }
        userScrollSuppressed.value = false;
        scrollRestoreSettling = true;
        const token = ++scrollRestoreToken;
        const restoredAtMs = performance.now();
        const settle = () => {
            if (token === scrollRestoreToken) {
                scrollRestoreSettling = false;
            }
        };
        const settleAfterFloor = () => {
            const remainingMs = SCROLL_RESTORE_SETTLE_FLOOR_MS - (performance.now() - restoredAtMs);
            if (remainingMs > 0) {
                setTimeout(settle, remainingMs);
                return;
            }
            settle();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(settleAfterFloor));
            return;
        }
        setTimeout(settle, SCROLL_RESTORE_SETTLE_FLOOR_MS);
    }

    function clearResidueReleaseTimer() {
        if (residueReleaseTimer !== null) {
            clearTimeout(residueReleaseTimer);
            residueReleaseTimer = null;
        }
    }

    function releaseCommandFence() {
        clearResidueReleaseTimer();
        fencedGestureId = null;
        fencedSequenceId = null;
        restoreUserScroll();
    }

    /**
     * True while residue can still move the viewport, which is exactly while
     * user scrolling is suppressed. Once scrolling is back, a scroll is the
     * user's again even though ownership of late packets continues.
     */
    function isCommandResidueLive() {
        return fencedGestureId !== null
            && wheelGestures.getGestureId() === fencedGestureId
            && userScrollSuppressed.value;
    }

    /**
     * The idle timer only ever restores scrolling; it never ends ownership.
     * Where a host reports boundaries it defers to them, and the stall bound
     * merely keeps a lost `end` from leaving the viewport unscrollable. A
     * residue packet that arrives afterwards suppresses scrolling again.
     */
    function restoreUserScrollOnceGestureIdle() {
        clearResidueReleaseTimer();
        residueReleaseTimer = setTimeout(() => {
            residueReleaseTimer = null;
            if (
                fencedSequenceId !== null
                && isSequenceOpen(fencedSequenceId)
                && performance.now() - lastWheelActivityAtMs < HOST_SEQUENCE_STALL_MS
            ) {
                restoreUserScrollOnceGestureIdle();
                return;
            }
            restoreUserScroll();
        }, WHEEL_GESTURE_IDLE_MS);
    }

    function claimNextLocalSequence() {
        for (let start = unclaimedSequenceStarts.shift(); start; start = unclaimedSequenceStarts.shift()) {
            // A prevented sequence never reaches the host as a scroll sequence.
            if (start.packet.defaultPrevented !== true && start.sequenceId > endedThroughSequenceId) {
                return start.sequenceId;
            }
        }
        return null;
    }

    const observeUserInteraction = (container?: HTMLElement) => {
        interactionEpoch += 1;
        activeIntent = null;
        if (container) {
            authorityWrites.delete(container);
        }
    };

    return {
        beginIntent(intentId) {
            if (!intentId) {
                throw new Error('Viewport intents require an intentId');
            }
            activeIntent = Object.freeze({
                intentId,
                documentRevision,
                interactionEpoch,
                sequence: ++sequence,
            });
            return activeIntent;
        },
        apply(container, write) {
            if (
                write.intent !== activeIntent
                || write.intent.documentRevision !== documentRevision
                || write.intent.interactionEpoch !== interactionEpoch
            ) {
                return false;
            }
            // Register the expected coordinate before each DOM assignment.
            // Browsers can dispatch a scroll event while a setter is still on
            // the stack, before the assignment returns. The event must see
            // the same authority fence as the write that caused it.
            const targetLeft = resolveAuthoredOffset(
                write.left,
                container.scrollLeft,
                container.scrollWidth,
                container.clientWidth,
            );
            const targetTop = resolveAuthoredOffset(
                write.top,
                container.scrollTop,
                container.scrollHeight,
                container.clientHeight,
            );
            if (write.left !== undefined) {
                authorityWrites.set(container, {
                    intentId: write.intent.intentId,
                    left: targetLeft,
                    top: container.scrollTop,
                });
                container.scrollLeft = targetLeft;
            }
            if (write.top !== undefined) {
                authorityWrites.set(container, {
                    intentId: write.intent.intentId,
                    left: container.scrollLeft,
                    top: targetTop,
                });
                container.scrollTop = targetTop;
            }
            authorityWrites.set(container, {
                intentId: write.intent.intentId,
                left: container.scrollLeft,
                top: container.scrollTop,
            });
            return true;
        },
        advanceDocumentRevision() {
            documentRevision += 1;
            activeIntent = null;
            return documentRevision;
        },
        consumeAuthorityScroll(container) {
            const authored = authorityWrites.get(container);
            if (!authored) {
                return false;
            }
            if (authored.left !== container.scrollLeft || authored.top !== container.scrollTop) {
                if (isCommandResidueLive()) {
                    // A command that lands within a frame of its fence can be
                    // displaced by a residue delta the compositor applied
                    // before suppression reached it. Suppression stops any
                    // further one, so this restores the write at most twice.
                    container.scrollLeft = authored.left;
                    container.scrollTop = authored.top;
                    return true;
                }
                authorityWrites.delete(container);
                return false;
            }
            // A single DOM scroll write may produce multiple trusted scroll
            // events. Keep the origin fence while the browser remains at the
            // exact authored coordinates; a real user scroll diverges from
            // them and is rejected by the branch above.
            return true;
        },
        getInteractionEpoch: () => interactionEpoch,
        observeUserInteraction,
        observeUserScroll(container) {
            observeUserInteraction(container);
        },
        fenceCommandAgainstLiveGesture(nowMs = performance.now()) {
            if (!wheelGestures.hasPackets()) {
                return;
            }
            const sequenceId = wheelGestures.getSequenceId();
            // Command ordering does not depend on delivery latency. Even an
            // ended or apparently idle gesture may still have packets queued
            // in the renderer. Retain ownership of that gesture; only a new
            // gesture can supersede this command.
            const knownEnded = isSequenceKnownEnded(sequenceId);
            fencedGestureId = wheelGestures.getGestureId();
            fencedSequenceId = sequenceId;
            lastWheelActivityAtMs = performance.now();
            if (knownEnded || (!isSequenceOpen(sequenceId) && !wheelGestures.isLive(nowMs))) {
                // Liveness decides whether to suppress native scrolling now,
                // never whether queued packets may cancel the command. If an
                // unended tail arrives later, observeWheelPacket suppresses it.
                return;
            }
            suppressUserScroll();
            restoreUserScrollOnceGestureIdle();
        },
        observeWheelPacket(packet) {
            const nativeScrollUnavailable = userScrollSuppressed.value || scrollRestoreSettling;
            const previousGestureId = wheelGestures.getGestureId();
            const {
                gestureId,
                sequenceId,
                startsSequence,
                joinedByTiming,
            } = wheelGestures.observe(packet);
            lastWheelActivityAtMs = performance.now();
            currentSequenceJoinedByTiming ||= joinedByTiming;
            if (startsSequence) {
                currentSequenceHasNonCancelable = false;
                currentSequenceJoinedByTiming = false;
                if (packet.cancelable) {
                    // Only the previous and the current start can still be
                    // owed a `begin`; without a host the list would only grow.
                    unclaimedSequenceStarts.splice(0, Math.max(0, unclaimedSequenceStarts.length - 1));
                    unclaimedSequenceStarts.push({
                        sequenceId,
                        packet,
                    });
                }
            }
            if (!packet.cancelable) {
                currentSequenceHasNonCancelable = true;
            }
            if (fencedGestureId !== null) {
                if (gestureId === fencedGestureId) {
                    if (!isSequenceKnownEnded(sequenceId)) {
                        // The tail is evidently still going.
                        suppressUserScroll();
                        restoreUserScrollOnceGestureIdle();
                    }
                    return 'command-residue';
                }
                releaseCommandFence();
            }
            if (gestureId !== previousGestureId && nativeScrollUnavailable && packet.cancelable) {
                adoptedGestureId = gestureId;
            }
            // A non-cancelable packet belongs to a sequence Chromium scrolls
            // natively, so adopting it would scroll twice.
            return gestureId === adoptedGestureId && packet.cancelable
                ? 'adopted-user-input'
                : 'user-input';
        },
        observeWheelScrollSequence(boundary) {
            hostReportsSequences = true;
            lastWheelActivityAtMs = performance.now();
            if (boundary === 'begin') {
                hostOpenSequenceId = claimNextLocalSequence();
                declinedHostBegin = hostOpenSequenceId === null;
                return;
            }
            const currentSequenceId = wheelGestures.getSequenceId();
            const endedSequenceId = hostOpenSequenceId
                ?? (!declinedHostBegin && isSequenceOpen(currentSequenceId) ? currentSequenceId : null);
            hostOpenSequenceId = null;
            declinedHostBegin = false;
            if (endedSequenceId === null) {
                // Another scroller's sequence.
                return;
            }
            endedThroughSequenceId = Math.max(endedThroughSequenceId, endedSequenceId);
            if (fencedSequenceId === null || fencedSequenceId > endedThroughSequenceId) {
                return;
            }
            // The sequence is over, so nothing can displace the command any
            // more and scrolling can come back at once. Ownership stays: this
            // signal can overtake the gesture's last packets by however long
            // the main thread is busy, and they share the fenced gesture's id.
            clearResidueReleaseTimer();
            restoreUserScroll();
        },
        isCommandResidueLive,
        userScrollSuppressed: readonly(userScrollSuppressed),
    };
}

/**
 * The single verdict on who owns a wheel packet. Residue of a gesture that a
 * newer command superseded is not user interaction, so it must not advance the
 * interaction epoch that fences the command's pending authored write.
 */
export function observeDocumentViewportWheelInteraction(
    port: IDocumentViewportWritePort,
    interaction: {
        readonly intent: TDocumentWheelIntent;
        readonly deltaPx: number;
        readonly event: IWheelGesturePacket & { preventDefault(): void };
    },
    container?: HTMLElement,
): TDocumentWheelPacketOwner {
    // Zoom gestures need the layout lifecycle's anchor restore; bumping the
    // epoch on every streamed zoom tick would cancel that restore one frame
    // after it was captured.
    if (interaction.intent === 'zoom') {
        return 'user-input';
    }
    const owner = port.observeWheelPacket(interaction.event);
    if (owner === 'command-residue') {
        return owner;
    }
    port.observeUserInteraction(container);
    if (owner === 'adopted-user-input' && container) {
        // Deliberately not an authored write: this is the user scrolling, so
        // the scroll it causes must read as physical input downstream.
        interaction.event.preventDefault();
        container.scrollLeft += interaction.event.deltaX;
        container.scrollTop += interaction.deltaPx;
    }
    return owner;
}
