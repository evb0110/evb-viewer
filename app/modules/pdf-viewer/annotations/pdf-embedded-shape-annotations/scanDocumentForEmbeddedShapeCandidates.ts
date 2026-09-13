import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

const EMBEDDED_SHAPE_SCAN_CHUNK_BYTES = 1024 * 1024;

const PDF_NAME_CANDIDATES = [
    '/EVBShapeKey',
    '/Annots',
    '/Square',
    '/Circle',
    '/Line',
    '/PolyLine',
    '/Polygon',
    '/Ink',
] as const;

const CANDIDATE_BYTES = PDF_NAME_CANDIDATES.map(candidate => (
    Uint8Array.from(candidate, character => character.charCodeAt(0))
));

const MAX_CANDIDATE_BYTES = Math.max(...CANDIDATE_BYTES.map(candidate => candidate.byteLength));
const CANDIDATE_FOUND = new Error('Embedded PDF shape candidate found');

function isPdfNameDelimiter(value: number | undefined) {
    return value === undefined
        || value <= 0x20
        || value === 0x25
        || value === 0x28
        || value === 0x29
        || value === 0x2F
        || value === 0x3C
        || value === 0x3E
        || value === 0x5B
        || value === 0x5D
        || value === 0x7B
        || value === 0x7D;
}

function matchesAt(
    data: Uint8Array,
    offset: number,
    candidate: Uint8Array,
    allowTerminalMatch: boolean,
) {
    if (offset + candidate.byteLength > data.byteLength) {
        return false;
    }
    for (let index = 0; index < candidate.byteLength; index += 1) {
        if (data[offset + index] !== candidate[index]) {
            return false;
        }
    }
    const followingByte = data[offset + candidate.byteLength];
    return (followingByte !== undefined || allowTerminalMatch)
        && isPdfNameDelimiter(followingByte);
}

function containsEmbeddedShapeCandidateBytes(data: Uint8Array, allowTerminalMatch: boolean) {
    let offset = data.indexOf(0x2F);
    while (offset !== -1) {
        if (CANDIDATE_BYTES.some(candidate => matchesAt(data, offset, candidate, allowTerminalMatch))) {
            return true;
        }
        offset = data.indexOf(0x2F, offset + 1);
    }
    return false;
}

export function hasEmbeddedShapeCandidateBytes(data: Uint8Array) {
    return containsEmbeddedShapeCandidateBytes(data, true);
}

export async function documentHasEmbeddedShapeCandidates(
    path: TDocumentRef,
    options: {signal?: AbortSignal} = {},
) {
    const documentFiles = getDocumentFilesCapability();
    let tail = new Uint8Array(0);

    try {
        await documentFiles.readFileChunks(
            path,
            {
                chunkBytes: EMBEDDED_SHAPE_SCAN_CHUNK_BYTES,
                ...(options.signal ? {signal: options.signal} : {}),
            },
            (chunk) => {
                options.signal?.throwIfAborted();
                const scanBytes = new Uint8Array(tail.byteLength + chunk.byteLength);
                scanBytes.set(tail);
                scanBytes.set(chunk, tail.byteLength);
                if (containsEmbeddedShapeCandidateBytes(scanBytes, false)) {
                    throw CANDIDATE_FOUND;
                }
                const retainedBytes = Math.min(MAX_CANDIDATE_BYTES, scanBytes.byteLength);
                tail = scanBytes.slice(scanBytes.byteLength - retainedBytes);
            },
        );
    } catch (error) {
        if (error === CANDIDATE_FOUND) {
            return true;
        }
        throw error;
    }

    return hasEmbeddedShapeCandidateBytes(tail);
}
