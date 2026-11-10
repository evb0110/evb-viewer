/** Image types every platform's open turns into PDF pages. */
export const PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.jp2',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

const SUPPORTED_OPEN_EXTENSIONS = new Set<string>([
    '.pdf',
    '.djvu',
    '.djv',
    ...PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
]);

/** The most files one open, a folder's included, admits. */
export const MAX_OPEN_INPUT_PATHS = 512;

/** Whether a lower-case extension, dot included, names a document an open accepts. */
export function isSupportedOpenExtension(extension: string) {
    return SUPPORTED_OPEN_EXTENSIONS.has(extension);
}

/** A bounded content probe shared by document admission and extension downloads. */
export const DOCUMENT_HEADER_BYTES = 1024;

export function detectDocumentFormat(header: Uint8Array, fileSize: number) {
    if (fileSize === 0) return 'empty';
    const head = new TextDecoder('latin1').decode(header);
    // DjVuLibre also reads bare FORM and the historical SDJV prefix.
    const formOffset = head.startsWith('FORM') ? 0 : /^(?:AT&T|SDJV)FORM/u.test(head) ? 4 : -1;
    if (formOffset >= 0) {
        if (header.length < formOffset + 12) return 'invalid-djvu';
        if (/^(?:DJVU|DJVM|DJVI|THUM|PM44|BM44)$/u.test(head.slice(formOffset + 8, formOffset + 12))) {
            const size = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(formOffset + 4);
            return size < 4 || formOffset + 8 + size > fileSize ? 'invalid-djvu' : 'djvu';
        }
    }
    const encoding = header[0] === 0xff && header[1] === 0xfe ? 'utf-16le'
        : header[0] === 0xfe && header[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding).decode(header);
    if (/^\s*(?:(?:<\?xml[^>]*>|<!--[\s\S]*?-->)\s*)*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/iu.test(text)) return 'html';
    // PDF readers accept a header anywhere in the first kilobyte.
    if (head.includes('%PDF-')) return 'pdf';
    if (head.startsWith('PK') && ((header[2] === 3 && header[3] === 4)
        || (header[2] === 5 && header[3] === 6) || (header[2] === 7 && header[3] === 8))) return 'zip';
    return 'unknown';
}

const folderEntryCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

/** The order Open Folder opens a folder's files in: natural name order, so page-2 comes before page-10. */
export function compareFolderEntryNames(left: string, right: string) {
    return folderEntryCollator.compare(left, right) || left.localeCompare(right);
}
