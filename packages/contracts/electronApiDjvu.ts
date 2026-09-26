import type { TPageNumber } from '@contracts/pageNumbers';

import type {TDocumentRef} from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    ExpectedOutcome,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import type {
    TPdfViewMode,
    TPrintOrientation,
    TJobId,
    TRequestId,
} from '@contracts/shared';
import {
    parseEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';
import type {
    IPdfSearchProgress,
    IPdfSearchResponse,
    ISearchMatchOptions,
} from '@contracts/search';
import {
    DJVU_OUTLINE_MAX_DEPTH,
    DJVU_OUTLINE_MAX_NODES,
    DJVU_OUTLINE_MAX_TITLE_CHARS,
    DJVU_SEARCH_MAX_PAGE_TEXT_CHARS,
} from '@contracts/djvuResourceLimits';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

export type { TDjvuPdfExportStrategy } from '@contracts/djvuConversionPolicy';

export interface IDjvuProgress {
    readonly jobId: TJobId;
    readonly requestId?: TRequestId;
    readonly documentRef?: TDocumentRef;
    readonly phase: 'converting' | 'bookmarks' | 'optimizing' | 'loading' | 'printing';
    readonly status?: 'running' | 'success' | 'canceled' | 'failed';
    readonly current?: number;
    readonly total?: number;
    readonly percent: number;
    readonly error?: string;
}

export const DJVU_DOCUMENT_OUTPUT_OPERATIONS = [
    'djvu-convert',
    'djvu-open',
    'djvu-print',
] as const;

export type TDjvuDocumentOutputOperation = typeof DJVU_DOCUMENT_OUTPUT_OPERATIONS[number];

export function isDjvuDocumentOutputOperation(value: unknown): value is TDjvuDocumentOutputOperation {
    return DJVU_DOCUMENT_OUTPUT_OPERATIONS.some(operation => value === operation);
}

export type TDocumentOutputOperation = TDjvuDocumentOutputOperation;

export type TDocumentOutputJobState =
    | {
        readonly jobId: TJobId;
        readonly operation: TDocumentOutputOperation;
        readonly status: 'queued' | 'running';
        readonly progress: IDjvuProgress;
        readonly updatedAtMs: TEpochMs;
    }
    | {
        readonly jobId: TJobId;
        readonly operation: TDocumentOutputOperation;
        readonly status: 'handoff';
        readonly artifactPath: TDocumentRef;
        readonly progress: IDjvuProgress;
        readonly updatedAtMs: TEpochMs;
    }
    | {
        readonly jobId: TJobId;
        readonly operation: TDocumentOutputOperation;
        readonly status: 'completed';
        readonly artifactPath?: TDocumentRef;
        readonly progress: IDjvuProgress;
        readonly updatedAtMs: TEpochMs;
    }
    | {
        readonly jobId: TJobId;
        readonly operation: TDocumentOutputOperation;
        readonly status: 'canceled' | 'failed';
        readonly error?: string;
        readonly failure?: FailureReceipt;
        readonly expected?: ExpectedOutcome;
        readonly progress: IDjvuProgress;
        readonly updatedAtMs: TEpochMs;
    };

export interface IDjvuInfo {
    readonly pageCount: number;
    readonly sourceDpi: number;
    readonly hasBookmarks: boolean;
    readonly hasText: boolean;
    readonly metadata: Readonly<Record<string, string>>;
}

export interface IDjvuSizeEstimate {
    readonly subsample: number;
    readonly label: string;
    readonly description: string;
    readonly resultingDpi: number;
    readonly estimatedBytes: number;
}

export interface IDjvuPageSize {
    readonly width: number;
    readonly height: number;
    readonly dpi: number;
}

export interface IDjvuPageSourceInfo {
    readonly pageCount: number;
    readonly pageNumber: TPageNumber;
    readonly pageSize: IDjvuPageSize;
    /** Native source revision used to fence trusted pre-open geometry. */
    readonly sourceSize?: number;
    readonly sourceModifiedAt?: TEpochMs;
}

export interface IDjvuOutlineItem {
    readonly title: string;
    readonly pageNumber: TPageNumber | null;
    readonly children: readonly IDjvuOutlineItem[];
}

type TMutableDjvuOutlineItem = Omit<IDjvuOutlineItem, 'children'> & {children: TMutableDjvuOutlineItem[];};

export function decodeDjvuPageText(value: unknown) {
    if (typeof value !== 'string') {
        throw new Error('DjVu page text must be a string');
    }
    if (value.length > DJVU_SEARCH_MAX_PAGE_TEXT_CHARS) {
        throw new Error('DjVu page text exceeds the supported limit');
    }
    return value;
}

export function decodeDjvuOutline(value: unknown): IDjvuOutlineItem[] {
    if (!Array.isArray(value)) {
        throw new Error('DjVu outline must be an array');
    }
    const result: TMutableDjvuOutlineItem[] = [];
    const items = value as unknown[];
    const stack: Array<{
        depth: number;
        item: unknown;
        target: TMutableDjvuOutlineItem[];
    }> = items.toReversed().map(item => ({
        depth: 1,
        item,
        target: result,
    }));
    let nodeCount = 0;
    let titleChars = 0;
    for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
        if (
            !isRecord(entry.item)
            || typeof entry.item.title !== 'string'
            || (
                entry.item.pageNumber !== null
                && (
                    !Number.isSafeInteger(entry.item.pageNumber)
                    || Number(entry.item.pageNumber) < 1
                )
            )
            || !Array.isArray(entry.item.children)
        ) {
            throw new Error('invalid DjVu outline item');
        }
        nodeCount += 1;
        titleChars += entry.item.title.length;
        if (
            entry.depth > DJVU_OUTLINE_MAX_DEPTH
            || nodeCount > DJVU_OUTLINE_MAX_NODES
            || titleChars > DJVU_OUTLINE_MAX_TITLE_CHARS
        ) {
            throw new Error('DjVu outline exceeds the supported limit');
        }
        const mapped: TMutableDjvuOutlineItem = {
            title: entry.item.title,
            pageNumber: entry.item.pageNumber === null
                ? null
                : requirePageNumber(Number(entry.item.pageNumber)),
            children: [],
        };
        entry.target.push(mapped);
        const children = entry.item.children as unknown[];
        for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({
                depth: entry.depth + 1,
                item: children[index],
                target: mapped.children,
            });
        }
    }
    return result;
}

export function decodeDjvuPageSize(value: unknown): IDjvuPageSize {
    if (
        !isRecord(value)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
        || !isFiniteNumber(value.dpi)
    ) {
        throw new Error('invalid DjVu page size');
    }
    return {
        width: value.width,
        height: value.height,
        dpi: value.dpi,
    };
}

export function decodeDjvuPageSizes(value: unknown) {
    if (!Array.isArray(value)) {
        throw new Error('page sizes must be an array');
    }
    return (value as unknown[]).map(decodeDjvuPageSize);
}

export function decodeDjvuPageSourceInfo(value: unknown): IDjvuPageSourceInfo {
    if (
        !isRecord(value)
        || !Number.isSafeInteger(value.pageCount)
        || Number(value.pageCount) < 1
        || !Number.isSafeInteger(value.pageNumber)
        || Number(value.pageNumber) < 1
        || Number(value.pageNumber) > Number(value.pageCount)
    ) {
        throw new Error('invalid DjVu page source info');
    }
    const sourceModifiedAt = value.sourceModifiedAt === undefined
        ? undefined
        : parseEpochMs(value.sourceModifiedAt);
    if (sourceModifiedAt === null) {
        throw new Error('invalid DjVu page source info');
    }
    return {
        pageCount: Number(value.pageCount),
        pageNumber: requirePageNumber(Number(value.pageNumber), Number(value.pageCount)),
        pageSize: decodeDjvuPageSize(value.pageSize),
        ...(Number.isSafeInteger(value.sourceSize) && Number(value.sourceSize) >= 0
            ? {sourceSize: Number(value.sourceSize)}
            : {}),
        ...(sourceModifiedAt === undefined ? {} : {sourceModifiedAt}),
    };
}

export interface IDjvuPagePreview {
    bytes: Uint8Array;
    width: number;
    height: number;
}

export function decodeDjvuPagePreview(value: unknown): IDjvuPagePreview {
    if (
        !isRecord(value)
        || !(value.bytes instanceof Uint8Array)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        throw new Error('invalid DjVu page preview');
    }
    return {
        bytes: value.bytes,
        width: value.width,
        height: value.height,
    };
}

export interface IDjvuPagePreviewOptions {
    previewPriority?: number;
    previewRequestId?: TRequestId;
    subsample?: number;
    targetWidthPx?: number;
}

export interface IDjvuTextSearchOptions extends ISearchMatchOptions {
    requestId: TRequestId;
    pageCount: number;
}

export interface IDjvuTextSearchProgress extends IPdfSearchProgress {}

export interface IDjvuTextSearchResponse extends IPdfSearchResponse {}

export interface IDjvuConvertOptions {
    jobId?: TJobId;
    subsample?: number;
    preserveBookmarks?: boolean;
    pdfStrategy?: TDjvuPdfExportStrategy;
    requestId?: TRequestId;
    documentRef?: TDocumentRef;
    hostTier?: THostResourceTier;
}

export interface IDjvuJobStartHandle {
    readonly jobId: TJobId;
    readonly requestId: TRequestId;
}

export interface IDjvuPrintOptions {
    fileName?: string;
    pageNumbers?: TPageNumber[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
    requestId?: TRequestId;
    subsample?: number;
    pdfStrategy?: TDjvuPdfExportStrategy;
}

export interface IDjvuOpenResult {
    readonly success: boolean;
    readonly pageCount?: number;
    readonly pageSourceInfo?: IDjvuPageSourceInfo;
    readonly jobId?: TJobId;
    readonly requestId?: TRequestId;
    readonly error?: string;
}

export interface IDjvuConvertResult {
    readonly success: boolean;
    readonly pdfPath?: TDocumentRef;
    readonly jobId?: TJobId;
    readonly requestId?: TRequestId;
    readonly documentRef?: TDocumentRef;
    readonly error?: string;
    readonly failure?: FailureReceipt;
    readonly expected?: ExpectedOutcome;
}

export interface IDjvuPrintResult {
    readonly success: boolean;
    readonly canceled?: boolean;
    readonly jobId?: TJobId;
    readonly error?: string;
}
