export interface IDocumentPageSlotOwner {
    readonly ownerId: string;
    isMounted(pageNumber: number): boolean;
    markMounted(pageNumber: number): void;
    markUnmounted(pageNumber: number): void;
    dispose(): void;
}

export interface IDocumentPageSlotRegistry extends IDocumentPageSlotOwner {createOwner(ownerId: string): IDocumentPageSlotOwner;}

/** Owner-scoped registry: stale feature-pack cleanup cannot touch its successor. */
export function createDocumentPageSlotRegistry(): IDocumentPageSlotRegistry {
    const mountedByOwner = new Map<string, Set<number>>();

    function createOwner(ownerId: string): IDocumentPageSlotOwner {
        if (!ownerId) throw new TypeError('Page-slot owners require an id');
        const mountedPages = mountedByOwner.get(ownerId) ?? new Set<number>();
        mountedByOwner.set(ownerId, mountedPages);
        let disposed = false;

        return {
            ownerId,
            isMounted: pageNumber => !disposed && mountedPages.has(pageNumber),
            markMounted(pageNumber) {
                if (!disposed) mountedPages.add(pageNumber);
            },
            markUnmounted(pageNumber) {
                if (!disposed) mountedPages.delete(pageNumber);
            },
            dispose() {
                if (disposed) {
                    return;
                }
                disposed = true;
                mountedPages.clear();
                mountedByOwner.delete(ownerId);
            },
        };
    }

    const root = createOwner('registry-root');
    return {
        ...root,
        createOwner,
    };
}
