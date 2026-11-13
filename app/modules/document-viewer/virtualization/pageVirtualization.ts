export interface ILazyIndexedCollection<T> extends Array<T> {
    readonly get: (index: number) => T | undefined;
    readonly map: <U>(
        callback: (value: T, index: number, source: T[]) => U,
        thisArg?: unknown,
    ) => ILazyIndexedCollection<U>;
}

const LAZY_INDEXED_COLLECTION_MARKER = Symbol('lazy-indexed-collection');
const LAZY_INDEXED_COLLECTION_DEFAULT_CHUNK_SIZE = 256;

interface ILazyIndexedCollectionTarget<T> extends ILazyIndexedCollection<T> {[LAZY_INDEXED_COLLECTION_MARKER]: true;}

function isArrayIndex(value: PropertyKey): value is `${number}` {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }
    const index = Number(value);
    return Number.isSafeInteger(index)
        && index >= 0
        && String(index) === value;
}

export function createLazyIndexedCollection<T>(options: {
    length: number;
    getValue: (index: number) => T;
    chunkSize?: number;
    maxCachedChunks?: number;
    cacheValues?: boolean;
}): ILazyIndexedCollection<T> {
    const chunkSize = Math.max(1, Math.trunc(options.chunkSize ?? LAZY_INDEXED_COLLECTION_DEFAULT_CHUNK_SIZE));
    const maxCachedChunks = Math.max(1, Math.trunc(options.maxCachedChunks ?? 32));
    const cacheValues = options.cacheValues !== false;
    const chunks = new Map<number, T[]>();

    function getChunk(chunkIndex: number) {
        const cached = chunks.get(chunkIndex);
        if (cached) {
            // Map insertion order doubles as a tiny LRU. Chunks touched by a
            // visible window stay resident while a far navigation evicts old
            // work instead of retaining the whole document.
            chunks.delete(chunkIndex);
            chunks.set(chunkIndex, cached);
            return cached;
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(options.length, start + chunkSize);
        const chunk = new Array<T>(Math.max(0, end - start));
        for (let index = start; index < end; index += 1) {
            chunk[index - start] = options.getValue(index);
        }
        chunks.set(chunkIndex, chunk);
        while (chunks.size > maxCachedChunks) {
            const oldest = chunks.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            chunks.delete(oldest);
        }
        return chunk;
    }

    let lazyProxy: ILazyIndexedCollection<T> | null = null;
    const target = Object.assign([] as T[], {
        [LAZY_INDEXED_COLLECTION_MARKER]: true as const,
        get(index: number): T | undefined {
            if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) {
                return undefined;
            }
            if (!cacheValues) {
                return options.getValue(index);
            }
            return getChunk(Math.floor(index / chunkSize))[index % chunkSize];
        },
        map<U>(
            callback: (value: T, index: number, source: T[]) => U,
            thisArg?: unknown,
        ): ILazyIndexedCollection<U> {
            return createLazyIndexedCollection<U>({
                length: options.length,
                getValue: index => callback.call(
                    thisArg,
                    target.get(index) as T,
                    index,
                    lazyProxy ?? target,
                ),
                chunkSize,
                maxCachedChunks,
            });
        },
    });
    target.length = options.length;

    lazyProxy = new Proxy(target, {
        get(current, property, receiver) {
            if (isArrayIndex(property)) {
                return current.get(Number(property));
            }
            const value: unknown = Reflect.get(current, property, receiver);
            return value;
        },
        has(current, property) {
            if (isArrayIndex(property)) {
                const index = Number(property);
                return index >= 0 && index < options.length;
            }
            return Reflect.has(current, property);
        },
    });
    return lazyProxy;
}

export function isLazyIndexedCollection<T>(value: unknown): value is ILazyIndexedCollection<T> {
    return typeof value === 'object'
        && value !== null
        && (value as Partial<ILazyIndexedCollectionTarget<T>>)[LAZY_INDEXED_COLLECTION_MARKER] === true;
}

export interface IDocumentViewerPageRange {
    start: number;
    end: number;
}

export const EMPTY_DOCUMENT_VIEWER_PAGE_RANGE: Readonly<IDocumentViewerPageRange> = Object.freeze({
    start: 1,
    end: 0,
});

interface ICreateAnchorPageWindowOptions {
    anchorPage: number | null;
    totalPages: number;
    radiusPages: number;
}

function normalizePositiveInteger(value: number) {
    return Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : 0;
}

function normalizeNonNegativeInteger(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.trunc(value);
}

function clampPageNumber(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

function hasDocumentViewerPageRange(range: IDocumentViewerPageRange) {
    return range.end >= range.start;
}

export function createPageNumbersForWindow(range: IDocumentViewerPageRange) {
    if (!hasDocumentViewerPageRange(range)) {
        return [] as number[];
    }

    return Array.from(
        { length: range.end - range.start + 1 },
        (_, index) => range.start + index,
    );
}

export function createAnchorPageWindow(options: ICreateAnchorPageWindowOptions): IDocumentViewerPageRange | null {
    const totalPages = normalizePositiveInteger(options.totalPages);
    if (totalPages <= 0 || options.anchorPage === null || !Number.isFinite(options.anchorPage)) {
        return null;
    }

    const anchorPage = clampPageNumber(Math.trunc(options.anchorPage), 1, totalPages);
    const radiusPages = normalizeNonNegativeInteger(options.radiusPages);

    return {
        start: clampPageNumber(anchorPage - radiusPages, 1, totalPages),
        end: clampPageNumber(anchorPage + radiusPages, 1, totalPages),
    };
}
