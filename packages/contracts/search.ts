import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    parsePageNumber,
    type TPageNumber,
} from '@contracts/pageNumbers';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {
    isOcrWord,
    type IOcrWord,
    requireRequestId,
    type TRequestId,
} from '@contracts/shared';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';
import {
    findSerializableErrorEnvelope,
    type ISerializableErrorEnvelope,
} from '@contracts/serializableError';
import {
    isEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

/** Shared user-visible search limits. Keep every runtime on these values. */
export const SEARCH_RESULT_LIMIT = 500;
export const SEARCH_EXCERPT_CONTEXT_CHARS = 56;
export const SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Minimum query lengths every search surface must honor, backend and UI alike.
 * PDF search answers from a prepared index, so a single character is cheap and
 * is the only way to search ideographic scripts. Document-source search scans
 * page text on demand, where a one-character query is too broad to be useful.
 */
export const PDF_SEARCH_MIN_QUERY_LENGTH = 1;
export const DOCUMENT_SOURCE_SEARCH_MIN_QUERY_LENGTH = 2;

export interface IPdfSearchExcerpt {
    readonly prefix: boolean;
    readonly suffix: boolean;
    readonly before: string;
    readonly match: string;
    readonly after: string;
}

export type TPdfSearchUtf16Offset = number;

export interface IPdfSearchUtf16Range {
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IPdfSearchResult {
    readonly pageNumber: TPageNumber;
    readonly pageMatchIndex: number;
    readonly matchIndex: number;
    readonly startOffset: TPdfSearchUtf16Offset;
    readonly endOffset: TPdfSearchUtf16Offset;
    readonly excerpt: IPdfSearchExcerpt;
    readonly words?: readonly IOcrWord[];
    readonly pageWidth?: number;
    readonly pageHeight?: number;
    readonly rotation?: TOcrIndexRotation;
}

export interface IPdfSearchResponse {
    readonly results: readonly IPdfSearchResult[];
    readonly truncated: boolean;
    readonly canceled?: boolean;
}

function decodeSearchExcerpt(value: unknown): IPdfSearchExcerpt | null {
    if (
        !isRecord(value)
        || typeof value.prefix !== 'boolean'
        || typeof value.suffix !== 'boolean'
        || typeof value.before !== 'string'
        || typeof value.match !== 'string'
        || typeof value.after !== 'string'
    ) {
        return null;
    }
    return {
        prefix: value.prefix,
        suffix: value.suffix,
        before: value.before,
        match: value.match,
        after: value.after,
    };
}

function decodeSearchResult(value: unknown, pageCount?: number): IPdfSearchResult | null {
    if (!isRecord(value)) {
        return null;
    }
    const pageNumber = typeof value.pageNumber === 'number'
        ? parsePageNumber(value.pageNumber, pageCount)
        : null;
    const excerpt = decodeSearchExcerpt(value.excerpt);
    const isNonNegativeInteger = (candidate: unknown): candidate is number => (
        typeof candidate === 'number'
        && Number.isSafeInteger(candidate)
        && candidate >= 0
    );
    if (
        pageNumber === null
        || !isNonNegativeInteger(value.pageMatchIndex)
        || !isNonNegativeInteger(value.matchIndex)
        || !isNonNegativeInteger(value.startOffset)
        || !isNonNegativeInteger(value.endOffset)
        || value.endOffset < value.startOffset
        || excerpt === null
        || (value.words !== undefined && (!Array.isArray(value.words) || !value.words.every(isOcrWord)))
        || (value.pageWidth !== undefined && (typeof value.pageWidth !== 'number' || !Number.isFinite(value.pageWidth) || value.pageWidth <= 0))
        || (value.pageHeight !== undefined && (typeof value.pageHeight !== 'number' || !Number.isFinite(value.pageHeight) || value.pageHeight <= 0))
        || (value.rotation !== undefined && value.rotation !== 0 && value.rotation !== 90 && value.rotation !== 180 && value.rotation !== 270)
    ) {
        return null;
    }
    return {
        pageNumber,
        pageMatchIndex: value.pageMatchIndex,
        matchIndex: value.matchIndex,
        startOffset: value.startOffset,
        endOffset: value.endOffset,
        excerpt,
        ...(value.words === undefined ? {} : {words: value.words}),
        ...(value.pageWidth === undefined ? {} : {pageWidth: value.pageWidth}),
        ...(value.pageHeight === undefined ? {} : {pageHeight: value.pageHeight}),
        ...(value.rotation === undefined ? {} : {rotation: value.rotation}),
    };
}

function decodeSearchResponse(value: unknown, pageCount?: number): IPdfSearchResponse | null {
    if (
        !isRecord(value)
        || !Array.isArray(value.results)
        || value.results.length > SEARCH_RESULT_LIMIT
        || typeof value.truncated !== 'boolean'
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
    ) {
        return null;
    }
    const results: IPdfSearchResult[] = [];
    for (const result of value.results) {
        const decoded = decodeSearchResult(result, pageCount);
        if (decoded === null) {
            return null;
        }
        results.push(decoded);
    }
    return {
        results,
        truncated: value.truncated,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
    };
}

/** The sole runtime decoder for search results crossing worker, IPC, or native boundaries. */
export const SEARCH_WIRE_CODEC = {
    decodeExcerpt: decodeSearchExcerpt,
    decodeResult: decodeSearchResult,
    decodeResponse: decodeSearchResponse,
} as const;

export interface IPdfSearchProgress {
    readonly requestId: TRequestId;
    readonly processed: number;
    readonly total: number;
    readonly results?: readonly IPdfSearchResult[];
    readonly resultsStartIndex?: number;
    readonly truncated?: boolean;
    readonly canceled?: boolean;
    readonly status?: 'running' | 'success' | 'canceled' | 'failed';
    readonly error?: string;
}

export type TSearchErrorCode =
    | 'SEARCH_INVALID_PAYLOAD'
    | 'SEARCH_PATH_DENIED'
    | 'SEARCH_WORKER_LIMIT'
    | 'SEARCH_WORKER_PROTOCOL'
    | 'SEARCH_TIMEOUT'
    | 'SEARCH_WORKER_ERROR'
    | 'SEARCH_INTERNAL';

export interface ISearchErrorEnvelope extends ISerializableErrorEnvelope<TSearchErrorCode> {
    readonly retryable: boolean;
    readonly timestamp: TEpochMs;
    readonly details?: string;
}

export interface ISearchErrorEnvelopeCarrier {readonly errorEnvelope?: ISearchErrorEnvelope;}

export function isSearchErrorEnvelope(value: unknown): value is ISearchErrorEnvelope {
    return isRecord(value)
        && typeof value.code === 'string'
        && [
            'SEARCH_INVALID_PAYLOAD',
            'SEARCH_PATH_DENIED',
            'SEARCH_WORKER_LIMIT',
            'SEARCH_WORKER_PROTOCOL',
            'SEARCH_TIMEOUT',
            'SEARCH_WORKER_ERROR',
            'SEARCH_INTERNAL',
        ].includes(value.code)
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean'
        && isEpochMs(value.timestamp)
        && (value.details === undefined || typeof value.details === 'string');
}

export function findSearchErrorEnvelope(value: unknown): ISearchErrorEnvelope | null {
    return findSerializableErrorEnvelope(value, isSearchErrorEnvelope);
}

export interface ISearchMatchOptions {
    matchCase?: boolean;
    wholeWord?: boolean;
    useRegex?: boolean;
}

export interface IResolvedSearchMatchOptions {
    matchCase: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

/** Exhaustive option semantics; consumers must not invent additional combinations. */
export const SEARCH_OPTION_SEMANTICS = [
    {
        matchCase: false,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: false,
        matcher: 'literal-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: false,
        matcher: 'literal-exact-boundary',
    },
    {
        matchCase: false,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-unicode-fold',
    },
    {
        matchCase: true,
        wholeWord: false,
        useRegex: true,
        matcher: 'regex-exact',
    },
    {
        matchCase: false,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-unicode-fold-boundary',
    },
    {
        matchCase: true,
        wholeWord: true,
        useRegex: true,
        matcher: 'regex-exact-boundary',
    },
] as const;

export interface IPdfSearchRequestOptions extends ISearchMatchOptions {
    requestId?: TRequestId;
    pageCount?: number;
    documentRevision?: TDocumentRevisionToken;
}

export const SEARCH_REQUEST_ID_MAX_LENGTH = 128;
export const SEARCH_PDF_PATH_MAX_LENGTH = 4_096;
export const SEARCH_QUERY_MAX_LENGTH = 2_048;
export const SEARCH_REGEX_QUERY_MAX_LENGTH = 512;
export const SEARCH_REGEX_MAX_EXECUTION_MS = 250;
export const SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH = 8_192;

export type TSearchablePageTextSeparator = 'none' | 'space' | 'line';

export interface ISearchablePageTextItem {
    text: string;
    separatorAfter?: TSearchablePageTextSeparator;
}

export interface ISearchablePageTextItemOffset {
    itemIndex: number;
    startOffset: TPdfSearchUtf16Offset;
    endOffset: TPdfSearchUtf16Offset;
}

export interface IAssembledSearchablePageText {
    text: string;
    itemOffsets: ISearchablePageTextItemOffset[];
    sourceOffsets: IPdfSearchUtf16Range[];
}

function joinSearchLineHyphenation(text: string) {
    return text.replace(/\u00AD|-[\p{Zs}\t]*(?:\r\n?|\n)[\p{Zs}\t]*/gu, '');
}

/**
 * Canonical assembly used by PDF.js items, word-box/OCR items and plain-text
 * extractors. Adjacent non-whitespace items receive one separator, line-end
 * hyphens are joined, and normalization/collapse policy is applied once.
 */
export function assembleSearchablePageText(
    items: readonly ISearchablePageTextItem[],
): IAssembledSearchablePageText {
    const parts: string[] = [];
    const owners: number[] = [];
    const rawSourceStarts: number[] = [];
    const rawSourceEnds: number[] = [];
    let sourceCursor = 0;

    const append = (value: string, owner: number, generated = false) => {
        parts.push(value);
        for (let index = 0; index < value.length; index += 1) {
            owners.push(owner);
            rawSourceStarts.push(sourceCursor + (generated ? 0 : index));
            rawSourceEnds.push(sourceCursor + (generated ? 0 : index + 1));
        }
    };

    items.forEach((item, itemIndex) => {
        const previous = parts.at(-1)?.at(-1) ?? '';
        const first = item.text.at(0) ?? '';
        if (previous && first && !/\s/u.test(previous) && !/\s/u.test(first)) {
            append(' ', itemIndex, true);
        }
        append(item.text, itemIndex);
        sourceCursor += item.text.length;
        const separator = item.separatorAfter ?? 'none';
        const last = parts.at(-1)?.at(-1) ?? '';
        if (separator === 'line' && last !== '\n') {
            append('\n', itemIndex, true);
        } else if (separator === 'space' && last && !/\s/u.test(last)) {
            append(' ', itemIndex, true);
        }
    });

    const rawText = parts.join('');
    const joinedText = joinSearchLineHyphenation(rawText);
    const retainedOwners: number[] = [];
    const retainedSourceStarts: number[] = [];
    const retainedSourceEnds: number[] = [];
    let normalizedOffset = 0;
    const hyphenationPattern = /\u00AD|-[\p{Zs}\t]*(?:\r\n?|\n)[\p{Zs}\t]*/gu;
    for (const match of rawText.matchAll(hyphenationPattern)) {
        retainedOwners.push(...owners.slice(normalizedOffset, match.index));
        retainedSourceStarts.push(...rawSourceStarts.slice(normalizedOffset, match.index));
        retainedSourceEnds.push(...rawSourceEnds.slice(normalizedOffset, match.index));
        normalizedOffset = match.index + match[0].length;
    }
    retainedOwners.push(...owners.slice(normalizedOffset));
    retainedSourceStarts.push(...rawSourceStarts.slice(normalizedOffset));
    retainedSourceEnds.push(...rawSourceEnds.slice(normalizedOffset));

    const text = collapseRepeatedPdfSearchPageText(joinedText);
    const finalOwners = retainedOwners.slice(0, text.length);
    const sourceOffsets = retainedSourceStarts.slice(0, text.length).map((startOffset, index) => ({
        startOffset,
        endOffset: retainedSourceEnds[index] ?? startOffset,
    }));
    const itemStarts = new Int32Array(items.length).fill(-1);
    const itemEnds = new Int32Array(items.length).fill(-1);
    for (let offset = 0; offset < finalOwners.length; offset += 1) {
        const owner = finalOwners[offset];
        if (owner === undefined || owner < 0 || owner >= items.length) {
            continue;
        }
        if (itemStarts[owner] === -1) {
            itemStarts[owner] = offset;
        }
        itemEnds[owner] = offset + 1;
    }
    const itemOffsets = items.map((_item, itemIndex): ISearchablePageTextItemOffset => {
        const startOffset = itemStarts[itemIndex] ?? -1;
        const endOffset = itemEnds[itemIndex] ?? -1;
        return {
            itemIndex,
            startOffset: startOffset < 0 ? 0 : startOffset,
            endOffset: endOffset < 0 ? 0 : endOffset,
        };
    });

    return {
        text,
        itemOffsets,
        sourceOffsets,
    };
}

export function escapeSearchRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SearchRegexLimitError extends Error {
    readonly code = 'SEARCH_REGEX_LIMIT';

    constructor(message: string) {
        super(message);
        this.name = 'SearchRegexLimitError';
    }
}

const SEARCH_WORD_CHARACTER_CLASS = '\\p{L}\\p{N}\\p{M}_\'’';
const SEARCH_CJK_SCRIPT_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function applyWholeWordBoundary(pattern: string) {
    return `(?<![${SEARCH_WORD_CHARACTER_CLASS}])(?:${pattern})(?![${SEARCH_WORD_CHARACTER_CLASS}])`;
}

export function buildPdfSearchRegex(
    query: string,
    options: IResolvedSearchMatchOptions,
) {
    if (options.useRegex) {
        assertSafePdfSearchRegex(query, options);
    }
    const basePattern = options.useRegex ? query : escapeSearchRegex(query);
    // CJK scripts normally have no whitespace-delimited word boundaries. For
    // literal CJK queries, wholeWord therefore intentionally means substring.
    const useBoundary = options.wholeWord
        && (options.useRegex || !SEARCH_CJK_SCRIPT_PATTERN.test(query));
    const pattern = useBoundary
        ? applyWholeWordBoundary(basePattern)
        : basePattern;
    const flags = options.matchCase ? 'gu' : 'giu';
    return new RegExp(pattern, flags);
}

interface IRegexGroupSafety {
    hasAlternation: boolean;
    hasQuantifier: boolean;
}

interface IClosedRegexGroupSafety extends IRegexGroupSafety {endIndex: number;}

const MAX_REGEX_QUANTIFIERS = 3;

function isRegexQuantifierAt(pattern: string, index: number) {
    const char = pattern[index];
    if (char === '*' || char === '+' || char === '?') {
        return true;
    }

    if (char !== '{') {
        return false;
    }

    const closeIndex = pattern.indexOf('}', index + 1);
    if (closeIndex < 0) {
        return false;
    }

    return /^\{\d*(?:,\d*)?\}$/u.test(pattern.slice(index, closeIndex + 1));
}

function getRegexQuantifierEnd(pattern: string, index: number) {
    if (pattern[index] !== '{') {
        return index;
    }
    return pattern.indexOf('}', index + 1);
}

function getRegexAtomBefore(pattern: string, quantifierIndex: number) {
    const endIndex = quantifierIndex - 1;
    if (endIndex < 0) {
        return null;
    }

    const end = pattern[endIndex];
    if (end === ')') {
        let depth = 0;
        for (let index = endIndex; index >= 0; index -= 1) {
            const char = pattern[index];
            if (char === ')' && pattern[index - 1] !== '\\') {
                depth += 1;
            } else if (char === '(' && pattern[index - 1] !== '\\') {
                depth -= 1;
                if (depth === 0) {
                    return {
                        startIndex: index,
                        source: pattern.slice(index, quantifierIndex),
                    };
                }
            }
        }
        return null;
    }

    if (end === ']') {
        for (let index = endIndex - 1; index >= 0; index -= 1) {
            if (pattern[index] === '[' && pattern[index - 1] !== '\\') {
                return {
                    startIndex: index,
                    source: pattern.slice(index, quantifierIndex),
                };
            }
        }
        return null;
    }

    const startIndex = pattern[endIndex - 1] === '\\'
        ? endIndex - 1
        : endIndex;
    return {
        startIndex,
        source: pattern.slice(startIndex, quantifierIndex),
    };
}

function isUnsafeSearchRegexPattern(pattern: string) {
    if (/\\(?:[1-9]\d*|k<[^>]+>)/u.test(pattern)) {
        return true;
    }

    if (/\(\?(?:[=!]|<[=!])/u.test(pattern)) {
        return true;
    }

    const stack: IRegexGroupSafety[] = [];
    let lastClosedGroup: IClosedRegexGroupSafety | null = null;
    let escaped = false;
    let inCharacterClass = false;
    let quantifierCount = 0;
    let previousQuantifiedAtom: {
        startIndex: number;
        source: string
    } | null = null;
    let previousQuantifierEnd = -1;

    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];

        if (escaped) {
            escaped = false;
            lastClosedGroup = null;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            lastClosedGroup = null;
            continue;
        }

        if (inCharacterClass) {
            if (char === ']') {
                inCharacterClass = false;
            }
            continue;
        }

        if (char === '[') {
            inCharacterClass = true;
            lastClosedGroup = null;
            continue;
        }

        if (char === '(') {
            stack.push({
                hasAlternation: false,
                hasQuantifier: false,
            });
            lastClosedGroup = null;
            continue;
        }

        if (char === ')') {
            const closedGroup = stack.pop();
            if (closedGroup) {
                const parentGroup = stack.at(-1);
                if (parentGroup && closedGroup.hasQuantifier) {
                    parentGroup.hasQuantifier = true;
                }
                lastClosedGroup = {
                    ...closedGroup,
                    endIndex: index,
                };
            }
            continue;
        }

        if (char === '|') {
            const currentGroup = stack.at(-1);
            if (currentGroup) {
                currentGroup.hasAlternation = true;
            }
            lastClosedGroup = null;
            continue;
        }

        if (char === '?' && pattern[index - 1] === '(') {
            lastClosedGroup = null;
            continue;
        }

        if (isRegexQuantifierAt(pattern, index)) {
            quantifierCount += 1;
            if (quantifierCount > MAX_REGEX_QUANTIFIERS) {
                return true;
            }

            const atom = getRegexAtomBefore(pattern, index);
            if (
                atom
                && previousQuantifiedAtom
                && previousQuantifierEnd === atom.startIndex
            ) {
                return true;
            }
            previousQuantifiedAtom = atom;
            previousQuantifierEnd = getRegexQuantifierEnd(pattern, index) + 1;

            if (lastClosedGroup && lastClosedGroup.endIndex === index - 1) {
                if (lastClosedGroup.hasAlternation || lastClosedGroup.hasQuantifier) {
                    return true;
                }
            }
            const currentGroup = stack.at(-1);
            if (currentGroup) {
                currentGroup.hasQuantifier = true;
            }
            lastClosedGroup = null;
            continue;
        }

        lastClosedGroup = null;
    }

    return false;
}

export function assertSafePdfSearchRegex(
    query: string,
    options: Pick<IResolvedSearchMatchOptions, 'matchCase' | 'wholeWord'>,
) {
    const pattern = options.wholeWord
        ? applyWholeWordBoundary(query)
        : query;
    try {
        new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
    } catch (error) {
        throw new Error(`Invalid search regex: ${error instanceof Error ? getErrorMessage(error) : 'pattern could not be compiled'}`);
    }

    if (isUnsafeSearchRegexPattern(query)) {
        throw new SearchRegexLimitError('Invalid search regex: pattern is too complex for document search');
    }
}

function assertSearchQueryWithinLimit(query: string, useRegex: boolean) {
    const maxLength = useRegex ? SEARCH_REGEX_QUERY_MAX_LENGTH : SEARCH_QUERY_MAX_LENGTH;
    if (query.length > maxLength) {
        throw new Error(`Invalid search query: maximum length is ${maxLength} characters`);
    }
}

export function validateSearchQuery(query: string, options: ISearchMatchOptions) {
    const useRegex = options.useRegex === true;
    assertSearchQueryWithinLimit(query, useRegex);
    if (useRegex && query.length > 0) {
        assertSafePdfSearchRegex(query, {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
        });
    }
}

export function normalizeOptionalSearchRequestId(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw !== 'string') {
        throw new Error('requestId must be a string');
    }
    const requestId = raw.trim();
    if (!requestId) {
        return undefined;
    }
    if (requestId.length > SEARCH_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`requestId exceeds maximum length (${SEARCH_REQUEST_ID_MAX_LENGTH})`);
    }
    return requireRequestId(requestId);
}

/**
 * Validate a declared document page count without imposing a product cap.
 * Consumers must keep work and messages bounded independently of this scalar.
 */
export function normalizeOptionalSearchPageCount(raw: unknown) {
    if (raw === undefined) {
        return undefined;
    }

    if (
        typeof raw !== 'number'
        || !Number.isSafeInteger(raw)
        || raw < 1
    ) {
        throw new Error('Invalid pageCount: must be a positive safe integer');
    }

    return raw;
}

function normalizeSearchPdfPath(raw: unknown): TDocumentRef {
    const pdfPath = typeof raw === 'string' ? raw.trim() : '';
    if (!pdfPath) {
        throw new Error('Invalid PDF path');
    }
    if (pdfPath.length > SEARCH_PDF_PATH_MAX_LENGTH) {
        throw new Error(`Invalid PDF path: maximum length is ${SEARCH_PDF_PATH_MAX_LENGTH} characters`);
    }
    const documentRef = parseDocumentRef(pdfPath);
    if (documentRef === null) {
        throw new Error('Invalid PDF path');
    }
    return documentRef;
}

function normalizeSearchBooleanOption(raw: unknown) {
    return typeof raw === 'boolean' ? raw : undefined;
}

function normalizeOptionalSearchDocumentRevision(raw: unknown) {
    if (raw === undefined || raw === null) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length === 0) {
        return undefined;
    }
    if (typeof raw === 'string' && raw.trim().length > SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH) {
        throw new Error(`documentRevision exceeds maximum length (${SEARCH_DOCUMENT_REVISION_TOKEN_MAX_LENGTH})`);
    }
    const documentRevision = parseDocumentRevisionToken(raw);
    if (documentRevision === null) {
        throw new Error('documentRevision must be a valid document revision token');
    }
    return documentRevision;
}

export interface INormalizedPdfSearchRequest extends IPdfSearchRequestOptions {
    pdfPath: TDocumentRef;
    query: string;
}

export interface INormalizedPdfSearchWarmIndexRequest extends IPdfSearchRequestOptions {pdfPath: TDocumentRef;}

export function normalizePdfSearchRequestPayload(
    raw: unknown,
): INormalizedPdfSearchRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid search request payload');
    }
    if (typeof raw.query !== 'string') {
        throw new Error('Invalid search query');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);
    const matchCase = normalizeSearchBooleanOption(raw.matchCase);
    const wholeWord = normalizeSearchBooleanOption(raw.wholeWord);
    const useRegex = normalizeSearchBooleanOption(raw.useRegex);
    validateSearchQuery(raw.query, {
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    });

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        query: raw.query,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
        ...(matchCase === undefined ? {} : {matchCase}),
        ...(wholeWord === undefined ? {} : {wholeWord}),
        ...(useRegex === undefined ? {} : {useRegex}),
    };
}

export function normalizePdfSearchWarmIndexPayload(
    raw: unknown,
): INormalizedPdfSearchWarmIndexRequest {
    if (!isRecord(raw)) {
        throw new Error('Invalid warm-index payload');
    }

    const pageCount = normalizeOptionalSearchPageCount(raw.pageCount);
    const requestId = normalizeOptionalSearchRequestId(raw.requestId);
    const documentRevision = normalizeOptionalSearchDocumentRevision(raw.documentRevision);

    return {
        pdfPath: normalizeSearchPdfPath(raw.pdfPath),
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(requestId === undefined ? {} : {requestId}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

const MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH = 48;
const MIN_TWO_COPY_PAGE_TEXT_SEGMENT_LENGTH = 160;
const MAX_REPEATED_PAGE_TEXT_COPIES = 16;

export function collapseRepeatedPdfSearchPageText(text: string) {
    const maxRepeatCount = Math.min(
        MAX_REPEATED_PAGE_TEXT_COPIES,
        Math.floor(text.length / MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH),
    );

    for (let repeatCount = maxRepeatCount; repeatCount >= 2; repeatCount -= 1) {
        if (text.length % repeatCount !== 0) {
            continue;
        }

        const segmentLength = text.length / repeatCount;
        const minSegmentLength = repeatCount === 2
            ? MIN_TWO_COPY_PAGE_TEXT_SEGMENT_LENGTH
            : MIN_REPEATED_PAGE_TEXT_SEGMENT_LENGTH;
        if (segmentLength < minSegmentLength) {
            continue;
        }

        const firstSegment = text.slice(0, segmentLength);
        let isRepeated = true;
        for (let index = 1; index < repeatCount; index += 1) {
            if (text.slice(index * segmentLength, (index + 1) * segmentLength) !== firstSegment) {
                isRepeated = false;
                break;
            }
        }

        if (isRepeated) {
            return firstSegment;
        }
    }

    return text;
}
