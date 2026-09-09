import {
    open,
    rm,
    stat,
} from 'fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {isAbortError} from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { syncFileHandleForDurability } from '@electron/utils/syncFileHandleForDurability';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    compactSearchIndexRecordsFitLoadBudget as recordsFitLoadBudget,
    parseCompactSearchIndexHeader as parseHeader,
    parseCompactSearchIndexPageRecords as parsePageRecords,
    readCompactSearchIndexPages as readPages,
    writeCompactSearchIndexPayload,
} from '@electron/features/search/searchIndexSidecarLegacy';
import {
    readBufferAt,
    throwIfAborted,
    writeBufferAt,
} from '@electron/features/search/searchIndexSidecarIo';
import {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_MAX_PAGE_RECORDS as MAX_COMPACT_SEARCH_INDEX_PAGE_RECORDS,
    COMPACT_SEARCH_INDEX_MAX_TOTAL_TEXT_BYTES as MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
    getCompactSearchIndexPath,
    type ICompactSearchIndexPage,
    type ICompactSearchIndexPageRecord,
    type ICompactSearchIndexPayload,
    type ICompactSearchIndexCoverageMetadata,
    type ICompactSearchIndexStreamingFinalizeOptions,
    type ICompactSearchIndexStreamingOptions,
    type ICompactSearchIndexTextSource,
} from '@contracts/searchIndexSidecar';

export {
    COMPACT_SEARCH_INDEX_HEADER_SIZE,
    COMPACT_SEARCH_INDEX_MAGIC,
    COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE,
    COMPACT_SEARCH_INDEX_SCHEMA_VERSION,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC,
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE,
    COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_MAGIC,
    COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION,
    getCompactSearchIndexPath,
};
export type {
    ICompactSearchIndexCoverageMetadata,
    ICompactSearchIndexPage,
    ICompactSearchIndexPayload,
    ICompactSearchIndexStreamingFinalizeOptions,
    ICompactSearchIndexStreamingOptions,
    ICompactSearchIndexTextSource,
};

const MAX_UINT16 = 0xFFFF;
const log = createLogger('search-index-sidecar');

export interface ICompactSearchIndex {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pages: ICompactSearchIndexPage[];
    textSource: ICompactSearchIndexTextSource;
    /** Present when the sidecar uses the v3 streaming format. */
    coverage?: ICompactSearchIndexCoverageMetadata;
}

export interface ILoadCompactSearchIndexOptions {
    documentRevision?: TDocumentRevisionToken;
    expectedPageCount?: number;
    minSourceMtimeMs?: number;
    requiredTextSource?: ICompactSearchIndexTextSource;
    metadataOnly?: boolean;
    maxTotalTextBytes?: number;
    signal?: AbortSignal;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function decodeTextSource(value: number): ICompactSearchIndexTextSource {
    return {
        kind: value & MAX_UINT16,
        version: Math.floor(value / 0x10000),
    };
}

function textSourcesMatch(
    actual: ICompactSearchIndexTextSource,
    required: ICompactSearchIndexTextSource | undefined,
) {
    return required === undefined
        || (
            actual.kind === required.kind
            && actual.version === required.version
        );
}

function safeNumberFromBigInt(value: bigint, label: string) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${label} does not fit in a safe file offset`);
    }
    return Number(value);
}

function assertStreamingUInt32(value: number, label: string) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xFFFFFFFF) {
        throw new Error(`${label} must fit in an unsigned 32-bit integer`);
    }
}

function encodeStreamingTextSource(textSource: ICompactSearchIndexTextSource | undefined) {
    if (textSource === undefined) {
        return 0;
    }
    assertStreamingUInt32(textSource.kind, 'textSource.kind');
    assertStreamingUInt32(textSource.version, 'textSource.version');
    if (textSource.kind > MAX_UINT16 || textSource.version > MAX_UINT16) {
        throw new Error('textSource fields must fit in an unsigned 16-bit integer');
    }
    return textSource.kind + textSource.version * 0x10000;
}

interface IStreamingSearchIndexLayout {
    pageCount: number;
    revisionToken: Buffer;
    directoryOffset: bigint;
    directoryLength: bigint;
    textDataOffset: bigint;
    textSourceValue: number;
}

function createStreamingSearchIndexLayout(options: ICompactSearchIndexStreamingOptions) {
    if (!isPositiveInteger(options.pageCount)) {
        throw new Error('pageCount must be a positive integer');
    }
    assertStreamingUInt32(options.pageCount, 'pageCount');
    if (!options.documentRevision) {
        throw new Error('documentRevision is required for compact search index');
    }

    const revisionToken = Buffer.from(options.documentRevision, 'utf8');
    if (revisionToken.byteLength === 0 || revisionToken.byteLength > 8_192) {
        throw new Error('documentRevision must contain between 1 and 8192 UTF-8 bytes');
    }
    const directoryOffset = BigInt(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE)
        + BigInt(revisionToken.byteLength);
    const directoryLength = BigInt(options.pageCount)
        * BigInt(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
    const textDataOffset = directoryOffset + directoryLength;
    safeNumberFromBigInt(textDataOffset, 'compact search index directory end');

    return {
        pageCount: options.pageCount,
        revisionToken,
        directoryOffset,
        directoryLength,
        textDataOffset,
        textSourceValue: encodeStreamingTextSource(options.textSource),
    } satisfies IStreamingSearchIndexLayout;
}

function createStreamingHeader(
    layout: IStreamingSearchIndexLayout,
    pagesWritten: number,
    flags: number,
    footerOffset: bigint,
) {
    const header = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE);
    header.write(COMPACT_SEARCH_INDEX_STREAMING_MAGIC, 0, 'ascii');
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    header.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE, 12);
    header.writeUInt32LE(layout.pageCount, 16);
    header.writeUInt32LE(pagesWritten, 20);
    header.writeUInt32LE(flags, 24);
    header.writeUInt32LE(layout.revisionToken.byteLength, 28);
    header.writeBigUInt64LE(BigInt(COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE), 32);
    header.writeBigUInt64LE(layout.directoryOffset, 40);
    header.writeBigUInt64LE(layout.textDataOffset, 48);
    header.writeBigUInt64LE(footerOffset, 56);
    return header;
}

function createStreamingFooter(
    layout: IStreamingSearchIndexLayout,
    flags: number,
    pagesScanned: number,
    pagesWritten: number,
    bytesWritten: bigint,
    fileLength: bigint,
) {
    const footer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
    footer.write(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC, 0, 'ascii');
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION, 8);
    footer.writeUInt32LE(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE, 12);
    footer.writeUInt32LE(flags, 16);
    footer.writeUInt32LE(layout.textSourceValue, 20);
    footer.writeUInt32LE(pagesWritten, 24);
    footer.writeBigUInt64LE(bytesWritten, 32);
    footer.writeBigUInt64LE(fileLength, 40);
    footer.writeBigUInt64LE(layout.directoryLength, 48);
    footer.writeBigUInt64LE(BigInt(pagesScanned), 56);
    return footer;
}

export interface ICompactSearchIndexStreamingWriteResult extends ICompactSearchIndexCoverageMetadata {
    indexPath: string;
    pageCount: number;
}

export interface ICompactSearchIndexStreamingWriter {
    readonly indexPath: string;
    readonly temporaryPath: string;
    readonly pageCount: number;
    writePage(page: ICompactSearchIndexPage): Promise<void>;
    writePages(pages: Iterable<ICompactSearchIndexPage> | AsyncIterable<ICompactSearchIndexPage>): Promise<void>;
    finalize(options: ICompactSearchIndexStreamingFinalizeOptions): Promise<ICompactSearchIndexStreamingWriteResult>;
    abort(): Promise<void>;
}

class CompactSearchIndexStreamingWriter implements ICompactSearchIndexStreamingWriter {
    private file: FileHandle | null;
    private nextTextOffset: bigint;
    private pagesWritten = 0;
    private bytesWritten = 0n;
    private result: ICompactSearchIndexStreamingWriteResult | null = null;
    private aborted = false;

    constructor(
        private readonly layout: IStreamingSearchIndexLayout,
        private readonly options: ICompactSearchIndexStreamingOptions,
        readonly indexPath: string,
        readonly temporaryPath: string,
        file: FileHandle,
    ) {
        this.file = file;
        this.nextTextOffset = layout.textDataOffset;
    }

    get pageCount() {
        return this.layout.pageCount;
    }

    private assertOpen() {
        if (this.aborted) {
            throw new Error('Compact search index writer has been aborted');
        }
        if (this.result !== null || this.file === null) {
            throw new Error('Compact search index writer has already been finalized');
        }
    }

    private async fail(error: unknown): Promise<never> {
        await this.abort();
        throw error;
    }

    async writePage(page: ICompactSearchIndexPage) {
        try {
            this.assertOpen();
            throwIfAborted(this.options.signal);
            if (!isPositiveInteger(page.pageNumber) || page.pageNumber > this.layout.pageCount) {
                throw new Error(`pageNumber must be between 1 and ${this.layout.pageCount}`);
            }
            if (typeof page.text !== 'string') {
                throw new Error('page text must be a string');
            }
            assertStreamingUInt32(page.text.length, 'textUtf16Length');
            const byteLength = Buffer.byteLength(page.text, 'utf8');
            const file = this.file;
            if (file === null) {
                throw new Error('Compact search index writer is closed');
            }
            const recordOffset = this.layout.directoryOffset
                + BigInt(page.pageNumber - 1)
                * BigInt(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
            const recordBuffer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
            const recordPosition = safeNumberFromBigInt(recordOffset, 'directory entry offset');
            if (!(await readBufferAt(file, recordBuffer, recordPosition, this.options.signal))) {
                throw new Error('Compact search index directory is truncated');
            }
            if (
                recordBuffer.readBigUInt64LE(0) !== 0n
                || recordBuffer.readBigUInt64LE(8) !== 0n
                || recordBuffer.readUInt32LE(16) !== 0
                || recordBuffer.readUInt32LE(20) !== 0
            ) {
                throw new Error(`Duplicate pageNumber in compact search index: ${page.pageNumber}`);
            }

            const textBuffer = byteLength === 0 ? null : Buffer.from(page.text, 'utf8');
            const nextTextEnd = this.nextTextOffset + BigInt(byteLength);
            safeNumberFromBigInt(nextTextEnd, 'page text end offset');
            if (textBuffer !== null) {
                await writeBufferAt(
                    file,
                    textBuffer,
                    safeNumberFromBigInt(this.nextTextOffset, 'page text offset'),
                    this.options.signal,
                );
                recordBuffer.writeBigUInt64LE(this.nextTextOffset, 0);
                recordBuffer.writeBigUInt64LE(BigInt(textBuffer.byteLength), 8);
            }
            recordBuffer.writeUInt32LE(page.text.length, 16);
            recordBuffer.writeUInt32LE(1, 20);
            await writeBufferAt(file, recordBuffer, recordPosition, this.options.signal);
            this.nextTextOffset = nextTextEnd;
            if (byteLength > 0) {
                this.pagesWritten += 1;
            }
            this.bytesWritten += BigInt(byteLength);
        } catch (error) {
            return this.fail(error);
        }
    }

    async writePages(pages: Iterable<ICompactSearchIndexPage> | AsyncIterable<ICompactSearchIndexPage>) {
        try {
            for await (const page of pages) {
                await this.writePage(page);
            }
        } catch (error) {
            return this.fail(error);
        }
    }

    async finalize(finalizeOptions: ICompactSearchIndexStreamingFinalizeOptions) {
        if (this.result !== null) {
            return this.result;
        }
        try {
            this.assertOpen();
            throwIfAborted(this.options.signal);
            const file = this.file;
            if (file === null) {
                throw new Error('Compact search index writer is closed');
            }
            assertStreamingUInt32(this.pagesWritten, 'pagesWritten');
            const pagesScanned = finalizeOptions.pagesScanned;
            if (!Number.isSafeInteger(pagesScanned)
                || pagesScanned < 0
                || pagesScanned > this.layout.pageCount) {
                throw new Error(`pagesScanned must be between 0 and ${this.layout.pageCount}`);
            }
            const partialCoverage = finalizeOptions.partialCoverage === true
                || pagesScanned < this.layout.pageCount;
            const truncatedCoverage = finalizeOptions.truncatedCoverage === true;
            const flags = COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE
                | (partialCoverage ? COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE : 0)
                | (truncatedCoverage ? COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE : 0);
            const footerOffset = this.nextTextOffset;
            const fileLength = footerOffset + BigInt(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
            const bytesWrittenNumber = safeNumberFromBigInt(this.bytesWritten, 'bytesWritten');
            safeNumberFromBigInt(fileLength, 'compact search index file length');
            const footer = createStreamingFooter(
                this.layout,
                flags,
                pagesScanned,
                this.pagesWritten,
                this.bytesWritten,
                fileLength,
            );
            await writeBufferAt(
                file,
                footer,
                safeNumberFromBigInt(footerOffset, 'completion footer offset'),
                this.options.signal,
            );
            const header = createStreamingHeader(this.layout, this.pagesWritten, flags, footerOffset);
            await writeBufferAt(file, header, 0, this.options.signal);
            await syncFileHandleForDurability(file);
            await file.close();
            this.file = null;
            await finalizeOptions.beforePublish?.();
            throwIfAborted(this.options.signal);
            await atomicReplace(this.temporaryPath, this.indexPath);
            this.result = {
                indexPath: this.indexPath,
                pageCount: this.layout.pageCount,
                flags,
                pagesScanned,
                pagesWritten: this.pagesWritten,
                bytesWritten: bytesWrittenNumber,
                complete: true,
                partialCoverage,
                truncatedCoverage,
            };
            return this.result;
        } catch (error) {
            return this.fail(error);
        }
    }

    async abort() {
        if (this.aborted) {
            return;
        }
        this.aborted = true;
        const file = this.file;
        this.file = null;
        await file?.close().catch(() => undefined);
        await rm(this.temporaryPath, {force: true}).catch(() => undefined);
    }
}

export async function openCompactSearchIndexWriter(
    pdfPath: string,
    options: ICompactSearchIndexStreamingOptions,
): Promise<ICompactSearchIndexStreamingWriter> {
    return openCompactSearchIndexWriterAtPath(getCompactSearchIndexPath(pdfPath), options);
}

async function openCompactSearchIndexWriterAtPath(
    indexPath: string,
    options: ICompactSearchIndexStreamingOptions,
): Promise<ICompactSearchIndexStreamingWriter> {
    throwIfAborted(options.signal);
    const layout = createStreamingSearchIndexLayout(options);
    const temporaryPath = makeSiblingTempPath(indexPath);
    let file: FileHandle | null = null;
    try {
        file = await open(temporaryPath, 'wx+');
        await file.truncate(safeNumberFromBigInt(
            layout.textDataOffset,
            'compact search index directory end',
        ));
        await writeBufferAt(
            file,
            createStreamingHeader(layout, 0, 0, 0n),
            0,
            options.signal,
        );
        await writeBufferAt(
            file,
            layout.revisionToken,
            COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE,
            options.signal,
        );
        return new CompactSearchIndexStreamingWriter(
            layout,
            options,
            indexPath,
            temporaryPath,
            file,
        );
    } catch (error) {
        await file?.close().catch(() => undefined);
        await rm(temporaryPath, {force: true}).catch(() => undefined);
        throw error;
    }
}

export async function persistCompactSearchIndexStreaming(
    pdfPath: string,
    options: ICompactSearchIndexStreamingOptions,
    pages: Iterable<ICompactSearchIndexPage> | AsyncIterable<ICompactSearchIndexPage>,
) {
    const writer = await openCompactSearchIndexWriter(pdfPath, options);
    try {
        await writer.writePages(pages);
        return await writer.finalize({
            pagesScanned: options.pagesScanned ?? options.pageCount,
            ...(options.partialCoverage === undefined
                ? {}
                : {partialCoverage: options.partialCoverage}),
            ...(options.truncatedCoverage === undefined
                ? {}
                : {truncatedCoverage: options.truncatedCoverage}),
            ...(options.beforePublish === undefined
                ? {}
                : {beforePublish: options.beforePublish}),
        });
    } catch (error) {
        await writer.abort();
        throw error;
    }
}

interface IStreamingSearchIndexHeader {
    pageCount: number;
    pagesWritten: number;
    flags: number;
    revisionTokenByteLength: number;
    revisionTokenByteOffset: bigint;
    directoryOffset: bigint;
    textDataOffset: bigint;
    footerOffset: bigint;
}

interface IStreamingSearchIndexFooter {
    flags: number;
    textSource: ICompactSearchIndexTextSource;
    pagesScanned: number;
    pagesWritten: number;
    bytesWritten: bigint;
    fileLength: bigint;
    directoryLength: bigint;
}

function parseStreamingHeader(header: Buffer): IStreamingSearchIndexHeader | null {
    if (
        header.toString('ascii', 0, 8) !== COMPACT_SEARCH_INDEX_STREAMING_MAGIC
        || header.readUInt32LE(8) !== COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION
        || header.readUInt32LE(12) !== COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE
    ) {
        return null;
    }
    return {
        pageCount: header.readUInt32LE(16),
        pagesWritten: header.readUInt32LE(20),
        flags: header.readUInt32LE(24),
        revisionTokenByteLength: header.readUInt32LE(28),
        revisionTokenByteOffset: header.readBigUInt64LE(32),
        directoryOffset: header.readBigUInt64LE(40),
        textDataOffset: header.readBigUInt64LE(48),
        footerOffset: header.readBigUInt64LE(56),
    };
}

function parseStreamingFooter(footer: Buffer): IStreamingSearchIndexFooter | null {
    if (
        footer.toString('ascii', 0, 8) !== COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC
        || footer.readUInt32LE(8) !== COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION
        || footer.readUInt32LE(12) !== COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE
        || footer.readUInt32LE(28) !== 0
    ) {
        return null;
    }
    return {
        flags: footer.readUInt32LE(16),
        textSource: decodeTextSource(footer.readUInt32LE(20)),
        pagesWritten: footer.readUInt32LE(24),
        bytesWritten: footer.readBigUInt64LE(32),
        fileLength: footer.readBigUInt64LE(40),
        directoryLength: footer.readBigUInt64LE(48),
        pagesScanned: bigintToSafeNumber(footer.readBigUInt64LE(56)) ?? -1,
    };
}

function bigintToSafeNumber(value: bigint) {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : null;
}

const STREAMING_DIRECTORY_READ_CHUNK_BYTES = 48 * 1024;

interface IStreamingDirectoryScanResult {
    records: ICompactSearchIndexPageRecord[];
    pagesWritten: number;
    bytesWritten: bigint;
}

async function scanStreamingDirectory(
    file: FileHandle,
    metadata: IStreamingSearchIndexHeader,
    footer: IStreamingSearchIndexFooter,
    fileSize: number,
    includeRecords: boolean,
    signal?: AbortSignal,
): Promise<IStreamingDirectoryScanResult | null> {
    const directoryOffset = bigintToSafeNumber(metadata.directoryOffset);
    const textDataOffset = bigintToSafeNumber(metadata.textDataOffset);
    const footerOffset = bigintToSafeNumber(metadata.footerOffset);
    if (directoryOffset === null || textDataOffset === null || footerOffset === null) {
        return null;
    }
    const directoryLengthBigInt = BigInt(metadata.pageCount)
        * BigInt(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
    const directoryLength = bigintToSafeNumber(directoryLengthBigInt);
    if (directoryLength === null) {
        return null;
    }
    const records: ICompactSearchIndexPageRecord[] = [];
    const chunkSize = STREAMING_DIRECTORY_READ_CHUNK_BYTES
        - (STREAMING_DIRECTORY_READ_CHUNK_BYTES % COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
    const buffer = Buffer.alloc(chunkSize);
    let pagesWritten = 0;
    let bytesWritten = 0n;
    for (let directoryCursor = 0; directoryCursor < directoryLength;) {
        throwIfAborted(signal);
        const bytesToRead = Math.min(chunkSize, directoryLength - directoryCursor);
        const chunk = bytesToRead === buffer.byteLength
            ? buffer
            : Buffer.alloc(bytesToRead);
        if (!(await readBufferAt(file, chunk, directoryOffset + directoryCursor, signal))) {
            return null;
        }
        for (
            let chunkOffset = 0;
            chunkOffset < bytesToRead;
            chunkOffset += COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE
        ) {
            const pageNumber = Math.floor(directoryCursor / COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE)
                + Math.floor(chunkOffset / COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE)
                + 1;
            const byteOffset = chunk.readBigUInt64LE(chunkOffset);
            const byteLength = chunk.readBigUInt64LE(chunkOffset + 8);
            const textUtf16Length = chunk.readUInt32LE(chunkOffset + 16);
            const reserved = chunk.readUInt32LE(chunkOffset + 20);
            if (reserved > 1) {
                return null;
            }
            if (reserved === 0) {
                if (byteOffset !== 0n || textUtf16Length !== 0) {
                    return null;
                }
                continue;
            }
            if (byteLength === 0n) {
                if (byteOffset !== 0n || textUtf16Length !== 0) {
                    return null;
                }
                continue;
            }
            if (textUtf16Length === 0) {
                return null;
            }
            const byteEnd = byteOffset + byteLength;
            if (
                byteOffset < BigInt(textDataOffset)
                || byteEnd > BigInt(footerOffset)
                || byteLength > BigInt(Number.MAX_SAFE_INTEGER)
            ) {
                return null;
            }
            pagesWritten += 1;
            bytesWritten += byteLength;
            if (includeRecords) {
                records.push({
                    pageNumber: requirePageNumber(pageNumber),
                    textUtf16Length,
                    byteOffset,
                    byteLength,
                });
            }
        }
        directoryCursor += bytesToRead;
    }
    if (
        pagesWritten !== metadata.pagesWritten
        || pagesWritten !== footer.pagesWritten
        || bytesWritten !== footer.bytesWritten
        || footer.directoryLength !== directoryLengthBigInt
        || footer.fileLength !== BigInt(fileSize)
    ) {
        return null;
    }
    return {
        records,
        pagesWritten,
        bytesWritten,
    };
}

function isFreshEnough(
    sidecarMtimeMs: number | undefined,
    minSourceMtimeMs: number | undefined,
) {
    if (typeof minSourceMtimeMs !== 'number' || !Number.isFinite(minSourceMtimeMs)) {
        return true;
    }
    return typeof sidecarMtimeMs === 'number'
        && Number.isFinite(sidecarMtimeMs)
        && sidecarMtimeMs >= minSourceMtimeMs;
}

function coversExpectedPages(
    pageCount: number,
    pageRecordCount: number,
    expectedPageCount: number | undefined,
) {
    if (!isPositiveInteger(expectedPageCount)) {
        return true;
    }
    return pageCount >= expectedPageCount && pageRecordCount >= expectedPageCount;
}

function streamingCoverage(
    flags: number,
    pagesScanned: number,
    pagesWritten: number,
    bytesWritten: bigint,
): ICompactSearchIndexCoverageMetadata | null {
    const knownFlags = COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE
        | COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE
        | COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE;
    if ((flags & ~knownFlags) !== 0 || (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE) === 0) {
        return null;
    }
    const bytesWrittenNumber = bigintToSafeNumber(bytesWritten);
    if (bytesWrittenNumber === null) {
        return null;
    }
    const partialCoverage = (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE) !== 0;
    const truncatedCoverage = (flags & COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE) !== 0;
    return {
        flags,
        pagesScanned,
        pagesWritten,
        bytesWritten: bytesWrittenNumber,
        complete: true,
        partialCoverage,
        truncatedCoverage,
    };
}

function coversStreamingExpectedPages(
    metadata: IStreamingSearchIndexHeader,
    coverage: ICompactSearchIndexCoverageMetadata,
    expectedPageCount: number | undefined,
) {
    if (!isPositiveInteger(expectedPageCount)) {
        return true;
    }
    if (
        metadata.pageCount < expectedPageCount
        || coverage.pagesScanned < expectedPageCount
        || (expectedPageCount === metadata.pageCount
            && (coverage.partialCoverage || coverage.truncatedCoverage))
    ) {
        return false;
    }
    return true;
}

async function loadStreamingCompactSearchIndex(
    file: FileHandle,
    indexStat: { size: number },
    metadata: IStreamingSearchIndexHeader,
    documentRevision: TDocumentRevisionToken,
    expectedPageCount: number | undefined,
    requiredTextSource: ICompactSearchIndexTextSource | undefined,
    metadataOnly: boolean | undefined,
    maxTotalTextBytes: number | undefined,
    signal: AbortSignal | undefined,
): Promise<ICompactSearchIndex | null> {
    if (
        metadata.pageCount <= 0
        || metadata.pagesWritten > metadata.pageCount
        || metadata.revisionTokenByteLength <= 0
        || metadata.revisionTokenByteLength > 8_192
        || !Number.isSafeInteger(indexStat.size)
    ) {
        return null;
    }
    const revisionTokenByteOffset = bigintToSafeNumber(metadata.revisionTokenByteOffset);
    const directoryOffset = bigintToSafeNumber(metadata.directoryOffset);
    const textDataOffset = bigintToSafeNumber(metadata.textDataOffset);
    const footerOffset = bigintToSafeNumber(metadata.footerOffset);
    if (
        revisionTokenByteOffset === null
        || directoryOffset === null
        || textDataOffset === null
        || footerOffset === null
        || metadata.footerOffset === 0n
    ) {
        return null;
    }
    const revisionTokenEnd = revisionTokenByteOffset + metadata.revisionTokenByteLength;
    const directoryLengthBigInt = BigInt(metadata.pageCount)
        * BigInt(COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE);
    const directoryLength = bigintToSafeNumber(directoryLengthBigInt);
    const directoryEnd = directoryLength === null ? null : directoryOffset + directoryLength;
    const footerEnd = footerOffset + COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE;
    if (
        directoryLength === null
        || directoryEnd === null
        || !Number.isSafeInteger(revisionTokenEnd)
        || !Number.isSafeInteger(directoryEnd)
        || !Number.isSafeInteger(footerEnd)
        || revisionTokenByteOffset < COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE
        || revisionTokenEnd > directoryOffset
        || directoryOffset < revisionTokenEnd
        || textDataOffset !== directoryEnd
        || footerOffset < textDataOffset
        || footerEnd !== indexStat.size
    ) {
        return null;
    }

    const footerBuffer = Buffer.alloc(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE);
    if (!(await readBufferAt(file, footerBuffer, footerOffset, signal))) {
        return null;
    }
    const footer = parseStreamingFooter(footerBuffer);
    if (
        footer === null
        || footer.flags !== metadata.flags
        || footer.pagesWritten !== metadata.pagesWritten
        || footer.pagesScanned < 0
        || footer.pagesScanned > metadata.pageCount
        || footer.fileLength !== BigInt(indexStat.size)
        || footer.directoryLength !== directoryLengthBigInt
        || footerOffset !== bigintToSafeNumber(footer.fileLength - BigInt(COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE))
    ) {
        return null;
    }
    const coverage = streamingCoverage(
        metadata.flags,
        footer.pagesScanned,
        metadata.pagesWritten,
        footer.bytesWritten,
    );
    if (
        coverage === null
        || !coversStreamingExpectedPages(metadata, coverage, expectedPageCount)
        || !textSourcesMatch(footer.textSource, requiredTextSource)
        || footer.bytesWritten !== BigInt(footerOffset - textDataOffset)
        || (!coverage.partialCoverage && coverage.pagesScanned < metadata.pageCount)
    ) {
        return null;
    }

    const revisionTokenBuffer = Buffer.alloc(metadata.revisionTokenByteLength);
    if (!(await readBufferAt(file, revisionTokenBuffer, revisionTokenByteOffset, signal))) {
        return null;
    }
    if (revisionTokenBuffer.toString('utf8') !== documentRevision) {
        return null;
    }

    const scan = await scanStreamingDirectory(
        file,
        metadata,
        footer,
        indexStat.size,
        !metadataOnly,
        signal,
    );
    if (scan === null) {
        return null;
    }
    if (maxTotalTextBytes !== undefined) {
        if (!Number.isFinite(maxTotalTextBytes)) {
            return null;
        }
        const textBudget = BigInt(Math.max(0, Math.floor(maxTotalTextBytes)));
        if (scan.bytesWritten > textBudget) {
            return null;
        }
    }
    if (metadataOnly) {
        return {
            documentRevision,
            pageCount: metadata.pageCount,
            pages: [],
            textSource: footer.textSource,
            coverage,
        };
    }
    const pages = await readPages(file, scan.records, signal);
    if (!pages) {
        return null;
    }
    return {
        documentRevision,
        pageCount: metadata.pageCount,
        pages,
        textSource: footer.textSource,
        coverage,
    };
}

export async function persistCompactSearchIndex(
    pdfPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const indexPath = getCompactSearchIndexPath(pdfPath);
    const tempPath = makeSiblingTempPath(indexPath);
    try {
        await writeCompactSearchIndexPayload(tempPath, payload, signal);
        throwIfAborted(signal);
        await atomicReplace(tempPath, indexPath);
        log.debug(`Compact search index saved successfully: ${indexPath}`);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function persistCompactSearchIndexBestEffort(
    pdfPath: string,
    payload: ICompactSearchIndexPayload,
    signal?: AbortSignal,
) {
    try {
        await persistCompactSearchIndex(pdfPath, payload, signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Failed to save compact search index: ${getErrorMessage(error)}`);
    }
}

export async function loadCompactSearchIndex(
    pdfPath: string,
    options: ILoadCompactSearchIndexOptions = {},
): Promise<ICompactSearchIndex | null> {
    const indexPath = getCompactSearchIndexPath(pdfPath);
    const {
        documentRevision,
        expectedPageCount,
        minSourceMtimeMs,
        metadataOnly,
        maxTotalTextBytes,
        requiredTextSource,
        signal,
    } = options;
    if (!documentRevision) {
        return null;
    }

    try {
        throwIfAborted(signal);
        const indexStat = await stat(indexPath);
        if (!isFreshEnough(indexStat.mtimeMs, minSourceMtimeMs)) {
            return null;
        }

        const file = await open(indexPath, 'r');
        try {
            const header = Buffer.alloc(COMPACT_SEARCH_INDEX_HEADER_SIZE);
            if (!(await readBufferAt(file, header, 0, signal))) {
                return null;
            }

            const streamingMetadata = parseStreamingHeader(header);
            if (streamingMetadata) {
                return await loadStreamingCompactSearchIndex(
                    file,
                    indexStat,
                    streamingMetadata,
                    documentRevision,
                    expectedPageCount,
                    requiredTextSource,
                    metadataOnly,
                    maxTotalTextBytes,
                    signal,
                );
            }

            const metadata = parseHeader(header);
            if (
                !metadata
                || !coversExpectedPages(metadata.pageCount, metadata.pageRecordCount, expectedPageCount)
                || !textSourcesMatch(metadata.textSource, requiredTextSource)
                || metadata.pageRecordCount > MAX_COMPACT_SEARCH_INDEX_PAGE_RECORDS
            ) {
                return null;
            }

            const revisionTokenByteOffset = bigintToSafeNumber(metadata.revisionTokenByteOffset);
            const pageTableOffset = bigintToSafeNumber(metadata.pageTableOffset);
            const textDataOffset = bigintToSafeNumber(metadata.textDataOffset);
            if (
                revisionTokenByteOffset === null
                || pageTableOffset === null
                || textDataOffset === null
                || metadata.revisionTokenByteLength <= 0
            ) {
                return null;
            }
            const revisionTokenEnd = revisionTokenByteOffset + metadata.revisionTokenByteLength;
            const tableSize = metadata.pageRecordCount * COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE;
            const tableEnd = pageTableOffset + tableSize;
            if (
                revisionTokenByteOffset < COMPACT_SEARCH_INDEX_HEADER_SIZE
                || revisionTokenEnd > pageTableOffset
                || textDataOffset < tableEnd
                || !Number.isSafeInteger(tableSize)
                || !Number.isSafeInteger(tableEnd)
                || indexStat.size < textDataOffset
            ) {
                return null;
            }

            const revisionTokenBuffer = Buffer.alloc(metadata.revisionTokenByteLength);
            if (!(await readBufferAt(file, revisionTokenBuffer, revisionTokenByteOffset, signal))) {
                return null;
            }
            if (revisionTokenBuffer.toString('utf8') !== documentRevision) {
                return null;
            }

            const table = Buffer.alloc(tableSize);
            if (!(await readBufferAt(file, table, pageTableOffset, signal))) {
                return null;
            }

            const records = parsePageRecords(table, indexStat.size, textDataOffset);
            const legacyTextBudget = maxTotalTextBytes === undefined
                ? MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES
                : Math.min(
                    MAX_COMPACT_SEARCH_INDEX_TOTAL_TEXT_BYTES,
                    Math.max(0, Math.floor(maxTotalTextBytes)),
                );
            if (!records || !recordsFitLoadBudget(records, legacyTextBudget)) {
                return null;
            }

            if (metadataOnly) {
                return {
                    documentRevision,
                    pageCount: metadata.pageCount,
                    pages: [],
                    textSource: metadata.textSource,
                };
            }

            const pages = await readPages(file, records, signal);
            if (!pages) {
                return null;
            }

            return {
                documentRevision,
                pageCount: metadata.pageCount,
                pages,
                textSource: metadata.textSource,
            };
        } finally {
            await file.close();
        }
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        log.debug(`Compact search index not available: ${getErrorMessage(error)}`);
        return null;
    }
}
