import type { TPageNumber } from '@contracts/pageNumbers';

import type { TDocumentRevisionToken } from '@contracts/documentRevision';

export const COMPACT_SEARCH_INDEX_SCHEMA_VERSION = 2;
export const COMPACT_SEARCH_INDEX_MAGIC = 'EVBSIDX2';
export const COMPACT_SEARCH_INDEX_HEADER_SIZE = 64;
export const COMPACT_SEARCH_INDEX_PAGE_RECORD_SIZE = 24;
export const COMPACT_SEARCH_INDEX_MAX_BYTES = 320 * 1024 * 1024;
export const COMPACT_SEARCH_INDEX_MAX_PAGE_RECORDS = 1_000_000;
export const COMPACT_SEARCH_INDEX_MAX_PAGE_TEXT_BYTES = 32 * 1024 * 1024;
export const COMPACT_SEARCH_INDEX_MAX_TOTAL_TEXT_BYTES = 256 * 1024 * 1024;
export const COMPACT_SEARCH_INDEX_SOURCE_KIND_GENERIC = 0;
export const COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER = 1;

/**
 * Version 3 stores one fixed-size directory entry per declared page. The
 * directory lives on disk, so a million-page document does not require a
 * million-element JavaScript collection while it is being indexed.
 */
export const COMPACT_SEARCH_INDEX_STREAMING_SCHEMA_VERSION = 3;
export const COMPACT_SEARCH_INDEX_STREAMING_MAGIC = 'EVBSIDX3';
export const COMPACT_SEARCH_INDEX_STREAMING_HEADER_SIZE = 64;
export const COMPACT_SEARCH_INDEX_STREAMING_FOOTER_MAGIC = 'EVBSFTR3';
export const COMPACT_SEARCH_INDEX_STREAMING_FOOTER_SIZE = 64;
export const COMPACT_SEARCH_INDEX_STREAMING_DIRECTORY_ENTRY_SIZE = 24;
export const COMPACT_SEARCH_INDEX_STREAMING_FLAG_COMPLETE = 1;
export const COMPACT_SEARCH_INDEX_STREAMING_FLAG_PARTIAL_COVERAGE = 1 << 1;
export const COMPACT_SEARCH_INDEX_STREAMING_FLAG_TRUNCATED_COVERAGE = 1 << 2;

/** The v3 page-count field is an unsigned 32-bit wire value, not a file-size budget. */
export const COMPACT_SEARCH_INDEX_STREAMING_MAX_PAGE_COUNT = 0xFFFFFFFF;

export interface ICompactSearchIndexTextSource {
    readonly kind: number;
    readonly version: number;
}

export interface ICompactSearchIndexPage {
    readonly pageNumber: TPageNumber;
    readonly text: string;
}

export interface ICompactSearchIndexPayload {
    readonly documentRevision: TDocumentRevisionToken;
    readonly pageCount: number;
    readonly pages: readonly ICompactSearchIndexPage[];
    readonly textSource?: ICompactSearchIndexTextSource;
}

export interface ICompactSearchIndexStreamingOptions {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    textSource?: ICompactSearchIndexTextSource;
    partialCoverage?: boolean;
    truncatedCoverage?: boolean;
    pagesScanned?: number;
    beforePublish?: () => Promise<void>;
    signal?: AbortSignal;
}

export interface ICompactSearchIndexStreamingFinalizeOptions {
    /** Number of source pages examined, including pages with no text record. */
    pagesScanned: number;
    /** Mark the published index as having truncated source coverage. */
    truncatedCoverage?: boolean;
    /** Mark the published index as partial even when pagesScanned reaches pageCount. */
    partialCoverage?: boolean;
    /** Run after the temp file is fully written and synced, before atomic publication. */
    beforePublish?: () => Promise<void>;
}

export interface ICompactSearchIndexCoverageMetadata {
    readonly flags: number;
    readonly pagesScanned: number;
    readonly pagesWritten: number;
    readonly bytesWritten: number;
    readonly complete: boolean;
    readonly partialCoverage: boolean;
    readonly truncatedCoverage: boolean;
}

export interface ICompactSearchIndexPageRecord {
    readonly pageNumber: TPageNumber;
    readonly textUtf16Length: number;
    readonly byteOffset: bigint;
    readonly byteLength: bigint;
}

export function getCompactSearchIndexPath(pdfPath: string) {
    return `${pdfPath}.index.evb-search-v2.bin`;
}
