export interface IPdfVisualSnapshotReleaseOptions {
    maxDelayMs?: number;
    minFrames?: number;
    waitFor?: () => boolean;
}

export type TPdfVisualSnapshotReleaseCancellation = () => void;

function normalizeMaxDelayMs(maxDelayMs: number | undefined) {
    if (
        typeof maxDelayMs !== 'number'
        || !Number.isFinite(maxDelayMs)
        || maxDelayMs <= 0
    ) {
        return 0;
    }
    return maxDelayMs;
}

function normalizeMinFrames(minFrames: number | undefined) {
    if (
        typeof minFrames !== 'number'
        || !Number.isFinite(minFrames)
        || minFrames < 1
    ) {
        return 1;
    }
    return Math.ceil(minFrames);
}

export function schedulePdfVisualSnapshotRelease(
    release: (() => void) | null | undefined,
    options: IPdfVisualSnapshotReleaseOptions = {},
): TPdfVisualSnapshotReleaseCancellation {
    if (!release) {
        return () => {};
    }
    const releaseSnapshot = release;

    const maxDelayMs = normalizeMaxDelayMs(options.maxDelayMs);
    const minFrames = normalizeMinFrames(options.minFrames);
    const startTime = Date.now();
    let frameCount = 0;
    let frameId: number | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function stop() {
        settled = true;
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
            frameId = null;
        }
        if (deadlineTimer !== null) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
        }
    }

    function complete() {
        if (settled) {
            return;
        }
        stop();
        releaseSnapshot();
    }

    function cancel() {
        if (settled) {
            return;
        }
        stop();
    }

    function shouldRelease() {
        frameCount += 1;
        if (frameCount < minFrames) {
            return false;
        }
        if (!options.waitFor || options.waitFor()) {
            return true;
        }
        return Date.now() - startTime >= maxDelayMs;
    }

    if (
        typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function'
    ) {
        const tick = () => {
            frameId = null;
            if (settled) {
                return;
            }
            if (shouldRelease()) {
                complete();
                return;
            }
            frameId = window.requestAnimationFrame(tick);
        };
        frameId = window.requestAnimationFrame(tick);
        if (maxDelayMs > 0) {
            // The deadline inside the loop only fires when a frame is served.
            // A backgrounded tab stops serving them, so without a wall-clock
            // timer the snapshot would be held until the tab is looked at again.
            deadlineTimer = setTimeout(complete, maxDelayMs);
        }
        return cancel;
    }

    deadlineTimer = setTimeout(complete, 0);
    return cancel;
}
