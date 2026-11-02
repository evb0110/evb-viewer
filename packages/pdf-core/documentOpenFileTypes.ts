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

const folderEntryCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

/** The order Open Folder opens a folder's files in: natural name order, so page-2 comes before page-10. */
export function compareFolderEntryNames(left: string, right: string) {
    return folderEntryCollator.compare(left, right) || left.localeCompare(right);
}
