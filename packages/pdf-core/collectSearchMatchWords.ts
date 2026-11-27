import type { IOcrWord } from '@contracts/shared';
import {
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

interface IPageWithSearchWords {
    text?: string;
    words?: readonly IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

interface IIndexedGlyphBox extends IOcrWord {
    startOffset?: number;
    endOffset?: number;
}

type TWordWithGlyphs = IOcrWord & { chars?: IIndexedGlyphBox[] };

function getGlyphOffset(
    value: number | undefined,
    fallback: number,
): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function unionBoxes(
    boxes: readonly IOcrWord[],
    text: string,
): IOcrWord | null {
    if (boxes.length === 0) {
        return null;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const box of boxes) {
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.width);
        maxY = Math.max(maxY, box.y + box.height);
    }

    if (
        !Number.isFinite(minX)
        || !Number.isFinite(minY)
        || !Number.isFinite(maxX)
        || !Number.isFinite(maxY)
        || maxX <= minX
        || maxY <= minY
    ) {
        return null;
    }

    return {
        text,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
    };
}

function cropWordByCharacterRatio(
    word: IOcrWord,
    relativeStart: number,
    relativeEnd: number,
) {
    const textLength = Math.max(1, word.text.length);
    const clampedStart = Math.max(0, Math.min(textLength, relativeStart));
    const clampedEnd = Math.max(clampedStart, Math.min(textLength, relativeEnd));
    const startRatio = clampedStart / textLength;
    const endRatio = clampedEnd / textLength;

    return {
        text: word.text.slice(clampedStart, clampedEnd),
        x: word.x + word.width * startRatio,
        y: word.y,
        width: word.width * Math.max(0, endRatio - startRatio),
        height: word.height,
    };
}

function cropWordToMatch(
    word: TWordWithGlyphs,
    relativeStart: number,
    relativeEnd: number,
) {
    const selectedGlyphs = Array.isArray(word.chars)
        ? word.chars.filter((glyph, index) => {
            const glyphStart = getGlyphOffset(glyph.startOffset, index);
            const glyphEnd = getGlyphOffset(glyph.endOffset, glyphStart + glyph.text.length);
            return glyphStart < relativeEnd && glyphEnd > relativeStart;
        })
        : [];

    if (selectedGlyphs.length > 0) {
        const selectedText = word.text.slice(relativeStart, relativeEnd);
        return unionBoxes(selectedGlyphs, selectedText);
    }

    return cropWordByCharacterRatio(word, relativeStart, relativeEnd);
}

interface ISuffixMaxIndex {
    readonly text: string;
    readonly sa: Int32Array;
    readonly maxTree: Int32Array;
    readonly treeSize: number;
}

export interface ISearchPageWordIndex {
    readonly page: IPageWithSearchWords;
    readonly pageWords: readonly IOcrWord[];
    readonly words: IOcrWord[];
    readonly starts: number[];
    readonly ends: number[];
    readonly prefixMaxStarts: number[];
    readonly prefixMaxEnds: number[];
    readonly failedLogicalLookups: Set<string>;
    pageTextChars: Set<number> | null;
    suffixMaxIndex: ISuffixMaxIndex | null;
    failedIndexOfCount: number;
    nextWordIndex: number;
    fallbackCursor: number;
    logicalTextCursor: number;
}

interface ICachedWordIndexEntry {
    readonly text: string | undefined;
    readonly length: number;
    readonly index: ISearchPageWordIndex;
}

const wordIndexCache = new WeakMap<readonly IOcrWord[], ICachedWordIndexEntry>();
const SUFFIX_INDEX_FAILURE_THRESHOLD = 16;

function buildSuffixMaxIndex(text: string): ISuffixMaxIndex {
    const length = text.length;
    const sa = new Int32Array(length);
    let rank = new Int32Array(length);
    let nextRank = new Int32Array(length);
    const order = new Int32Array(length);

    if (length > 0) {
        // Initial O(L log |Sigma| + L) rank assignment by UTF-16 code unit.
        const uniqueCodes: number[] = [];
        const seenCodes = new Set<number>();
        for (let index = 0; index < length; index += 1) {
            const code = text.charCodeAt(index);
            if (!seenCodes.has(code)) {
                seenCodes.add(code);
                uniqueCodes.push(code);
            }
        }
        uniqueCodes.sort((left, right) => left - right);
        const codeToRank = new Map<number, number>();
        for (let index = 0; index < uniqueCodes.length; index += 1) {
            codeToRank.set(uniqueCodes[index]!, index);
        }
        let classes = uniqueCodes.length;
        const count = new Int32Array(Math.max(length, classes) + 1);
        for (let index = 0; index < length; index += 1) {
            const r = codeToRank.get(text.charCodeAt(index))!;
            rank[index] = r;
            count[r]! += 1;
        }
        for (let index = 1; index < classes; index += 1) {
            count[index]! += count[index - 1]!;
        }
        for (let index = length - 1; index >= 0; index -= 1) {
            const r = rank[index]!;
            count[r]! -= 1;
            sa[count[r]!] = index;
        }

        // Prefix-doubling O(L log L) suffix array with single radix pass per round.
        for (let step = 1; step < length && classes < length; step <<= 1) {
            let outIndex = 0;
            for (let index = length - step; index < length; index += 1) {
                order[outIndex] = index;
                outIndex += 1;
            }
            for (let index = 0; index < length; index += 1) {
                const candidate = sa[index]!;
                if (candidate >= step) {
                    order[outIndex] = candidate - step;
                    outIndex += 1;
                }
            }

            count.fill(0, 0, classes);
            for (let index = 0; index < length; index += 1) {
                count[rank[order[index]!]!]! += 1;
            }
            for (let index = 1; index < classes; index += 1) {
                count[index]! += count[index - 1]!;
            }
            for (let index = length - 1; index >= 0; index -= 1) {
                const suffix = order[index]!;
                const r = rank[suffix]!;
                count[r]! -= 1;
                sa[count[r]!] = suffix;
            }

            nextRank[sa[0]!] = 0;
            let nextClasses = 1;
            for (let index = 1; index < length; index += 1) {
                const prev = sa[index - 1]!;
                const curr = sa[index]!;
                const prevSecond = prev + step < length ? rank[prev + step]! : -1;
                const currSecond = curr + step < length ? rank[curr + step]! : -1;
                if (rank[prev] !== rank[curr] || prevSecond !== currSecond) {
                    nextClasses += 1;
                }
                nextRank[curr] = nextClasses - 1;
            }
            const swapped = rank;
            rank = nextRank;
            nextRank = swapped;
            classes = nextClasses;
        }
    }

    let treeSize = 1;
    while (treeSize < length) {
        treeSize <<= 1;
    }
    const maxTree = new Int32Array(treeSize * 2);
    maxTree.fill(-1);
    for (let index = 0; index < length; index += 1) {
        maxTree[treeSize + index] = sa[index]!;
    }
    for (let node = treeSize - 1; node >= 1; node -= 1) {
        const left = maxTree[node << 1]!;
        const right = maxTree[(node << 1) | 1]!;
        maxTree[node] = left > right ? left : right;
    }

    return {
        text,
        sa,
        maxTree,
        treeSize,
    };
}

function compareSuffixToNeedle(text: string, suffixPos: number, needle: string): number {
    const limit = Math.min(needle.length, text.length - suffixPos);
    for (let offset = 0; offset < limit; offset += 1) {
        const diff = text.charCodeAt(suffixPos + offset) - needle.charCodeAt(offset);
        if (diff !== 0) {
            return diff;
        }
    }
    return limit < needle.length ? -1 : 0;
}

function maxOccurrenceInSuffixIndex(suffixIndex: ISuffixMaxIndex, needle: string): number {
    const {
        text,
        sa,
        maxTree,
        treeSize,
    } = suffixIndex;
    const length = sa.length;
    if (length === 0) {
        return -1;
    }

    let low = 0;
    let high = length;
    while (low < high) {
        const mid = low + ((high - low) >>> 1);
        if (compareSuffixToNeedle(text, sa[mid]!, needle) < 0) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    const rangeStart = low;

    low = rangeStart;
    high = length;
    while (low < high) {
        const mid = low + ((high - low) >>> 1);
        if (compareSuffixToNeedle(text, sa[mid]!, needle) <= 0) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    const rangeEnd = low;
    if (rangeStart >= rangeEnd) {
        return -1;
    }

    let left = rangeStart + treeSize;
    let right = rangeEnd + treeSize;
    let best = -1;
    while (left < right) {
        if ((left & 1) === 1) {
            const candidate = maxTree[left]!;
            if (candidate > best) {
                best = candidate;
            }
            left += 1;
        }
        if ((right & 1) === 1) {
            right -= 1;
            const candidate = maxTree[right]!;
            if (candidate > best) {
                best = candidate;
            }
        }
        left >>>= 1;
        right >>>= 1;
    }
    return best;
}

function isValidPageGeometry(page: IPageWithSearchWords): page is IPageWithSearchWords & {
    words: readonly IOcrWord[];
    pageWidth: number;
    pageHeight: number;
} {
    const {
        pageWidth,
        pageHeight,
    } = page;
    return Boolean(
        page.words
        && page.words.length > 0
        && typeof pageWidth === 'number'
        && Number.isFinite(pageWidth)
        && typeof pageHeight === 'number'
        && Number.isFinite(pageHeight)
        && pageWidth > 0
        && pageHeight > 0,
    );
}

function findLogicalWordStart(index: ISearchPageWordIndex, needle: string): number {
    const pageText = index.page.text;
    if (pageText === undefined) {
        return -1;
    }
    if (needle.length === 0) {
        return index.logicalTextCursor <= pageText.length ? index.logicalTextCursor : -1;
    }
    if (
        needle.length > pageText.length - index.logicalTextCursor
        || index.failedLogicalLookups.has(needle)
    ) {
        return -1;
    }
    if (index.pageTextChars !== null) {
        for (let charIndex = 0; charIndex < needle.length; charIndex += 1) {
            if (!index.pageTextChars.has(needle.charCodeAt(charIndex))) {
                index.failedLogicalLookups.add(needle);
                return -1;
            }
        }
    }
    if (index.suffixMaxIndex !== null) {
        const lastMatch = maxOccurrenceInSuffixIndex(index.suffixMaxIndex, needle);
        if (lastMatch < index.logicalTextCursor) {
            index.failedLogicalLookups.add(needle);
            return -1;
        }
        // Guaranteed to exist at >= logicalTextCursor; indexOf advances the cursor.
        return pageText.indexOf(needle, index.logicalTextCursor);
    }

    const found = pageText.indexOf(needle, index.logicalTextCursor);
    if (found >= 0) {
        return found;
    }

    // Because logicalTextCursor is monotonically non-decreasing, a needle that
    // does not appear from logicalTextCursor onward cannot appear later either.
    index.failedLogicalLookups.add(needle);
    index.failedIndexOfCount += 1;
    if (index.pageTextChars === null) {
        const chars = new Set<number>();
        for (let charIndex = 0; charIndex < pageText.length; charIndex += 1) {
            chars.add(pageText.charCodeAt(charIndex));
        }
        index.pageTextChars = chars;
    }
    if (index.suffixMaxIndex === null && index.failedIndexOfCount >= SUFFIX_INDEX_FAILURE_THRESHOLD) {
        index.suffixMaxIndex = buildSuffixMaxIndex(pageText);
    }
    return -1;
}

function ensureWordIndexUpTo(index: ISearchPageWordIndex, endOffset: number) {
    const {
        pageWords,
        words,
        starts,
        ends,
        prefixMaxStarts,
        prefixMaxEnds,
    } = index;
    while (index.nextWordIndex < pageWords.length) {
        const lastMaxStart = prefixMaxStarts.length > 0
            ? prefixMaxStarts[prefixMaxStarts.length - 1]!
            : Number.NEGATIVE_INFINITY;
        if (lastMaxStart >= endOffset) {
            break;
        }
        const wordIndex = index.nextWordIndex;
        index.nextWordIndex += 1;
        const word = pageWords[wordIndex];
        if (!word) {
            continue;
        }
        const wordText = buildOcrTextLayerItemText(word);
        const logicalWordStart = findLogicalWordStart(index, word.text);
        const wordStart = logicalWordStart >= 0 ? logicalWordStart : index.fallbackCursor;
        const wordEnd = wordStart + word.text.length;

        const prevMaxStart = prefixMaxStarts.length > 0
            ? prefixMaxStarts[prefixMaxStarts.length - 1]!
            : Number.NEGATIVE_INFINITY;
        const prevMaxEnd = prefixMaxEnds.length > 0
            ? prefixMaxEnds[prefixMaxEnds.length - 1]!
            : Number.NEGATIVE_INFINITY;
        words.push(word);
        starts.push(wordStart);
        ends.push(wordEnd);
        prefixMaxStarts.push(wordStart > prevMaxStart ? wordStart : prevMaxStart);
        prefixMaxEnds.push(wordEnd > prevMaxEnd ? wordEnd : prevMaxEnd);

        if (logicalWordStart >= 0) {
            index.logicalTextCursor = wordEnd;
        }
        index.fallbackCursor += wordText.length;
        if (isLastOcrWordInLine(pageWords, wordIndex)) {
            index.fallbackCursor += 1;
        }
    }
}

function lowerBoundOffset(values: readonly number[], target: number, upperLimit: number) {
    let low = 0;
    let high = upperLimit;
    while (low < high) {
        const middle = low + ((high - low) >>> 1);
        if (values[middle]! < target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

function upperBoundOffset(values: readonly number[], target: number, upperLimit: number) {
    let low = 0;
    let high = upperLimit;
    while (low < high) {
        const middle = low + ((high - low) >>> 1);
        if (values[middle]! <= target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    return low;
}

export function createSearchPageWordIndex(
    page: IPageWithSearchWords,
): ISearchPageWordIndex | null {
    if (!isValidPageGeometry(page)) {
        return null;
    }
    return {
        page,
        pageWords: page.words,
        words: [],
        starts: [],
        ends: [],
        prefixMaxStarts: [],
        prefixMaxEnds: [],
        failedLogicalLookups: new Set(),
        pageTextChars: null,
        suffixMaxIndex: null,
        failedIndexOfCount: 0,
        nextWordIndex: 0,
        fallbackCursor: 0,
        logicalTextCursor: 0,
    };
}

export function collectSearchMatchWordsFromIndex(
    index: ISearchPageWordIndex,
    startOffset: number,
    endOffset: number,
): IOcrWord[] | undefined {
    if (endOffset <= startOffset) {
        return undefined;
    }
    ensureWordIndexUpTo(index, endOffset);
    const {
        words,
        starts,
        ends,
        prefixMaxStarts,
        prefixMaxEnds,
    } = index;
    const stopIndex = lowerBoundOffset(prefixMaxStarts, endOffset, words.length);
    const firstIndex = upperBoundOffset(prefixMaxEnds, startOffset, stopIndex);
    const matchWords: IOcrWord[] = [];
    for (let position = firstIndex; position < stopIndex; position += 1) {
        const wordStart = starts[position]!;
        const wordEnd = ends[position]!;
        if (wordStart < endOffset && wordEnd > startOffset) {
            const word = words[position]!;
            const relativeStart = Math.max(0, startOffset - wordStart);
            const relativeEnd = Math.min(word.text.length, endOffset - wordStart);
            const cropped = cropWordToMatch(word, relativeStart, relativeEnd);
            if (cropped && cropped.width > 0 && cropped.height > 0) {
                matchWords.push(cropped);
            }
        }
    }
    return matchWords.length > 0 ? matchWords : undefined;
}

export function collectSearchMatchWords(
    page: IPageWithSearchWords,
    startOffset: number,
    endOffset: number,
): IOcrWord[] | undefined {
    if (!isValidPageGeometry(page) || endOffset <= startOffset) {
        return undefined;
    }
    const cached = wordIndexCache.get(page.words);
    let index: ISearchPageWordIndex;
    if (cached && cached.text === page.text && cached.length === page.words.length) {
        index = cached.index;
    } else {
        index = createSearchPageWordIndex(page)!;
        wordIndexCache.set(page.words, {
            text: page.text,
            length: page.words.length,
            index,
        });
    }
    return collectSearchMatchWordsFromIndex(index, startOffset, endOffset);
}
