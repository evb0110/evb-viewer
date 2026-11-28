const BLOCK_BYTES = 64 * 1024;
const READ_BYTES = 64 * BLOCK_BYTES;
const DIGEST_BYTES = 32;
const EMPTY_DIGEST = new Uint8Array(0);
const HEX = Array.from({length: 256}, (_, byte) => byte.toString(16).padStart(2, '0'));

// FIPS 180-4 SHA-256 round constants.
const SHA256_K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
    0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
    0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

interface INodeCrypto {
    hash?: (algorithm: 'sha256', data: Uint8Array, outputEncoding: 'buffer') => Uint8Array;
    createHash?: (algorithm: 'sha256') => {update(data: Uint8Array): unknown; digest(): Uint8Array};
}

function getNodeCrypto(): INodeCrypto | null {
    const proc = (globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}).process;
    const mod = proc?.getBuiltinModule?.('node:crypto') as INodeCrypto | undefined;
    return typeof mod?.hash === 'function' || typeof mod?.createHash === 'function' ? mod : null;
}

function writeWord(out: Uint8Array, offset: number, value: number) {
    out[offset] = (value >>> 24) & 0xff;
    out[offset + 1] = (value >>> 16) & 0xff;
    out[offset + 2] = (value >>> 8) & 0xff;
    out[offset + 3] = value & 0xff;
}

/** Synchronous single-scratch-buffer pure-JS SHA-256 (8-round unrolled) for contexts without Node `crypto` or `crypto.subtle`. */
function hashBlockInScratchJs(scratch: Uint8Array, total: number, w: Int32Array) {
    scratch[total] = 0x80;
    const paddedLen = (total + 9 + 63) & ~63;
    scratch.fill(0, total + 1, paddedLen - 8);
    writeWord(scratch, paddedLen - 8, Math.floor(total / 0x20000000) >>> 0);
    writeWord(scratch, paddedLen - 4, (total << 3) >>> 0);
    let h0 = 0x6a09e667 | 0;
    let h1 = 0xbb67ae85 | 0;
    let h2 = 0x3c6ef372 | 0;
    let h3 = 0xa54ff53a | 0;
    let h4 = 0x510e527f | 0;
    let h5 = 0x9b05688c | 0;
    let h6 = 0x1f83d9ab | 0;
    let h7 = 0x5be0cd19 | 0;
    const k = SHA256_K;
    for (let pos = 0; pos < paddedLen; pos += 64) {
        let o = pos;
        for (let i = 0; i < 16; i += 1) {
            w[i] = (scratch[o]! << 24) | (scratch[o + 1]! << 16) | (scratch[o + 2]! << 8) | scratch[o + 3]!;
            o += 4;
        }
        for (let i = 16; i < 64; i += 1) {
            const w15 = w[i - 15]!;
            const w2 = w[i - 2]!;
            w[i] =
                (w[i - 16]! +
                    (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) +
                    w[i - 7]! +
                    (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10))) |
                0;
        }
        let a = h0;
        let b = h1;
        let c = h2;
        let d = h3;
        let e = h4;
        let f = h5;
        let g = h6;
        let h = h7;
        for (let i = 0; i < 64; i += 8) {
            let t1: number;
            let t2: number;
            t1 =
                (h +
                    (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
                    ((e & f) ^ (~e & g)) +
                    k[i]! +
                    w[i]!) |
                0;
            t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            d = (d + t1) | 0;
            h = (t1 + t2) | 0;
            t1 =
                (g +
                    (((d >>> 6) | (d << 26)) ^ ((d >>> 11) | (d << 21)) ^ ((d >>> 25) | (d << 7))) +
                    ((d & e) ^ (~d & f)) +
                    k[i + 1]! +
                    w[i + 1]!) |
                0;
            t2 = ((((h >>> 2) | (h << 30)) ^ ((h >>> 13) | (h << 19)) ^ ((h >>> 22) | (h << 10))) + ((h & a) ^ (h & b) ^ (a & b))) | 0;
            c = (c + t1) | 0;
            g = (t1 + t2) | 0;
            t1 =
                (f +
                    (((c >>> 6) | (c << 26)) ^ ((c >>> 11) | (c << 21)) ^ ((c >>> 25) | (c << 7))) +
                    ((c & d) ^ (~c & e)) +
                    k[i + 2]! +
                    w[i + 2]!) |
                0;
            t2 = ((((g >>> 2) | (g << 30)) ^ ((g >>> 13) | (g << 19)) ^ ((g >>> 22) | (g << 10))) + ((g & h) ^ (g & a) ^ (h & a))) | 0;
            b = (b + t1) | 0;
            f = (t1 + t2) | 0;
            t1 =
                (e +
                    (((b >>> 6) | (b << 26)) ^ ((b >>> 11) | (b << 21)) ^ ((b >>> 25) | (b << 7))) +
                    ((b & c) ^ (~b & d)) +
                    k[i + 3]! +
                    w[i + 3]!) |
                0;
            t2 = ((((f >>> 2) | (f << 30)) ^ ((f >>> 13) | (f << 19)) ^ ((f >>> 22) | (f << 10))) + ((f & g) ^ (f & h) ^ (g & h))) | 0;
            a = (a + t1) | 0;
            e = (t1 + t2) | 0;
            t1 =
                (d +
                    (((a >>> 6) | (a << 26)) ^ ((a >>> 11) | (a << 21)) ^ ((a >>> 25) | (a << 7))) +
                    ((a & b) ^ (~a & c)) +
                    k[i + 4]! +
                    w[i + 4]!) |
                0;
            t2 = ((((e >>> 2) | (e << 30)) ^ ((e >>> 13) | (e << 19)) ^ ((e >>> 22) | (e << 10))) + ((e & f) ^ (e & g) ^ (f & g))) | 0;
            h = (h + t1) | 0;
            d = (t1 + t2) | 0;
            t1 =
                (c +
                    (((h >>> 6) | (h << 26)) ^ ((h >>> 11) | (h << 21)) ^ ((h >>> 25) | (h << 7))) +
                    ((h & a) ^ (~h & b)) +
                    k[i + 5]! +
                    w[i + 5]!) |
                0;
            t2 = ((((d >>> 2) | (d << 30)) ^ ((d >>> 13) | (d << 19)) ^ ((d >>> 22) | (d << 10))) + ((d & e) ^ (d & f) ^ (e & f))) | 0;
            g = (g + t1) | 0;
            c = (t1 + t2) | 0;
            t1 =
                (b +
                    (((g >>> 6) | (g << 26)) ^ ((g >>> 11) | (g << 21)) ^ ((g >>> 25) | (g << 7))) +
                    ((g & h) ^ (~g & a)) +
                    k[i + 6]! +
                    w[i + 6]!) |
                0;
            t2 = ((((c >>> 2) | (c << 30)) ^ ((c >>> 13) | (c << 19)) ^ ((c >>> 22) | (c << 10))) + ((c & d) ^ (c & e) ^ (d & e))) | 0;
            f = (f + t1) | 0;
            b = (t1 + t2) | 0;
            t1 =
                (a +
                    (((f >>> 6) | (f << 26)) ^ ((f >>> 11) | (f << 21)) ^ ((f >>> 25) | (f << 7))) +
                    ((f & g) ^ (~f & h)) +
                    k[i + 7]! +
                    w[i + 7]!) |
                0;
            t2 = ((((b >>> 2) | (b << 30)) ^ ((b >>> 13) | (b << 19)) ^ ((b >>> 22) | (b << 10))) + ((b & c) ^ (b & d) ^ (c & d))) | 0;
            e = (e + t1) | 0;
            a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0;
        h1 = (h1 + b) | 0;
        h2 = (h2 + c) | 0;
        h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0;
        h5 = (h5 + f) | 0;
        h6 = (h6 + g) | 0;
        h7 = (h7 + h) | 0;
    }
    writeWord(scratch, 0, h0);
    writeWord(scratch, 4, h1);
    writeWord(scratch, 8, h2);
    writeWord(scratch, 12, h3);
    writeWord(scratch, 16, h4);
    writeWord(scratch, 20, h5);
    writeWord(scratch, 24, h6);
    writeWord(scratch, 28, h7);
}

function formatWitness(size: number, digest: Uint8Array) {
    let hex = '';
    for (let i = 0; i < digest.byteLength; i += 1) {
        hex += HEX[digest[i]!]!;
    }
    return `content-v2:${size}:${hex}`;
}

function createSyncChain() {
    const nodeCrypto = getNodeCrypto();
    if (nodeCrypto?.hash) {
        const scratch = new Uint8Array(DIGEST_BYTES + BLOCK_BYTES);
        let hasDigest = false;
        const hashOneShot = nodeCrypto.hash;
        return {
            update(bytes: Uint8Array) {
                for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
                    const chunk = bytes.subarray(block, block + BLOCK_BYTES);
                    const offset = hasDigest ? DIGEST_BYTES : 0;
                    scratch.set(chunk, offset);
                    scratch.set(hashOneShot('sha256', scratch.subarray(0, offset + chunk.byteLength), 'buffer'), 0);
                    hasDigest = true;
                }
            },
            finish: (size: number) => formatWitness(size, hasDigest ? scratch.subarray(0, DIGEST_BYTES) : EMPTY_DIGEST),
        };
    }
    if (nodeCrypto?.createHash) {
        const createHash = nodeCrypto.createHash;
        let digest: Uint8Array = EMPTY_DIGEST;
        return {
            update(bytes: Uint8Array) {
                for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
                    const hash = createHash('sha256');
                    if (digest.byteLength > 0) {
                        hash.update(digest);
                    }
                    hash.update(bytes.subarray(block, block + BLOCK_BYTES));
                    digest = hash.digest();
                }
            },
            finish: (size: number) => formatWitness(size, digest),
        };
    }
    const scratch = new Uint8Array(DIGEST_BYTES + BLOCK_BYTES + 128);
    const w = new Int32Array(64);
    let hasDigest = false;
    return {
        update(bytes: Uint8Array) {
            for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
                const chunk = bytes.subarray(block, block + BLOCK_BYTES);
                const offset = hasDigest ? DIGEST_BYTES : 0;
                scratch.set(chunk, offset);
                hashBlockInScratchJs(scratch, offset + chunk.byteLength, w);
                hasDigest = true;
            }
        },
        finish: (size: number) => formatWitness(size, hasDigest ? scratch.subarray(0, DIGEST_BYTES) : EMPTY_DIGEST),
    };
}

/**
 * Synchronous full-content witness of `size` bytes: a SHA-256 chain over every 64 KiB block,
 * byte-identical to `contentWitness` using Node `crypto` when available and single-scratch-buffer
 * pure-JS SHA-256 otherwise.
 */
export function contentWitnessSync(size: number, read: (offset: number, length: number) => Uint8Array) {
    const chain = createSyncChain();
    for (let offset = 0; offset < size; offset += READ_BYTES) {
        const expected = Math.min(READ_BYTES, size - offset);
        const bytes = read(offset, expected);
        if (bytes.byteLength !== expected) {
            throw new Error(`Content ended at ${offset + bytes.byteLength} of ${size} bytes`);
        }
        chain.update(bytes);
    }
    return chain.finish(size);
}

/**
 * The full-content witness of `size` bytes: a SHA-256 chain over every 64 KiB block, independent of
 * file metadata. Equal witnesses mean equal bytes. Uses synchronous Node `crypto` on Node/Electron,
 * hardware-accelerated `crypto.subtle` with one reused scratch buffer in secure browser contexts,
 * and synchronous pure-JS SHA-256 when `crypto.subtle` is unavailable.
 */
export async function contentWitness(size: number, read: (offset: number, length: number) => Promise<Uint8Array>) {
    if (getNodeCrypto() !== null || typeof crypto === 'undefined' || !crypto.subtle) {
        const chain = createSyncChain();
        for (let offset = 0; offset < size; offset += READ_BYTES) {
            const expected = Math.min(READ_BYTES, size - offset);
            const bytes = await read(offset, expected);
            if (bytes.byteLength !== expected) {
                throw new Error(`Content ended at ${offset + bytes.byteLength} of ${size} bytes`);
            }
            chain.update(bytes);
        }
        return chain.finish(size);
    }
    const scratch = new Uint8Array(DIGEST_BYTES + BLOCK_BYTES);
    let hasDigest = false;
    for (let offset = 0; offset < size; offset += READ_BYTES) {
        const expected = Math.min(READ_BYTES, size - offset);
        const bytes = await read(offset, expected);
        if (bytes.byteLength !== expected) {
            throw new Error(`Content ended at ${offset + bytes.byteLength} of ${size} bytes`);
        }
        for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
            const chunk = bytes.subarray(block, block + BLOCK_BYTES);
            const start = hasDigest ? DIGEST_BYTES : 0;
            scratch.set(chunk, start);
            const out = await crypto.subtle.digest('SHA-256', scratch.subarray(0, start + chunk.byteLength));
            scratch.set(new Uint8Array(out), 0);
            hasDigest = true;
        }
    }
    return formatWitness(size, hasDigest ? scratch.subarray(0, DIGEST_BYTES) : EMPTY_DIGEST);
}

/** The `content-v2:` fact of a witness, if it carries one. */
export const contentOf = (witness: string | null | undefined) => witness?.split(' ').find((fact) => fact.startsWith('content-v2:'));

/**
 * Witnesses are space-separated facts: the `content-v2:` fact names the bytes, other facts (a platform's
 * file metadata, which a desktop destination's witness carries) name one version of a file. Two witnesses
 * match by content when both carry it, otherwise by their other facts.
 */
export function sameWitness(left: string | null | undefined, right: string | null | undefined) {
    if (!left || !right) {
        return false;
    }
    const content = [contentOf(left), contentOf(right)];
    if (content[0] && content[1]) {
        return content[0] === content[1];
    }
    const other = (witness: string) =>
        witness
            .split(' ')
            .filter((fact) => !fact.startsWith('content-v2:'))
            .join(' ');
    return other(left) !== '' && other(left) === other(right);
}
