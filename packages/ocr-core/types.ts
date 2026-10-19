import type { IOcrWord } from '@contracts/shared';

/**
 * A recognized word in Tesseract's own numbering: `ordinal` counts the page's
 * non-empty words, which is also the order of their text in Tesseract's PDF.
 */
export interface ITesseractWord {
    ordinal: number;
    lineKey: string;
    text: string;
}

/** Replaces a word's text in Tesseract's PDF; the new text may be longer or hold spaces. */
export interface IOcrWordEdit {
    word: number;
    from: string;
    to: string;
}

/** One recognized page: its words and text, in the pixels of the raster Tesseract read. */
export interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
}
