import {BROWSER_DOCUMENT_CHUNK_SIZE} from '@app/platform/browser/browserDocumentConstants';

const WITNESS_CHUNK_BYTES = 64 * 1024;

/** A versioned SHA-256 chain over every fixed-size block, independent of metadata. */
async function createContentWitness(size: number, read: (offset: number, length: number) => Promise<Uint8Array>) {
    let digest = new Uint8Array();
    for (let offset = 0; offset < size; offset += WITNESS_CHUNK_BYTES) {
        const bytes = await read(offset, Math.min(WITNESS_CHUNK_BYTES, size - offset));
        const input = new Uint8Array(digest.byteLength + bytes.byteLength);
        input.set(digest);
        input.set(bytes, digest.byteLength);
        digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    }
    return `content-v2:${size}:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createBrowserStoredBytesWitness(bytes: Uint8Array) {
    return createContentWitness(bytes.byteLength, (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)));
}

export function createBrowserFileContentWitness(file: File, knownBytes?: Uint8Array) {
    if (knownBytes?.byteLength === file.size) return createBrowserStoredBytesWitness(knownBytes);
    let chunk = new Uint8Array();
    let chunkOffset = 0;
    return createContentWitness(file.size, async (offset, length) => {
        if (offset + length > chunkOffset + chunk.byteLength) {
            chunkOffset = offset;
            chunk = new Uint8Array(await file.slice(offset, offset + BROWSER_DOCUMENT_CHUNK_SIZE).arrayBuffer());
        }
        return chunk.subarray(offset - chunkOffset, offset - chunkOffset + length);
    });
}
