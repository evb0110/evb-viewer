const BLOCK_BYTES = 64 * 1024;
const READ_BYTES = 64 * BLOCK_BYTES;

/**
 * The full-content witness of `size` bytes: a SHA-256 chain over every 64 KiB block, independent of
 * file metadata. Equal witnesses mean equal bytes. The format is the browser's existing `content-v2`
 * witness, so witnesses recorded by either platform compare.
 */
export async function contentWitness(size: number, read: (offset: number, length: number) => Promise<Uint8Array>) {
    let digest = new Uint8Array();
    for (let offset = 0; offset < size; offset += READ_BYTES) {
        const bytes = await read(offset, Math.min(READ_BYTES, size - offset));
        if (bytes.byteLength !== Math.min(READ_BYTES, size - offset)) {
            throw new Error(`Content ended at ${offset + bytes.byteLength} of ${size} bytes`);
        }
        for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
            const chunk = bytes.subarray(block, block + BLOCK_BYTES);
            const input = new Uint8Array(digest.byteLength + chunk.byteLength);
            input.set(digest);
            input.set(chunk, digest.byteLength);
            digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
        }
    }
    return `content-v2:${size}:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
