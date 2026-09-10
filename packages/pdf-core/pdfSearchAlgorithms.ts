import {
    assertSafePdfSearchRegex,
    buildPdfSearchRegex,
    SearchRegexLimitError,
    SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
    SEARCH_REGEX_MAX_EXECUTION_MS,
} from '@contracts/search';
import type {
    IAssembledSearchablePageText,
    IPdfSearchUtf16Range,
    ISearchMatchOptions,
    TPdfSearchUtf16Offset,
} from '@contracts/search';

const SEARCH_LIGATURE_FOLDS: Readonly<Record<string, string>> = {
    '\uFB00': 'ff',
    '\uFB01': 'fi',
    '\uFB02': 'fl',
    '\uFB03': 'ffi',
    '\uFB04': 'ffl',
    '\uFB05': 'st',
    '\uFB06': 'st',
};
const searchTextEncoder = new TextEncoder();

interface INormalizedSearchText {
    text: string;
    sourceStarts: number[];
    sourceEnds: number[];
}

export class SearchTextBudgetError extends Error {
    constructor(actualBytes: number, maxBytes: number) {
        super(`normalized search text exceeds ${maxBytes} bytes (at least ${actualBytes} bytes)`);
        this.name = 'SearchTextBudgetError';
    }
}

function normalizedTextByteLength(text: string) {
    let isAscii = true;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charCodeAt(index) > 0x7F) {
            isAscii = false;
            break;
        }
    }
    return isAscii
        ? text.length
        : searchTextEncoder.encode(text).byteLength;
}

/**
 * Search normalization is deliberately narrower than NFKC: canonical Unicode
 * composition plus the presentation ligatures commonly emitted by PDF fonts.
 */
export function normalizeSearchText(
    text: string,
    maxOutputBytes = SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
) {
    let outputBytes = 0;
    const foldedParts: string[] = [];
    for (const character of text) {
        const folded = SEARCH_LIGATURE_FOLDS[character] ?? character;
        outputBytes += normalizedTextByteLength(folded);
        if (outputBytes > maxOutputBytes) {
            throw new SearchTextBudgetError(outputBytes, maxOutputBytes);
        }
        foldedParts.push(folded);
    }
    const normalized = foldedParts.join('').normalize('NFC');
    if (normalizedTextByteLength(normalized) > maxOutputBytes) {
        throw new SearchTextBudgetError(normalizedTextByteLength(normalized), maxOutputBytes);
    }
    return normalized;
}

function normalizeSearchTextWithOffsets(text: string): INormalizedSearchText {
    const normalizedParts: string[] = [];
    const sourceStarts: number[] = [];
    const sourceEnds: number[] = [];
    const graphemePattern = /\P{M}\p{M}*|\p{M}+/gu;
    let normalizedBytes = 0;

    for (const match of text.matchAll(graphemePattern)) {
        const source = match[0];
        const sourceStart = match.index;
        const sourceEnd = sourceStart + source.length;
        const normalized = normalizeSearchText(source);
        normalizedBytes += normalizedTextByteLength(normalized);
        if (normalizedBytes > SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES) {
            throw new SearchTextBudgetError(normalizedBytes, SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES);
        }
        normalizedParts.push(normalized);
        for (let index = 0; index < normalized.length; index += 1) {
            sourceStarts.push(sourceStart);
            sourceEnds.push(sourceEnd);
        }
    }

    return {
        text: normalizedParts.join(''),
        sourceStarts,
        sourceEnds,
    };
}

export function mapAssembledSearchablePageTextRange(
    assembled: IAssembledSearchablePageText,
    range: IPdfSearchUtf16Range,
): IPdfSearchUtf16Range | null {
    if (
        range.startOffset < 0
        || range.endOffset <= range.startOffset
        || range.endOffset > assembled.text.length
    ) {
        return null;
    }
    const start = assembled.sourceOffsets[range.startOffset];
    const end = assembled.sourceOffsets[range.endOffset - 1];
    return start && end
        ? {
            startOffset: start.startOffset,
            endOffset: end.endOffset,
        }
        : null;
}

export function findPdfSearchMatches(
    text: string,
    matcherOrQuery: RegExp | string,
    options?: ISearchMatchOptions,
) {
    return Array.from(iteratePdfSearchMatches(text, matcherOrQuery, options));
}

export function* iteratePdfSearchMatches(
    text: string,
    matcherOrQuery: RegExp | string,
    options?: ISearchMatchOptions,
) {
    if (matcherOrQuery instanceof RegExp && options?.useRegex === true) {
        assertSafePdfSearchRegex(matcherOrQuery.source, {
            matchCase: Boolean(options.matchCase),
            wholeWord: Boolean(options.wholeWord),
        });
    }
    const normalizedText = typeof matcherOrQuery === 'string'
        ? normalizeSearchTextWithOffsets(text)
        : null;
    const sourceMatcher = typeof matcherOrQuery === 'string'
        ? buildPdfSearchRegex(normalizeSearchText(matcherOrQuery), {
            matchCase: Boolean(options?.matchCase),
            wholeWord: Boolean(options?.wholeWord),
            useRegex: Boolean(options?.useRegex),
        })
        : matcherOrQuery;
    const flags = sourceMatcher.flags.includes('g')
        ? sourceMatcher.flags
        : `${sourceMatcher.flags}g`;
    const matcher = new RegExp(sourceMatcher.source, flags);

    let match: RegExpExecArray | null;
    const matchedText = normalizedText?.text ?? text;
    const regexDeadline = options?.useRegex === true
        ? options.deadlineAtMs ?? Date.now() + SEARCH_REGEX_MAX_EXECUTION_MS
        : null;
    for (;;) {
        if (regexDeadline !== null && Date.now() >= regexDeadline) {
            throw new SearchRegexLimitError(
                `Search regex exceeded the ${SEARCH_REGEX_MAX_EXECUTION_MS}ms page budget`,
            );
        }
        match = matcher.exec(matchedText);
        if (match === null) {
            break;
        }
        const value = match[0];
        if (value.length === 0) {
            matcher.lastIndex += 1;
            continue;
        }
        const normalizedEndOffset = match.index + value.length;
        yield {
            startOffset: normalizedText?.sourceStarts[match.index] ?? match.index,
            endOffset: normalizedText?.sourceEnds[normalizedEndOffset - 1] ?? normalizedEndOffset,
        } satisfies IPdfSearchUtf16Range;
    }
}

export function buildPdfSearchExcerpt(
    text: string,
    startOffset: TPdfSearchUtf16Offset,
    endOffset: TPdfSearchUtf16Offset,
    contextChars: number,
) {
    const excerptStart = Math.max(0, startOffset - contextChars);
    const excerptEnd = Math.min(text.length, endOffset + contextChars);
    return {
        prefix: excerptStart > 0,
        suffix: excerptEnd < text.length,
        before: text.slice(excerptStart, startOffset).replace(/\s+/g, ' ').trimStart(),
        match: text.slice(startOffset, endOffset),
        after: text.slice(endOffset, excerptEnd).replace(/\s+/g, ' ').trimEnd(),
    };
}
