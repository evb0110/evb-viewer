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
