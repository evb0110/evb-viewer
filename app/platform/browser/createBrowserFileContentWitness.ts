import {
    BROWSER_DOCUMENT_CHUNK_SIZE, BROWSER_MAX_FULL_READ_BYTES,
} from '@app/platform/browser/browserDocumentConstants';

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

export async function matchesBrowserFileContentWitness(file: File, baseline: string, currentWitness: string) {
    if (baseline === currentWitness) return true;
    // Only migrates baselines persisted before content-v2; discard embedded mtime.
    const legacy = baseline.replace(/^file:(\d+):[^:]+:/u, 'bytes:$1:');
    if (!legacy.startsWith(`bytes:${file.size}:`)) return false;
    const sampleSize = file.size <= BROWSER_MAX_FULL_READ_BYTES ? file.size : WITNESS_CHUNK_BYTES;
    const offsets = sampleSize === file.size ? [0] : [
        0,
        Math.floor(file.size / 2) - sampleSize / 2,
        file.size - sampleSize,
    ];
    let first = 2_166_136_261;
    let second = 2_169_136_261;
    for (const offset of offsets) {
        for (const byte of new Uint8Array(await file.slice(offset, offset + sampleSize).arrayBuffer())) {
            first = Math.imul(first ^ byte, 16_777_619);
            second = Math.imul(second ^ byte, 2_654_435_761);
        }
    }
    return legacy === `bytes:${file.size}:${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}
