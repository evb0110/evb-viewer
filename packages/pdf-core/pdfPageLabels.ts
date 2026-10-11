import { clamp } from 'es-toolkit/math';
import {
    admitPdfPageLabelStartNumber, PDF_PAGE_LABEL_STYLE_VALUES,
} from '@contracts/pdfPageLabels';
import {
    getLabelForOffset, pageLabelMatchesText, pageLabelValuesMatch, formatPageLabelForDisplay,
} from '@pdf-core/pdfPageLabelFormatting';
import type {
    IPdfPageLabelRange,
    IPdfPageLabelSegment,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';
export { formatPageLabelForDisplay } from '@pdf-core/pdfPageLabelFormatting';

/** Maximum number of labels returned by one bounded window read. */
export const PAGE_LABEL_MAX_WINDOW_PAGES = 128;

export type TDocumentPageLabelStyle = TPdfPageLabelStyle;
export type IDocumentPageLabelRange = IPdfPageLabelRange;
export type IDocumentPageLabelSegment = IPdfPageLabelSegment;

export interface IDocumentPageLabelWindow {
    startPage: number;
    endPage: number;
    labels: string[];
}
export interface IDocumentPageLabelModel {
    totalPages: number;
    ranges: readonly IDocumentPageLabelRange[];
    segments: readonly IDocumentPageLabelSegment[];
    labelAt: (page: number) => string | null;
    readWindow: (startPage: number, endPageOrCount?: number) => string[];
}
export interface IDocumentPageRange {
    startPage: number;
    endPage: number;
}

export type TDocumentPageLabelLookup = readonly string[] | IDocumentPageLabelModel | null;

type TNonNullPageLabelStyle = Exclude<TDocumentPageLabelStyle, null>;
const PAGE_LABEL_STYLE_SET: ReadonlySet<string> = new Set<TNonNullPageLabelStyle>(PDF_PAGE_LABEL_STYLE_VALUES);

function isNonNullPageLabelStyle(style: unknown): style is TNonNullPageLabelStyle {
    return typeof style === 'string' && PAGE_LABEL_STYLE_SET.has(style);
}

function toPositiveInt(value: unknown, fallback: number) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return parsed;
}

export {
    getPageLabelStartNumberMax, PAGE_LABEL_MAX_ALPHABETIC_START_NUMBER, PAGE_LABEL_MAX_ROMAN_START_NUMBER,
} from '@contracts/pdfPageLabels';

function normalizeStyle(style: unknown): TDocumentPageLabelStyle {
    if (style === null) {
        return null;
    }
    if (isNonNullPageLabelStyle(style)) {
        return style;
    }
    return 'D';
}
function parseRoman(value: string) {
    if (!/^[ivxlcdm]+$/i.test(value)) {
        return null;
    }

    const numerals: Record<string, number> = {
        I: 1,
        V: 5,
        X: 10,
        L: 50,
        C: 100,
        D: 500,
        M: 1000,
    };

    const upper = value.toUpperCase();
    let total = 0;
    for (let index = 0; index < upper.length; index += 1) {
        const current = numerals[upper[index] ?? ''] ?? 0;
        const next = numerals[upper[index + 1] ?? ''] ?? 0;
        total += current < next ? -current : current;
    }

    if (total < 1) {
        return null;
    }

    return pageLabelMatchesText({
        startPage: 1,
        style: value === value.toLowerCase() ? 'r' : 'R',
        prefix: '',
        startNumber: total,
    }, 0, value) ? total : null;
}

function parseAlphabetic(value: string) {
    if (!/^[A-Za-z]+$/.test(value)) {
        return null;
    }
    const normalized = value.toLowerCase();
    if (normalized !== normalized.charAt(0).repeat(normalized.length)) {
        return null;
    }
    const offset = normalized.charCodeAt(0) - 0x61;
    const repeatCount = normalized.length;
    return ((repeatCount - 1) * 26) + offset + 1;
}

function findRangeIndexForPage(
    page: number,
    ranges: readonly IDocumentPageLabelRange[],
) {
    let low = 0;
    let high = ranges.length - 1;
    let result = 0;

    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const range = ranges[middle];
        if (!range || range.startPage > page) {
            high = middle - 1;
            continue;
        }
        result = middle;
        low = middle + 1;
    }

    return result;
}
function buildPageLabelSegmentsFromNormalizedRanges(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
): IDocumentPageLabelSegment[] {
    return ranges.map((range, index) => ({
        ...range,
        endPage: Math.max(
            range.startPage,
            Math.min(totalPages, (ranges[index + 1]?.startPage ?? totalPages + 1) - 1),
        ),
    }));
}
/** A label prefix holding a line break was never inferred: the old `(.*?)` could not cross one. */
const LINE_BREAK = /[\n\r\u2028\u2029]/u;
/** Start of the longest trailing run of characters `inRun` accepts. A loop: a lazy regex overflows on a long label. */
function trailingRunStart(label: string, inRun: (code: number) => boolean) {
    let start = label.length;
    while (start > 0 && inRun(label.charCodeAt(start - 1))) {
        start -= 1;
    }
    return start;
}
function inferDecimalCandidate(label: string): IDocumentPageLabelRange | null {
    const start = trailingRunStart(label, code => code >= 0x30 && code <= 0x39);
    if (start === label.length || LINE_BREAK.test(label.slice(0, start))) {
        return null;
    }

    return {
        startPage: 1,
        style: 'D',
        prefix: label.slice(0, start),
        startNumber: toPositiveInt(label.slice(start), 1),
    };
}
function inferRomanCandidate(label: string): IDocumentPageLabelRange | null {
    const start = trailingRunStart(label, code => 'ivxlcdm'.includes(String.fromCharCode(code | 0x20)));
    const suffix = label.slice(start);
    const romanValue = parseRoman(suffix);
    if (romanValue === null || LINE_BREAK.test(label.slice(0, start))) {
        return null;
    }

    return {
        startPage: 1,
        style: suffix === suffix.toLowerCase() ? 'r' : 'R',
        prefix: label.slice(0, start),
        startNumber: romanValue,
    };
}
function inferAlphabeticCandidate(label: string): IDocumentPageLabelRange | null {
    const start = trailingRunStart(label, code => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a);
    const suffix = label.slice(start);
    const alphaValue = parseAlphabetic(suffix);
    if (alphaValue === null || LINE_BREAK.test(label.slice(0, start))) {
        return null;
    }

    return {
        startPage: 1,
        style: suffix === suffix.toLowerCase() ? 'a' : 'A',
        prefix: label.slice(0, start),
        startNumber: alphaValue,
    };
}
function inferCandidates(label: string): [IDocumentPageLabelRange, ...IDocumentPageLabelRange[]] {
    const candidates: [IDocumentPageLabelRange, ...IDocumentPageLabelRange[]] = [{
        startPage: 1,
        style: null,
        prefix: label,
        startNumber: 1,
    }];
    const parsedCandidates = [
        inferDecimalCandidate(label),
        inferRomanCandidate(label),
        inferAlphabeticCandidate(label),
    ];

    for (const candidate of parsedCandidates) {
        if (candidate) {
            candidates.push(candidate);
        }
    }

    return candidates;
}
export function normalizePageLabelRanges(
    ranges: readonly IDocumentPageLabelRange[],
    totalPages: number,
): IDocumentPageLabelRange[] {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    if (normalizedTotalPages <= 0) {
        return [];
    }

    const deduped = new Map<number, IDocumentPageLabelRange>();

    for (const range of ranges) {
        const startPage = clamp(
            toPositiveInt(range.startPage, 1),
            1,
            normalizedTotalPages,
        );
        const style = normalizeStyle(range.style);
        const prefix = typeof range.prefix === 'string' ? range.prefix : '';
        const startNumber = toPositiveInt(range.startNumber, 1);

        deduped.set(startPage, {
            startPage,
            style,
            prefix,
            startNumber,
        });
    }

    if (!deduped.has(1)) {
        deduped.set(1, {
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        });
    }

    const sorted = Array.from(deduped.values()).sort((left, right) => left.startPage - right.startPage);
    const canonical: IDocumentPageLabelRange[] = [];
    for (const range of sorted) {
        const previous = canonical[canonical.length - 1];
        if (
            previous
            && previous.style === range.style
            && previous.prefix === range.prefix
            && (
                range.style === null
                || previous.startNumber + (range.startPage - previous.startPage) === range.startNumber
            )
        ) {
            continue;
        }
        canonical.push(range);
    }
    return canonical;
}
/** Return canonical, inclusive segments for a page-label range list. */
export function buildPageLabelSegments(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
): IDocumentPageLabelSegment[] {
    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    return buildPageLabelSegmentsFromNormalizedRanges(
        Number.isSafeInteger(totalPages) ? Math.max(0, totalPages) : 0,
        normalizedRanges,
    );
}

function normalizeWindowBounds(
    totalPages: number,
    startPage: number,
    endPageOrCount: number | undefined,
) {
    if (totalPages <= 0) {
        return null;
    }

    const first = clamp(
        Number.isFinite(startPage) ? Math.trunc(startPage) : 1,
        1,
        totalPages,
    );
    if (
        endPageOrCount !== undefined
        && (!Number.isFinite(endPageOrCount) || Math.trunc(endPageOrCount) < 1)
    ) {
        return null;
    }
    const requestedEnd = endPageOrCount === undefined
        ? first + PAGE_LABEL_MAX_WINDOW_PAGES - 1
        : Math.trunc(endPageOrCount) < first
            ? first + Math.max(0, Math.trunc(endPageOrCount)) - 1
            : Math.trunc(endPageOrCount);
    const last = clamp(
        requestedEnd,
        first,
        Math.min(totalPages, first + PAGE_LABEL_MAX_WINDOW_PAGES - 1),
    );

    return {
        startPage: first,
        endPage: last,
    };
}
function readPageLabelWindowFromNormalizedRanges(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    startPage: number,
    endPageOrCount?: number,
): string[] {
    const bounds = normalizeWindowBounds(totalPages, startPage, endPageOrCount);
    if (!bounds) {
        return [];
    }

    const labels = new Array<string>(bounds.endPage - bounds.startPage + 1);
    let rangeIndex = findRangeIndexForPage(bounds.startPage, ranges);
    let activeRange = ranges[rangeIndex] ?? ranges[0] ?? {
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    };

    for (let page = bounds.startPage; page <= bounds.endPage; page += 1) {
        while (
            rangeIndex + 1 < ranges.length
            && (ranges[rangeIndex + 1]?.startPage ?? totalPages + 1) <= page
        ) {
            rangeIndex += 1;
            activeRange = ranges[rangeIndex] ?? activeRange;
        }
        labels[page - bounds.startPage] = getLabelForOffset(activeRange, page - activeRange.startPage);
    }

    return labels;
}
/**
 * Read at most PAGE_LABEL_MAX_WINDOW_PAGES labels without creating a
 * page-count-sized array. The third argument is an inclusive end page when
 * it is at least startPage, or a count when it is smaller than startPage.
 */
export function readPageLabelWindow(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    startPage: number,
    endPageOrCount?: number,
): string[] {
    return readPageLabelWindowFromNormalizedRanges(
        Number.isSafeInteger(totalPages) ? Math.max(0, totalPages) : 0,
        normalizePageLabelRanges(ranges, totalPages),
        startPage,
        endPageOrCount,
    );
}
/** Return a bounded window together with its resolved one-based bounds. */
export function getPageLabelWindow(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    startPage: number,
    endPageOrCount?: number,
): IDocumentPageLabelWindow {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    const bounds = normalizeWindowBounds(normalizedTotalPages, startPage, endPageOrCount);
    if (!bounds) {
        return {
            startPage: 0,
            endPage: 0,
            labels: [],
        };
    }
    return {
        ...bounds,
        labels: readPageLabelWindow(
            normalizedTotalPages,
            ranges,
            bounds.startPage,
            bounds.endPage,
        ),
    };
}

export function createPageLabelModel(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
): IDocumentPageLabelModel {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    const normalizedRanges = normalizePageLabelRanges(ranges, normalizedTotalPages);
    const segments = buildPageLabelSegmentsFromNormalizedRanges(
        normalizedTotalPages,
        normalizedRanges,
    );

    const labelAt = (page: number) => {
        if (
            !Number.isSafeInteger(page)
            || page < 1
            || page > normalizedTotalPages
        ) {
            return null;
        }
        const range = normalizedRanges[findRangeIndexForPage(page, normalizedRanges)];
        return range
            ? getLabelForOffset(range, page - range.startPage)
            : String(page);
    };

    const readWindow = (startPage: number, endPageOrCount?: number) => (
        readPageLabelWindowFromNormalizedRanges(
            normalizedTotalPages,
            normalizedRanges,
            startPage,
            endPageOrCount,
        )
    );

    return {
        totalPages: normalizedTotalPages,
        ranges: normalizedRanges,
        segments,
        labelAt,
        readWindow,
    };
}
/** Resolve one logical label without materializing the whole document. */
export function getPageLabelAt(
    page: number,
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
): string | null {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    if (
        !Number.isSafeInteger(page)
        || page < 1
        || page > normalizedTotalPages
    ) {
        return null;
    }
    const normalizedRanges = normalizePageLabelRanges(ranges, normalizedTotalPages);
    const range = normalizedRanges[findRangeIndexForPage(page, normalizedRanges)];
    return range
        ? getLabelForOffset(range, page - range.startPage)
        : String(page);
}
function getRangeForPage(
    page: number,
    ranges: readonly IDocumentPageLabelRange[],
) {
    return ranges[findRangeIndexForPage(page, ranges)] ?? ranges[0] ?? {
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    };
}

function pageLabelFormulasMatch(
    before: IDocumentPageLabelRange,
    after: IDocumentPageLabelRange,
) {
    if (before.style !== after.style || before.prefix !== after.prefix) {
        return false;
    }
    if (before.style === null) {
        return true;
    }
    return before.startNumber - before.startPage === after.startNumber - after.startPage;
}

function normalizePageRangeForEdit(
    totalPages: number,
    range: IDocumentPageRange,
) {
    if (totalPages <= 0) {
        return null;
    }
    const first = clamp(toPositiveInt(range.startPage, 1), 1, totalPages);
    const last = clamp(toPositiveInt(range.endPage, first), 1, totalPages);
    return {
        startPage: Math.min(first, last),
        endPage: Math.max(first, last),
    };
}

/**
 * Replace one inclusive page span while retaining the old numbering after the
 * span. This is range surgery, so a million-page document costs O(rangeCount)
 * and never needs a labels array.
 */
export function replacePageLabelRange(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    target: IDocumentPageRange,
    replacement: Omit<IDocumentPageLabelRange, 'startPage'>,
): IDocumentPageLabelRange[] {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    const normalizedTarget = normalizePageRangeForEdit(normalizedTotalPages, target);
    if (!normalizedTarget) {
        return [];
    }

    const currentRanges = normalizePageLabelRanges(ranges, normalizedTotalPages);
    const nextRanges: IDocumentPageLabelRange[] = currentRanges.filter(
        range => range.startPage < normalizedTarget.startPage,
    );
    nextRanges.push({
        startPage: normalizedTarget.startPage,
        style: normalizeStyle(replacement.style),
        prefix: typeof replacement.prefix === 'string' ? replacement.prefix : '',
        startNumber: admitPdfPageLabelStartNumber(normalizeStyle(replacement.style), toPositiveInt(replacement.startNumber, 1)),
    });

    if (normalizedTarget.endPage < normalizedTotalPages) {
        const pageAfterTarget = normalizedTarget.endPage + 1;
        const previousRange = getRangeForPage(pageAfterTarget, currentRanges);
        if (previousRange.startPage < pageAfterTarget) {
            nextRanges.push({
                ...previousRange,
                startPage: pageAfterTarget,
                startNumber: previousRange.style === null
                    ? previousRange.startNumber
                    : toPositiveInt(
                        previousRange.startNumber + (pageAfterTarget - previousRange.startPage),
                        Number.MAX_SAFE_INTEGER,
                    ),
            });
        }
        nextRanges.push(...currentRanges.filter(range => range.startPage > normalizedTarget.endPage));
    }

    return normalizePageLabelRanges(nextRanges, normalizedTotalPages);
}

/** Alias kept descriptive at call sites that apply a configured span. */
export const applyPageLabelRange = replacePageLabelRange;

/** Set one explicit logical label while retaining every other page's label. */
export function setPageLabelAt(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    page: number,
    label: string,
): IDocumentPageLabelRange[] {
    const normalizedPage = clamp(toPositiveInt(page, 1), 1, Math.max(1, totalPages));
    return replacePageLabelRange(
        totalPages,
        ranges,
        {
            startPage: normalizedPage,
            endPage: normalizedPage,
        },
        {
            style: null,
            prefix: typeof label === 'string' ? label : '',
            startNumber: 1,
        },
    );
}

export interface IDocumentPageLabelUpdate {
    page: number;
    label: string;
}

/** Apply sparse explicit-label updates without cloning the document's pages. */
export function applySparsePageLabelUpdates(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
    updates: Iterable<IDocumentPageLabelUpdate>,
): IDocumentPageLabelRange[] {
    let nextRanges = normalizePageLabelRanges(ranges, totalPages);
    for (const update of updates) {
        if (!Number.isFinite(update.page)) {
            continue;
        }
        const page = Math.trunc(update.page);
        if (page < 1 || page > totalPages) {
            continue;
        }
        const currentRange = getRangeForPage(page, nextRanges);
        const nextLabel = typeof update.label === 'string' ? update.label : '';
        if (pageLabelMatchesText(currentRange, page - currentRange.startPage, nextLabel)) {
            continue;
        }
        nextRanges = setPageLabelAt(totalPages, nextRanges, page, nextLabel);
    }
    return nextRanges;
}

/**
 * Count changed pages by comparing range formulas. Long equal or changed
 * spans stay O(rangeCount), while short spans use the actual formatted labels
 * to keep unusual prefix/style collisions exact.
 */
export function countPageLabelDifferences(
    totalPages: number,
    beforeRanges: readonly IDocumentPageLabelRange[],
    afterRanges: readonly IDocumentPageLabelRange[],
): number {
    const normalizedTotalPages = Number.isSafeInteger(totalPages)
        ? Math.max(0, totalPages)
        : 0;
    if (normalizedTotalPages <= 0) {
        return 0;
    }

    const before = normalizePageLabelRanges(beforeRanges, normalizedTotalPages);
    const after = normalizePageLabelRanges(afterRanges, normalizedTotalPages);
    const boundaries = new Set<number>([
        1,
        normalizedTotalPages + 1,
    ]);
    for (const range of before) {
        boundaries.add(range.startPage);
    }
    for (const range of after) {
        boundaries.add(range.startPage);
    }
    const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
    let changed = 0;
    const EXACT_INTERVAL_SCAN_LIMIT = 256;

    for (let index = 0; index + 1 < sortedBoundaries.length; index += 1) {
        const startPage = sortedBoundaries[index] ?? 1;
        const endPage = Math.min(
            normalizedTotalPages,
            (sortedBoundaries[index + 1] ?? normalizedTotalPages + 1) - 1,
        );
        const pageCount = Math.max(0, endPage - startPage + 1);
        if (pageCount === 0) {
            continue;
        }

        const beforeRange = getRangeForPage(startPage, before);
        const afterRange = getRangeForPage(startPage, after);
        if (pageLabelFormulasMatch(beforeRange, afterRange)) {
            continue;
        }
        if (pageCount > EXACT_INTERVAL_SCAN_LIMIT) {
            changed += pageCount;
            continue;
        }

        for (let page = startPage; page <= endPage; page += 1) {
            if (!pageLabelValuesMatch(beforeRange, page - beforeRange.startPage, afterRange, page - afterRange.startPage)) {
                changed += 1;
            }
        }
    }

    return changed;
}

export function buildPageLabelsFromRanges(
    totalPages: number,
    ranges: readonly IDocumentPageLabelRange[],
): string[] {
    if (totalPages <= 0) {
        return [];
    }

    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    const labels = new Array<string>(totalPages);
    let rangeIndex = 0;
    let activeRange = normalizedRanges[0] ?? {
        startPage: 1,
        style: 'D' as const,
        prefix: '',
        startNumber: 1,
    };

    for (let page = 1; page <= totalPages; page += 1) {
        while (
            rangeIndex + 1 < normalizedRanges.length
            && (normalizedRanges[rangeIndex + 1]?.startPage ?? totalPages + 1) <= page
        ) {
            rangeIndex += 1;
            activeRange = normalizedRanges[rangeIndex] ?? activeRange;
        }

        const offset = page - activeRange.startPage;
        labels[page - 1] = getLabelForOffset(activeRange, offset);
    }

    return labels;
}

export function buildWholeDocumentPageLabelRanges(
    totalPages: number,
    options: Omit<IDocumentPageLabelRange, 'startPage'>,
): IDocumentPageLabelRange[] {
    if (totalPages <= 0) {
        return [];
    }

    return normalizePageLabelRanges([{
        startPage: 1,
        style: options.style,
        prefix: options.prefix,
        startNumber: admitPdfPageLabelStartNumber(options.style, toPositiveInt(options.startNumber, 1)),
    }], totalPages);
}

export function derivePageLabelRangesFromLabels(
    pageLabels: readonly string[] | null,
    totalPages: number,
): IDocumentPageLabelRange[] {
    if (totalPages <= 0) {
        return [];
    }

    if (!pageLabels || pageLabels.length !== totalPages) {
        return [{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }];
    }

    const ranges: IDocumentPageLabelRange[] = [];
    let pageIndex = 0;

    while (pageIndex < totalPages) {
        const label = pageLabels[pageIndex] ?? '';
        const candidates = inferCandidates(label);

        let bestRange: IDocumentPageLabelRange = candidates[0];
        let bestLength = 1;
        let bestPriority = bestRange.style === null ? 0 : 1;

        for (const candidate of candidates) {
            let length = 1;
            while (pageIndex + length < totalPages) {
                const actual = pageLabels[pageIndex + length] ?? '';
                if (!pageLabelMatchesText(candidate, length, actual)) {
                    break;
                }
                length += 1;
            }

            const priority = candidate.style === null ? 0 : 1;
            if (length > bestLength || (length === bestLength && priority > bestPriority)) {
                bestRange = candidate;
                bestLength = length;
                bestPriority = priority;
            }
        }

        ranges.push({
            ...bestRange,
            startPage: pageIndex + 1,
        });
        pageIndex += bestLength;
    }

    return normalizePageLabelRanges(ranges, totalPages);
}

function isPageLabelArray(
    pageLabels: TDocumentPageLabelLookup,
): pageLabels is readonly string[] {
    return Array.isArray(pageLabels);
}

/** Parse the numbering part of a label in its segment's style, or null when it is not one. */
function parseSegmentNumber(style: TNonNullPageLabelStyle, suffix: string) {
    if (style === 'D') {
        return /^\d+$/.test(suffix) ? Number.parseInt(suffix, 10) : null;
    }
    if (style === 'R' || style === 'r') {
        return parseRoman(suffix);
    }
    return parseAlphabetic(suffix);
}

function findPageByLabelInModel(
    input: string,
    model: IDocumentPageLabelModel,
    caseInsensitive: boolean,
) {
    const candidate = caseInsensitive ? input.toLowerCase() : input;
    for (const segment of model.segments) {
        if (segment.style === null) {
            const segmentLabel = caseInsensitive ? segment.prefix.toLowerCase() : segment.prefix;
            if (segmentLabel === candidate) {
                return segment.startPage;
            }
            continue;
        }

        // The segment already knows its prefix; only the remainder is numbering.
        const inputPrefix = input.slice(0, segment.prefix.length);
        const prefixMatches = caseInsensitive
            ? inputPrefix.toLowerCase() === segment.prefix.toLowerCase()
            : inputPrefix === segment.prefix;
        if (!prefixMatches) {
            continue;
        }
        const suffix = input.slice(segment.prefix.length);
        const number = parseSegmentNumber(segment.style, caseInsensitive ? suffix.toLowerCase() : suffix);
        if (number === null) {
            continue;
        }
        const page = segment.startPage + number - segment.startNumber;
        if (page >= segment.startPage && page <= segment.endPage) {
            if (pageLabelMatchesText(segment, page - segment.startPage, input, caseInsensitive)) {
                return page;
            }
        }
    }
    return null;
}

/** Shortened text is a target only when exactly one physical page displays it. */
function findPageByPresentedLabel(input: string, labels: Exclude<TDocumentPageLabelLookup, null>, folded = false): number | null {
    const candidate = folded ? input.toLowerCase() : input;
    let match: number | null = null;
    const matches = (text: string) => (folded ? text.toLowerCase() : text) === candidate;
    if (isPageLabelArray(labels)) {
        for (let index = 0; index < labels.length; index += 1) {
            if (matches(formatPageLabelForDisplay(labels[index] ?? ''))) {
                if (match !== null) {
                    return null;
                }
                match = index + 1;
            }
        }
        return match;
    }
    for (const segment of labels.segments) {
        function* candidates() {
            if (segment.style === null) {
                yield segment.startPage;
                yield segment.startPage + 1;
                return;
            }
            const suffix = input.slice(input.lastIndexOf('…') + 1);
            const number = parseSegmentNumber(segment.style, folded ? suffix.toLowerCase() : suffix);
            if (number !== null) {
                yield segment.startPage + number - segment.startNumber;
            }
            if (!input.endsWith('…')) {
                return;
            }
            if (segment.style === 'A' || segment.style === 'a') {
                // Once the repeated letters fill the head, every later cycle has that same view.
                for (let residue = 0; residue < 26; residue += 1) {
                    const firstNumber = Math.max(26 * 32 + residue + 1,
                        segment.startNumber + (residue - (segment.startNumber - 1) % 26 + 26) % 26);
                    for (let step = 0; step <= 65; step += 1) {
                        yield segment.startPage + firstNumber + step * 26 - segment.startNumber;
                    }
                }
            } else if (segment.style === 'R' || segment.style === 'r') {
                // Roman remainder repeats every thousand; the head stabilizes within 65 thousands.
                for (let remainder = 0; remainder < 1000; remainder += 1) {
                    const suffixLength = remainder === 0 ? 0
                        : getLabelForOffset({
                            ...segment,
                            prefix: '',
                            startNumber: remainder,
                        }, 0).length;
                    const thousands = Math.max(0, 33 - suffixLength, Math.ceil((segment.startNumber - remainder) / 1000));
                    for (let step = 0; step <= 65; step += 1) {
                        yield segment.startPage + (thousands + step) * 1000 + remainder - segment.startNumber;
                    }
                }
            }
        }
        for (const page of candidates()) {
            if (page < segment.startPage || page > segment.endPage
                || !matches(formatPageLabelForDisplay(segment, page - segment.startPage))) {
                continue;
            }
            if (match !== null && match !== page) {
                return null;
            }
            match = page;
        }
    }
    return match;
}

export function findPageByPageLabelInput(input: string, totalPages: number, pageLabels: TDocumentPageLabelLookup) {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        return null;
    }

    if (isPageLabelArray(pageLabels) && pageLabels.length === totalPages) {
        const exactIndex = pageLabels.findIndex(label => label === trimmed);
        if (exactIndex >= 0) {
            return exactIndex + 1;
        }

        const lowered = trimmed.toLowerCase();
        const caseInsensitiveIndex = pageLabels.findIndex(label => label.toLowerCase() === lowered);
        if (caseInsensitiveIndex >= 0) {
            return caseInsensitiveIndex + 1;
        }
    }

    if (!isPageLabelArray(pageLabels) && pageLabels) {
        const exactModelPage = findPageByLabelInModel(trimmed, pageLabels, false);
        if (exactModelPage !== null) {
            return exactModelPage;
        }
        const caseInsensitiveModelPage = findPageByLabelInModel(trimmed, pageLabels, true);
        if (caseInsensitiveModelPage !== null) {
            return caseInsensitiveModelPage;
        }
    }

    if (pageLabels && trimmed.includes('…')) {
        const displayed = findPageByPresentedLabel(trimmed, pageLabels)
            ?? findPageByPresentedLabel(trimmed, pageLabels, true);
        if (displayed !== null) {
            return displayed;
        }
    }

    if (/^\d+$/.test(trimmed)) {
        const page = Number.parseInt(trimmed, 10);
        if (Number.isFinite(page) && page >= 1 && page <= totalPages) {
            return page;
        }
    }

    return null;
}

export function isImplicitDefaultPageLabels(
    ranges: readonly IDocumentPageLabelRange[],
    totalPages: number,
) {
    const normalizedRanges = normalizePageLabelRanges(ranges, totalPages);
    if (normalizedRanges.length !== 1) {
        return false;
    }
    const range = normalizedRanges[0];
    if (!range) {
        return false;
    }
    return (
        range.startPage === 1
        && range.style === 'D'
        && range.prefix.length === 0
        && range.startNumber === 1
    );
}
