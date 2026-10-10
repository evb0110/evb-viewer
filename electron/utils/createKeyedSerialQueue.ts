/**
 * Runs operations that share a key one after another, in call order.
 * `isIdle(key)` tells whether nothing for that key is running or waiting.
 */
export function createKeyedSerialQueue() {
    const tails = new Map<string, Promise<void>>();
    return Object.assign(function runSerially<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
        const result = (tails.get(key) ?? Promise.resolve()).then(operation, operation);
        const tail = result.then(() => undefined, () => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) {
                tails.delete(key);
            }
        });
        return result;
    }, {isIdle: (key: string) => !tails.has(key)});
}
