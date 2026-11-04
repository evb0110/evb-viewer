export function runBrowserLock<T>(name: string, operation: () => Promise<T>, signal?: AbortSignal) {
    const locks = typeof navigator !== 'undefined'
        ? (navigator as Navigator & {locks?: {request<T>(name: string, options: {
            mode: 'exclusive';
            signal?: AbortSignal
        }, callback: () => Promise<T>): Promise<T>}}).locks
        : undefined;
    if (!locks) {
        return operation();
    }
    return locks.request(name, {
        mode: 'exclusive',
        ...(signal ? {signal} : {}),
    }, operation);
}
