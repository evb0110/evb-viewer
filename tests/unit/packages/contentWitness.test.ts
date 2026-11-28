import {afterEach, describe, expect, it, vi} from 'vitest';
import {contentWitness, contentWitnessSync} from '@document-store/contentWitness';

const BLOCK_BYTES = 64 * 1024;

/** Original sequential `crypto.subtle.digest` reference oracle for `content-v2`. */
async function referenceContentWitness(bytes: Uint8Array) {
    let digest = new Uint8Array();
    for (let block = 0; block < bytes.byteLength; block += BLOCK_BYTES) {
        const chunk = bytes.subarray(block, block + BLOCK_BYTES);
        const input = new Uint8Array(digest.byteLength + chunk.byteLength);
        input.set(digest);
        input.set(chunk, digest.byteLength);
        digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
    }
    return `content-v2:${bytes.byteLength}:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function makePayload(size: number) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
        bytes[i] = (i * 31 + (i >>> 8) * 17 + 7) & 0xff;
    }
    return bytes;
}

describe('contentWitness differential equivalence across all implementations', () => {
    const origGetBuiltin = process.getBuiltinModule;

    afterEach(() => {
        process.getBuiltinModule = origGetBuiltin;
        vi.restoreAllMocks();
    });

    const boundarySizes = [
        0,
        1,
        55,
        56,
        63,
        64,
        65,
        127,
        128,
        1_000,
        BLOCK_BYTES - 1,
        BLOCK_BYTES,
        BLOCK_BYTES + 1,
        BLOCK_BYTES + 23,
        BLOCK_BYTES + 24,
        BLOCK_BYTES * 2,
        4 * 1024 * 1024,
        5 * 1024 * 1024 + 37,
    ];

    it('matches the reference content-v2 oracle byte-for-byte across Node one-shot, Node createHash, browser subtle scratch, and pure-JS SHA-256', async () => {
        for (const size of boundarySizes) {
            const payload = makePayload(size);
            const expected = await referenceContentWitness(payload);
            const readAsync = async (offset: number, length: number) => payload.subarray(offset, offset + length);
            const readSync = (offset: number, length: number) => payload.subarray(offset, offset + length);

            // 1. Default Node one-shot crypto.hash path
            process.getBuiltinModule = origGetBuiltin;
            expect(await contentWitness(size, readAsync), `node-async size=${size}`).toBe(expected);
            expect(contentWitnessSync(size, readSync), `node-sync size=${size}`).toBe(expected);

            // 2. Node createHash fallback (without crypto.hash)
            const realCrypto = origGetBuiltin.call(process, 'node:crypto') as typeof import('node:crypto');
            process.getBuiltinModule = ((id: string) =>
                id === 'node:crypto' ? {createHash: realCrypto.createHash} : undefined) as typeof process.getBuiltinModule;
            expect(await contentWitness(size, readAsync), `createHash-async size=${size}`).toBe(expected);
            expect(contentWitnessSync(size, readSync), `createHash-sync size=${size}`).toBe(expected);

            // 3. Browser crypto.subtle single-scratch-buffer path (no Node builtin)
            process.getBuiltinModule = undefined as unknown as typeof process.getBuiltinModule;
            expect(await contentWitness(size, readAsync), `browser-subtle size=${size}`).toBe(expected);

            // 4. Pure-JS 8-round-unrolled SHA-256 fallback (sync & non-secure context)
            expect(contentWitnessSync(size, readSync), `pure-js-sync size=${size}`).toBe(expected);
        }
    });

    it('matches the oracle via async contentWitness() pure-JS fallback when crypto.subtle is unavailable across multi-chunk payloads', async () => {
        const size = 4 * 1024 * 1024 + 137;
        const payload = makePayload(size);
        const expected = await referenceContentWitness(payload);
        const origCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        process.getBuiltinModule = undefined as unknown as typeof process.getBuiltinModule;
        Object.defineProperty(globalThis, 'crypto', {value: {}, configurable: true});
        try {
            const actual = await contentWitness(size, async (offset, length) => payload.subarray(offset, offset + length));
            expect(actual).toBe(expected);
        } finally {
            if (origCrypto) {
                Object.defineProperty(globalThis, 'crypto', origCrypto);
            }
        }
    });

    it('throws the exact short-read error when the reader ends early', async () => {
        await expect(contentWitness(100, async () => new Uint8Array(42))).rejects.toThrow('Content ended at 42 of 100 bytes');
        expect(() => contentWitnessSync(100, () => new Uint8Array(42))).toThrow('Content ended at 42 of 100 bytes');
    });
});
