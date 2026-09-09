 

import { createReadStream } from 'fs';
import { randomUUID } from 'crypto';
import {
    open,
    readFile,
    rm,
    stat,
} from 'fs/promises';
import { join } from 'path';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@contracts/scan-cleanup/inputLimits';
import type {
    IPdfPageSize,
    IPdfPageSizeChunk,
    IReadPdfPageSizesOptions,
    TPdfPageSizeDominantImageAnalysis,
} from '@evb/scan-cleanup/core/types';

export type {
    IPdfPageSize,
    IPdfPageSizeChunk,
    IReadPdfPageSizesOptions,
    IScanCleanupPageRasterSource,
    TPdfPageSizeDominantImageAnalysis,
} from '@evb/scan-cleanup/core/types';

const PAGE_SIZES_TIMEOUT_MS = 60 * 1000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDF_PAGE_OPS_STDOUT_BYTES = 64 * 1024;
export const PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const PDF_PAGE_SIZE_SIDECAR_MAX_LINE_BYTES = PDF_PAGE_SIZE_SIDECAR_MAX_CHUNK_BYTES;
export const PDF_PAGE_SIZE_SIDECAR_READ_WINDOW_BYTES = 512 * 1024;
export const PDF_PAGE_SIZE_STORE_MAX_READ_PAGES = 1_024;
const PDF_PAGE_SIZE_SIDECAR_MIN_CHUNK_BYTES = 64;
const PDF_PAGE_SIZE_LEGACY_JSON_COMPAT_BYTES = 64 * 1024 * 1024;
const PDFINFO_PAGE_WINDOW_PAGES = 512;
export const PDF_PAGE_SIZE_SIDECAR_FORMAT = 'evb-pdf-page-sizes';
export const PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION = 1;
const MAX_U64 = 0xffffffffffffffffn;
const PDFINFO_PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/mu;
// `Page 4 size: 595.276 x 841.89 pts (A4)`: the page view Poppler renders with
// `-cropbox`, which is the same rectangle evb-pdf-page-ops reports.
const PDFINFO_PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+(-?[0-9.]+)\s+x\s+(-?[0-9.]+)\s+pts/gmu;
const PDFINFO_PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gmu;
const PDFINFO_PAGE_BOX_RE = /^Page\s+(\d+)\s+(MediaBox|CropBox):\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s*$/gmu;

const MIN_CROP_FALLBACK_DOCUMENT_PAGES = 3;
const MIN_CROP_FALLBACK_LANDSCAPE_SHARE = 0.75;
const LANDSCAPE_GEOMETRY_RATIO = 1.1;
/** A retry candidate must lose at least this share of its physical paper. */
const MATERIAL_CROP_AREA_RATIO = 0.8;

interface IPdfBox {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
}

interface IPageBoxes {
    media?: IPdfBox;
    crop?: IPdfBox;
}

function invalidPageNumbering(reason: string) {
    return new Error(`evb-pdf-page-ops returned invalid page numbering: ${reason}`);
}

/**
 * The geometry a page carries: the page view (CropBox intersected with
 * MediaBox) in PDF user space, plus the display rotation that view is presented
 * under. It is the same rectangle `split-pages` writes back and the same one
 * `pdftoppm -cropbox` rasterizes, so a canvas measured from it is the canvas the
 * assembled document ends up carrying.
 */
function decodeFinite(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePdfBox(
    x1Value: string,
    y1Value: string,
    x2Value: string,
    y2Value: string,
): IPdfBox | null {
    const x1 = Number.parseFloat(x1Value);
    const y1 = Number.parseFloat(y1Value);
    const x2 = Number.parseFloat(x2Value);
    const y2 = Number.parseFloat(y2Value);
    const widthPoints = x2 - x1;
    const heightPoints = y2 - y1;
    if (
        !Number.isFinite(x1)
        || !Number.isFinite(y1)
        || !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || widthPoints <= 0
        || heightPoints <= 0
    ) {
        return null;
    }
    return {
        xPoints: x1,
        yPoints: y1,
        widthPoints,
        heightPoints,
    };
}

function parsePdfInfoBoxes(output: string) {
    const boxes = new Map<number, IPageBoxes>();
    for (const match of output.matchAll(PDFINFO_PAGE_BOX_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const box = parsePdfBox(match[3] ?? '', match[4] ?? '', match[5] ?? '', match[6] ?? '');
        const boxName = match[2];
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || box === null) {
            continue;
        }
        const pageBoxes = boxes.get(pageNumber) ?? {};
        if (boxName === 'MediaBox') {
            pageBoxes.media = box;
        } else if (boxName === 'CropBox') {
            pageBoxes.crop = box;
        }
        boxes.set(pageNumber, pageBoxes);
    }
    return boxes;
}

function attachMediaBoxes(pageSizes: readonly IPdfPageSize[], output: string) {
    const boxes = parsePdfInfoBoxes(output);
    return pageSizes.map(page => {
        const media = boxes.get(page.pageNumber)?.media;
        const crop = boxes.get(page.pageNumber)?.crop;
        return media === undefined
            ? crop === undefined
                ? page
                : {
                    ...page,
                    cropXPoints: crop.xPoints,
                    cropYPoints: crop.yPoints,
                    cropWidthPoints: crop.widthPoints,
                    cropHeightPoints: crop.heightPoints,
                }
            : {
                ...page,
                mediaXPoints: media.xPoints,
                mediaYPoints: media.yPoints,
                mediaWidthPoints: media.widthPoints,
                mediaHeightPoints: media.heightPoints,
                ...(crop === undefined
                    ? {}
                    : {
                        cropXPoints: crop.xPoints,
                        cropYPoints: crop.yPoints,
                        cropWidthPoints: crop.widthPoints,
                        cropHeightPoints: crop.heightPoints,
                    }),
            };
    });
}

export function toCropBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (
        page.cropXPoints === undefined
        || page.cropYPoints === undefined
        || page.cropWidthPoints === undefined
        || page.cropHeightPoints === undefined
    ) {
        return page;
    }
    return {
        ...page,
        xPoints: page.cropXPoints,
        yPoints: page.cropYPoints,
        widthPoints: page.cropWidthPoints,
        heightPoints: page.cropHeightPoints,
        renderBox: 'cropbox',
    };
}

function isLandscape(widthPoints: number, heightPoints: number) {
    return widthPoints >= heightPoints * LANDSCAPE_GEOMETRY_RATIO;
}

function hasMediaGeometry(page: IPdfPageSize): page is IPdfPageSize & {
    mediaXPoints: number;
    mediaYPoints: number;
    mediaWidthPoints: number;
    mediaHeightPoints: number;
} {
    return page.mediaXPoints !== undefined
        && page.mediaYPoints !== undefined
        && page.mediaWidthPoints !== undefined
        && page.mediaHeightPoints !== undefined
        && Number.isFinite(page.mediaXPoints)
        && Number.isFinite(page.mediaYPoints)
        && Number.isFinite(page.mediaWidthPoints)
        && Number.isFinite(page.mediaHeightPoints)
        && page.mediaWidthPoints > 0
        && page.mediaHeightPoints > 0;
}

export function isCropBoxOrientationMismatch(page: IPdfPageSize) {
    return page.heightPoints >= page.widthPoints * LANDSCAPE_GEOMETRY_RATIO
        && hasMediaGeometry(page)
        && isLandscape(page.mediaWidthPoints, page.mediaHeightPoints);
}

/**
 * A large area difference alone is not enough to render a page twice. This
 * predicate is for the native retry after a first-pass classification has
 * supplied content evidence, not for the ordinary renderer fallback.
 */
export function isMateriallySmallerCropBox(page: IPdfPageSize) {
    if (!hasMediaGeometry(page)) {
        return false;
    }
    const cropArea = page.widthPoints * page.heightPoints;
    const mediaArea = page.mediaWidthPoints * page.mediaHeightPoints;
    return Number.isFinite(cropArea)
        && Number.isFinite(mediaArea)
        && cropArea > 0
        && mediaArea > 0
        && cropArea / mediaArea < MATERIAL_CROP_AREA_RATIO;
}

export function toMediaBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (!hasMediaGeometry(page)) {
        return page;
    }
    return {
        ...page,
        xPoints: page.mediaXPoints,
        yPoints: page.mediaYPoints,
        widthPoints: page.mediaWidthPoints,
        heightPoints: page.mediaHeightPoints,
        renderBox: 'mediabox',
    };
}

/**
 * Returns the pages where a portrait CropBox is incompatible with the
 * document's dominant landscape paper. This is intentionally a high bar. A
 * normal crop, even a large same-orientation crop, keeps its existing CropBox.
 * A later analysis-driven retry can safely widen that set once the native
 * classifier proves that the MediaBox contains a two-page spread.
 */
export function shouldUseMediaBoxForSuspiciousCrop(
    page: IPdfPageSize,
    pageSizes: readonly IPdfPageSize[],
) {
    if (!hasMediaGeometry(page)) {
        return false;
    }
    const pagesWithMedia = pageSizes.filter(hasMediaGeometry);
    if (pagesWithMedia.length < MIN_CROP_FALLBACK_DOCUMENT_PAGES) {
        return false;
    }
    const landscapePages = pagesWithMedia.filter(candidate => isLandscape(
        candidate.mediaWidthPoints,
        candidate.mediaHeightPoints,
    ));
    if (landscapePages.length / pagesWithMedia.length < MIN_CROP_FALLBACK_LANDSCAPE_SHARE) {
        return false;
    }
    if (!isLandscape(page.mediaWidthPoints, page.mediaHeightPoints)) {
        return false;
    }

    return isCropBoxOrientationMismatch(page);
}

/**
 * Replaces only the suspicious page views with their physical MediaBox. The
 * caller can use the same predicate for the Poppler command, keeping the
 * raster and the page geometry on one rectangle.
 */
export function resolveSuspiciousCropBoxPageSizes(pageSizes: readonly IPdfPageSize[]) {
    return pageSizes.map(page => {
        if (!shouldUseMediaBoxForSuspiciousCrop(page, pageSizes) || !hasMediaGeometry(page)) {
            return page;
        }
        return toMediaBoxPageSize({
            ...page,
            cropXPoints: page.cropXPoints ?? page.xPoints,
            cropYPoints: page.cropYPoints ?? page.yPoints,
            cropWidthPoints: page.cropWidthPoints ?? page.widthPoints,
            cropHeightPoints: page.cropHeightPoints ?? page.heightPoints,
        });
    });
}

function decodeOptionalPdfBox(page: Record<string, unknown>, prefix: 'media' | 'crop') {
    const xPoints = decodeFinite(page[`${prefix}XPoints`]);
    const yPoints = decodeFinite(page[`${prefix}YPoints`]);
    const widthPoints = decodeFinite(page[`${prefix}WidthPoints`]);
    const heightPoints = decodeFinite(page[`${prefix}HeightPoints`]);
    if (
        xPoints === null
        || yPoints === null
        || widthPoints === null
        || heightPoints === null
        || widthPoints <= 0
        || heightPoints <= 0
    ) {
        return undefined;
    }
    return {
        [`${prefix}XPoints`]: xPoints,
        [`${prefix}YPoints`]: yPoints,
        [`${prefix}WidthPoints`]: widthPoints,
        [`${prefix}HeightPoints`]: heightPoints,
    } as const;
}

function decodePageSizeRecord(
    page: unknown,
    pageCount: number,
    recordLabel: string,
) {
    if (!isRecord(page)) {
        throw new Error(`evb-pdf-page-ops returned no geometry for ${recordLabel}`);
    }
    const widthPoints = decodeFinite(page.widthPoints)
        ?? (decodeFinite(page.widthInches) === null ? null : decodeFinite(page.widthInches)! * 72);
    const heightPoints = decodeFinite(page.heightPoints)
        ?? (decodeFinite(page.heightInches) === null ? null : decodeFinite(page.heightInches)! * 72);
    const pageNumber = decodeFinite(page.pageNumber);
    if (
        pageNumber === null
        || !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || pageNumber > pageCount
    ) {
        throw invalidPageNumbering(`invalid page number for ${recordLabel}`);
    }
    if (widthPoints === null || heightPoints === null || widthPoints <= 0 || heightPoints <= 0) {
        throw new Error(`evb-pdf-page-ops returned invalid geometry for page ${String(pageNumber)}`);
    }
    const dominantImageWidthPx = decodeFinite(page.dominantImageWidthPx);
    const dominantImageHeightPx = decodeFinite(page.dominantImageHeightPx);
    const dominantImageWidthPoints = decodeFinite(page.dominantImageWidthPoints);
    const dominantImageHeightPoints = decodeFinite(page.dominantImageHeightPoints);
    const hasDominantImage = dominantImageWidthPx !== null
        && dominantImageHeightPx !== null
        && dominantImageWidthPoints !== null
        && dominantImageHeightPoints !== null
        && Number.isSafeInteger(dominantImageWidthPx)
        && Number.isSafeInteger(dominantImageHeightPx)
        && dominantImageWidthPx > 0
        && dominantImageHeightPx > 0
        && dominantImageWidthPoints > 0
        && dominantImageHeightPoints > 0;
    const media = decodeOptionalPdfBox(page, 'media');
    const crop = decodeOptionalPdfBox(page, 'crop');
    const renderBox = page.renderBox === 'cropbox' || page.renderBox === 'mediabox'
        ? page.renderBox
        : undefined;
    return {
        pageNumber,
        xPoints: decodeFinite(page.xPoints) ?? 0,
        yPoints: decodeFinite(page.yPoints) ?? 0,
        widthPoints,
        heightPoints,
        rotation: decodeFinite(page.rotation) ?? 0,
        ...(media ?? {}),
        ...(crop ?? {}),
        ...(renderBox === undefined ? {} : {renderBox}),
        ...(hasDominantImage ? {
            dominantImageWidthPx,
            dominantImageHeightPx,
            dominantImageWidthPoints,
            dominantImageHeightPoints,
        } : {}),
    } satisfies IPdfPageSize;
}

export function parsePdfPageSizesPayload(payload: unknown): IPdfPageSize[] {
    if (!isRecord(payload) || !Array.isArray(payload.pages) || payload.pages.length === 0) {
        throw new Error('evb-pdf-page-ops page-sizes returned no pages');
    }
    const pageCount = payload.pages.length;
    const decoded = new Map<number, IPdfPageSize>();
    for (const [
        index,
        page,
    ] of payload.pages.entries()) {
        const pageSize = decodePageSizeRecord(page, pageCount, `page ${String(index + 1)}`);
        if (decoded.has(pageSize.pageNumber)) {
            throw invalidPageNumbering(`duplicate geometry for page ${String(pageSize.pageNumber)}`);
        }
        decoded.set(pageSize.pageNumber, pageSize);
    }
    const pageSizes: IPdfPageSize[] = [];
    for (let index = 0; index < pageCount; index += 1) {
        const pageNumber = index + 1;
        const page = decoded.get(pageNumber);
        if (!page) {
            throw invalidPageNumbering(`no geometry for page ${String(pageNumber)}`);
        }
        pageSizes.push(page);
    }
    return pageSizes;
}

export interface IPdfPageSizeSidecarHeader {
    format: typeof PDF_PAGE_SIZE_SIDECAR_FORMAT;
    schemaVersion: typeof PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION;
    /** The root `/Pages /Count` declaration, normalized for old sidecars. */
    declaredPageCount: number;
    /** The reachable leaf count validated before the sidecar was published. */
    reachablePageCount: number;
    pageCount: number;
    chunkBytes: number;
    /** Header capability, with `unknown` for pre-status sidecars. */
    dominantImageAnalysis: TPdfPageSizeDominantImageAnalysis;
}

/**
 * Bounded page geometry access for document-scale callers. Implementations
 * keep only their current chunk and may reopen the source when a scalar read
 * moves backwards. Callers own the returned range array and should keep it to
 * the window they are processing. `pageCount` becomes available after the
 * first chunk has been read.
 */
export interface IPdfPageSizeStore {
    readonly pageCount: number | null;
    /** Header capability, when the source provides it. */
    readonly dominantImageAnalysis?: TPdfPageSizeDominantImageAnalysis | undefined;
    /** Create an independent cursor over the same bounded source, when supported. */
    readonly fork?: () => IPdfPageSizeStore;
    getPage(pageNumber: number): Promise<IPdfPageSize>;
    readRange(firstPageNumber: number, lastPageNumberExclusive: number): Promise<IPdfPageSize[]>;
    forEachChunk(onChunk: (chunk: IPdfPageSizeChunk) => Promise<void> | void): Promise<void>;
    close(): Promise<void>;
}

/**
 * Keep array-backed page geometry usable for small compatibility tests. The
 * production path uses PdfPageSizeStore, so this adapter never expands a
 * document-scale source into an in-memory page array.
 */
export function createArrayBackedPdfPageSizeStore(
    pageSizes: readonly IPdfPageSize[],
    documentPageCount = pageSizes.length,
): IPdfPageSizeStore {
    const pageCount = Number.isSafeInteger(documentPageCount) && documentPageCount >= 0
        ? documentPageCount
        : pageSizes.length;
    const fallback = pageSizes[0] ?? {
        pageNumber: 1,
        xPoints: 0,
        yPoints: 0,
        widthPoints: 612,
        heightPoints: 792,
        rotation: 0,
    } satisfies IPdfPageSize;
    let closed = false;
    const assertOpen = () => {
        if (closed) throw new Error('Page-size store is closed');
    };
    const resolvePage = (pageNumber: number) => {
        const page = pageSizes[pageNumber - 1];
        if (page !== undefined && page.pageNumber === pageNumber) {
            return page;
        }
        // A few direct compatibility tests vary pageCount without replacing
        // their tiny geometry fixture. Production always supplies a native
        // store and never takes this branch.
        if (pageSizes.length === pageCount) {
            throw new Error(`Page-size source returned no geometry for page ${String(pageNumber)}`);
        }
        return {
            ...fallback,
            pageNumber,
        };
    };
    const validatePageNumber = (pageNumber: number) => {
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
            throw new RangeError(`Page-size source has no geometry for page ${String(pageNumber)}`);
        }
    };
    return {
        get pageCount() {
            return pageCount;
        },
        getPage: pageNumber => {
            assertOpen();
            validatePageNumber(pageNumber);
            return Promise.resolve(resolvePage(pageNumber));
        },
        readRange: (firstPageNumber, lastPageNumberExclusive) => {
            assertOpen();
            if (
                !Number.isSafeInteger(firstPageNumber)
                || !Number.isSafeInteger(lastPageNumberExclusive)
                || firstPageNumber < 1
                || lastPageNumberExclusive < firstPageNumber
                || lastPageNumberExclusive > pageCount + 1
            ) {
                throw new RangeError('Page-size range read has invalid page bounds');
            }
            const pages: IPdfPageSize[] = [];
            for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                pages.push(resolvePage(pageNumber));
            }
            return Promise.resolve(pages);
        },
        forEachChunk: async onChunk => {
            assertOpen();
            let chunkIndex = 0;
            for (
                let firstPageNumber = 1;
                firstPageNumber <= pageCount;
                firstPageNumber += SCAN_CLEANUP_STREAMING_BATCH_PAGES
            ) {
                const pages: IPdfPageSize[] = [];
                const lastPageNumberExclusive = Math.min(
                    pageCount + 1,
                    firstPageNumber + SCAN_CLEANUP_STREAMING_BATCH_PAGES,
                );
                for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                    pages.push(resolvePage(pageNumber));
                }
                await onChunk({
                    pageCount,
                    chunkIndex,
                    firstPageNumber,
                    offset: 0,
                    byteLength: 0,
                    pages,
                });
                chunkIndex += 1;
            }
        },
        close: () => {
            closed = true;
            return Promise.resolve();
        },
    };
}

function checkedU64Add(left: bigint, right: number, label: string) {
    const next = left + BigInt(right);
    if (next > MAX_U64) {
        throw new RangeError(`${label} exceeds the checked u64 range`);
    }
    return next;
}

function safeU64Number(value: bigint, label: string) {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${label} exceeds the JavaScript safe integer range`);
    }
    return Number(value);
}

function decodeDominantImageAnalysis(value: unknown): TPdfPageSizeDominantImageAnalysis {
    if (value === undefined) {
        return 'unknown';
    }
    if (
        value === 'performed'
        || value === 'unavailable'
        || value === 'skipped'
        || value === 'unknown'
    ) {
        return value;
    }
    throw new Error('evb-pdf-page-ops returned an invalid dominant-image analysis status');
}

function decodeOptionalSidecarPageCount(
    value: unknown,
    fallback: number,
    fieldName: 'declaredPageCount' | 'reachablePageCount',
) {
    if (value === undefined) {
        return fallback;
    }
    const pageCount = decodeFinite(value);
    if (pageCount === null || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error(`evb-pdf-page-ops returned an invalid ${fieldName}`);
    }
    return pageCount;
}

export function parsePdfPageSizeSidecarHeader(payload: unknown): IPdfPageSizeSidecarHeader {
    if (!isRecord(payload)
        || payload.format !== PDF_PAGE_SIZE_SIDECAR_FORMAT
        || payload.schemaVersion !== PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION) {
        throw new Error('evb-pdf-page-ops returned an unsupported page-size sidecar header');
    }
    const pageCount = decodeFinite(payload.pageCount);
    const chunkBytes = decodeFinite(payload.chunkBytes);
    const dominantImageAnalysis = decodeDominantImageAnalysis(payload.dominantImageAnalysis);
    if (
        pageCount === null
        || !Number.isSafeInteger(pageCount)
        || pageCount < 1
        || chunkBytes === null
        || !Number.isSafeInteger(chunkBytes)
        || chunkBytes < PDF_PAGE_SIZE_SIDECAR_MIN_CHUNK_BYTES
        || chunkBytes > PDF_PAGE_SIZE_SIDECAR_MAX_LINE_BYTES
    ) {
        throw new Error('evb-pdf-page-ops returned invalid page-size sidecar bounds');
    }
    const declaredPageCount = decodeOptionalSidecarPageCount(
        payload.declaredPageCount,
        pageCount,
        'declaredPageCount',
    );
    const reachablePageCount = decodeOptionalSidecarPageCount(
        payload.reachablePageCount,
        pageCount,
        'reachablePageCount',
    );
    if (declaredPageCount !== pageCount || reachablePageCount !== pageCount) {
        throw invalidPageNumbering(
            `page-size sidecar declared ${String(declaredPageCount)} pages and reached ${String(reachablePageCount)} pages, but its pageCount is ${String(pageCount)}`,
        );
    }
    return {
        format: PDF_PAGE_SIZE_SIDECAR_FORMAT,
        schemaVersion: PDF_PAGE_SIZE_SIDECAR_SCHEMA_VERSION,
        pageCount,
        declaredPageCount,
        reachablePageCount,
        chunkBytes,
        dominantImageAnalysis,
    };
}

function parseJsonLine(line: Buffer, label: string) {
    const withoutNewline = line[line.length - 1] === 0x0a
        ? line.subarray(0, line.length - 1)
        : line;
    const withoutCarriageReturn = withoutNewline[withoutNewline.length - 1] === 0x0d
        ? withoutNewline.subarray(0, withoutNewline.length - 1)
        : withoutNewline;
    try {
        return JSON.parse(withoutCarriageReturn.toString('utf8')) as unknown;
    } catch (error) {
        throw new Error(`evb-pdf-page-ops returned invalid ${label} JSON: ${getErrorMessage(error)}`);
    }
}

function parsePdfPageSizeSidecarChunk(
    payload: unknown,
    header: IPdfPageSizeSidecarHeader,
    expectedChunkIndex: number,
    expectedPageNumber: number,
    offset: bigint,
    byteLength: number,
): IPdfPageSizeChunk {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        throw new Error('evb-pdf-page-ops returned an invalid page-size sidecar chunk');
    }
    const chunkIndex = decodeFinite(payload.chunkIndex);
    const firstPageNumber = decodeFinite(payload.firstPageNumber);
    if (
        chunkIndex === null
        || !Number.isSafeInteger(chunkIndex)
        || chunkIndex !== expectedChunkIndex
        || firstPageNumber === null
        || !Number.isSafeInteger(firstPageNumber)
        || firstPageNumber !== expectedPageNumber
        || payload.pages.length === 0
        || byteLength > header.chunkBytes
    ) {
        throw invalidPageNumbering(`invalid page-size sidecar chunk ${String(expectedChunkIndex)}`);
    }

    const pages: IPdfPageSize[] = [];
    for (const [
        index,
        page,
    ] of payload.pages.entries()) {
        const pageSize = decodePageSizeRecord(
            page,
            header.pageCount,
            `sidecar chunk ${String(chunkIndex)} record ${String(index + 1)}`,
        );
        const expectedPage = expectedPageNumber + index;
        if (pageSize.pageNumber !== expectedPage) {
            throw invalidPageNumbering(
                `sidecar chunk ${String(chunkIndex)} expected page ${String(expectedPage)}, received page ${String(pageSize.pageNumber)}`,
            );
        }
        pages.push(pageSize);
    }

    return {
        pageCount: header.pageCount,
        declaredPageCount: header.declaredPageCount,
        reachablePageCount: header.reachablePageCount,
        chunkIndex,
        firstPageNumber,
        offset: safeU64Number(offset, 'page-size sidecar offset'),
        byteLength,
        dominantImageAnalysis: header.dominantImageAnalysis,
        pages,
    };
}

/**
 * Read the JSONL sidecar one bounded line/chunk at a time. The generator owns
 * the stream, and closing it on `return()` makes a cancelled OCR or scan job
 * stop reading the sidecar without waiting for the whole document.
 */
export async function* readPdfPageSizeSidecarChunks(
    sidecarPath: string,
    signal?: AbortSignal,
): AsyncGenerator<IPdfPageSizeChunk> {
    const stream = createReadStream(sidecarPath, {highWaterMark: PDF_PAGE_SIZE_SIDECAR_READ_WINDOW_BYTES});
    let pending: Buffer = Buffer.alloc(0);
    let offset = 0n;
    let header: IPdfPageSizeSidecarHeader | null = null;
    let expectedChunkIndex = 0;
    let expectedPageNumber = 1;
    let sawHeader = false;
    try {
        for await (const rawChunk of stream) {
            if (signal?.aborted) {
                throw signal.reason instanceof Error ? signal.reason : new Error('Page-size read aborted');
            }
            const chunk = Buffer.from(rawChunk as Uint8Array);
            if (chunk.length > PDF_PAGE_SIZE_SIDECAR_READ_WINDOW_BYTES) {
                throw new RangeError('Page-size sidecar read window exceeded its bound');
            }
            pending = pending.length === 0
                ? chunk
                : Buffer.concat([
                    pending,
                    chunk,
                ]);
            let newlineIndex = pending.indexOf(0x0a);
            while (newlineIndex >= 0) {
                if (signal?.aborted) {
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new Error('Page-size read aborted');
                }
                const line = pending.subarray(0, newlineIndex + 1);
                pending = pending.subarray(newlineIndex + 1);
                if (line.length > PDF_PAGE_SIZE_SIDECAR_MAX_LINE_BYTES) {
                    throw new RangeError('Page-size sidecar line exceeds the 4 MiB bound');
                }
                const lineOffset = offset;
                offset = checkedU64Add(offset, line.length, 'page-size sidecar offset');
                const payload = parseJsonLine(line, sawHeader ? 'page-size sidecar chunk' : 'page-size sidecar header');
                if (!sawHeader) {
                    header = parsePdfPageSizeSidecarHeader(payload);
                    sawHeader = true;
                } else {
                    const currentHeader = header;
                    if (currentHeader === null) {
                        throw new Error('evb-pdf-page-ops page-size sidecar header is missing');
                    }
                    const pageChunk = parsePdfPageSizeSidecarChunk(
                        payload,
                        currentHeader,
                        expectedChunkIndex,
                        expectedPageNumber,
                        lineOffset,
                        line.length,
                    );
                    expectedChunkIndex += 1;
                    expectedPageNumber += pageChunk.pages.length;
                    yield pageChunk;
                }
                newlineIndex = pending.indexOf(0x0a);
            }
            if (newlineIndex < 0 && pending.length > PDF_PAGE_SIZE_SIDECAR_MAX_LINE_BYTES) {
                throw new RangeError('Page-size sidecar line exceeds the 4 MiB bound');
            }
        }
        if (pending.length !== 0) {
            throw new Error('evb-pdf-page-ops page-size sidecar ended with an unterminated line');
        }
        if (header === null || !sawHeader) {
            throw new Error('evb-pdf-page-ops page-size sidecar returned no header');
        }
        if (expectedPageNumber - 1 !== header.pageCount) {
            throw invalidPageNumbering(
                `page-size sidecar declared ${String(header.pageCount)} pages but returned ${String(expectedPageNumber - 1)}`,
            );
        }
    } finally {
        stream.destroy();
    }
}

/**
 * The same geometry read out of `pdfinfo -f 1 -l N`. Poppler reports the page
 * view it would render and the page's own rotation. With `-box`, it also gives
 * us the physical MediaBox needed to recognize a clearly undersized CropBox.
 */
export function parsePdfInfoPageGeometry(output: string): IPdfPageSize[] {
    const pageCount = Number.parseInt(PDFINFO_PAGE_COUNT_RE.exec(output)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pdfinfo returned no page count');
    }
    return parsePdfInfoPageGeometryWindow(output, pageCount, 1, pageCount);
}

function parsePdfInfoPageGeometryWindow(
    output: string,
    pageCount: number,
    firstPageNumber: number,
    lastPageNumber: number,
): IPdfPageSize[] {
    const rotations = new Map<number, number>();
    for (const match of output.matchAll(PDFINFO_PAGE_ROTATION_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const rotation = Number.parseInt(match[2] ?? '', 10);
        if (Number.isSafeInteger(pageNumber) && Number.isSafeInteger(rotation)) {
            rotations.set(pageNumber, rotation);
        }
    }
    const boxes = parsePdfInfoBoxes(output);
    const sizes = new Map<number, IPdfPageSize>();
    for (const match of output.matchAll(PDFINFO_PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const widthPoints = Number.parseFloat(match[2] ?? '');
        const heightPoints = Number.parseFloat(match[3] ?? '');
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !Number.isFinite(widthPoints)
            || !Number.isFinite(heightPoints)
            || widthPoints <= 0
            || heightPoints <= 0
        ) {
            continue;
        }
        const media = boxes.get(pageNumber)?.media;
        const crop = boxes.get(pageNumber)?.crop;
        sizes.set(pageNumber, {
            pageNumber,
            xPoints: crop?.xPoints ?? 0,
            yPoints: crop?.yPoints ?? 0,
            widthPoints,
            heightPoints,
            rotation: rotations.get(pageNumber) ?? 0,
            ...(crop === undefined
                ? {}
                : {
                    cropXPoints: crop.xPoints,
                    cropYPoints: crop.yPoints,
                    cropWidthPoints: crop.widthPoints,
                    cropHeightPoints: crop.heightPoints,
                }),
            ...(media === undefined
                ? {}
                : {
                    mediaXPoints: media.xPoints,
                    mediaYPoints: media.yPoints,
                    mediaWidthPoints: media.widthPoints,
                    mediaHeightPoints: media.heightPoints,
                }),
        });
    }
    const pageSizes: IPdfPageSize[] = [];
    for (let pageNumber = firstPageNumber; pageNumber <= lastPageNumber; pageNumber += 1) {
        const pageSize = sizes.get(pageNumber);
        // A document canvas is the largest rectangle the document carries, so a
        // page whose geometry is missing is not a page to guess at: it could be
        // the one that decides the answer.
        if (!pageSize) throw new Error(`pdfinfo returned no geometry for page ${String(pageNumber)}`);
        pageSizes.push(pageSize);
    }
    return pageSizes;
}

async function readPdfInfoBoxes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
    binary: string,
    pageCount: number,
) {
    const result = await options.runCommand(binary, [
        '-f',
        '1',
        '-l',
        String(pageCount),
        '-box',
        pdfPath,
    ], {
        timeoutMs: PAGE_SIZES_TIMEOUT_MS,
        commandLabel: 'pdfinfo(page-boxes)',
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES + pageCount * 1024,
        rejectOnStdoutTruncation: true,
        ...(options.signal ? {signal: options.signal} : {}),
        log: options.log,
    });
    return result.stdout;
}

async function* readNativePageSizeChunks(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
    binary: string,
): AsyncGenerator<IPdfPageSizeChunk> {
    const outputPath = join(
        options.tempDir,
        `page-sizes-${String(process.pid)}-${randomUUID()}.jsonl`,
    );
    try {
        const args = [
            'page-sizes',
            '--input',
            pdfPath,
            '--output',
            outputPath,
        ];
        if (options.qpdfBinary !== undefined) {
            args.push('--qpdf', options.qpdfBinary);
        }
        await options.runCommand(binary, args, {
            timeoutMs: PAGE_SIZES_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(page-sizes)',
            maxStdoutBytes: PDF_PAGE_OPS_STDOUT_BYTES,
            rejectOnStdoutTruncation: true,
            ...(options.signal ? {signal: options.signal} : {}),
            log: options.log,
        });
        if (options.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Page-size read aborted');
        }
        const outputStat = await stat(outputPath);
        if (!Number.isSafeInteger(outputStat.size) || outputStat.size < 1) {
            throw new Error('evb-pdf-page-ops returned an empty page-size payload');
        }
        const prefixHandle = await open(outputPath, 'r');
        let prefix: string;
        try {
            const bytes = Buffer.alloc(Math.min(PDF_PAGE_SIZE_SIDECAR_MAX_LINE_BYTES, 512));
            const readResult = await prefixHandle.read(bytes, 0, bytes.length, 0);
            prefix = bytes.subarray(0, readResult.bytesRead).toString('utf8');
        } finally {
            await prefixHandle.close();
        }
        if (prefix.includes(`"format":"${PDF_PAGE_SIZE_SIDECAR_FORMAT}"`)) {
            yield* readPdfPageSizeSidecarChunks(outputPath, options.signal);
            return;
        }
        if (outputStat.size > PDF_PAGE_SIZE_LEGACY_JSON_COMPAT_BYTES) {
            throw new RangeError(
                `evb-pdf-page-ops returned a non-streaming page-size payload larger than ${PDF_PAGE_SIZE_LEGACY_JSON_COMPAT_BYTES} bytes`,
            );
        }
        const payload: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
        const pageSizes = parsePdfPageSizesPayload(payload);
        const compatibilityChunkPages = 1_024;
        for (let start = 0; start < pageSizes.length; start += compatibilityChunkPages) {
            if (options.signal?.aborted) {
                throw options.signal.reason instanceof Error
                    ? options.signal.reason
                    : new Error('Page-size read aborted');
            }
            const pages = pageSizes.slice(start, start + compatibilityChunkPages);
            yield {
                pageCount: pageSizes.length,
                declaredPageCount: pageSizes.length,
                reachablePageCount: pageSizes.length,
                chunkIndex: Math.floor(start / compatibilityChunkPages),
                firstPageNumber: start + 1,
                offset: 0,
                byteLength: outputStat.size,
                dominantImageAnalysis: 'unknown',
                pages,
            };
        }
    } finally {
        await rm(outputPath, {force: true}).catch(() => undefined);
    }
}

async function* readPdfInfoPageSizeChunks(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
    binary: string,
): AsyncGenerator<IPdfPageSizeChunk> {
    const commandOptions = {
        timeoutMs: PAGE_SIZES_TIMEOUT_MS,
        commandLabel: 'pdfinfo(page-sizes)',
        ...(options.signal ? {signal: options.signal} : {}),
        log: options.log,
    };
    const overview = await options.runCommand(binary, [pdfPath], {
        ...commandOptions,
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
    });
    const pageCount = Number.parseInt(PDFINFO_PAGE_COUNT_RE.exec(overview.stdout)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pdfinfo returned no page count');
    }
    let chunkIndex = 0;
    for (let firstPageNumber = 1; firstPageNumber <= pageCount; firstPageNumber += PDFINFO_PAGE_WINDOW_PAGES) {
        if (options.signal?.aborted) {
            throw options.signal.reason instanceof Error
                ? options.signal.reason
                : new Error('Page-size read aborted');
        }
        const lastPageNumber = Math.min(
            pageCount,
            firstPageNumber + PDFINFO_PAGE_WINDOW_PAGES - 1,
        );
        const detailed = await options.runCommand(binary, [
            '-f',
            String(firstPageNumber),
            '-l',
            String(lastPageNumber),
            '-box',
            pdfPath,
        ], {
            ...commandOptions,
            maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES + (lastPageNumber - firstPageNumber + 1) * 1024,
            rejectOnStdoutTruncation: true,
        });
        const pages = parsePdfInfoPageGeometryWindow(
            detailed.stdout,
            pageCount,
            firstPageNumber,
            lastPageNumber,
        );
        yield {
            pageCount,
            declaredPageCount: pageCount,
            reachablePageCount: pageCount,
            chunkIndex,
            firstPageNumber,
            offset: 0,
            byteLength: Buffer.byteLength(detailed.stdout, 'utf8'),
            dominantImageAnalysis: 'skipped',
            pages,
        };
        chunkIndex += 1;
    }
}

async function readWithPageOps(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const pageSizes: IPdfPageSize[] = [];
    for await (const chunk of readNativePageSizeChunks(pdfPath, options, binary)) {
        pageSizes.push(...chunk.pages);
    }
    if (options.pdfinfoBinary === undefined) {
        return pageSizes;
    }
    try {
        const pageInfo = await readPdfInfoBoxes(pdfPath, options, options.pdfinfoBinary, pageSizes.length);
        const attached = attachMediaBoxes(pageSizes, pageInfo).map(toCropBoxPageSize);
        return options.resolveSuspiciousCropBoxFallback === false
            ? attached
            : resolveSuspiciousCropBoxPageSizes(attached);
    } catch (error) {
        if (options.signal?.aborted) throw error;
        options.log(
            'warn',
            `pdfinfo could not expose MediaBox geometry for suspicious CropBox recovery; retaining page-ops geometry: ${getErrorMessage(error)}`,
        );
        return pageSizes;
    }
}

async function readWithPdfInfo(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const pageSizes: IPdfPageSize[] = [];
    for await (const chunk of readPdfInfoPageSizeChunks(pdfPath, options, binary)) {
        pageSizes.push(...chunk.pages);
    }
    return options.resolveSuspiciousCropBoxFallback === false
        ? pageSizes
        : resolveSuspiciousCropBoxPageSizes(pageSizes);
}

/**
 * Stream page geometry from native page-ops or Poppler. Native sidecars are
 * read directly from disk, while the Poppler fallback asks for bounded page
 * windows. Callers that only need selected pages can discard other chunks
 * without constructing a document-sized array.
 */
export async function* readPdfPageSizeChunks(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
): AsyncGenerator<IPdfPageSizeChunk> {
    if (options.pdfPageOpsBinary) {
        try {
            yield* readNativePageSizeChunks(pdfPath, options, options.pdfPageOpsBinary);
            return;
        } catch (error) {
            if (options.signal?.aborted || !options.pdfinfoBinary) throw error;
            options.log(
                'warn',
                `evb-pdf-page-ops could not report page geometry, falling back to bounded pdfinfo windows: ${getErrorMessage(error)}`,
            );
        }
    }
    if (options.pdfinfoBinary) {
        yield* readPdfInfoPageSizeChunks(pdfPath, options, options.pdfinfoBinary);
        return;
    }
    throw new Error('No PDF tool is available to read page geometry');
}

export type TPdfPageSizeChunkReader = () => AsyncGenerator<IPdfPageSizeChunk>;

interface IPdfPageSizeReaderCursor {
    currentChunk: IPdfPageSizeChunk | null;
    nextChunkIndex: number;
}

/**
 * A forward-scanning page geometry view with one bounded chunk in memory.
 * Scalar reads are serialized on this store's cursor, so callers can issue
 * concurrent sparse requests without corrupting one another. Use `fork` when
 * two long-lived consumers should advance independently.
 */
export class PdfPageSizeStore implements IPdfPageSizeStore {
    private readonly createReader: TPdfPageSizeChunkReader;
    private readonly activeReaders = new Set<AsyncGenerator<IPdfPageSizeChunk>>();
    private pageReader: AsyncGenerator<IPdfPageSizeChunk> | null = null;
    private pageCursor: IPdfPageSizeReaderCursor = {
        currentChunk: null,
        nextChunkIndex: 0,
    };
    private pageReadTail = Promise.resolve();
    private closed = false;
    private _pageCount: number | null = null;
    private _dominantImageAnalysis: TPdfPageSizeDominantImageAnalysis | undefined;

    public constructor(createReader: TPdfPageSizeChunkReader) {
        this.createReader = createReader;
    }

    public get pageCount() {
        return this._pageCount;
    }

    public get dominantImageAnalysis() {
        return this._dominantImageAnalysis;
    }

    public fork() {
        if (this.closed) {
            throw new Error('Page-size store is closed');
        }
        return new PdfPageSizeStore(this.createReader);
    }

    private openReader() {
        if (this.closed) {
            throw new Error('Page-size store is closed');
        }
        const reader = this.createReader();
        this.activeReaders.add(reader);
        return reader;
    }

    private async closeReader(reader: AsyncGenerator<IPdfPageSizeChunk>) {
        if (this.activeReaders.delete(reader)) {
            await reader.return(undefined);
        }
    }

    private async resetPageReader() {
        const reader = this.pageReader;
        this.pageReader = null;
        this.pageCursor = {
            currentChunk: null,
            nextChunkIndex: 0,
        };
        if (reader !== null) {
            await this.closeReader(reader);
        }
    }

    private ensurePageReader() {
        if (this.pageReader === null) {
            this.pageReader = this.openReader();
            this.pageCursor = {
                currentChunk: null,
                nextChunkIndex: 0,
            };
        }
        return this.pageReader;
    }

    private validateChunk(chunk: IPdfPageSizeChunk, expectedChunkIndex: number) {
        if (chunk.chunkIndex !== expectedChunkIndex) {
            throw new Error(
                `Page-size source returned chunk ${String(chunk.chunkIndex)} after ${String(expectedChunkIndex)}`,
            );
        }
        if (this._pageCount === null) {
            this._pageCount = chunk.pageCount;
        } else if (chunk.pageCount !== this._pageCount) {
            throw new Error('Page-size source changed its page count between chunks');
        }
        const declaredPageCount = chunk.declaredPageCount ?? chunk.pageCount;
        const reachablePageCount = chunk.reachablePageCount ?? chunk.pageCount;
        if (declaredPageCount !== chunk.pageCount || reachablePageCount !== chunk.pageCount) {
            throw invalidPageNumbering(
                `page-size source declared ${String(declaredPageCount)} pages and reached ${String(reachablePageCount)} pages, but reported ${String(chunk.pageCount)}`,
            );
        }
        const chunkAnalysis = chunk.dominantImageAnalysis ?? 'unknown';
        if (this._dominantImageAnalysis === undefined) {
            this._dominantImageAnalysis = chunkAnalysis;
        } else if (
            this._dominantImageAnalysis !== chunkAnalysis
            && this._dominantImageAnalysis !== 'unknown'
            && chunkAnalysis !== 'unknown'
        ) {
            throw new Error('Page-size source changed its dominant-image analysis status between chunks');
        } else if (this._dominantImageAnalysis === 'unknown') {
            this._dominantImageAnalysis = chunkAnalysis;
        }
        if (chunk.pages.length === 0 || chunk.firstPageNumber < 1) {
            throw new Error('Page-size source returned an empty or invalid chunk');
        }
    }

    private async readPageFromReader(
        reader: AsyncGenerator<IPdfPageSizeChunk>,
        pageNumber: number,
        cursor: IPdfPageSizeReaderCursor = {
            currentChunk: null,
            nextChunkIndex: 0,
        },
    ) {
        while (cursor.currentChunk === null
            || pageNumber >= cursor.currentChunk.firstPageNumber + cursor.currentChunk.pages.length) {
            const result = await reader.next();
            if (result.done) {
                if (this._pageCount === null) {
                    throw new Error('Page-size source returned no chunks');
                }
                throw new RangeError(`Page-size source has no geometry for page ${String(pageNumber)}`);
            }
            const chunk = result.value;
            this.validateChunk(chunk, cursor.nextChunkIndex);
            cursor.nextChunkIndex += 1;
            cursor.currentChunk = chunk;
        }
        const page = cursor.currentChunk.pages[pageNumber - cursor.currentChunk.firstPageNumber];
        if (page === undefined || page.pageNumber !== pageNumber) {
            throw new Error(`Page-size source returned no geometry for page ${String(pageNumber)}`);
        }
        return page;
    }

    private async forEachChunkFromReader(
        reader: AsyncGenerator<IPdfPageSizeChunk>,
        onChunk: (chunk: IPdfPageSizeChunk) => Promise<void> | void,
    ) {
        let nextChunkIndex = 0;
        for (;;) {
            const result = await reader.next();
            if (result.done) {
                if (this._pageCount === null) {
                    throw new Error('Page-size source returned no chunks');
                }
                return;
            }
            const chunk = result.value;
            this.validateChunk(chunk, nextChunkIndex);
            nextChunkIndex += 1;
            await onChunk(chunk);
        }
    }

    public getPage(pageNumber: number) {
        const read = this.pageReadTail.then(async () => {
            if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
                throw new RangeError('Page-size scalar read requires a positive safe page number');
            }
            if (this.closed) {
                throw new Error('Page-size store is closed');
            }
            if (
                this.pageCursor.currentChunk !== null
                && pageNumber < this.pageCursor.currentChunk.firstPageNumber
            ) {
                await this.resetPageReader();
            }
            const activeReader = this.ensurePageReader();
            try {
                return await this.readPageFromReader(activeReader, pageNumber, this.pageCursor);
            } catch (error) {
                await this.resetPageReader();
                throw error;
            }
        });
        this.pageReadTail = read.then(() => undefined, () => undefined);
        return read;
    }

    /** Read [firstPageNumber, lastPageNumberExclusive) into a bounded caller-owned range. */
    public async readRange(firstPageNumber: number, lastPageNumberExclusive: number) {
        if (
            !Number.isSafeInteger(firstPageNumber)
            || !Number.isSafeInteger(lastPageNumberExclusive)
            || firstPageNumber < 1
            || lastPageNumberExclusive < firstPageNumber
            || lastPageNumberExclusive - firstPageNumber > PDF_PAGE_SIZE_STORE_MAX_READ_PAGES
        ) {
            throw new RangeError(
                `Page-size range read is invalid or exceeds the ${String(PDF_PAGE_SIZE_STORE_MAX_READ_PAGES)}-page bound`,
            );
        }
        if (firstPageNumber === lastPageNumberExclusive) {
            return [] as IPdfPageSize[];
        }
        const reader = this.openReader();
        try {
            const pages: IPdfPageSize[] = [];
            const cursor: IPdfPageSizeReaderCursor = {
                currentChunk: null,
                nextChunkIndex: 0,
            };
            for (let pageNumber = firstPageNumber; pageNumber < lastPageNumberExclusive; pageNumber += 1) {
                pages.push(await this.readPageFromReader(reader, pageNumber, cursor));
            }
            return pages;
        } finally {
            await this.closeReader(reader);
        }
    }

    /** Visit each bounded chunk in source order. */
    public async forEachChunk(onChunk: (chunk: IPdfPageSizeChunk) => Promise<void> | void) {
        const reader = this.openReader();
        try {
            await this.forEachChunkFromReader(reader, onChunk);
        } finally {
            await this.closeReader(reader);
        }
    }

    public async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const readers = [...this.activeReaders];
        this.activeReaders.clear();
        await Promise.all(readers.map(reader => reader.return(undefined)));
        await this.pageReadTail;
        this.pageReader = null;
        this.pageCursor = {
            currentChunk: null,
            nextChunkIndex: 0,
        };
    }
}

export function createPdfPageSizeStore(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return new PdfPageSizeStore(() => readPdfPageSizeChunks(pdfPath, options));
}

// Plural spelling is kept as a direct alias for callers that name the stream
// after the existing `readPdfPageSizes` compatibility function.
export const readPdfPageSizesChunks = readPdfPageSizeChunks;

/**
 * The paper rectangle of every page. It is document metadata rather than
 * content, so it costs one fast process on a scan of any size and answers
 * before a page has been rendered — and preview and final run never disagree
 * about the geometry, because they read it through the same order of tools.
 *
 * evb-pdf-page-ops answers first: it is the tool the lossless assembler writes
 * these boxes back with, so a run that has it measures and writes the same
 * rectangle. Poppler answers when it is missing or disabled, which keeps
 * matched page size — a default setting — working on an installation that
 * carries no page-ops rather than failing the feature over geometry every PDF
 * tool can report.
 */
export async function readPdfPageSizes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    if (options.pdfPageOpsBinary) {
        try {
            return await readWithPageOps(pdfPath, options, options.pdfPageOpsBinary);
        } catch (error) {
            if (options.signal?.aborted || !options.pdfinfoBinary) throw error;
            options.log(
                'warn',
                `evb-pdf-page-ops could not report page geometry, falling back to pdfinfo: ${getErrorMessage(error)}`,
            );
        }
    }
    if (options.pdfinfoBinary) {
        return readWithPdfInfo(pdfPath, options, options.pdfinfoBinary);
    }
    throw new Error('No PDF tool is available to read page geometry');
}
