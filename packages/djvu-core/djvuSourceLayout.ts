import {DEFAULT_DJVU_SOURCE_DPI} from '@contracts/djvuConversionPolicy';
import {SerializableError} from '@contracts/serializableError';
import type {IDjvuPageSize} from '@contracts/electronApiDjvu';
import type {IDjvuComponentRequest} from '@djvu-core/djvuLibreTypes';

/**
 * Streaming range-backed DjVu source layout shared across browser and desktop.
 *
 * A multi-page bundled FORM:DJVM is rewritten into a tiny synthetic indirect
 * index (clearing the bundled bit and stripping the offset table while keeping
 * the compressed DIRM name table and optional NAVM chunk intact). Each page or
 * shared dictionary component is then read on demand by byte range, so opening
 * or navigating a multi-hundred-megabyte book never buffers the whole file.
 */

export type TDjvuRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Reads a sibling component of an indirect document by its DIRM file name. */
export interface IDjvuComponentFiles {
    readComponent(name: string, length?: number): Promise<Uint8Array>;
}

export interface IDjvuSourceLayout {
    /** Bytes supplied to `evb_djvu_open`: the index, or a single-page file. */
    documentBytes: Uint8Array;
    /** Whether components are loaded on demand via `readComponent`. */
    hasComponents: boolean;
    /** True when the source on disk/storage was an indirect multi-file index. */
    isIndirect: boolean;
    /** Component byte offsets inside a bundled FORM:DJVM (for sync readers). */
    bundledOffsets: readonly number[] | null;
    /** Total source file size in bytes. */
    fileSize: number;
    /** Reads one whole component as a standalone `AT&T` file. */
    readComponent(request: IDjvuComponentRequest): Promise<Uint8Array>;
    /** Reads the starts of one or more components in one batched layout pass. */
    readComponentHeads(requests: readonly IDjvuComponentRequest[], signal?: AbortSignal): Promise<Uint8Array[]>;
}

const IFF_MAGIC = 'AT&T';
const CHUNK_HEADER_BYTES = 8;
const FORM_HEADER_BYTES = 12;
const FILE_HEADER_BYTES = IFF_MAGIC.length + FORM_HEADER_BYTES;
const DIRM_BUNDLED_FLAG = 0x80;
const IW44_CODEC_MAJOR = 1;
const IW44_CODEC_MINOR_MAX = 2;
const IW44_DEFAULT_DPI = 100;
// FORM:DJVU header (12) + INFO chunk header (8) + full 10-byte INFO payload
// (also covers FORM:BM44/PM44 header (12) + BM44/PM44 chunk header (8) + 8-byte IW44 header).
export const DJVU_COMPONENT_HEAD_BYTES = FORM_HEADER_BYTES + CHUNK_HEADER_BYTES + 10;
/** Max size of any single page/dictionary component buffered into JS or WASM. */
export const DJVU_MAX_COMPONENT_BYTES = 64 * 1024 * 1024;
/** Max size of a DIRM/NAVM index or indirect index file buffered into JS or WASM. */
export const DJVU_MAX_INDEX_BYTES = 32 * 1024 * 1024;
/** Max size of a legacy DIR0 OLD_BUNDLED file passed whole to DjVuLibre. */
export const DJVU_MAX_LEGACY_BUNDLED_BYTES = 64 * 1024 * 1024;
const DJVU_SOURCE_READ_WINDOW_BYTES = 4 * 1024 * 1024;
const DJVU_HEAD_COALESCE_GAP_BYTES = 256 * 1024;
const DJVU_HEAD_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const DJVU_HEAD_BATCH_MAX_READS = 16;

const asciiDecoder = new TextDecoder('ascii');
const utf8Decoder = new TextDecoder();

function invalidDjvu(message: string): never {
    throw new SerializableError({
        code: 'invalid-djvu',
        message,
    });
}

function componentTooLarge(message: string): never {
    throw new RangeError(message);
}

function readAscii(bytes: Uint8Array, offset: number, length = 4) {
    return asciiDecoder.decode(bytes.subarray(offset, offset + length));
}

function readUint32(bytes: Uint8Array, offset: number) {
    if (offset + 4 > bytes.byteLength) {
        invalidDjvu('DjVu chunk header is truncated');
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function writeAscii(target: Uint8Array, offset: number, text: string) {
    for (let index = 0; index < text.length; index += 1) {
        target[offset + index] = text.charCodeAt(index);
    }
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
    new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value);
}

function paddedChunkLength(dataLength: number) {
    return CHUNK_HEADER_BYTES + dataLength + (dataLength & 1);
}

/** Wraps a component stored without the file magic as a standalone DjVu file. */
export function wrapDjvuComponentWithIffMagic(component: Uint8Array) {
    const output = new Uint8Array(IFF_MAGIC.length + component.byteLength);
    writeAscii(output, 0, IFF_MAGIC);
    output.set(component, IFF_MAGIC.length);
    return output;
}

function abortReason(signal: AbortSignal) {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        void promise.catch(() => undefined);
        return Promise.reject(abortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            void promise.catch(() => undefined);
            reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function createWindowedRangeStore(readRange: TDjvuRangeReader, fileSize: number, windowBytes = DJVU_SOURCE_READ_WINDOW_BYTES) {
    let window: {
        start: number;
        bytes: Uint8Array;
    } | null = null;
    const readExact = async (offset: number, length: number) => {
        const bytes = await readRange(offset, length);
        if (bytes.byteLength !== length) {
            throw new Error(`DjVu source returned ${bytes.byteLength} bytes for a ${length}-byte range`);
        }
        return bytes;
    };
    const tryReadCached = (offset: number, length: number): Uint8Array | null => {
        if (!window || offset < window.start || offset + length > window.start + window.bytes.byteLength) {
            return null;
        }
        const relative = offset - window.start;
        return window.bytes.slice(relative, relative + length);
    };
    return {
        readExact,
        tryReadCached,
        readRange: async (offset: number, length: number) => {
            if (offset < 0 || length < 0 || offset + length > fileSize) {
                invalidDjvu(`DjVu component range ${offset}+${length} is outside the ${fileSize}-byte file`);
            }
            if (length > windowBytes) {
                return readRange(offset, length);
            }
            const cached = tryReadCached(offset, length);
            if (cached) {
                return cached;
            }
            const start = Math.floor(offset / windowBytes) * windowBytes;
            const end = Math.min(fileSize, Math.max(start + windowBytes, offset + length));
            const bytes = await readExact(start, end - start);
            window = {
                start,
                bytes,
            };
            const relative = offset - window.start;
            return window.bytes.slice(relative, relative + length);
        },
    };
}

interface ICoalescedHeadEntry {
    position: number;
    offset: number;
    length: number;
}

interface ICoalescedHeadSpan {
    start: number;
    end: number;
    entries: ICoalescedHeadEntry[];
}

function coalesceHeadRanges(targets: readonly ICoalescedHeadEntry[]): ICoalescedHeadSpan[] {
    if (targets.length === 0) {
        return [];
    }
    const sorted = [...targets].sort((left, right) => left.offset - right.offset);
    const spans: ICoalescedHeadSpan[] = [];
    for (const entry of sorted) {
        const entryEnd = entry.offset + entry.length;
        const current = spans.at(-1);
        if (
            current &&
            entry.offset - current.end <= DJVU_HEAD_COALESCE_GAP_BYTES &&
            Math.max(current.end, entryEnd) - current.start <= DJVU_SOURCE_READ_WINDOW_BYTES
        ) {
            current.end = Math.max(current.end, entryEnd);
            current.entries.push(entry);
        } else {
            spans.push({
                start: entry.offset,
                end: entryEnd,
                entries: [entry],
            });
        }
    }
    return spans;
}

interface IDjvmLayout {
    dirmDataOffset: number;
    dirmDataLength: number;
    navm: {
        offset: number;
        length: number;
    } | null;
}

function parseDir0Entries(documentBytes: Uint8Array): {
    entriesByName: Map<
        string,
        {
            offset: number;
            size: number;
        }
    >;
    firstPageOffset: number | null;
} {
    const entriesByName = new Map<
        string,
        {
            offset: number;
            size: number;
        }
    >();
    let firstPageOffset: number | null = null;
    if (documentBytes.byteLength < FILE_HEADER_BYTES + CHUNK_HEADER_BYTES) {
        return {
            entriesByName,
            firstPageOffset,
        };
    }
    const dir0Len = readUint32(documentBytes, FILE_HEADER_BYTES + 4);
    const dir0Start = FILE_HEADER_BYTES + CHUNK_HEADER_BYTES;
    const dir0End = Math.min(documentBytes.byteLength, dir0Start + dir0Len);
    if (dir0Start + 2 > dir0End) {
        return {
            entriesByName,
            firstPageOffset,
        };
    }
    const count = (documentBytes[dir0Start]! << 8) | documentBytes[dir0Start + 1]!;
    let pos = dir0Start + 2;
    for (let i = 0; i < count && pos < dir0End; i += 1) {
        const nameStart = pos;
        while (pos < dir0End && documentBytes[pos] !== 0) {
            pos += 1;
        }
        if (pos >= dir0End) {
            break;
        }
        const name = utf8Decoder.decode(documentBytes.subarray(nameStart, pos));
        pos += 1; // null terminator
        if (pos + 9 > dir0End) {
            break;
        }
        pos += 1; // iff_file flag
        const offset = readUint32(documentBytes, pos);
        const size = readUint32(documentBytes, pos + 4);
        pos += 8;
        if (offset >= FILE_HEADER_BYTES && offset + FORM_HEADER_BYTES <= documentBytes.byteLength) {
            if (name) {
                entriesByName.set(name, {
                    offset,
                    size,
                });
            }
            if (firstPageOffset === null && readAscii(documentBytes, offset) === 'FORM') {
                const subForm = readAscii(documentBytes, offset + 8);
                if (subForm === 'DJVU' || subForm === 'BM44' || subForm === 'PM44') {
                    firstPageOffset = offset;
                }
            }
        }
    }
    return {
        entriesByName,
        firstPageOffset,
    };
}

/**
 * Extracts a compact page head starting with FORM:<type> + its dimension-bearing
 * chunk (INFO for FORM:DJVU; serial-0 BM44/PM44 for FORM:BM44/FORM:PM44), even
 * when leading metadata/navigation chunks (e.g. ANTa or NDIR) precede it.
 */
function extractPageHeadFromForm(bytes: Uint8Array, formOffset: number): Uint8Array {
    if (formOffset < 0 || formOffset + FORM_HEADER_BYTES > bytes.byteLength) {
        return new Uint8Array(0);
    }
    if (readAscii(bytes, formOffset) !== 'FORM') {
        return bytes.slice(formOffset, Math.min(bytes.byteLength, formOffset + DJVU_COMPONENT_HEAD_BYTES));
    }
    const formLen = readUint32(bytes, formOffset + 4);
    const formType = readAscii(bytes, formOffset + 8);
    const formEnd = Math.min(bytes.byteLength, formOffset + CHUNK_HEADER_BYTES + formLen);
    if (formOffset + FORM_HEADER_BYTES + CHUNK_HEADER_BYTES <= formEnd) {
        const firstChunkId = readAscii(bytes, formOffset + FORM_HEADER_BYTES);
        if (
            (formType === 'DJVU' && firstChunkId === 'INFO') ||
            ((formType === 'BM44' || formType === 'PM44') && (firstChunkId === 'BM44' || firstChunkId === 'PM44'))
        ) {
            return bytes.slice(formOffset, Math.min(formEnd, formOffset + DJVU_COMPONENT_HEAD_BYTES));
        }
    }
    if (formType === 'DJVU' || formType === 'BM44' || formType === 'PM44') {
        let pos = formOffset + FORM_HEADER_BYTES;
        while (pos + CHUNK_HEADER_BYTES <= formEnd) {
            const chunkId = readAscii(bytes, pos);
            const chunkLen = readUint32(bytes, pos + 4);
            const payloadStart = pos + CHUNK_HEADER_BYTES;
            const payloadEnd = Math.min(formEnd, payloadStart + chunkLen);
            const isMatch =
                (formType === 'DJVU' && chunkId === 'INFO') ||
                ((formType === 'BM44' || formType === 'PM44') &&
                    (chunkId === 'BM44' || chunkId === 'PM44') &&
                    payloadStart < payloadEnd &&
                    bytes[payloadStart] === 0);
            if (isMatch) {
                const copyPayloadLen = Math.min(10, payloadEnd - payloadStart);
                const head = new Uint8Array(FORM_HEADER_BYTES + CHUNK_HEADER_BYTES + copyPayloadLen);
                head.set(bytes.subarray(formOffset, formOffset + FORM_HEADER_BYTES), 0);
                head.set(bytes.subarray(pos, pos + CHUNK_HEADER_BYTES), FORM_HEADER_BYTES);
                head.set(bytes.subarray(payloadStart, payloadStart + copyPayloadLen), FORM_HEADER_BYTES + CHUNK_HEADER_BYTES);
                return head;
            }
            const step = paddedChunkLength(chunkLen);
            if (step <= 0) {
                break;
            }
            pos += step;
        }
    }
    return bytes.slice(formOffset, Math.min(formEnd, formOffset + DJVU_COMPONENT_HEAD_BYTES));
}

async function readDjvmLayout(
    readRange: TDjvuRangeReader,
    fileSize: number,
    firstChunkHeader: Uint8Array,
    maxIndexBytes: number,
): Promise<IDjvmLayout> {
    if (readAscii(firstChunkHeader, 0) !== 'DIRM') {
        invalidDjvu('A multi-page DjVu must start with its DIRM or DIR0 chunk');
    }
    const dirmDataLength = readUint32(firstChunkHeader, 4);
    const dirmDataOffset = FILE_HEADER_BYTES + CHUNK_HEADER_BYTES;
    if (dirmDataLength < 3 || dirmDataOffset + dirmDataLength > fileSize) {
        invalidDjvu('The DjVu DIRM chunk is truncated');
    }
    if (dirmDataLength > maxIndexBytes) {
        componentTooLarge(`The DjVu DIRM chunk (${dirmDataLength} bytes) exceeds the ${maxIndexBytes}-byte limit`);
    }
    const nextChunkOffset = FILE_HEADER_BYTES + paddedChunkLength(dirmDataLength);
    let navm: IDjvmLayout['navm'] = null;
    if (nextChunkOffset + CHUNK_HEADER_BYTES <= fileSize) {
        const nextHeader = await readRange(nextChunkOffset, CHUNK_HEADER_BYTES);
        if (readAscii(nextHeader, 0) === 'NAVM') {
            const navmLength = readUint32(nextHeader, 4);
            if (nextChunkOffset + CHUNK_HEADER_BYTES + navmLength > fileSize) {
                invalidDjvu('The DjVu NAVM chunk is truncated');
            }
            if (navmLength > maxIndexBytes) {
                componentTooLarge(`The DjVu NAVM chunk (${navmLength} bytes) exceeds the ${maxIndexBytes}-byte limit`);
            }
            navm = {
                offset: nextChunkOffset,
                length: paddedChunkLength(navmLength),
            };
        }
    }
    return {
        dirmDataOffset,
        dirmDataLength,
        navm,
    };
}

/** Builds a synthetic indirect FORM:DJVM index from rewritten DIRM data + optional NAVM chunk. */
function buildIndirectIndex(dirmData: Uint8Array, navmChunk: Uint8Array | null) {
    const dirmChunkLength = paddedChunkLength(dirmData.byteLength);
    const formDataLength = 4 + dirmChunkLength + (navmChunk?.byteLength ?? 0);
    const output = new Uint8Array(IFF_MAGIC.length + CHUNK_HEADER_BYTES + formDataLength);
    writeAscii(output, 0, `${IFF_MAGIC}FORM`);
    writeUint32(output, 8, formDataLength);
    writeAscii(output, 12, 'DJVMDIRM');
    writeUint32(output, 20, dirmData.byteLength);
    output.set(dirmData, 24);
    if (navmChunk) {
        output.set(navmChunk, FILE_HEADER_BYTES + dirmChunkLength);
    }
    return output;
}

export function isIndirectDjvuHeader(bytes: Uint8Array) {
    return (
        bytes.byteLength >= 25 &&
        readAscii(bytes, 0, 8) === 'AT&TFORM' &&
        readAscii(bytes, 12, 8) === 'DJVMDIRM' &&
        (bytes[24]! & DIRM_BUNDLED_FLAG) === 0
    );
}

/**
 * Lays out a DjVu source for on-demand component reading by `DjVuLibre` WASM.
 */
export async function readDjvuSourceLayout(options: {
    fileSize: number;
    readRange: TDjvuRangeReader;
    componentFiles?: IDjvuComponentFiles | null;
    signal?: AbortSignal | undefined;
    maxComponentBytes?: number;
    maxIndexBytes?: number;
    maxLegacyBundledBytes?: number;
}): Promise<IDjvuSourceLayout> {
    const {fileSize} = options;
    const maxComponentBytes = options.maxComponentBytes ?? DJVU_MAX_COMPONENT_BYTES;
    const maxIndexBytes = options.maxIndexBytes ?? DJVU_MAX_INDEX_BYTES;
    const maxLegacyBundledBytes = options.maxLegacyBundledBytes ?? DJVU_MAX_LEGACY_BUNDLED_BYTES;
    if (fileSize < FILE_HEADER_BYTES) {
        invalidDjvu('The file is too short to be a DjVu document');
    }
    const rangeStore = createWindowedRangeStore(options.readRange, fileSize);
    const {readRange} = rangeStore;
    const header = await readRange(0, FILE_HEADER_BYTES);
    if (readAscii(header, 0, 8) !== 'AT&TFORM') {
        invalidDjvu('The file is not a DjVu document');
    }
    const formType = readAscii(header, 12);
    if (formType !== 'DJVM') {
        if (fileSize > maxComponentBytes) {
            componentTooLarge(`Single-page DjVu (${fileSize} bytes) exceeds the ${maxComponentBytes}-byte limit`);
        }
        const documentBytes = await options.readRange(0, fileSize);
        options.signal?.throwIfAborted();
        const head = extractPageHeadFromForm(documentBytes, IFF_MAGIC.length);
        return {
            documentBytes,
            hasComponents: false,
            isIndirect: false,
            bundledOffsets: null,
            fileSize,
            readComponent: () => Promise.reject(new Error('A single-page DjVu has no components')),
            async readComponentHeads(requests, signal) {
                signal?.throwIfAborted();
                return requests.map(() => head);
            },
        };
    }

    if (fileSize < FILE_HEADER_BYTES + CHUNK_HEADER_BYTES) {
        invalidDjvu('The multi-page DjVu header is truncated');
    }
    const firstChunkHeader = await readRange(FILE_HEADER_BYTES, CHUNK_HEADER_BYTES);
    const firstChunkId = readAscii(firstChunkHeader, 0);
    if (firstChunkId === 'DIR0') {
        const dir0Length = readUint32(firstChunkHeader, 4);
        if (FILE_HEADER_BYTES + CHUNK_HEADER_BYTES + dir0Length > fileSize) {
            invalidDjvu('The DjVu DIR0 chunk is truncated');
        }
        if (fileSize > maxLegacyBundledBytes) {
            componentTooLarge(`Legacy bundled DjVu (${fileSize} bytes) exceeds the ${maxLegacyBundledBytes}-byte limit`);
        }
        const documentBytes = await awaitWithSignal(options.readRange(0, fileSize), options.signal);
        options.signal?.throwIfAborted();
        const {entriesByName, firstPageOffset} = parseDir0Entries(documentBytes);
        return {
            documentBytes,
            // Expose the multi-page DIR0 directory so shared preview openers fetch
            // all pages' geometries via getComponentDirectory + readComponentHeads.
            hasComponents: true,
            isIndirect: false,
            bundledOffsets: null,
            fileSize,
            async readComponent({name}) {
                const entry = entriesByName.get(name);
                if (!entry || entry.offset + entry.size > documentBytes.byteLength) {
                    invalidDjvu(`Legacy DIR0 component ${name} has no valid offset`);
                }
                if (IFF_MAGIC.length + entry.size > maxComponentBytes) {
                    componentTooLarge(
                        `DjVu component ${name} (${IFF_MAGIC.length + entry.size} bytes) exceeds the ${maxComponentBytes}-byte limit`,
                    );
                }
                const slice = documentBytes.subarray(entry.offset, entry.offset + entry.size);
                return readAscii(slice, 0, 4) === IFF_MAGIC ? slice.slice() : wrapDjvuComponentWithIffMagic(slice);
            },
            async readComponentHeads(requests, signal) {
                signal?.throwIfAborted();
                return requests.map((request) => {
                    const offset =
                        (request.name ? entriesByName.get(request.name)?.offset : undefined) ??
                        (request.index === 0 ? (firstPageOffset ?? undefined) : undefined);
                    if (offset === undefined) {
                        return new Uint8Array(0);
                    }
                    return extractPageHeadFromForm(documentBytes, offset);
                });
            },
        };
    }

    const layout = await readDjvmLayout(readRange, fileSize, firstChunkHeader, maxIndexBytes);
    options.signal?.throwIfAborted();
    const dirmData = await readRange(layout.dirmDataOffset, layout.dirmDataLength);
    const navmChunk = layout.navm ? await readRange(layout.navm.offset, Math.min(layout.navm.length, fileSize - layout.navm.offset)) : null;
    const dflags = dirmData[0]!;
    const fileCount = (dirmData[1]! << 8) | dirmData[2]!;

    if ((dflags & DIRM_BUNDLED_FLAG) === 0) {
        const componentFiles = options.componentFiles;
        if (!componentFiles) {
            throw new SerializableError({
                code: 'djvu-components-required',
                message: 'This DjVu index keeps its pages in separate files; open it together with them.',
            });
        }
        if (fileSize > maxIndexBytes) {
            componentTooLarge(`Indirect DjVu index (${fileSize} bytes) exceeds the ${maxIndexBytes}-byte limit`);
        }
        const readIndirectHead = async ({name}: IDjvuComponentRequest) =>
            (await componentFiles.readComponent(name, IFF_MAGIC.length + DJVU_COMPONENT_HEAD_BYTES)).subarray(IFF_MAGIC.length);
        const documentBytes = await awaitWithSignal(readRange(0, fileSize), options.signal);
        options.signal?.throwIfAborted();
        return {
            documentBytes,
            hasComponents: true,
            isIndirect: true,
            bundledOffsets: null,
            fileSize,
            async readComponent({name}) {
                const head = await componentFiles.readComponent(name, FILE_HEADER_BYTES);
                let formLen: number;
                let prefixBytes: number;
                if (
                    head.byteLength >= IFF_MAGIC.length + CHUNK_HEADER_BYTES &&
                    (readAscii(head, 0, 8) === 'AT&TFORM' || readAscii(head, 0, 8) === 'SDJVFORM')
                ) {
                    prefixBytes = IFF_MAGIC.length;
                    formLen = readUint32(head, 8);
                } else if (head.byteLength >= CHUNK_HEADER_BYTES && readAscii(head, 0, 4) === 'FORM') {
                    prefixBytes = 0;
                    formLen = readUint32(head, 4);
                } else {
                    invalidDjvu(`DjVu component ${name} does not start with a valid FORM header`);
                }
                if (formLen < 4) {
                    invalidDjvu(`DjVu component ${name} has a truncated FORM header`);
                }
                const declaredBytes = prefixBytes + CHUNK_HEADER_BYTES + formLen;
                if (declaredBytes > maxComponentBytes) {
                    componentTooLarge(`DjVu component ${name} (${declaredBytes} bytes) exceeds the ${maxComponentBytes}-byte limit`);
                }
                const bytes = await componentFiles.readComponent(name, declaredBytes);
                if (bytes.byteLength > maxComponentBytes) {
                    componentTooLarge(`DjVu component ${name} exceeds the ${maxComponentBytes}-byte limit`);
                }
                return bytes;
            },
            async readComponentHeads(requests, signal) {
                signal?.throwIfAborted();
                const heads: Uint8Array[] = [];
                for (let start = 0; start < requests.length; start += DJVU_HEAD_BATCH_MAX_READS) {
                    signal?.throwIfAborted();
                    const batch = requests.slice(start, start + DJVU_HEAD_BATCH_MAX_READS);
                    const batchHeads = await awaitWithSignal(Promise.all(batch.map(readIndirectHead)), signal);
                    signal?.throwIfAborted();
                    heads.push(...batchHeads);
                }
                return heads;
            },
        };
    }

    const dirmVersion = dflags & 0x7f;
    // DIRM v0 stores a 4-byte offset + 3-byte size per bundled file; v1 stores 4-byte offsets only.
    const recordBytes = dirmVersion === 0 ? 7 : 4;
    const offsetTableBytes = fileCount * recordBytes;
    if (3 + offsetTableBytes > dirmData.byteLength) {
        invalidDjvu('The DjVu DIRM offset table is truncated');
    }
    const offsets = Array.from({length: fileCount}, (_, index) => readUint32(dirmData, 3 + index * recordBytes));
    const indirectDirm = new Uint8Array(dirmData.byteLength - offsetTableBytes);
    indirectDirm[0] = dflags & ~DIRM_BUNDLED_FLAG;
    indirectDirm.set(dirmData.subarray(1, 3), 1);
    indirectDirm.set(dirmData.subarray(3 + offsetTableBytes), 3);

    const componentOffset = (index: number) => {
        const offset = offsets[index];
        if (offset === undefined || offset < FILE_HEADER_BYTES || offset + FORM_HEADER_BYTES > fileSize) {
            invalidDjvu(`DjVu component ${index} has no valid offset`);
        }
        return offset;
    };

    return {
        documentBytes: buildIndirectIndex(indirectDirm, navmChunk),
        hasComponents: true,
        isIndirect: false,
        bundledOffsets: offsets,
        fileSize,
        async readComponent({index}) {
            const offset = componentOffset(index);
            const formHeader = await readRange(offset, CHUNK_HEADER_BYTES);
            if (readAscii(formHeader, 0) !== 'FORM') {
                invalidDjvu(`DjVu component ${index} is not a FORM chunk`);
            }
            const length = CHUNK_HEADER_BYTES + readUint32(formHeader, 4);
            if (offset + length > fileSize) {
                invalidDjvu(`DjVu component ${index} runs past the end of the file`);
            }
            if (IFF_MAGIC.length + length > maxComponentBytes) {
                componentTooLarge(
                    `DjVu component ${index} (${IFF_MAGIC.length + length} bytes) exceeds the ${maxComponentBytes}-byte limit`,
                );
            }
            return wrapDjvuComponentWithIffMagic(await readRange(offset, length));
        },
        async readComponentHeads(requests, signal) {
            signal?.throwIfAborted();
            if (requests.length === 0) {
                return [];
            }
            const heads = new Array<Uint8Array>(requests.length);
            const missing: ICoalescedHeadEntry[] = [];
            for (const [position, request] of requests.entries()) {
                const offset = componentOffset(request.index);
                const length = Math.min(DJVU_COMPONENT_HEAD_BYTES, fileSize - offset);
                const cached = rangeStore.tryReadCached(offset, length);
                if (cached) {
                    heads[position] = cached;
                } else {
                    missing.push({
                        position,
                        offset,
                        length,
                    });
                }
            }
            const spans = coalesceHeadRanges(missing);
            let spanIndex = 0;
            while (spanIndex < spans.length) {
                signal?.throwIfAborted();
                const batch: ICoalescedHeadSpan[] = [];
                let batchBytes = 0;
                while (spanIndex < spans.length && batch.length < DJVU_HEAD_BATCH_MAX_READS) {
                    const span = spans[spanIndex]!;
                    const spanBytes = span.end - span.start;
                    if (batch.length > 0 && batchBytes + spanBytes > DJVU_HEAD_BATCH_MAX_BYTES) {
                        break;
                    }
                    batch.push(span);
                    batchBytes += spanBytes;
                    spanIndex += 1;
                }
                const buffers = await awaitWithSignal(
                    Promise.all(batch.map((span) => rangeStore.readExact(span.start, span.end - span.start))),
                    signal,
                );
                signal?.throwIfAborted();
                for (const [batchIndex, span] of batch.entries()) {
                    const buffer = buffers[batchIndex]!;
                    for (const entry of span.entries) {
                        const relative = entry.offset - span.start;
                        heads[entry.position] = buffer.slice(relative, relative + entry.length);
                    }
                }
            }
            return heads;
        },
    };
}

/**
 * Reads one page's upright size and DPI from the start of its FORM:DJVU,
 * FORM:BM44, or FORM:PM44 component.
 * Width and height are unsigned 16-bit values, swapped when INFO orientation is 90° or 270°.
 */
export function parseDjvuPageHead(head: Uint8Array, pageNumber: number): IDjvuPageSize {
    if (head.byteLength < FORM_HEADER_BYTES + CHUNK_HEADER_BYTES || readAscii(head, 0) !== 'FORM') {
        invalidDjvu(`DjVu page ${pageNumber} does not start with a valid FORM header`);
    }
    const formType = readAscii(head, 8);
    const firstChunkId = readAscii(head, 12);
    if (formType === 'DJVU') {
        if (firstChunkId !== 'INFO') {
            invalidDjvu(`DjVu page ${pageNumber} does not start with an INFO chunk`);
        }
        const infoLength = readUint32(head, 16);
        const info = head.subarray(FORM_HEADER_BYTES + CHUNK_HEADER_BYTES);
        if (infoLength < 5 || info.byteLength < Math.min(infoLength, 10)) {
            invalidDjvu(`DjVu page ${pageNumber} has a truncated INFO chunk`);
        }
        const rawWidth = (info[0]! << 8) | info[1]!;
        const rawHeight = (info[2]! << 8) | info[3]!;
        if (rawWidth <= 0 || rawHeight <= 0) {
            invalidDjvu(`DjVu page ${pageNumber} has invalid INFO dimensions`);
        }
        let dpi = infoLength > 7 && info.byteLength >= 8 ? info[6]! | (info[7]! << 8) : DEFAULT_DJVU_SOURCE_DPI;
        if (dpi < 25 || dpi > 6000) {
            dpi = DEFAULT_DJVU_SOURCE_DPI;
        }
        const orientation = infoLength >= 10 && info.byteLength >= 10 ? info[9]! & 7 : 1;
        const swap = orientation === 5 || orientation === 6;
        return {
            width: swap ? rawHeight : rawWidth,
            height: swap ? rawWidth : rawHeight,
            dpi,
        };
    }
    if (formType === 'BM44' || formType === 'PM44') {
        if (firstChunkId !== 'BM44' && firstChunkId !== 'PM44') {
            invalidDjvu(`DjVu page ${pageNumber} does not start with a BM44 or PM44 chunk`);
        }
        const chunkLength = readUint32(head, 16);
        const payload = head.subarray(FORM_HEADER_BYTES + CHUNK_HEADER_BYTES);
        if (chunkLength < 8 || payload.byteLength < 8) {
            invalidDjvu(`DjVu page ${pageNumber} has a truncated ${firstChunkId} header`);
        }
        const serial = payload[0]!;
        const major = payload[2]! & 0x7f;
        const minor = payload[3]!;
        const width = (payload[4]! << 8) | payload[5]!;
        const height = (payload[6]! << 8) | payload[7]!;
        if (serial !== 0 || major !== IW44_CODEC_MAJOR || minor > IW44_CODEC_MINOR_MAX || width <= 0 || height <= 0) {
            invalidDjvu(`DjVu page ${pageNumber} has an invalid ${firstChunkId} IW44 header`);
        }
        return {
            width,
            height,
            dpi: IW44_DEFAULT_DPI,
        };
    }
    invalidDjvu(`DjVu page ${pageNumber} has unsupported FORM type ${formType}`);
}
