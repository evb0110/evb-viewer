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

export interface IScanCleanupPreviewImageSwap {
    currentUrl: string;
    entering: boolean;
    incomingUrl: string;
    outgoingUrl: string;
}

// The CSS crossfade is 150 ms today. Keep URL retirement bounded even when a
// browser skips transition events, for example when reduced motion disables
// the transition.
export const SCAN_CLEANUP_PREVIEW_IMAGE_SWAP_FALLBACK_MS = 250;

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
    let rawPixelSwapCompletionTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanedPixelSwapCompletionTimers = new Map<
        TScanCleanupOutputHalf,
        ReturnType<typeof setTimeout>
    >();
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
    const displayedFrameWaiters: Array<{
        resolve: () => void;
        result: IScanCleanupPreviewResult;
    }> = [];

    function revokeBlobUrl(url: string) {
        URL.revokeObjectURL(url);
    }

    function clearRawPixelSwapCompletionTimer() {
        if (rawPixelSwapCompletionTimer !== null) clearTimeout(rawPixelSwapCompletionTimer);
        rawPixelSwapCompletionTimer = null;
    }

    function clearCleanedPixelSwapCompletionTimer(half: TScanCleanupOutputHalf) {
        const timer = cleanedPixelSwapCompletionTimers.get(half);
        if (timer !== undefined) clearTimeout(timer);
        cleanedPixelSwapCompletionTimers.delete(half);
    }

    function scheduleRawPixelSwapCompletion(url: string) {
        clearRawPixelSwapCompletionTimer();
        if (!rawPixelSwap.value.entering || rawPixelSwap.value.currentUrl !== url) return;
        rawPixelSwapCompletionTimer = setTimeout(() => {
            rawPixelSwapCompletionTimer = null;
            completeRawPixelSwap(url);
        }, SCAN_CLEANUP_PREVIEW_IMAGE_SWAP_FALLBACK_MS);
    }

    function scheduleCleanedPixelSwapCompletion(half: TScanCleanupOutputHalf, url: string) {
        clearCleanedPixelSwapCompletionTimer(half);
        const state = cleanedPixelSwaps[half];
        if (!state?.entering || state.currentUrl !== url) return;
        cleanedPixelSwapCompletionTimers.set(half, setTimeout(() => {
            cleanedPixelSwapCompletionTimers.delete(half);
            completeCleanedPixelSwap(half, url);
        }, SCAN_CLEANUP_PREVIEW_IMAGE_SWAP_FALLBACK_MS));
    }

    function revokeUrls() {
        clearRawPixelSwapCompletionTimer();
        for (const half of cleanedPixelSwapCompletionTimers.keys()) {
            clearCleanedPixelSwapCompletionTimer(half);
        }
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
        for (const waiter of displayedFrameWaiters.splice(0)) waiter.resolve();
    }

    function loadRawPixelSwap(url: string) {
        rawPixelSwap.value = loadPreviewImageSwap(rawPixelSwap.value, url);
        scheduleRawPixelSwapCompletion(url);
    }

    function completeRawPixelSwap(url: string) {
        clearRawPixelSwapCompletionTimer();
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
        scheduleCleanedPixelSwapCompletion(half, url);
    }

    function completeCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        clearCleanedPixelSwapCompletionTimer(half);
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
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        loadedPendingCleanedUrls.clear();
        pendingCleanedFrame = null;
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

    function resolveDisplayedFrameWaiters(result: IScanCleanupPreviewResult) {
        for (let index = displayedFrameWaiters.length - 1; index >= 0; index -= 1) {
            const waiter = displayedFrameWaiters[index];
            if (waiter?.result !== result) continue;
            displayedFrameWaiters.splice(index, 1);
            waiter.resolve();
        }
    }

    function publishCleanedFrame(nextFrame: IScanCleanupPendingCleanedFrame<TPresentation>) {
        const nextResult = nextFrame.result;
        const hadPreviousResult = displayedCleanedFrame.value !== null;
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            clearCleanedPixelSwapCompletionTimer(half);
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
        resolveDisplayedFrameWaiters(nextResult);
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

    function revealLatestFrame() {
        const latestResult = toRaw(toValue(result));
        if (
            !latestResult
            || latestResult === displayedCleanedFrame.value?.result
        ) {
            return Promise.resolve();
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
        const revealed = new Promise<void>(resolve => displayedFrameWaiters.push({
            resolve,
            result: latestResult,
        }));
        pendingCleanedFrame = nextFrame;
        for (const output of latestResult.outputs) {
            pendingCleanedPixelUrls[output.metadata.half] = pngUrl(output.imageData);
        }
        if (latestResult.outputs.length === 0) publishCleanedFrame(nextFrame);
        return revealed;
    }

    watch(() => toValue(rawResult), (nextResult) => {
        if (!nextResult) {
            clearRawPixelSwapCompletionTimer();
            disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
            rawPixelSwap.value = createPreviewImageSwap();
            return;
        }
        clearRawPixelSwapCompletionTimer();
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
                clearCleanedPixelSwapCompletionTimer(half);
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
