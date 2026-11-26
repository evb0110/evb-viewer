import { SerializableError } from '@contracts/serializableError';
import type { IDjvuPageSize } from '@contracts/electronApiDjvu';
import type { IDjvuComponentRequest } from '@djvu-core/djvuLibreTypes';

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
export interface IDjvuComponentFiles { readComponent(name: string, length?: number): Promise<Uint8Array>; }

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
// FORM:DJVU header (12) + INFO chunk header (8) + full 10-byte INFO payload.
export const DJVU_COMPONENT_HEAD_BYTES = FORM_HEADER_BYTES + CHUNK_HEADER_BYTES + 10;
const DJVU_SOURCE_READ_WINDOW_BYTES = 4 * 1024 * 1024;
const DJVU_HEAD_COALESCE_GAP_BYTES = 256 * 1024;
const DJVU_HEAD_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const DJVU_HEAD_BATCH_MAX_READS = 16;

const asciiDecoder = new TextDecoder('ascii');

function invalidDjvu(message: string): never {
    throw new SerializableError({
        code: 'invalid-djvu',
        message,
    });
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
        promise.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}

function createWindowedRangeStore(
    readRange: TDjvuRangeReader,
    fileSize: number,
    windowBytes = DJVU_SOURCE_READ_WINDOW_BYTES,
) {
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
            current
            && entry.offset - current.end <= DJVU_HEAD_COALESCE_GAP_BYTES
            && Math.max(current.end, entryEnd) - current.start <= DJVU_SOURCE_READ_WINDOW_BYTES
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

async function readDjvmLayout(readRange: TDjvuRangeReader, fileSize: number): Promise<IDjvmLayout> {
    const dirmHeader = await readRange(FILE_HEADER_BYTES, CHUNK_HEADER_BYTES);
    if (readAscii(dirmHeader, 0) !== 'DIRM') {
        invalidDjvu('A multi-page DjVu must start with its DIRM chunk');
    }
    const dirmDataLength = readUint32(dirmHeader, 4);
    const dirmDataOffset = FILE_HEADER_BYTES + CHUNK_HEADER_BYTES;
    if (dirmDataLength < 3 || dirmDataOffset + dirmDataLength > fileSize) {
        invalidDjvu('The DjVu DIRM chunk is truncated');
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
    return bytes.byteLength >= 25
        && readAscii(bytes, 0, 8) === 'AT&TFORM'
        && readAscii(bytes, 12, 8) === 'DJVMDIRM'
        && (bytes[24]! & DIRM_BUNDLED_FLAG) === 0;
}

/**
 * Lays out a DjVu source for on-demand component reading by `DjVuLibre` WASM.
 */
export async function readDjvuSourceLayout(options: {
    fileSize: number;
    readRange: TDjvuRangeReader;
    componentFiles?: IDjvuComponentFiles | null;
    signal?: AbortSignal | undefined;
}): Promise<IDjvuSourceLayout> {
    const {fileSize} = options;
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
        const documentBytes = await options.readRange(0, fileSize);
        options.signal?.throwIfAborted();
        const head = documentBytes.slice(IFF_MAGIC.length, IFF_MAGIC.length + DJVU_COMPONENT_HEAD_BYTES);
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

    const layout = await readDjvmLayout(readRange, fileSize);
    options.signal?.throwIfAborted();
    const dirmData = await readRange(layout.dirmDataOffset, layout.dirmDataLength);
    const navmChunk = layout.navm
        ? await readRange(layout.navm.offset, Math.min(layout.navm.length, fileSize - layout.navm.offset))
        : null;
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
        const readIndirectHead = async ({name}: IDjvuComponentRequest) => (
            (await componentFiles.readComponent(name, IFF_MAGIC.length + DJVU_COMPONENT_HEAD_BYTES)).subarray(IFF_MAGIC.length)
        );
        const documentBytes = await awaitWithSignal(readRange(0, fileSize), options.signal);
        options.signal?.throwIfAborted();
        return {
            documentBytes,
            hasComponents: true,
            isIndirect: true,
            bundledOffsets: null,
            fileSize,
            readComponent: ({name}) => componentFiles.readComponent(name),
            async readComponentHeads(requests, signal) {
                signal?.throwIfAborted();
                const heads: Uint8Array[] = [];
                for (let start = 0; start < requests.length; start += DJVU_HEAD_BATCH_MAX_READS) {
                    signal?.throwIfAborted();
                    const batch = requests.slice(start, start + DJVU_HEAD_BATCH_MAX_READS);
                    const batchHeads = await awaitWithSignal(
                        Promise.all(batch.map(readIndirectHead)),
                        signal,
                    );
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
    const offsets = Array.from({length: fileCount}, (_, index) => readUint32(dirmData, 3 + (index * recordBytes)));
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
            return wrapDjvuComponentWithIffMagic(await readRange(offset, length));
        },
        async readComponentHeads(requests, signal) {
            signal?.throwIfAborted();
            if (requests.length === 0) {
                return [];
            }
            const heads = new Array<Uint8Array>(requests.length);
            const missing: ICoalescedHeadEntry[] = [];
            for (const [
                position,
                request,
            ] of requests.entries()) {
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
                    Promise.all(batch.map(span => rangeStore.readExact(span.start, span.end - span.start))),
                    signal,
                );
                signal?.throwIfAborted();
                for (const [
                    batchIndex,
                    span,
                ] of batch.entries()) {
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
 * Reads one page's upright size and DPI from the start of its FORM:DJVU component.
 * Width and height are unsigned 16-bit values, swapped when INFO orientation is 90° or 270°.
 */
export function parseDjvuPageHead(head: Uint8Array, pageNumber: number): IDjvuPageSize {
    if (head.byteLength < FORM_HEADER_BYTES + CHUNK_HEADER_BYTES
        || readAscii(head, 0) !== 'FORM'
        || readAscii(head, 8) !== 'DJVU'
        || readAscii(head, 12) !== 'INFO') {
        invalidDjvu(`DjVu page ${pageNumber} does not start with an INFO chunk`);
    }
    const infoLength = readUint32(head, 16);
    const info = head.subarray(FORM_HEADER_BYTES + CHUNK_HEADER_BYTES);
    if (infoLength < 5 || info.byteLength < Math.min(infoLength, 10)) {
        invalidDjvu(`DjVu page ${pageNumber} has a truncated INFO chunk`);
    }
    const rawWidth = (info[0]! << 8) | info[1]!;
    const rawHeight = (info[2]! << 8) | info[3]!;
    let dpi = infoLength > 7 && info.byteLength >= 8 ? info[6]! | (info[7]! << 8) : 300;
    if (dpi < 25 || dpi > 6000) {
        dpi = 300;
    }
    const orientation = infoLength >= 10 && info.byteLength >= 10 ? (info[9]! & 7) : 1;
    const swap = orientation === 5 || orientation === 6;
    return {
        width: swap ? rawHeight : rawWidth,
        height: swap ? rawWidth : rawHeight,
        dpi,
    };
}
