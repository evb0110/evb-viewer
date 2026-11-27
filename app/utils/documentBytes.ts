import type {TDocumentRef} from '@contracts/documentRef';
import {assertDocumentAllocationSize} from '@contracts/electronApiDocuments';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';

const DEFAULT_DOCUMENT_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface IReadDocumentBytesOptions {
    chunkSize?: number;
    knownSize?: number;
    maxBytes?: number;
    signal?: AbortSignal;
}

function normalizeChunkSize(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_DOCUMENT_READ_CHUNK_BYTES;
    }

    return Math.max(64 * 1024, Math.floor(value));
}

async function resolveDocumentSize(path: TDocumentRef, knownSize: number | undefined) {
    if (typeof knownSize === 'number' && Number.isFinite(knownSize)) {
        return Math.max(0, Math.floor(knownSize));
    }

    return (await getDocumentFilesCapability().statFile(path)).size;
}

function normalizeBytes(data: Uint8Array | ArrayBuffer) {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function assertReadSize(path: TDocumentRef, actualBytes: number, expectedBytes: number) {
    if (actualBytes !== expectedBytes) {
        throw new Error(`Document changed while reading ${path}: expected ${expectedBytes} bytes, read ${actualBytes} bytes`);
    }
}

function assertWithinReadLimit(actualBytes: number, maxBytes: number | undefined) {
    if (typeof maxBytes === 'number' && actualBytes > maxBytes) {
        throw new Error(`Document exceeds in-memory read limit (${maxBytes} bytes)`);
    }
}

export async function readDocumentBytes(path: TDocumentRef, options: IReadDocumentBytesOptions = {}) {
    options.signal?.throwIfAborted();
    const documentFiles = getDocumentFilesCapability();
    const size = await resolveDocumentSize(path, options.knownSize);
    options.signal?.throwIfAborted();

    if (typeof options.maxBytes === 'number' && size > options.maxBytes) {
        throw new Error(`Document exceeds in-memory read limit (${options.maxBytes} bytes)`);
    }

    const chunkSize = normalizeChunkSize(options.chunkSize);
    if (size <= chunkSize) {
        const data = normalizeBytes(await documentFiles.readFile(path));
        options.signal?.throwIfAborted();
        assertWithinReadLimit(data.byteLength, options.maxBytes);
        assertReadSize(path, data.byteLength, size);
        return data;
    }

    const output = new Uint8Array(assertDocumentAllocationSize(size));
    let offset = 0;

    while (offset < size) {
        options.signal?.throwIfAborted();
        const nextChunkLength = Math.min(chunkSize, size - offset);
        const chunk = await documentFiles.readFileRange(path, offset, nextChunkLength);
        options.signal?.throwIfAborted();
        assertReadSize(path, chunk.byteLength, nextChunkLength);
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }

    assertWithinReadLimit(output.byteLength, options.maxBytes);
    return output;
}

export async function readDocumentBytesIfBelowLimit(
    path: TDocumentRef,
    maxBytes: number,
    options: Omit<IReadDocumentBytesOptions, 'maxBytes'> = {},
) {
    const size = await resolveDocumentSize(path, options.knownSize);
    if (size > maxBytes) {
        return null;
    }

    return readDocumentBytes(path, {
        ...options,
        knownSize: size,
        maxBytes,
    });
}
