import {stat} from 'node:fs/promises';

/** Keep the eager search-index route within the existing whole-value budget. */
export const SEARCH_JS_WHOLE_VALUE_MAX_BYTES = 16 * 1024 * 1024;

/** Above this count, retaining one page object per document is not acceptable. */
export const SEARCH_XLARGE_PAGE_COUNT_THRESHOLD = 200;

export interface IXlargeSearchPathClassification {
    isXlarge: boolean;
    pageCount: number | undefined;
    pathSizeBytes: number | undefined;
    reasons: ReadonlyArray<'path-size' | 'page-count'>;
}

export interface IXlargeSearchPathClassificationInput {
    pageCount?: number;
    pathSizeBytes?: number;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value > 0;
}

/** Classify a path-backed search request without reading the document. */
export function classifyXlargeSearchPath(
    input: IXlargeSearchPathClassificationInput,
): IXlargeSearchPathClassification {
    const pageCount = isPositiveSafeInteger(input.pageCount)
        ? input.pageCount
        : undefined;
    const pathSizeBytes = isPositiveFiniteNumber(input.pathSizeBytes)
        ? input.pathSizeBytes
        : undefined;
    const reasons: Array<'path-size' | 'page-count'> = [];
    if (pathSizeBytes !== undefined && pathSizeBytes > SEARCH_JS_WHOLE_VALUE_MAX_BYTES) {
        reasons.push('path-size');
    }
    if (pageCount !== undefined && pageCount > SEARCH_XLARGE_PAGE_COUNT_THRESHOLD) {
        reasons.push('page-count');
    }
    return {
        isXlarge: reasons.length > 0,
        pageCount,
        pathSizeBytes,
        reasons,
    };
}

/** Read only the scalar file size needed by the xlarge classifier. */
export async function classifyXlargeSearchPathFromFile(
    pdfPath: string,
    pageCount?: number,
): Promise<IXlargeSearchPathClassification> {
    let pathSizeBytes: number | undefined;
    try {
        const fileStat = await stat(pdfPath);
        if (isPositiveFiniteNumber(fileStat.size)) {
            pathSizeBytes = fileStat.size;
        }
    } catch {
        // An unknown size must not turn a known high-page-count request into
        // a legacy whole-document operation.
    }
    return classifyXlargeSearchPath({
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(pathSizeBytes === undefined ? {} : {pathSizeBytes}),
    });
}
