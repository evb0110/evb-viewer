import type { IOcrWord } from '@contracts/shared';
import type { TOcrIndexRotation } from '@contracts/ocrIndex';
import type { IDocumentSearchMatch } from '@app/modules/document-viewer/public';

export interface IDocumentPageSourceSearchHighlight {
    current: boolean;
    key: string;
    matchIndex: number;
    resultIndex: number;
    word: IOcrWord;
    rect: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
}

function isFinitePositive(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clampUnit(value: number) {
    return Math.min(1, Math.max(0, value));
}

function normalizeWordRect(
    word: IOcrWord,
    pageWidth: number,
    pageHeight: number,
    rotation: TOcrIndexRotation,
) {
    const rawLeft = word.x / pageWidth;
    const rawTop = word.y / pageHeight;
    const rawRight = (word.x + word.width) / pageWidth;
    const rawBottom = (word.y + word.height) / pageHeight;
    if (![
        rawLeft,
        rawTop,
        rawRight,
        rawBottom,
    ].every(Number.isFinite)) {
        return null;
    }

    const left = clampUnit(Math.min(rawLeft, rawRight));
    const top = clampUnit(Math.min(rawTop, rawBottom));
    const right = clampUnit(Math.max(rawLeft, rawRight));
    const bottom = clampUnit(Math.max(rawTop, rawBottom));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        return null;
    }

    switch (rotation) {
        case 90:
            return {
                left: 1 - bottom,
                top: left,
                width: height,
                height: width,
            };
        case 180:
            return {
                left: 1 - right,
                top: 1 - bottom,
                width,
                height,
            };
        case 270:
            return {
                left: top,
                top: 1 - right,
                width: height,
                height: width,
            };
        case 0:
            return {
                left,
                top,
                width,
                height,
            };
    }
}

/** Builds scale-independent page overlays from search geometry owned by the workspace session. */
export function resolveDocumentPageSourceSearchHighlights(options: {
    currentResultIndex: number;
    pageNumber: number;
    results: readonly IDocumentSearchMatch[];
}): IDocumentPageSourceSearchHighlight[] {
    const highlights: IDocumentPageSourceSearchHighlight[] = [];

    options.results.forEach((result, resultIndex) => {
        const pageWidth = result.pageWidth;
        const pageHeight = result.pageHeight;
        const words = result.words;
        if (
            result.pageIndex !== options.pageNumber - 1
            || !words
            || words.length === 0
            || !isFinitePositive(pageWidth)
            || !isFinitePositive(pageHeight)
        ) {
            return;
        }

        words.forEach((word, wordIndex) => {
            const rect = normalizeWordRect(
                word,
                pageWidth,
                pageHeight,
                result.rotation ?? 0,
            );
            if (!rect) {
                return;
            }
            highlights.push({
                current: resultIndex === options.currentResultIndex,
                key: `${String(result.matchIndex)}:${String(wordIndex)}`,
                matchIndex: result.matchIndex,
                resultIndex,
                word,
                rect,
            });
        });
    });

    return highlights;
}
