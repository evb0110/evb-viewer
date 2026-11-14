import type {TOcrSearchablePdfPages} from '@contracts/electronApiOcr';
import type {
    IOcrPdfPageRequest,
    TOcrPdfPageSelection,
} from '@electron/features/ocr/pipeline/types';

export function getLastOcrSelectionPage(selection: TOcrPdfPageSelection) {
    if (Array.isArray(selection)) {
        return selection.at(-1)?.pageNumber ?? 0;
    }
    switch (selection.kind) {
        case 'all':
            return selection.pageCount;
        case 'range':
            return selection.lastPage;
        case 'ranges':
            return selection.ranges.at(-1)?.lastPage ?? 0;
        case 'pages':
            return selection.pages.at(-1)?.pageNumber ?? 0;
    }
}

function assertUniqueOcrPageNumbers(pages: readonly IOcrPdfPageRequest[]) {
    const seenPageNumbers = new Set<number>();
    for (const page of pages) {
        if (seenPageNumbers.has(page.pageNumber)) {
            throw new Error(`Duplicate OCR page number ${page.pageNumber}`);
        }
        seenPageNumbers.add(page.pageNumber);
    }
}

export function normalizeOcrPageSelection(selection: TOcrPdfPageSelection): TOcrSearchablePdfPages {
    if (Array.isArray(selection)) {
        assertUniqueOcrPageNumbers(selection);
        return [...selection].sort((left, right) => left.pageNumber - right.pageNumber);
    }
    if (selection.kind === 'pages') {
        assertUniqueOcrPageNumbers(selection.pages);
        return {
            kind: 'pages',
            pages: [...selection.pages].sort((left, right) => left.pageNumber - right.pageNumber),
        };
    }
    return selection;
}
