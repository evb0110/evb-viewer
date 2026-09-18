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
    isCommandResidueLive(nowMs?: number): boolean;
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
    let fencedGestureId: number | null = null;
    // A scroll sequence that begins while the viewport is not user-scrollable
    // is bound to nothing and stays dead until it ends. Restoring scrolling
    // inside its first event is already too late, because the compositor
    // judges the sequence against a copy that learns of the change a frame
    // later. That first event is cancelable, though, and preventing it keeps
    // the whole sequence cancelable, so the viewer scrolls this one by hand.
    let adoptedGestureId: number | null = null;
    let residueReleaseTimer: ReturnType<typeof setTimeout> | null = null;

    function releaseCommandFence() {
        if (residueReleaseTimer !== null) {
            clearTimeout(residueReleaseTimer);
            residueReleaseTimer = null;
        }
        fencedGestureId = null;
        userScrollSuppressed.value = false;
    }

    function isCommandResidueLive(nowMs = performance.now()) {
        return fencedGestureId !== null
            && wheelGestures.getGestureId() === fencedGestureId
            && wheelGestures.isLive(nowMs);
    }

    function holdCommandFenceUntilGestureIdle() {
        if (residueReleaseTimer !== null) {
            clearTimeout(residueReleaseTimer);
        }
        residueReleaseTimer = setTimeout(releaseCommandFence, WHEEL_GESTURE_IDLE_MS);
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
            if (!wheelGestures.isLive(nowMs)) {
                return;
            }
            fencedGestureId = wheelGestures.getGestureId();
            userScrollSuppressed.value = true;
            holdCommandFenceUntilGestureIdle();
        },
        observeWheelPacket(packet) {
            const beganWhileSuppressed = userScrollSuppressed.value;
            const gestureId = wheelGestures.observe(packet);
            if (fencedGestureId !== null) {
                if (gestureId === fencedGestureId) {
                    holdCommandFenceUntilGestureIdle();
                    return 'command-residue';
                }
                releaseCommandFence();
                if (beganWhileSuppressed && packet.cancelable) {
                    adoptedGestureId = gestureId;
                }
            }
            // A non-cancelable packet belongs to a sequence Chromium scrolls
            // natively, so adopting it would scroll twice.
            return gestureId === adoptedGestureId && packet.cancelable
                ? 'adopted-user-input'
                : 'user-input';
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
