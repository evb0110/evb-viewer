import type { IDocumentTextPageLayout } from '@contracts/documentTextCatalog';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';

function throwIfAborted(signal?: AbortSignal) {
    signal?.throwIfAborted();
}

/** A page of text: its lines, or how its OCR layout sets them in regions and columns. */
export type TDocxTextPage = string | {
    readonly text: string;
    readonly layout?: IDocumentTextPageLayout;
};

/** Text pages are kept separate so callers do not need to merge a catalog first. */
export type TDocxTextPageSource = Iterable<TDocxTextPage> | AsyncIterable<TDocxTextPage>;

/** Keep renderer-to-main writes small enough for a predictable memory ceiling. */
export const DOCX_STREAM_CHUNK_BYTES = 64 * 1024;

/** A single XML text run is bounded even when one OCR line is unexpectedly huge. */
export const DOCX_MAX_TEXT_RUN_CHARACTERS = 64 * 1024;

export type TDocxParagraphDirection = boolean | ((text: string) => boolean);

const RTL_STRONG_CHARACTER_RE = /(?=\p{L})[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LTR_STRONG_CHARACTER_RE = /(?=\p{L})[A-Za-z\u00C0-\u02AF\u0370-\u052F\u1E00-\u1EFF]/u;

/** Resolve each paragraph independently so one RTL paragraph does not relabel a mixed document. */
export function resolveDocxParagraphDirection(text: string, fallbackRtl = false) {
    const firstRtl = text.search(RTL_STRONG_CHARACTER_RE);
    const firstLtr = text.search(LTR_STRONG_CHARACTER_RE);
    if (firstRtl === -1 && firstLtr === -1) {
        return fallbackRtl && /\p{L}/u.test(text);
    }
    if (firstRtl === -1) {
        return false;
    }
    if (firstLtr === -1) {
        return true;
    }
    return firstRtl < firstLtr;
}

const ZIP32_MAX_VALUE = 0xFFFFFFFF;
const ZIP_MAX_ENTRY_COUNT = 0xFFFF;
const ZIP_MAX_FILE_NAME_BYTES = 0xFFFF;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) === 1
                ? 0xEDB88320 ^ (value >>> 1)
                : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

export function encodeUtf8(value: string) {
    return new TextEncoder().encode(value);
}

function updateCrc32(crc: number, data: Uint8Array) {
    let next = crc;
    for (const byte of data) {
        next = (CRC_TABLE[(next ^ byte) & 0xFF] ?? 0) ^ (next >>> 8);
    }
    return next;
}

export function crc32(data: Uint8Array) {
    return (updateCrc32(0xFFFFFFFF, data) ^ 0xFFFFFFFF) >>> 0;
}

function assertZip32Value(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0 || value > ZIP32_MAX_VALUE) {
        throw new RangeError(`DOCX ZIP ${label} exceeds the ZIP32 safety limit`);
    }
}

export function makeLocalHeader(
    fileName: Uint8Array,
    crc: number,
    size: number,
    usesDataDescriptor = false,
) {
    if (fileName.byteLength > ZIP_MAX_FILE_NAME_BYTES) {
        throw new RangeError('DOCX ZIP file name exceeds the ZIP safety limit');
    }
    assertZip32Value(crc, 'CRC');
    assertZip32Value(size, 'entry size');
    const header = new Uint8Array(30 + fileName.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, usesDataDescriptor ? 0x08 : 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, fileName.byteLength, true);
    view.setUint16(28, 0, true);
    header.set(fileName, 30);
    return header;
}

function makeDataDescriptor(crc: number, size: number) {
    assertZip32Value(crc, 'CRC');
    assertZip32Value(size, 'entry size');
    const descriptor = new Uint8Array(16);
    const view = new DataView(descriptor.buffer);
    view.setUint32(0, 0x08074B50, true);
    view.setUint32(4, crc, true);
    view.setUint32(8, size, true);
    view.setUint32(12, size, true);
    return descriptor;
}

export function makeCentralHeader(
    fileName: Uint8Array,
    crc: number,
    size: number,
    offset: number,
) {
    if (fileName.byteLength > ZIP_MAX_FILE_NAME_BYTES) {
        throw new RangeError('DOCX ZIP file name exceeds the ZIP safety limit');
    }
    assertZip32Value(crc, 'CRC');
    assertZip32Value(size, 'entry size');
    assertZip32Value(offset, 'entry offset');
    const header = new Uint8Array(46 + fileName.byteLength);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014B50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, fileName.byteLength, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    header.set(fileName, 46);
    return header;
}

export function makeEndOfCentralDirectory(entryCount: number, centralSize: number, centralOffset: number) {
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > ZIP_MAX_ENTRY_COUNT) {
        throw new RangeError('DOCX ZIP entry count exceeds the ZIP safety limit');
    }
    assertZip32Value(centralSize, 'central directory size');
    assertZip32Value(centralOffset, 'central directory offset');
    const footer = new Uint8Array(22);
    const view = new DataView(footer.buffer);
    view.setUint32(0, 0x06054B50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return footer;
}

export function escapeXml(text: string) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function* iterateLines(text: string): Generator<string> {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) !== 0x0A) {
            continue;
        }
        const end = text.charCodeAt(index - 1) === 0x0D ? index - 1 : index;
        yield text.slice(start, end);
        start = index + 1;
    }
    yield text.slice(start);
}

function takeTextRun(text: string, start: number) {
    let end = Math.min(start + DOCX_MAX_TEXT_RUN_CHARACTERS, text.length);
    if (end < text.length) {
        const previous = text.charCodeAt(end - 1);
        if (previous >= 0xD800 && previous <= 0xDBFF) {
            end -= 1;
        }
    }
    return end > start ? end : Math.min(start + 1, text.length);
}

function paragraphPrefix(isRtl: boolean) {
    return isRtl
        ? '<w:p><w:pPr><w:bidi/></w:pPr>'
        : '<w:p>';
}

function runPrefix(isRtl: boolean) {
    return isRtl
        ? '<w:r><w:rPr><w:rtl/></w:rPr><w:t xml:space="preserve">'
        : '<w:r><w:t xml:space="preserve">';
}

function paragraphSuffix() {
    return '</w:r></w:p>';
}

export const DOCUMENT_XML_PREFIX = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
const DOCUMENT_PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const DOCUMENT_SECTION_PROPERTIES = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
    + '</w:sectPr>';
// Columns sit in a borderless table that spans the text width, a gutter of
// a quarter inch (360 twips) after each but the last.
const COLUMN_GUTTER_TWIPS = 360;
// Letter width less one-inch margins.
const TEXT_WIDTH_TWIPS = 9360;
const FULL_WIDTH_PERCENT_FIFTIETHS = 5000;

function columnsTableStart(columns: number, rtl: boolean) {
    const borders = [
        'top',
        'left',
        'bottom',
        'right',
        'insideH',
        'insideV',
    ].map(edge => `<w:${edge} w:val="nil"/>`).join('');
    return '<w:tbl><w:tblPr>'
        + (rtl ? '<w:bidiVisual/>' : '')
        + `<w:tblW w:w="${FULL_WIDTH_PERCENT_FIFTIETHS}" w:type="pct"/><w:tblLayout w:type="fixed"/>`
        + `<w:tblBorders>${borders}</w:tblBorders>`
        + `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="${COLUMN_GUTTER_TWIPS}" w:type="dxa"/></w:tblCellMar>`
        + '</w:tblPr><w:tblGrid>'
        + `<w:gridCol w:w="${Math.floor(TEXT_WIDTH_TWIPS / columns)}"/>`.repeat(columns)
        + '</w:tblGrid><w:tr>';
}

/** What the document body holds, in order: markup, or a paragraph of text. */
export type TDocxBodyPart =
    | {
        readonly kind: 'markup';
        readonly xml: string
    }
    | {
        readonly kind: 'paragraph';
        readonly text: string;
        readonly rtl: boolean
    };

/**
 * Lays pages out as the document body, each page on a new page. A page whose
 * OCR layout sets text in columns puts each run of columns in a borderless
 * table of one row, a cell per column, so every viewer shows the columns side
 * by side as the page prints them; Quick Look and Pages ignore Word's section
 * columns.
 */
export class DocxBodyWriter {
    private hasContent = false;

    private endsWithTable = false;

    constructor(private readonly direction: TDocxParagraphDirection) {}

    private isRtl(text: string) {
        return typeof this.direction === 'function'
            ? this.direction(text)
            : resolveDocxParagraphDirection(text, this.direction);
    }

    private* paragraphs(texts: Iterable<string>): Generator<TDocxBodyPart> {
        for (const text of texts) {
            yield {
                kind: 'paragraph',
                text,
                rtl: this.isRtl(text),
            };
            this.endsWithTable = false;
        }
    }

    * page(page: TDocxTextPage): Generator<TDocxBodyPart> {
        if (this.hasContent) {
            yield {
                kind: 'markup',
                xml: DOCUMENT_PAGE_BREAK,
            };
        }
        this.hasContent = true;
        const text = typeof page === 'string' ? page : page.text;
        const regions = typeof page === 'string' || !page.layout || page.layout.regions.length === 0
            ? null
            : page.layout.regions;
        if (!regions) {
            yield* this.paragraphs(iterateLines(text));
            return;
        }
        for (const region of regions) {
            if (region.columns.length === 1) {
                yield* this.paragraphs(region.columns[0]!);
                continue;
            }
            const first = region.columns.flat()[0];
            yield {
                kind: 'markup',
                xml: columnsTableStart(region.columns.length, first !== undefined && this.isRtl(first)),
            };
            const cellWidth = Math.floor(FULL_WIDTH_PERCENT_FIFTIETHS / region.columns.length);
            for (const column of region.columns) {
                yield {
                    kind: 'markup',
                    xml: `<w:tc><w:tcPr><w:tcW w:w="${cellWidth}" w:type="pct"/></w:tcPr>`,
                };
                // A cell holds at least one paragraph.
                yield* this.paragraphs(column.length > 0 ? column : ['']);
                yield {
                    kind: 'markup',
                    xml: '</w:tc>',
                };
            }
            yield {
                kind: 'markup',
                xml: '</w:tr></w:tbl>',
            };
            this.endsWithTable = true;
        }
    }

    /** The body ends with a paragraph, as Word requires after a table. */
    end() {
        return `${this.endsWithTable ? '<w:p/>' : ''}${DOCUMENT_SECTION_PROPERTIES}</w:body></w:document>`;
    }
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
const RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
const DOCUMENT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

interface ICentralDirectoryEntry {
    name: Uint8Array;
    crc: number;
    size: number;
    offset: number;
}

interface IStreamingEntry {
    name: string;
    data?: Uint8Array;
}

/**
 * Stream an uncompressed DOCX ZIP. The document entry uses a data descriptor,
 * because its CRC and size are only known after all text pages have arrived.
 */
export async function* createDocxFromTextChunks(
    pages: TDocxTextPageSource,
    direction: TDocxParagraphDirection = false,
    signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
    throwIfAborted(signal);
    const centralDirectory: ICentralDirectoryEntry[] = [];
    let archiveOffset = 0;
    let pendingChunks: Uint8Array[] = [];
    let pendingByteLength = 0;

    const flushPending = () => {
        if (pendingByteLength === 0) {
            return null;
        }
        if (pendingChunks.length === 1) {
            const chunk = pendingChunks[0];
            pendingChunks = [];
            pendingByteLength = 0;
            return chunk ?? null;
        }
        const chunk = new Uint8Array(pendingByteLength);
        let offset = 0;
        for (const pendingChunk of pendingChunks) {
            chunk.set(pendingChunk, offset);
            offset += pendingChunk.byteLength;
        }
        pendingChunks = [];
        pendingByteLength = 0;
        return chunk;
    };

    const flushPendingToBrowser = async function* (): AsyncGenerator<Uint8Array> {
        const chunk = flushPending();
        if (!chunk) {
            return;
        }
        yield chunk;
        await yieldToBrowser();
        throwIfAborted(signal);
    };

    const emit = async function* (bytes: Uint8Array): AsyncGenerator<Uint8Array> {
        let offset = 0;
        while (offset < bytes.byteLength) {
            throwIfAborted(signal);
            const remainingCapacity = DOCX_STREAM_CHUNK_BYTES - pendingByteLength;
            const chunkLength = Math.min(remainingCapacity, bytes.byteLength - offset);
            const chunk = bytes.subarray(offset, offset + chunkLength);
            pendingChunks.push(chunk);
            pendingByteLength += chunkLength;
            offset += chunkLength;
            archiveOffset += chunkLength;
            assertZip32Value(archiveOffset, 'archive size');
            if (pendingByteLength === DOCX_STREAM_CHUNK_BYTES) {
                yield* flushPendingToBrowser();
            }
        }
    };

    const emitKnownEntry = async function* (entry: IStreamingEntry): AsyncGenerator<Uint8Array> {
        throwIfAborted(signal);
        const data = entry.data ?? new Uint8Array();
        const name = encodeUtf8(entry.name);
        const entryOffset = archiveOffset;
        const header = makeLocalHeader(name, crc32(data), data.byteLength);
        yield* emit(header);
        yield* emit(data);
        centralDirectory.push({
            name,
            crc: crc32(data),
            size: data.byteLength,
            offset: entryOffset,
        });
    };

    throwIfAborted(signal);
    yield* emitKnownEntry({
        name: '[Content_Types].xml',
        data: encodeUtf8(CONTENT_TYPES_XML),
    });
    throwIfAborted(signal);
    yield* emitKnownEntry({
        name: '_rels/.rels',
        data: encodeUtf8(RELS_XML),
    });

    const documentName = encodeUtf8('word/document.xml');
    const documentOffset = archiveOffset;
    throwIfAborted(signal);
    yield* emit(makeLocalHeader(documentName, 0, 0, true));

    let documentCrc = 0xFFFFFFFF;
    let documentSize = 0;
    const emitDocumentBytes = async function* (bytes: Uint8Array): AsyncGenerator<Uint8Array> {
        throwIfAborted(signal);
        documentCrc = updateCrc32(documentCrc, bytes);
        documentSize += bytes.byteLength;
        assertZip32Value(documentSize, 'document.xml entry size');
        yield* emit(bytes);
    };
    const emitDocumentText = async function* (text: string): AsyncGenerator<Uint8Array> {
        throwIfAborted(signal);
        yield* emitDocumentBytes(encodeUtf8(text));
    };
    const emitParagraph = async function* (line: string, isRtl: boolean): AsyncGenerator<Uint8Array> {
        throwIfAborted(signal);
        yield* emitDocumentText(paragraphPrefix(isRtl));
        if (line.length === 0) {
            yield* emitDocumentText(runPrefix(isRtl));
            yield* emitDocumentText(`</w:t>${paragraphSuffix()}`);
            return;
        }

        let start = 0;
        while (start < line.length) {
            throwIfAborted(signal);
            const end = takeTextRun(line, start);
            yield* emitDocumentText(runPrefix(isRtl));
            yield* emitDocumentText(escapeXml(line.slice(start, end)));
            yield* emitDocumentText('</w:t></w:r>');
            start = end;
        }
        yield* emitDocumentText('</w:p>');
    };

    throwIfAborted(signal);
    yield* emitDocumentText(DOCUMENT_XML_PREFIX);
    const body = new DocxBodyWriter(direction);
    for await (const page of pages) {
        throwIfAborted(signal);
        if (typeof page !== 'string' && (typeof page !== 'object' || page === null || typeof page.text !== 'string')) {
            throw new TypeError('DOCX text pages must yield text');
        }
        for (const part of body.page(page)) {
            throwIfAborted(signal);
            if (part.kind === 'markup') yield* emitDocumentText(part.xml);
            else yield* emitParagraph(part.text, part.rtl);
        }
    }

    throwIfAborted(signal);
    yield* emitDocumentText(body.end());
    const finalDocumentCrc = (documentCrc ^ 0xFFFFFFFF) >>> 0;
    yield* emit(makeDataDescriptor(finalDocumentCrc, documentSize));
    centralDirectory.push({
        name: documentName,
        crc: finalDocumentCrc,
        size: documentSize,
        offset: documentOffset,
    });

    yield* emitKnownEntry({
        name: 'word/_rels/document.xml.rels',
        data: encodeUtf8(DOCUMENT_RELS_XML),
    });

    const centralOffset = archiveOffset;
    let centralSize = 0;
    for (const entry of centralDirectory) {
        throwIfAborted(signal);
        const header = makeCentralHeader(entry.name, entry.crc, entry.size, entry.offset);
        centralSize += header.byteLength;
        assertZip32Value(centralSize, 'central directory size');
        yield* emit(header);
    }
    throwIfAborted(signal);
    yield* emit(makeEndOfCentralDirectory(centralDirectory.length, centralSize, centralOffset));
    yield* flushPendingToBrowser();
}
