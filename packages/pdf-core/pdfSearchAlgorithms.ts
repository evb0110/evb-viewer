import {
    SEARCH_MAX_NORMALIZED_PAGE_TEXT_BYTES,
    SEARCH_QUERY_MAX_LENGTH,
    SEARCH_REGEX_QUERY_MAX_LENGTH,
    SEARCH_REGEX_MAX_EXECUTION_MS,
} from '@contracts/search';
import { getErrorMessage } from '@contracts/getErrorMessage';
import type {
    IAssembledSearchablePageText,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    ISearchablePageTextItem,
    TPdfSearchUtf16Offset,
} from '@contracts/search';
import type { IOcrWord } from '@contracts/shared';
import {
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

function joinSearchLineHyphenation(text: string) {
    return text.replace(/\u00AD|-[\p{Zs}\t]*(?:\r\n?|\n)[\p{Zs}\t]*/gu, '');
}

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
    const itemOffsets = items.map((_item, itemIndex) => {
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

export function buildOcrTextLayerIndexText(words: readonly IOcrWord[]) {
    return assembleSearchablePageText(words.map((word, index) => ({
        text: buildOcrTextLayerItemText(word),
        separatorAfter: isLastOcrWordInLine(words, index) ? 'line' : 'none',
    }))).text;
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
                if (parentGroup) {
                    parentGroup.hasAlternation ||= closedGroup.hasAlternation;
                    parentGroup.hasQuantifier ||= closedGroup.hasQuantifier;
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
