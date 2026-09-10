/* eslint-disable custom/file-naming -- Stable sidecar path is part of the native index wire contract. */
// Keep this low-level encoder independent from the application's contracts
// package. These values and shapes are the stable on-disk wire format.
const COMPACT_SEARCH_INDEX_HEADER_SIZE = 64;
const COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE = 24;
const COMPACT_SEARCH_INDEX_MAGIC = 'EVBSIDX2';
const COMPACT_SEARCH_INDEX_SCHEMA_VERSION = 2;
const MAX_UINT32 = 0xFFFFFFFF;
const MAX_UINT16 = 0xFFFF;

interface ICompactSearchIndexTextSource {
    kind: number;
    version: number;
}

interface ICompactSearchIndexPage {
    pageNumber: number;
    text: string;
}

interface ICompactSearchIndexPayload {
    documentRevision: string;
    pageCount: number;
    pages: readonly ICompactSearchIndexPage[];
    textSource?: ICompactSearchIndexTextSource;
}

interface ICompactSearchIndexPageRecord {
    pageNumber: number;
    textUtf16Length: number;
    byteOffset: bigint;
    byteLength: bigint;
}

function assertUInt32(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
        throw new Error(`${label} must fit in an unsigned 32-bit integer`);
    }
}

function assertUInt16(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT16) {
        throw new Error(`${label} must fit in an unsigned 16-bit integer`);
    }
}

function encodeTextSource(textSource: ICompactSearchIndexTextSource | undefined) {
    if (!textSource) {
        return 0;
    }
    assertUInt16(textSource.kind, 'textSource.kind');
    assertUInt16(textSource.version, 'textSource.version');
    return textSource.kind + textSource.version * 0x10000;
}

export function createCompactSearchIndexEncoding(
    payload: ICompactSearchIndexPayload,
    checkCanceled: () => void = () => undefined,
) {
    const pages = [...payload.pages].sort((left, right) => left.pageNumber - right.pageNumber);
    const seenPageNumbers = new Set<number>();
    for (const page of pages) {
        checkCanceled();
        assertUInt32(page.pageNumber, 'pageNumber');
        if (page.pageNumber <= 0) {
            throw new Error('pageNumber must be positive');
        }
        if (seenPageNumbers.has(page.pageNumber)) {
            throw new Error(`Duplicate pageNumber in compact search index: ${page.pageNumber}`);
        }
        if (typeof page.text !== 'string') {
            throw new Error('page text must be a string');
        }
        assertUInt32(page.text.length, 'textUtf16Length');
        seenPageNumbers.add(page.pageNumber);
    }

    if (!payload.documentRevision) {
        throw new Error('documentRevision is required for compact search index');
    }
    assertUInt32(payload.pageCount, 'pageCount');
    assertUInt32(pages.length, 'pageRecordCount');

    const revisionTokenBytes = Buffer.from(payload.documentRevision, 'utf8');
    assertUInt32(revisionTokenBytes.byteLength, 'revisionTokenByteLength');
    const tableSize = pages.length * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
    const pageTableOffset = COMPACT_SEARCH_INDEX_HEADER_SIZE + revisionTokenBytes.byteLength;
    const textDataOffset = pageTableOffset + tableSize;
    let nextByteOffset = BigInt(textDataOffset);
    const records: ICompactSearchIndexPageRecord[] = pages.map((page) => {
        checkCanceled();
        const byteLength = BigInt(Buffer.byteLength(page.text, 'utf8'));
        const record = {
            pageNumber: page.pageNumber,
            textUtf16Length: page.text.length,
            byteOffset: nextByteOffset,
            byteLength,
        };
        nextByteOffset += byteLength;
        return record;
    });

    const headerAndTable = Buffer.alloc(textDataOffset);
    headerAndTable.write(COMPACT_SEARCH_INDEX_MAGIC, 0, 'ascii');
    headerAndTable.writeUInt32LE(COMPACT_SEARCH_INDEX_SCHEMA_VERSION, 8);
    headerAndTable.writeUInt32LE(COMPACT_SEARCH_INDEX_HEADER_SIZE, 12);
    headerAndTable.writeUInt32LE(payload.pageCount, 16);
    headerAndTable.writeUInt32LE(records.length, 20);
    headerAndTable.writeUInt32LE(encodeTextSource(payload.textSource), 24);
    headerAndTable.writeUInt32LE(revisionTokenBytes.byteLength, 28);
    headerAndTable.writeBigUInt64LE(BigInt(COMPACT_SEARCH_INDEX_HEADER_SIZE), 32);
    headerAndTable.writeBigUInt64LE(BigInt(pageTableOffset), 40);
    headerAndTable.writeBigUInt64LE(BigInt(textDataOffset), 48);
    headerAndTable.writeBigUInt64LE(0n, 56);
    revisionTokenBytes.copy(headerAndTable, COMPACT_SEARCH_INDEX_HEADER_SIZE);

    records.forEach((record, recordIndex) => {
        checkCanceled();
        const offset = pageTableOffset + recordIndex * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
        headerAndTable.writeUInt32LE(record.pageNumber, offset);
        headerAndTable.writeUInt32LE(record.textUtf16Length, offset + 4);
        headerAndTable.writeBigUInt64LE(record.byteOffset, offset + 8);
        headerAndTable.writeBigUInt64LE(record.byteLength, offset + 16);
    });

    return {
        headerAndTable,
        pages,
        records,
    };
}
