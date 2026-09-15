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

export function collectSearchMatchWords(
    page: IPageWithSearchWords,
    startOffset: number,
    endOffset: number,
): IOcrWord[] | undefined {
    const pageWidth = page.pageWidth;
    const pageHeight = page.pageHeight;
    if (
        !page.words
        || page.words.length === 0
        || typeof pageWidth !== 'number'
        || !Number.isFinite(pageWidth)
        || typeof pageHeight !== 'number'
        || !Number.isFinite(pageHeight)
        || pageWidth <= 0
        || pageHeight <= 0
        || endOffset <= startOffset
    ) {
        return undefined;
    }

    const pageWords: readonly IOcrWord[] = page.words;
    const matchWords: IOcrWord[] = [];
    let fallbackCursor = 0;
    let logicalTextCursor = 0;

    for (let index = 0; index < pageWords.length; index += 1) {
        const word = pageWords[index];
        if (!word) {
            continue;
        }
        const wordText = buildOcrTextLayerItemText(word);
        const logicalWordStart = page.text === undefined
            ? -1
            : page.text.indexOf(word.text, logicalTextCursor);
        const wordStart = logicalWordStart >= 0 ? logicalWordStart : fallbackCursor;
        const wordEnd = wordStart + word.text.length;

        if (wordStart >= endOffset) {
            break;
        }

        if (wordStart < endOffset && wordEnd > startOffset) {
            const relativeStart = Math.max(0, startOffset - wordStart);
            const relativeEnd = Math.min(word.text.length, endOffset - wordStart);
            const cropped = cropWordToMatch(word, relativeStart, relativeEnd);
            if (cropped && cropped.width > 0 && cropped.height > 0) {
                matchWords.push(cropped);
            }
        }

        if (logicalWordStart >= 0) {
            logicalTextCursor = wordEnd;
        }
        fallbackCursor += wordText.length;
        if (isLastOcrWordInLine(pageWords, index)) {
            fallbackCursor += 1;
        }
    }

    return matchWords.length > 0 ? matchWords : undefined;
}
