export async function waitForCondition(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
    throw lastError;
}

/**
 * Resolves when the product's own completion state reports done. It has no
 * deadline of its own, so a slow host cannot fail it early; a stuck job is
 * still bounded by the test timeout.
 */
export async function waitUntilDone(isDone: () => boolean) {
    while (!isDone()) {
        await new Promise<void>(resolve => setTimeout(resolve, 1));
    }
}
