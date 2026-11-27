import type {TBrand} from '@contracts/brand';

export const PDF_NATIVE_DATE_PATTERN = /^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u;

export type TPdfDateString = TBrand<string, 'PdfDateString'>;

export function isPdfDateString(value: unknown): value is TPdfDateString {
    return typeof value === 'string' && PDF_NATIVE_DATE_PATTERN.test(value);
}

export function requirePdfDateString(value: unknown): TPdfDateString {
    if (!isPdfDateString(value)) {
        throw new TypeError("PDF date must match D:YYYYMMDDHHmmss with an optional Z or ±HH'mm' offset");
    }
    return value;
}
