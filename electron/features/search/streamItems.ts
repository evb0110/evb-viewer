/**
 * Adapts a producer that emits items through a callback, such as a native
 * command parsing its stdout, into an async iterable. Leaving the iteration
 * early aborts the producer.
 */
export async function* streamItems<T>(
    produce: (emit: (item: T) => void, signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
): AsyncGenerator<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) {
        abort();
    }
    const items: T[] = [];
    const run = {
        settled: false,
        failure: null as Error | null,
    };
    let wake: (() => void) | null = null;
    const production = produce((item) => {
        items.push(item);
        wake?.();
    }, controller.signal).then(() => undefined, (error: unknown) => {
        run.failure = error instanceof Error ? error : new Error(String(error));
    }).finally(() => {
        run.settled = true;
        wake?.();
    });
    try {
        for (;;) {
            const item = items.shift();
            if (item !== undefined) {
                yield item;
                continue;
            }
            if (run.failure !== null) {
                throw run.failure;
            }
            if (run.settled) {
                return;
            }
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
            wake = null;
        }
    } finally {
        controller.abort();
        signal?.removeEventListener('abort', abort);
        await production;
    }
}
