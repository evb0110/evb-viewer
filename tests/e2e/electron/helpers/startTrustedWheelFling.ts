import type {
    CDPSession,
    Page,
} from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';

// macOS keeps delivering wheel events for one to three seconds after the
// fingers leave the trackpad, with deltas that decay towards zero, and it
// latches those momentum events to the element that owned the gesture. This
// helper reproduces that shape with trusted CDP input so a test can keep the
// burst running while it delivers a real click somewhere else.

export interface ITrustedWheelFlingOptions {
    /** Latched gesture point. Momentum events keep this point for the whole burst. */
    x: number;
    y: number;
    /** Wheel delta of the first event, in CSS pixels. */
    initialDeltaY: number;
    /** Wheel delta of the last event. The burst decays exponentially towards it. */
    finalDeltaY: number;
    durationMs: number;
    /** Event period. The default imitates the 60 Hz macOS momentum cadence. */
    intervalMs?: number;
}

export interface ITrustedWheelFlingRun {
    /** Wall-clock start of the burst, so samples can be aligned to it. */
    startedAt: number;
    /** Resolves with the number of dispatched wheel events once the burst ends. */
    finished: Promise<number>;
    stop: () => void;
}

const DEFAULT_INTERVAL_MS = 16;

function resolveDecayPerMs(options: ITrustedWheelFlingOptions) {
    if (options.finalDeltaY <= 0 || options.initialDeltaY < options.finalDeltaY) {
        throw new Error('A wheel burst needs initialDeltaY at least a positive finalDeltaY');
    }
    return Math.log(options.initialDeltaY / options.finalDeltaY) / options.durationMs;
}

async function detachQuietly(client: CDPSession) {
    try {
        await client.detach();
    } catch {
        // The renderer target can go away first; the burst is already over.
    }
}

/**
 * Starts a decaying wheel burst and returns immediately, so the caller can
 * deliver other trusted input while the burst is still running.
 */
export async function startTrustedWheelFling(
    page: Page,
    options: ITrustedWheelFlingOptions,
): Promise<ITrustedWheelFlingRun> {
    // A dedicated CDP session keeps the burst off the page's own input queue,
    // so a concurrent page.mouse.click is not serialized behind it.
    const client = await page.createCDPSession();
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const decayPerMs = resolveDecayPerMs(options);
    const startedAt = Date.now();
    let stopped = false;

    const finished = (async () => {
        let dispatched = 0;
        try {
            for (let tick = 0; !stopped; tick += 1) {
                const elapsedMs = tick * intervalMs;
                if (elapsedMs >= options.durationMs) {
                    break;
                }
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: options.x,
                    y: options.y,
                    deltaX: 0,
                    deltaY: options.initialDeltaY * Math.exp(-decayPerMs * elapsedMs),
                    pointerType: 'mouse',
                });
                dispatched += 1;
                const remainingMs = startedAt + ((tick + 1) * intervalMs) - Date.now();
                if (remainingMs > 0) {
                    await delay(remainingMs);
                }
            }
        } finally {
            await detachQuietly(client);
        }
        return dispatched;
    })();

    return {
        startedAt,
        finished,
        stop: () => {
            stopped = true;
        },
    };
}
