export const PDF_PAGE_LABEL_STYLE_VALUES = [
    'D',
    'R',
    'r',
    'A',
    'a',
] as const;

export type TPdfPageLabelStyle = typeof PDF_PAGE_LABEL_STYLE_VALUES[number] | null;

export interface IPdfPageLabelRange {
    startPage: number;
    style: TPdfPageLabelStyle;
    prefix: string;
    startNumber: number;
}

/** Inclusive segment derived from one range and the next range boundary. */
export interface IPdfPageLabelSegment extends IPdfPageLabelRange {endPage: number;}

export interface IPdfPageLabelsMutation {
    totalPages: number;
    ranges: IPdfPageLabelRange[];
}

/** New numbering starts are bounded; imported ranges and continuations are lossless. */
export const PAGE_LABEL_MAX_ALPHABETIC_START_NUMBER = 26 * 4;
export const PAGE_LABEL_MAX_ROMAN_START_NUMBER = 3999;

export function getPageLabelStartNumberMax(style: TPdfPageLabelStyle): number {
    if (style === 'A' || style === 'a') {
        return PAGE_LABEL_MAX_ALPHABETIC_START_NUMBER;
    }
    if (style === 'R' || style === 'r') {
        return PAGE_LABEL_MAX_ROMAN_START_NUMBER;
    }
    return Number.MAX_SAFE_INTEGER;
}

export function admitPdfPageLabelStartNumber(style: TPdfPageLabelStyle, startNumber: number): number {
    return Math.min(getPageLabelStartNumberMax(style), Math.max(1, Math.trunc(startNumber) || 1));
}
