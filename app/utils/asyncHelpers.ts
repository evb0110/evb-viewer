interface IWaitUntilIdleOptions {
    delayMs?: number;
    maxAttempts?: number;
}

interface IWaitForVisualFramesOptions {
    frames?: number;
    timeoutMs?: number;
    hiddenFallbackMs?: number;
}

export async function waitUntilIdle(
    isBusy: () => boolean,
    options: IWaitUntilIdleOptions = {},
) {
    const {
        delayMs = 25,
        maxAttempts = Number.POSITIVE_INFINITY,
    } = options;
    const normalizedDelayMs = Math.max(0, delayMs);
    const normalizedMaxAttempts = Math.max(0, Math.floor(maxAttempts));
    let attempts = 0;

    while (isBusy() && attempts < normalizedMaxAttempts) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, normalizedDelayMs);
        });
        attempts += 1;
    }

    return !isBusy();
}

export async function waitForVisualFrames(
    options: IWaitForVisualFramesOptions = {},
) {
    const {
        frames = 1,
        timeoutMs = 64,
        hiddenFallbackMs = 16,
    } = options;

    const normalizedFrames = Math.max(1, Math.floor(frames));
    const normalizedTimeoutMs = Math.max(1, timeoutMs);
    const normalizedHiddenFallbackMs = Math.max(1, hiddenFallbackMs);

    for (let index = 0; index < normalizedFrames; index += 1) {
        await new Promise<void>((resolve) => {
            const settleAfterDelay = (delayMs: number) => {
                setTimeout(resolve, delayMs);
            };

            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                settleAfterDelay(normalizedHiddenFallbackMs);
                return;
            }

            if (typeof document !== 'undefined' && document.hidden) {
                settleAfterDelay(normalizedHiddenFallbackMs);
                return;
            }

            let settled = false;
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                    timeoutHandle = null;
                }
                resolve();
            };

            timeoutHandle = setTimeout(finish, normalizedTimeoutMs);
            window.requestAnimationFrame(() => {
                finish();
            });
        });
    }
}
