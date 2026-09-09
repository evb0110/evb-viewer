// The dynamic module shape keeps the loader typed without eagerly importing PDF.js.
type TPdfjsTextExtractorModule =
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import('@electron/features/search/extractTextWithPdfjs');

let pdfjsTextExtractorPromise:
    Promise<TPdfjsTextExtractorModule> | null = null;

export function loadPdfjsTextExtractor() {
    pdfjsTextExtractorPromise ??=
        import('@electron/features/search/extractTextWithPdfjs');
    return pdfjsTextExtractorPromise;
}
