import type { IOcrWord } from '@contracts/shared';

export const OCR_TEXT_LAYER_INDEX_SOURCE = 'ocr-v2-text-layer';
export const OCR_TEXT_LAYER_INDEX_VERSION = 1;

export function buildOcrTextLayerItemText(word: Pick<IOcrWord, 'text'>) {
    return `${word.text} `;
}

export function buildOcrWordKey(word: Pick<IOcrWord, 'text' | 'x' | 'y' | 'width' | 'height'>) {
    return `${word.text}|${word.x}|${word.y}|${word.width}|${word.height}`;
}

export function isLastOcrWordInLine(
    words: readonly IOcrWord[],
    index: number,
) {
    if (index === words.length - 1) {
        return true;
    }

    const currentWord = words[index];
    const nextWord = words[index + 1];
    if (!currentWord || !nextWord) {
        return true;
    }

    return Math.abs(nextWord.y - currentWord.y) > currentWord.height * 0.5;
}
