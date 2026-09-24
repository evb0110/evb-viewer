export {
    pdfSearchDocument,
    prepareSearchMainBindings,
    resolveSearchablePdfPath,
    searchService,
} from '@electron/features/search/main/ipc';
export {
    ensureSearchIndex,
    getSearchIndexPath,
    searchIndexedDocument,
    type ISearchIndexCoverage,
    type ISearchIndexedDocument,
} from '@electron/features/search/searchIndex';
export {
    readPdfPageTexts,
    streamPdfPageTexts,
} from '@electron/features/search/pdfPageTexts';
export { streamItems } from '@electron/features/search/streamItems';
export type { IPageText } from '@electron/features/search/pageText';
