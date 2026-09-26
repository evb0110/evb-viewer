/** Runs operations that share a key one after another, in call order. */
export function createKeyedSerialQueue() {
    const tails = new Map<string, Promise<void>>();
    return function runSerially<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
        const result = (tails.get(key) ?? Promise.resolve()).then(operation, operation);
        const tail = result.then(() => undefined, () => undefined);
        tails.set(key, tail);
        void tail.then(() => {
            if (tails.get(key) === tail) {
                tails.delete(key);
            }
        });
        return result;
    };
}
