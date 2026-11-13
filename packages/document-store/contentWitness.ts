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

/** The `content-v2:` fact of a witness, if it carries one. */
export const contentOf = (witness: string | null | undefined) => witness?.split(' ').find(fact => fact.startsWith('content-v2:'));

/**
 * Witnesses are space-separated facts: the `content-v2:` fact names the bytes, other facts (a platform's
 * file metadata, which a desktop destination's witness carries) name one version of a file. Two witnesses
 * match by content when both carry it, otherwise by their other facts.
 */
export function sameWitness(left: string | null | undefined, right: string | null | undefined) {
    if (!left || !right) return false;
    const content = [contentOf(left), contentOf(right)];
    if (content[0] && content[1]) return content[0] === content[1];
    const other = (witness: string) => witness.split(' ').filter(fact => !fact.startsWith('content-v2:')).join(' ');
    return other(left) !== '' && other(left) === other(right);
}
