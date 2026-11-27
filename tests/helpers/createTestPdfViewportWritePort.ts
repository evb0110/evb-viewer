import {
    readonly,
    ref,
    shallowRef,
} from 'vue';
import type {
    IPdfViewportWrite,
    IPdfViewportWritePort,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportWritePort';

export function createTestPdfViewportWritePort() {
    const writes: IPdfViewportWrite[] = [];
    let interactionEpoch = 0;
    const interactionEpochSignal = shallowRef(0);
    let sequence = 0;
    const commandFences: number[] = [];
    const userScrollSuppressed = ref(false);
    let commandResidueLive = false;
    // Like the real port, a scroll the user made is reader input.
    function observeUserInteraction() {
        interactionEpoch += 1;
        interactionEpochSignal.value = interactionEpoch;
    }
    const port: IPdfViewportWritePort = {
        beginIntent(intentId) {
            return {
                intentId,
                source: null,
                interactionEpoch,
                sequence: ++sequence,
            };
        },
        apply(container, write) {
            writes.push(write);
            if (write.left !== undefined) {container.scrollLeft = write.left;}
            if (write.top !== undefined) {container.scrollTop = write.top;}
            return true;
        },
        consumeAuthorityScroll: () => false,
        getInteractionEpoch: () => interactionEpoch,
        interactionEpochSignal: readonly(interactionEpochSignal),
        observeUserInteraction,
        observeUserScroll: observeUserInteraction,
        observeZoomPacket: () => {},
        fenceCommandAgainstLiveGesture: () => {
            commandFences.push(++sequence);
        },
        observeWheelPacket: () => commandResidueLive ? 'command-residue' : 'user-input',
        isCommandResidueLive: () => commandResidueLive,
        observeWheelScrollSequence: () => {},
        userScrollSuppressed,
        retire: () => {},
    };
    return {
        port,
        writes,
        commandFences,
        setCommandResidueLive(live: boolean) {
            commandResidueLive = live;
        },
    };
}
