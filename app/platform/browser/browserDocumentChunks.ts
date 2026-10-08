import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    DOCUMENT_CHUNKS_STORE,
} from '@app/platform/browser/browserDocumentConstants';
import type {
    IBrowserDocumentChunkRecord,
    IChunkKeyRecord,
} from '@app/platform/browser/browserDocumentTypes';
import {
    createChunkKey,
    BROWSER_DOCUMENT_CHUNK_RECORD_SCHEMA,
} from '@app/platform/browser/browserDocumentTypes';
import {
    withObjectStore,
    withObjectStoreReadResult,
} from '@app/platform/browser/browserDocumentIdb';
import * as v from 'valibot';

// One store-owned immutable generation chunk, including an in-flight read.
// Returned document ranges copy these bytes; callers never receive this value.
let cachedChunk: {
    key: string;
    result: Promise<IBrowserDocumentChunkRecord | null>
} | null = null;

const persistedChunkRecordSchema = v.pipe(
    v.object({
        key: v.pipe(v.string(), v.minLength(1)),
        ref: v.pipe(v.string(), v.minLength(1)),
        index: v.pipe(v.number(), v.minValue(0)),
        generation: v.optional(v.unknown()),
        data: v.custom<Uint8Array | ArrayBuffer>(value => value instanceof Uint8Array || value instanceof ArrayBuffer),
    }),
    v.transform(value => ({
        key: value.key,
        ref: value.ref,
        index: Math.floor(value.index),
        ...(typeof value.generation === 'string' && value.generation ? {generation: value.generation} : {}),
        data: value.data instanceof Uint8Array ? value.data : new Uint8Array(value.data),
    })),
    BROWSER_DOCUMENT_CHUNK_RECORD_SCHEMA,
);

export {createChunkKey} from '@app/platform/browser/browserDocumentTypes';

export function parseChunkKey(key: string): IChunkKeyRecord | null {
    const separatorIndex = key.lastIndexOf('::');
    if (separatorIndex <= 0) {
        return null;
    }

    const ref = key.slice(0, separatorIndex);
    const index = Number.parseInt(key.slice(separatorIndex + 2), 10);
    if (!ref || Number.isNaN(index) || index < 0) {
        return null;
    }

    const generationSeparatorIndex = ref.lastIndexOf('::');
    if (generationSeparatorIndex <= 0) {
        return {
            ref,
            index,
        };
    }

    return {
        ref: ref.slice(0, generationSeparatorIndex),
        generation: ref.slice(generationSeparatorIndex + 2),
        index,
    };
}

export function toPersistedChunkRecord(value: unknown): IBrowserDocumentChunkRecord | null {
    const result = v.safeParse(persistedChunkRecordSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export async function persistChunkRecord(record: IBrowserDocumentChunkRecord) {
    if (cachedChunk?.key === record.key) {
        cachedChunk = null;
    }
    const result = await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.put(record),
    );
    if (result === null) {
        throw new Error('IndexedDB document chunk write did not commit.');
    }
}

export async function loadChunkRecord(ref: string, index: number, generation?: string) {
    const key = createChunkKey(ref, index, generation);
    if (generation && cachedChunk?.key === key) {
        return cachedChunk.result;
    }
    const result = withObjectStore<unknown>(
        DOCUMENT_CHUNKS_STORE,
        'readonly',
        (store) => store.get(key) as IDBRequest<unknown>,
    ).then(toPersistedChunkRecord);
    if (!generation) {
        return result;
    }
    const candidate = {
        key,
        result,
    };
    cachedChunk = candidate;
    try {
        const chunk = await result;
        if ((!chunk || chunk.data.byteLength > BROWSER_DOCUMENT_CHUNK_SIZE) && cachedChunk === candidate) {
            cachedChunk = null;
        }
        return chunk;
    } catch (error) {
        if (cachedChunk === candidate) {
            cachedChunk = null;
        }
        throw error;
    }
}

export async function deleteChunkRecord(ref: string, index: number, generation?: string) {
    if (cachedChunk?.key === createChunkKey(ref, index, generation)) {
        cachedChunk = null;
    }
    const result = await withObjectStore(
        DOCUMENT_CHUNKS_STORE,
        'readwrite',
        (store) => store.delete(createChunkKey(ref, index, generation)),
    );
    if (result === null) {
        throw new Error('IndexedDB document chunk delete did not commit.');
    }
}

export async function loadAllChunkKeys() {
    return (await loadAllChunkKeysAvailability()).value;
}

export async function loadAllChunkKeysAvailability() {
    return withObjectStoreReadResult<IDBValidKey[]>(
        DOCUMENT_CHUNKS_STORE,
        (store) => store.getAllKeys(),
    );
}
