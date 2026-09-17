import type {
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type {MaybeRefOrGetter} from 'vue';
import {
    commitScanCleanupPreviewPresentationSettle,
    resetScanCleanupPreviewPresentationSettle,
    resolveScanCleanupPreviewPresentationCommit,
    type IScanCleanupPreviewPresentationPin,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentationPin';

interface IScanCleanupDisplayedCleanedFrame<TPresentation> {
    presentation: TPresentation;
    result: IScanCleanupPreviewResult;
    transitionKey: string;
}

interface IScanCleanupPendingCleanedFrame<TPresentation> {
    kind: 'forced' | 'initial' | 'provisional' | 'settled';
    presentation: TPresentation;
    result: IScanCleanupPreviewResult;
    transitionKey: string;
}

export type TScanCleanupPreviewFrameRevealOutcome = 'published' | 'dropped';

interface IScanCleanupDisplayedFrameWaiter {
    abort?: () => void;
    resolve: (outcome: TScanCleanupPreviewFrameRevealOutcome) => void;
    result: IScanCleanupPreviewResult;
    signal?: AbortSignal;
}

export interface IScanCleanupPreviewImageSwap {
    currentUrl: string;
    entering: boolean;
    incomingUrl: string;
    outgoingUrl: string;
}

export function createPreviewImageSwap(currentUrl = ''): IScanCleanupPreviewImageSwap {
    return {
        currentUrl,
        entering: false,
        incomingUrl: '',
        outgoingUrl: '',
    };
}

export function queuePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
): IScanCleanupPreviewImageSwap {
    if (!state.currentUrl) {
        return createPreviewImageSwap(url);
    }
    if (state.incomingUrl) revoke(state.incomingUrl);
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return {
        currentUrl: state.currentUrl,
        entering: false,
        incomingUrl: url,
        outgoingUrl: '',
    };
}

export function loadPreviewImageSwap(state: IScanCleanupPreviewImageSwap, url: string) {
    if (state.incomingUrl !== url) {
        return state;
    }
    return {
        currentUrl: url,
        entering: true,
        incomingUrl: '',
        outgoingUrl: state.currentUrl,
    };
}

export function completePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
) {
    if (!state.entering || state.currentUrl !== url) {
        return state;
    }
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return createPreviewImageSwap(state.currentUrl);
}

function disposePreviewImageSwap(state: IScanCleanupPreviewImageSwap, revoke: (url: string) => void) {
    for (const url of new Set([
        state.currentUrl,
        state.incomingUrl,
        state.outgoingUrl,
    ])) {
        if (url) revoke(url);
    }
}

function pngUrl(bytes: Uint8Array) {
    // Blob already copies what it is handed, so the page-sized copy that used
    // to be made first was pure waste. The branch narrows rather than copies:
    // bytes off the IPC boundary are always ArrayBuffer-backed, and the view
    // shares them.
    const view = bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([view], {type: 'image/png'}));
}

export const useScanCleanupPreviewImages = <TPresentation = undefined>(
    result: MaybeRefOrGetter<IScanCleanupPreviewResult | null>,
    onImagesChanged?: (hadPreviousResult: boolean) => void,
    rawResult: MaybeRefOrGetter<IScanCleanupRawPreviewResult | null> = result,
    detailResult: MaybeRefOrGetter<IScanCleanupPreviewResult | null> = () => null,
    captureFramePresentation: () => TPresentation = () => undefined as TPresentation,
    presentationTransitionKey?: MaybeRefOrGetter<string>,
    frameIsSettled: (presentation: TPresentation) => boolean = () => true,
) => {
    const rawPixelSwap = ref(createPreviewImageSwap());
    const cleanedPixelSwaps = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewImageSwap>>>({});
    const displayedCleanedFrame = shallowRef<IScanCleanupDisplayedCleanedFrame<TPresentation> | null>(null);
    const displayedCleanedFrameCurrent = computed(() => {
        const liveResult = toRaw(toValue(result));
        return liveResult !== null && displayedCleanedFrame.value?.result === liveResult;
    });
    const cleanedFrameError = ref('');
    const pendingCleanedPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    const detailPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    let pendingCleanedFrame: IScanCleanupPendingCleanedFrame<TPresentation> | null = null;
    let presentationPin: IScanCleanupPreviewPresentationPin | null = null;
    let unscopedFrameGeneration = 0;
    const loadedPendingCleanedUrls = new Set<string>();
    const displayedFrameWaiters: IScanCleanupDisplayedFrameWaiter[] = [];

    function revokeBlobUrl(url: string) {
        URL.revokeObjectURL(url);
    }

    function revokeUrls() {
        disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
        rawPixelSwap.value = createPreviewImageSwap();
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
        clearPendingCleanedFrame();
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = detailPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(detailPixelUrls, half);
        }
        for (const waiter of displayedFrameWaiters.splice(0)) {
            if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
            waiter.resolve('dropped');
        }
    }

    function loadRawPixelSwap(url: string) {
        rawPixelSwap.value = loadPreviewImageSwap(rawPixelSwap.value, url);
    }

    function completeRawPixelSwap(url: string) {
        rawPixelSwap.value = completePreviewImageSwap(rawPixelSwap.value, url, revokeBlobUrl);
    }

    function loadCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        if (pendingCleanedPixelUrls[half] !== url || pendingCleanedFrame === null) {
            return;
        }
        loadedPendingCleanedUrls.add(url);
        if (pendingCleanedFrame.result.outputs.every(output => {
            const pendingUrl = pendingCleanedPixelUrls[output.metadata.half];
            return pendingUrl !== undefined && loadedPendingCleanedUrls.has(pendingUrl);
        })) {
            commitPendingCleanedFrame();
        }
    }

    function completeCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        const state = cleanedPixelSwaps[half];
        if (state) cleanedPixelSwaps[half] = completePreviewImageSwap(state, url, revokeBlobUrl);
    }

    function failCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        if (pendingCleanedPixelUrls[half] !== url || pendingCleanedFrame === null) {
            return;
        }
        const failedFrame = pendingCleanedFrame;
        clearPendingCleanedFrame();
        if (
            failedFrame.kind === 'settled'
            && presentationPin?.transitionKey === failedFrame.transitionKey
        ) {
            presentationPin = resetScanCleanupPreviewPresentationSettle(presentationPin);
        }
        cleanedFrameError.value = 'Failed to decode the cleaned preview image.';
    }

    function clearPendingCleanedFrame() {
        const droppedFrame = pendingCleanedFrame;
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        loadedPendingCleanedUrls.clear();
        pendingCleanedFrame = null;
        if (droppedFrame) resolveDisplayedFrameWaiters(droppedFrame.result, 'dropped');
    }

    function pendingFrameLoaded() {
        return pendingCleanedFrame?.result.outputs.every(output => {
            const pendingUrl = pendingCleanedPixelUrls[output.metadata.half];
            return pendingUrl !== undefined && loadedPendingCleanedUrls.has(pendingUrl);
        }) ?? false;
    }

    function pendingFrameCanCommit() {
        return pendingCleanedFrame?.kind !== 'provisional';
    }

    function resolveDisplayedFrameWaiters(
        result: IScanCleanupPreviewResult,
        outcome: TScanCleanupPreviewFrameRevealOutcome,
    ) {
        for (let index = displayedFrameWaiters.length - 1; index >= 0; index -= 1) {
            const waiter = displayedFrameWaiters[index];
            if (waiter?.result !== result) continue;
            displayedFrameWaiters.splice(index, 1);
            if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
            waiter.resolve(outcome);
        }
    }

    function publishCleanedFrame(nextFrame: IScanCleanupPendingCleanedFrame<TPresentation>) {
        const nextResult = nextFrame.result;
        const hadPreviousResult = displayedCleanedFrame.value !== null;
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            const pendingUrl = pendingCleanedPixelUrls[half];
            cleanedPixelSwaps[half] = createPreviewImageSwap(
                pendingUrl ?? pngUrl(output.imageData),
            );
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        displayedCleanedFrame.value = {
            presentation: nextFrame.presentation,
            result: nextResult,
            transitionKey: nextFrame.transitionKey,
        };
        if (
            nextFrame.kind === 'settled'
            && presentationPin?.transitionKey === nextFrame.transitionKey
        ) {
            presentationPin = commitScanCleanupPreviewPresentationSettle(presentationPin);
        }
        loadedPendingCleanedUrls.clear();
        pendingCleanedFrame = null;
        resolveDisplayedFrameWaiters(nextResult, 'published');
        onImagesChanged?.(hadPreviousResult);
    }

    function commitPendingCleanedFrame() {
        const nextFrame = pendingCleanedFrame;
        if (nextFrame && pendingFrameCanCommit() && pendingFrameLoaded()) {
            publishCleanedFrame(nextFrame);
        }
    }

    function queueCleanedFrame(nextResult: IScanCleanupPreviewResult, transitionKey: string) {
        const presentation = captureFramePresentation();
        const settled = frameIsSettled(presentation);
        // Decide before allocating any blob URLs. Once a key is pinned, later
        // generations are terminally rejected and never enter image preload.
        const decision = resolveScanCleanupPreviewPresentationCommit(
            presentationPin,
            transitionKey,
            settled,
        );
        presentationPin = decision.pin;
        if (decision.action === 'reject') {
            return;
        }
        cleanedFrameError.value = '';
        const supersedesUncommittedInitial = decision.action === 'coalesce'
            && pendingCleanedFrame?.kind === 'initial'
            && pendingCleanedFrame.transitionKey === transitionKey;
        clearPendingCleanedFrame();
        const nextFrame = {
            kind: supersedesUncommittedInitial
                ? 'initial'
                : decision.action === 'coalesce'
                    ? 'provisional'
                    : settled
                        ? 'settled'
                        : 'initial',
            presentation,
            result: nextResult,
            transitionKey,
        } satisfies IScanCleanupPendingCleanedFrame<TPresentation>;
        if (!displayedCleanedFrame.value) {
            publishCleanedFrame(nextFrame);
            return;
        }
        pendingCleanedFrame = nextFrame;
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            pendingCleanedPixelUrls[half] = pngUrl(output.imageData);
        }
        if (nextResult.outputs.length === 0) {
            if (pendingFrameCanCommit()) publishCleanedFrame(nextFrame);
        }
    }

    function revealLatestFrame(signal?: AbortSignal): Promise<TScanCleanupPreviewFrameRevealOutcome> {
        const latestResult = toRaw(toValue(result));
        if (
            !latestResult
            || latestResult === displayedCleanedFrame.value?.result
        ) {
            return Promise.resolve('published');
        }
        if (signal?.aborted) {
            return Promise.resolve('dropped');
        }
        const transitionKey = presentationTransitionKey === undefined
            ? `run-reveal:${String(++unscopedFrameGeneration)}`
            : toValue(presentationTransitionKey);
        clearPendingCleanedFrame();
        presentationPin = {
            settledResultState: 'committed',
            transitionKey,
        };
        cleanedFrameError.value = '';
        const nextFrame = {
            kind: 'forced',
            presentation: captureFramePresentation(),
            result: latestResult,
            transitionKey,
        } satisfies IScanCleanupPendingCleanedFrame<TPresentation>;
        let waiter: IScanCleanupDisplayedFrameWaiter;
        const revealed = new Promise<TScanCleanupPreviewFrameRevealOutcome>(resolve => {
            waiter = {
                resolve,
                result: latestResult,
                ...(signal === undefined ? {} : {signal}),
            };
            waiter.abort = () => {
                const index = displayedFrameWaiters.indexOf(waiter);
                if (index < 0) return;
                displayedFrameWaiters.splice(index, 1);
                if (pendingCleanedFrame?.result === latestResult) clearPendingCleanedFrame();
                resolve('dropped');
            };
            displayedFrameWaiters.push(waiter);
            signal?.addEventListener('abort', waiter.abort, {once: true});
        });
        pendingCleanedFrame = nextFrame;
        for (const output of latestResult.outputs) {
            pendingCleanedPixelUrls[output.metadata.half] = pngUrl(output.imageData);
        }
        if (latestResult.outputs.length === 0) publishCleanedFrame(nextFrame);
        return revealed;
    }

    watch(() => toValue(rawResult), (nextResult) => {
        if (!nextResult) {
            disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
            rawPixelSwap.value = createPreviewImageSwap();
            return;
        }
        rawPixelSwap.value = queuePreviewImageSwap(rawPixelSwap.value, pngUrl(nextResult.rawImageData), revokeBlobUrl);
    }, {immediate: true});

    watch([
        () => toRaw(toValue(result)),
        () => presentationTransitionKey === undefined ? null : toValue(presentationTransitionKey),
    ], ([
        nextResult,
        scopedTransitionKey,
    ]) => {
        if (!nextResult) {
            clearPendingCleanedFrame();
            for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
                const state = cleanedPixelSwaps[half];
                if (state) disposePreviewImageSwap(state, revokeBlobUrl);
                Reflect.deleteProperty(cleanedPixelSwaps, half);
            }
            displayedCleanedFrame.value = null;
            presentationPin = null;
            cleanedFrameError.value = '';
            return;
        }
        queueCleanedFrame(
            nextResult,
            scopedTransitionKey ?? `unscoped:${String(++unscopedFrameGeneration)}`,
        );
    }, {immediate: true});

    watch(() => toValue(detailResult), (nextResult) => {
        const activeHalves = new Set<TScanCleanupOutputHalf>();
        for (const output of nextResult?.outputs ?? []) {
            const half = output.metadata.half;
            activeHalves.add(half);
            const previous = detailPixelUrls[half];
            if (previous) revokeBlobUrl(previous);
            detailPixelUrls[half] = pngUrl(output.imageData);
        }
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            if (!activeHalves.has(half)) {
                const url = detailPixelUrls[half];
                if (url) revokeBlobUrl(url);
                Reflect.deleteProperty(detailPixelUrls, half);
            }
        }
    }, {immediate: true});

    onBeforeUnmount(revokeUrls);

    return {
        cleanedPixelSwaps,
        cleanedFrameError,
        completeCleanedPixelSwap,
        completeRawPixelSwap,
        detailPixelUrls,
        displayedCleanedFrame,
        displayedCleanedFrameCurrent,
        failCleanedPixelSwap,
        loadCleanedPixelSwap,
        loadRawPixelSwap,
        pendingCleanedPixelUrls,
        rawPixelSwap,
        revealLatestFrame,
    };
};
