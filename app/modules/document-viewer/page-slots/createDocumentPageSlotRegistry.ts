export interface IDocumentPageSlotOwner {
    readonly ownerId: string;
    isMounted(pageNumber: number): boolean;
    markMounted(pageNumber: number): void;
    markUnmounted(pageNumber: number): void;
    whenMounted(pageNumber: number, signal: AbortSignal): Promise<void>;
    cancelPending(): void;
    dispose(): void;
}

export interface IDocumentPageSlotRegistry extends IDocumentPageSlotOwner {createOwner(ownerId: string): IDocumentPageSlotOwner;}

interface IPageSlotWaiter {
    reject: (reason: DOMException) => void;
    resolve: () => void;
    signal: AbortSignal;
    onAbort: () => void;
}

function abortedError() {
    return new DOMException('Page-slot wait aborted', 'AbortError');
}

/** Owner-scoped registry: stale feature-pack cleanup cannot touch its successor. */
export function createDocumentPageSlotRegistry(): IDocumentPageSlotRegistry {
    const mountedByOwner = new Map<string, Set<number>>();
    const waitersByOwner = new Map<string, Map<number, Set<IPageSlotWaiter>>>();

    function createOwner(ownerId: string): IDocumentPageSlotOwner {
        if (!ownerId) throw new TypeError('Page-slot owners require an id');
        const mountedPages = mountedByOwner.get(ownerId) ?? new Set<number>();
        mountedByOwner.set(ownerId, mountedPages);
        const waiters = waitersByOwner.get(ownerId) ?? new Map<number, Set<IPageSlotWaiter>>();
        waitersByOwner.set(ownerId, waiters);
        let disposed = false;

        function detach(pageNumber: number, waiter: IPageSlotWaiter) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            const pageWaiters = waiters.get(pageNumber);
            pageWaiters?.delete(waiter);
            if (pageWaiters?.size === 0) waiters.delete(pageNumber);
        }

        function cancelPending() {
            for (const [
                pageNumber,
                pageWaiters,
            ] of waiters) {
                for (const waiter of [...pageWaiters]) {
                    detach(pageNumber, waiter);
                    waiter.reject(abortedError());
                }
            }
        }

        return {
            ownerId,
            isMounted: pageNumber => !disposed && mountedPages.has(pageNumber),
            markMounted(pageNumber) {
                if (disposed) {
                    return;
                }
                mountedPages.add(pageNumber);
                const pageWaiters = waiters.get(pageNumber);
                if (!pageWaiters) {
                    return;
                }
                for (const waiter of [...pageWaiters]) {
                    detach(pageNumber, waiter);
                    waiter.resolve();
                }
            },
            markUnmounted(pageNumber) {
                if (!disposed) mountedPages.delete(pageNumber);
            },
            whenMounted(pageNumber, signal) {
                if (disposed || signal.aborted) {
                    return Promise.reject(abortedError());
                }
                if (mountedPages.has(pageNumber)) {
                    return Promise.resolve();
                }
                return new Promise<void>((resolve, reject) => {
                    const pageWaiters = waiters.get(pageNumber) ?? new Set<IPageSlotWaiter>();
                    const waiter: IPageSlotWaiter = {
                        reject,
                        resolve,
                        signal,
                        onAbort: () => {
                            detach(pageNumber, waiter);
                            reject(abortedError());
                        },
                    };
                    pageWaiters.add(waiter);
                    waiters.set(pageNumber, pageWaiters);
                    signal.addEventListener('abort', waiter.onAbort, {once: true});
                });
            },
            cancelPending,
            dispose() {
                if (disposed) {
                    return;
                }
                cancelPending();
                disposed = true;
                mountedPages.clear();
                mountedByOwner.delete(ownerId);
                waitersByOwner.delete(ownerId);
            },
        };
    }

    const root = createOwner('registry-root');
    return {
        ...root,
        createOwner,
    };
}
