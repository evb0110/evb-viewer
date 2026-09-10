import {BROWSER_MAX_FULL_READ_BYTES} from '@app/platform/browser/browserDocumentConstants';

export const BROWSER_FILE_WITNESS_SAMPLE_BYTES = 64 * 1024;

function hashBytes(bytes: Uint8Array) {
    let first = 2_166_136_261;
    let second = 2_169_136_261;
    for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index] ?? 0;
        first = Math.imul(first ^ byte, 16_777_619);
        second = Math.imul(second ^ byte, 2_654_435_761);
    }
    return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

function createSampledWitnessBytes(bytes: Uint8Array) {
    if (bytes.byteLength <= BROWSER_MAX_FULL_READ_BYTES) {
        return bytes;
    }

    const sampleSize = Math.min(BROWSER_FILE_WITNESS_SAMPLE_BYTES, bytes.byteLength);
    const middleStart = Math.max(0, Math.floor(bytes.byteLength / 2) - Math.floor(sampleSize / 2));
    const tailStart = Math.max(0, bytes.byteLength - sampleSize);
    const samples = new Uint8Array(sampleSize * 3);
    samples.set(bytes.subarray(0, sampleSize));
    samples.set(bytes.subarray(middleStart, middleStart + sampleSize), sampleSize);
    samples.set(bytes.subarray(tailStart), sampleSize * 2);
    return samples;
}

export function createBrowserStoredBytesWitness(bytes: Uint8Array) {
    return `bytes:${bytes.byteLength}:${hashBytes(createSampledWitnessBytes(bytes))}`;
}

/**
 * Reads small files in full and samples the first, middle, and last 64KB of
 * large files, keeping the content witness bounded by the browser memory
 * policy.
 */
async function readWitnessBytes(file: File) {
    if (file.size <= BROWSER_MAX_FULL_READ_BYTES) {
        return new Uint8Array(await file.arrayBuffer());
    }

    const sampleSize = Math.min(BROWSER_FILE_WITNESS_SAMPLE_BYTES, file.size);
    const head = new Uint8Array(await file.slice(0, sampleSize).arrayBuffer());
    const middleStart = Math.max(0, Math.floor(file.size / 2) - Math.floor(sampleSize / 2));
    const middle = new Uint8Array(
        await file.slice(middleStart, middleStart + sampleSize).arrayBuffer(),
    );
    const tailStart = Math.max(0, file.size - sampleSize);
    const tail = new Uint8Array(await file.slice(tailStart, file.size).arrayBuffer());
    const samples = new Uint8Array(head.byteLength + middle.byteLength + tail.byteLength);
    samples.set(head);
    samples.set(middle, head.byteLength);
    samples.set(tail, head.byteLength + middle.byteLength);
    return samples;
}

export async function createBrowserFileBytesWitness(file: File) {
    return `bytes:${file.size}:${hashBytes(await readWitnessBytes(file))}`;
}

/**
 * Builds a bounded witness. Files larger than the full-read limit use the
 * first and last 64 KiB, plus size and lastModified, rather than full content.
 */
export async function createBrowserFileContentWitness(
    file: File,
    knownBytes?: Uint8Array,
) {
    const bytes = knownBytes?.byteLength === file.size
        ? knownBytes
        : await readWitnessBytes(file);
    return `file:${file.size}:${file.lastModified}:${hashBytes(bytes)}`;
}
