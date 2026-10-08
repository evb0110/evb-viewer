import { BROWSER_CHUNK_WRITE_YIELD_EVERY } from '@app/platform/browser/browserDocumentConstants';
import { cloneBytes } from '@app/platform/browser/browserDocumentBytes';
import {
    createChunkKey,
    deleteChunkRecord,
    loadChunkRecord,
    persistChunkRecord,
} from '@app/platform/browser/browserDocumentChunks';
import type { IBrowserDocumentEntry } from '@app/platform/browser/browserDocumentTypes';
import { createBrowserSafeId } from '@app/utils/browserSafe';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';

export function createBrowserDocumentChunkGeneration() {
    return `${Date.now().toString(36)}-${createBrowserSafeId()}`;
}

export function createBrowserDocumentContentToken() {
    return createBrowserDocumentChunkGeneration();
}

export async function persistBrowserDocumentChunk(
    ref: string,
    index: number,
    generation: string,
    data: Uint8Array,
) {
    await persistChunkRecord({
        key: createChunkKey(ref, index, generation),
        ref,
        index,
        generation,
        data: cloneBytes(data),
    });
}

export async function persistBrowserDocumentChunkGeneration(
    ref: string,
    fileSize: number,
    chunkSize: number,
    readChunk: (offset: number, length: number) => Promise<Uint8Array>,
) {
    const generation = createBrowserDocumentChunkGeneration();
    const normalizedChunkSize = Math.max(1, chunkSize);
    let chunkCount = 0;

    try {
        for (let offset = 0; offset < fileSize; offset += normalizedChunkSize) {
            const chunk = await readChunk(offset, Math.min(normalizedChunkSize, fileSize - offset));
            await persistBrowserDocumentChunk(ref, chunkCount, generation, chunk);
            chunkCount += 1;
            if (chunkCount % BROWSER_CHUNK_WRITE_YIELD_EVERY === 0) {
                await yieldToBrowser();
            }
        }
    } catch (error) {
        await deleteBrowserDocumentChunks(ref, chunkCount, generation)
            .catch(() => undefined);
        throw error;
    }

    return {
        generation,
        chunkCount,
    };
}

async function loadBrowserDocumentChunk(
    ref: string,
    index: number,
    generation?: string,
) {
    return (await loadChunkRecord(ref, index, generation))?.data ?? null;
}

export async function assertBrowserDocumentChunkGenerationComplete(
    ref: string,
    generation: string,
    chunkCount: number,
) {
    for (let index = 0; index < chunkCount; index += 1) {
        const chunk = await loadBrowserDocumentChunk(ref, index, generation);
        if (!chunk) {
            throw new Error(`Browser document chunk missing: ${ref}#${index}`);
        }
    }
}

export function clearPendingBrowserDocumentChunkMetadata(
    entry: IBrowserDocumentEntry,
) {
    delete entry.pendingChunkGeneration;
    delete entry.pendingChunkCount;
    delete entry.pendingChunkSize;
    delete entry.pendingFileSize;
    delete entry.pendingChunkUpdatedAt;
}

export async function deleteBrowserDocumentChunks(
    ref: string,
    chunkCount: number,
    generation?: string,
    startIndex = 0,
) {
    if (chunkCount <= 0) {
        return;
    }
    await Promise.all(Array.from({ length: chunkCount }, async (_value, index) => {
        await deleteChunkRecord(ref, startIndex + index, generation);
    }));
}

export async function clearPendingBrowserDocumentChunks(
    entry: IBrowserDocumentEntry,
) {
    if (entry.pendingChunkGeneration) {
        await deleteBrowserDocumentChunks(
            entry.ref,
            entry.pendingChunkCount ?? 0,
            entry.pendingChunkGeneration,
        );
    }
    clearPendingBrowserDocumentChunkMetadata(entry);
}

export async function clearBrowserDocumentExternalChunkStorage(
    entry: IBrowserDocumentEntry,
) {
    if (entry.storageMode === 'chunked' && entry.chunkCount > 0) {
        await deleteBrowserDocumentChunks(entry.ref, entry.chunkCount, entry.chunkGeneration);
    }
}

export async function readBrowserDocumentChunkedEntryBytes(
    entry: IBrowserDocumentEntry,
) {
    if (entry.fileSize === 0 || entry.chunkCount === 0) {
        return new Uint8Array();
    }
    const bytes = new Uint8Array(entry.fileSize);
    let writeOffset = 0;
    for (let index = 0; index < entry.chunkCount; index += 1) {
        const chunk = await loadBrowserDocumentChunk(entry.ref, index, entry.chunkGeneration);
        if (!chunk) {
            throw new Error(`Browser document chunk missing: ${entry.ref}#${index}`);
        }
        bytes.set(chunk, writeOffset);
        writeOffset += chunk.byteLength;
    }
    return bytes;
}

export async function readBrowserDocumentChunkedEntryRange(
    entry: IBrowserDocumentEntry,
    start: number,
    rangeLength: number,
    end: number,
) {
    if (rangeLength === 0 || entry.chunkCount === 0 || entry.fileSize === 0) {
        return new Uint8Array();
    }
    const boundedEnd = Math.min(end, entry.fileSize);
    const boundedLength = Math.max(0, boundedEnd - start);
    if (boundedLength === 0) {
        return new Uint8Array();
    }

    const output = new Uint8Array(boundedLength);
    const chunkSize = Math.max(1, entry.chunkSize);
    const firstChunkIndex = Math.floor(start / chunkSize);
    const lastChunkIndex = Math.floor((boundedEnd - 1) / chunkSize);
    let outputOffset = 0;

    for (
        let chunkIndex = firstChunkIndex;
        chunkIndex <= lastChunkIndex;
        chunkIndex += 1
    ) {
        const chunk = await loadBrowserDocumentChunk(entry.ref, chunkIndex, entry.chunkGeneration);
        if (!chunk) {
            throw new Error(`Browser document chunk missing: ${entry.ref}#${chunkIndex}`);
        }

        const chunkStart = chunkIndex * chunkSize;
        const sliceStart = Math.max(0, start - chunkStart);
        const sliceEnd = Math.min(chunk.byteLength, boundedEnd - chunkStart);
        const slice = chunk.subarray(sliceStart, sliceEnd);
        output.set(slice, outputOffset);
        outputOffset += slice.byteLength;
    }

    return output;
}
