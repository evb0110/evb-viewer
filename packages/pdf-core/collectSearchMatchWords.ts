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

export interface ISearchPageWordIndex {
    readonly page: IPageWithSearchWords;
    readonly pageWords: readonly IOcrWord[];
    readonly words: IOcrWord[];
    readonly starts: number[];
    readonly ends: number[];
    readonly prefixMaxStarts: number[];
    readonly prefixMaxEnds: number[];
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

function ensureWordIndexUpTo(index: ISearchPageWordIndex, endOffset: number) {
    const {
        page,
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
        const logicalWordStart = page.text === undefined
            ? -1
            : page.text.indexOf(word.text, index.logicalTextCursor);
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
