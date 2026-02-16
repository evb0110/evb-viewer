import type { TSplitPayload } from '@app/types/split-payload';

interface IWorkspaceSplitCacheEntry {
    payload: TSplitPayload;
    createdAt: number;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const splitPayloadCache = new Map<string, IWorkspaceSplitCacheEntry>();

function clonePayload(payload: TSplitPayload): TSplitPayload {
    if (payload.kind === 'empty') {
        return { kind: 'empty' };
    }

    if (payload.kind === 'djvu') {
        return {
            kind: 'djvu',
            sourcePath: payload.sourcePath,
        };
    }

    return {
        kind: 'pdfSnapshot',
        fileName: payload.fileName,
        originalPath: payload.originalPath,
        data: payload.data.slice(),
        isDirty: payload.isDirty,
    };
}

function pruneCache(now = Date.now()) {
    for (const [
        tabId,
        entry,
    ] of splitPayloadCache) {
        if (now - entry.createdAt > CACHE_TTL_MS) {
            splitPayloadCache.delete(tabId);
        }
    }

    if (splitPayloadCache.size <= MAX_CACHE_ENTRIES) {
        return;
    }

    const sorted = Array.from(splitPayloadCache.entries())
        .sort((left, right) => left[1].createdAt - right[1].createdAt);
    const overflowCount = splitPayloadCache.size - MAX_CACHE_ENTRIES;

    for (let index = 0; index < overflowCount; index += 1) {
        const item = sorted[index];
        if (!item) {
            break;
        }
        splitPayloadCache.delete(item[0]);
    }
}

export function useWorkspaceSplitCache() {
    function set(tabId: string, payload: TSplitPayload | null | undefined) {
        if (!payload || payload.kind === 'empty') {
            splitPayloadCache.delete(tabId);
            return;
        }

        splitPayloadCache.set(tabId, {
            payload: clonePayload(payload),
            createdAt: Date.now(),
        });
        pruneCache();
    }

    function consume(tabId: string): TSplitPayload | null {
        pruneCache();

        const entry = splitPayloadCache.get(tabId);
        splitPayloadCache.delete(tabId);

        if (!entry) {
            return null;
        }

        return clonePayload(entry.payload);
    }

    function has(tabId: string) {
        pruneCache();
        return splitPayloadCache.has(tabId);
    }

    function clear(tabId: string) {
        splitPayloadCache.delete(tabId);
    }

    return {
        set,
        consume,
        has,
        clear,
    };
}
