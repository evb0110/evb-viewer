import { requirePageNumber } from '@contracts/pageNumbers';

// IPC payloads are renderer-controlled. These ceilings are intentionally far
// above legitimate document/UI sizes while keeping validation work and native
// allocations bounded before any scan-cleanup operation starts.
export const SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES = 20_000;
export const SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER = Number.MAX_SAFE_INTEGER;
/** Maximum page records in one native manifest. This is not a document cap. */
export const SCAN_CLEANUP_NATIVE_MANIFEST_MAX_PAGES = 20_000;
/** Maximum pages retained by one production conversion or compatibility window. */
export const SCAN_CLEANUP_STREAMING_BATCH_PAGES = 1_024;
/** Maximum clusters retained by the document-wide ink calibration summary. */
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_CLUSTERS = 256;
/** The summary carries only sparse early, middle, and late evidence. */
export const SCAN_CLEANUP_PLACEMENT_ANCHOR_SUMMARY_MAX_SAMPLES = 9;
export const SCAN_CLEANUP_INPUT_MAX_ZONES_PER_PAGE = 256;
export const SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_POLYGON = 64;
export const SCAN_CLEANUP_INPUT_MAX_VERTICES_PER_PAGE = 8_192;
export const SCAN_CLEANUP_INPUT_MAX_ZONES = 20_000;
export const SCAN_CLEANUP_INPUT_MAX_VERTICES = 100_000;
export const SCAN_CLEANUP_INPUT_MAX_PATH_BYTES = 4_096;
export const SCAN_CLEANUP_INPUT_MAX_ID_BYTES = 128;
export const SCAN_CLEANUP_LEGACY_STORAGE_MAX_BYTES = 5 * 1024 * 1024;

const UTF8_ENCODER = new TextEncoder();

export interface IScanCleanupInputBudget {
    pages: number;
    vertices: number;
    zones: number;
}

export function createScanCleanupInputBudget(): IScanCleanupInputBudget {
    return {
        pages: 0,
        vertices: 0,
        zones: 0,
    };
}

export function scanCleanupUtf8ByteLength(value: string) {
    return UTF8_ENCODER.encode(value).byteLength;
}

export function decodeBoundedScanCleanupString(
    value: unknown,
    label: string,
    maxBytes: number,
) {
    if (
        typeof value !== 'string'
        || value.trim().length === 0
        || value.includes('\0')
        || scanCleanupUtf8ByteLength(value) > maxBytes
    ) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return value;
}

export function decodeScanCleanupPageNumber(value: unknown, label: string) {
    if (
        !Number.isSafeInteger(value)
        || Number(value) < 1
        || Number(value) > SCAN_CLEANUP_INPUT_MAX_PAGE_NUMBER
    ) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return requirePageNumber(Number(value));
}

export function decodeScanCleanupPageKey(value: string, label: string) {
    if (!/^[1-9]\d*$/u.test(value)) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    const pageNumber = decodeScanCleanupPageNumber(Number(value), label);
    if (String(pageNumber) !== value) {
        throw new Error(`invalid scan-cleanup ${label}`);
    }
    return pageNumber;
}

export function consumeScanCleanupPages(
    budget: IScanCleanupInputBudget,
    count: number,
    label: string,
) {
    budget.pages += count;
    if (!Number.isSafeInteger(budget.pages) || budget.pages > SCAN_CLEANUP_INPUT_MAX_PAGE_ENTRIES) {
        throw new Error(`too many scan-cleanup ${label}`);
    }
}

export function consumeScanCleanupZones(
    budget: IScanCleanupInputBudget,
    count: number,
    label: string,
) {
    budget.zones += count;
    if (!Number.isSafeInteger(budget.zones) || budget.zones > SCAN_CLEANUP_INPUT_MAX_ZONES) {
        throw new Error(`too many scan-cleanup ${label}`);
    }
}

export function consumeScanCleanupVertices(
    budget: IScanCleanupInputBudget,
    count: number,
    label: string,
) {
    budget.vertices += count;
    if (!Number.isSafeInteger(budget.vertices) || budget.vertices > SCAN_CLEANUP_INPUT_MAX_VERTICES) {
        throw new Error(`too many scan-cleanup ${label}`);
    }
}
