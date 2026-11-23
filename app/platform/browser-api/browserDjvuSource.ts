import { SerializableError } from '@contracts/serializableError';
import type { IDjvuPageSize } from '@contracts/electronApiDjvu';
import type {
    IDjvuComponentRequest,
    IDjvuWorker,
} from '@app/platform/browser-api/djvujsLoader';

/**
 * A DjVu source the browser decoder reads one component at a time.
 *
 * DjVu.js keeps an indirect document as its small DIRM/NAVM index and loads
 * each page or shared dictionary when a page needs it, evicting loaded
 * components above its memory limit. A bundled file becomes the same kind of
 * document: its DIRM loses the bundled bit and the offset table, and the
 * compressed name table after them stays byte for byte. Its components are
 * then read from the stored file by range, so no step holds the whole source.
 * A single-page file has no components and is decoded from its own bytes.
 */

export type TDjvuRangeReader = (offset: number, length: number) => Promise<Uint8Array>;

/** Reads a sibling component of an indirect document by its DIRM file name. */
export interface IDjvuComponentFiles { readComponent(name: string, length?: number): Promise<Uint8Array>; }

export interface IBrowserDjvuSourceLayout {
    /** Bytes DjVu.js receives in createDocument: the index, or a single page. */
    documentBytes: Uint8Array;
    /** Whether DjVu.js loads components through the resolver. */
    hasComponents: boolean;
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
// FORM:DJVU header, INFO chunk header and the ten INFO bytes DjVu.js reads.
const COMPONENT_HEAD_BYTES = FORM_HEADER_BYTES + CHUNK_HEADER_BYTES + 10;
// A component read holds this window, so neighbouring pages and the INFO
// scan read each stored chunk once instead of once per component.
const DJVU_SOURCE_READ_WINDOW_BYTES = 4 * 1024 * 1024;
// Adjacent component heads within this gap share one range read so dense
// multi-page files avoid per-page round-trips while sparse large-page files
// read only their 30-byte INFO headers.
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
function withIffMagic(component: Uint8Array) {
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
        length: number
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

/** Builds the FORM:DJVM index DjVu.js opens as an indirect document. */
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
 * Lays out a DjVu source for the component-reading decoder. `componentFiles`
 * supplies the sibling files of an indirect index; without them an indirect
 * index is refused, because its pages are not in this file.
 */
export async function readBrowserDjvuSourceLayout(options: {
    fileSize: number;
    readRange: TDjvuRangeReader;
    componentFiles?: IDjvuComponentFiles | null;
    signal?: AbortSignal | undefined;
}): Promise<IBrowserDjvuSourceLayout> {
    const {fileSize} = options;
    if (fileSize < FILE_HEADER_BYTES) {
        invalidDjvu('The file is too short to be a DjVu document');
    }
    const rangeStore = createWindowedRangeStore(options.readRange, fileSize);
    const { readRange } = rangeStore;
    const header = await readRange(0, FILE_HEADER_BYTES);
    if (readAscii(header, 0, 8) !== 'AT&TFORM') {
        invalidDjvu('The file is not a DjVu document');
    }
    const formType = readAscii(header, 12);
    if (formType !== 'DJVM') {
        // A single page is one component: the decoder needs all of its bytes.
        const documentBytes = await options.readRange(0, fileSize);
        options.signal?.throwIfAborted();
        // A copy: the document bytes move to the decoder's worker.
        const head = documentBytes.slice(IFF_MAGIC.length, IFF_MAGIC.length + COMPONENT_HEAD_BYTES);
        return {
            documentBytes,
            hasComponents: false,
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
        const readIndirectHead = async ({name}: IDjvuComponentRequest) => (
            (await componentFiles.readComponent(name, IFF_MAGIC.length + COMPONENT_HEAD_BYTES)).subarray(IFF_MAGIC.length)
        );
        return {
            documentBytes: await readRange(0, fileSize),
            hasComponents: true,
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

    const offsetTableBytes = fileCount * 4;
    if (3 + offsetTableBytes > dirmData.byteLength) {
        invalidDjvu('The DjVu DIRM offset table is truncated');
    }
    const offsets = Array.from({length: fileCount}, (_, index) => readUint32(dirmData, 3 + (index * 4)));
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
            return withIffMagic(await readRange(offset, length));
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
                const length = Math.min(COMPONENT_HEAD_BYTES, fileSize - offset);
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
 * Reads one page's size from the start of its FORM:DJVU component, with the
 * defaults DjVu.js applies to short INFO chunks. Width and height are the
 * unsigned 16-bit values the format defines.
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
    if (infoLength < 5 || info.byteLength < 4) {
        invalidDjvu(`DjVu page ${pageNumber} has a truncated INFO chunk`);
    }
    const width = (info[0]! << 8) | info[1]!;
    const height = (info[2]! << 8) | info[3]!;
    let dpi = infoLength > 7 && info.byteLength >= 8 ? info[6]! | (info[7]! << 8) : 300;
    if (dpi < 25 || dpi > 6000) {
        dpi = 300;
    }
    return {
        width,
        height,
        dpi,
    };
}

const workerPageTables = new WeakMap<IDjvuWorker, IDjvuPageSize[]>();

/** Records the page table a worker's document was opened with. */
export function setDjvuWorkerPageSizes(worker: IDjvuWorker, pageSizes: IDjvuPageSize[]) {
    workerPageTables.set(worker, pageSizes);
}

/**
 * The page table read when the worker opened its document. Every caller
 * shares the one array, so callers read it and never modify it.
 */
export function getDjvuWorkerPageSizes(worker: IDjvuWorker): Promise<IDjvuPageSize[]> {
    const pageSizes = workerPageTables.get(worker);
    return pageSizes
        ? Promise.resolve(pageSizes)
        : Promise.reject(new Error('The DjVu worker was not opened by createDjvuWorkerFromPath'));
}
