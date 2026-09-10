import {open} from 'fs/promises';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_MAX_PAGE_TEXT_BYTES,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    type ICompactSearchIndexPage,
    type ICompactSearchIndexPageRecord,
    type ICompactSearchIndexPayload,
    type ICompactSearchIndexTextSource,
} from '@contracts/searchIndexSidecar';
import {createCompactSearchIndexEncoding} from '@node-runtime/searchIndexSidecar';
import {
    readBufferAt,
    throwIfAborted,
    writeBufferAt,
} from '@electron/features/search/searchIndexSidecarIo';
import {syncFileHandleForDurability} from '@electron/utils/syncFileHandleForDurability';

const MAX_UINT16 = 0xFFFF;
const utf8Decoder = new TextDecoder('utf-8', {fatal: true});

function decodeTextSource(value: number): ICompactSearchIndexTextSource {
    return {
        kind: value & MAX_UINT16,
        version: Math.floor(value / 0x10000),
    };
}

export async function writeCompactSearchIndexPayload(
    targetPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    const {
        headerAndTable,
        pages,
        records,
    } = createCompactSearchIndexEncoding(payload, () => throwIfAborted(signal));

    const file = await open(targetPath, 'w');
    try {
        await writeBufferAt(file, headerAndTable, 0, signal);
        for (const [
            pageIndex,
            page,
        ] of pages.entries()) {
            throwIfAborted(signal);
            const record = records[pageIndex];
            if (!record) {
                throw new Error(`Missing compact search index record for page ${page.pageNumber}`);
            }
            const textBuffer = Buffer.from(page.text, 'utf8');
            await writeBufferAt(file, textBuffer, Number(record.byteOffset), signal);
        }
        await syncFileHandleForDurability(file);
    } finally {
        await file.close();
    }
}

export function parseCompactSearchIndexHeader(header: Buffer) {
    if (header.toString('ascii', 0, 8) !== COMPACT_SEARCH_INDEX_MAGIC) {
        return null;
    }

    const schemaVersion = header.readUInt32LE(8);
    if (schemaVersion !== COMPACT_SEARCH_INDEX_SCHEMA_VERSION) {
        return null;
    }
    const headerSize = header.readUInt32LE(12);
    if (headerSize !== COMPACT_SEARCH_INDEX_HEADER_SIZE) {
        return null;
    }

    return {
        pageCount: header.readUInt32LE(16),
        pageRecordCount: header.readUInt32LE(20),
        textSource: decodeTextSource(header.readUInt32LE(24)),
        revisionTokenByteLength: header.readUInt32LE(28),
        revisionTokenByteOffset: header.readBigUInt64LE(32),
        pageTableOffset: header.readBigUInt64LE(40),
        textDataOffset: header.readBigUInt64LE(48),
    };
}

function bigintToSafeNumber(value: bigint) {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : null;
}

export function parseCompactSearchIndexPageRecords(
    table: Buffer,
    fileSize: number,
    textDataOffset: number,
) {
    const records: ICompactSearchIndexPageRecord[] = [];
    const seenPageNumbers = new Set<number>();
    const fileSizeBigInt = BigInt(fileSize);

    for (
        let offset = 0;
        offset < table.byteLength;
        offset += COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE
    ) {
        const pageNumber = table.readUInt32LE(offset);
        const textUtf16Length = table.readUInt32LE(offset + 4);
        const byteOffset = table.readBigUInt64LE(offset + 8);
        const byteLength = table.readBigUInt64LE(offset + 16);
        if (pageNumber <= 0 || seenPageNumbers.has(pageNumber)) {
            return null;
        }
        if (
            byteOffset < BigInt(textDataOffset)
            || byteOffset + byteLength > fileSizeBigInt
            || byteLength > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
            return null;
        }
        seenPageNumbers.add(pageNumber);
        records.push({
            pageNumber: requirePageNumber(pageNumber),
            textUtf16Length,
            byteOffset,
            byteLength,
        });
    }

    return records;
}

export async function readCompactSearchIndexPages(
    file: Awaited<ReturnType<typeof open>>,
    records: readonly ICompactSearchIndexPageRecord[],
    signal?: AbortSignal,
) {
    const pages: ICompactSearchIndexPage[] = [];
    for (const record of records) {
        throwIfAborted(signal);
        const byteLength = bigintToSafeNumber(record.byteLength);
        const byteOffset = bigintToSafeNumber(record.byteOffset);
        if (byteLength === null || byteOffset === null) {
            return null;
        }
        const textBuffer = Buffer.alloc(byteLength);
        if (!(await readBufferAt(file, textBuffer, byteOffset, signal))) {
            return null;
        }
        let text: string;
        try {
            text = utf8Decoder.decode(textBuffer);
        } catch {
            return null;
        }
        if (text.length !== record.textUtf16Length) {
            return null;
        }
        pages.push({
            pageNumber: record.pageNumber,
            text,
        });
    }
    return pages.sort((left, right) => left.pageNumber - right.pageNumber);
}

export function compactSearchIndexRecordsFitLoadBudget(
    records: readonly ICompactSearchIndexPageRecord[],
    maxTotalTextBytes: number,
) {
    let totalTextBytes = BigInt(0);
    for (const record of records) {
        if (record.byteLength > BigInt(COMPACT_SEARCH_INDEX_MAX_PAGE_TEXT_BYTES)) {
            return false;
        }
        totalTextBytes += record.byteLength;
        if (totalTextBytes > BigInt(maxTotalTextBytes)) {
            return false;
        }
    }
    return true;
}
