export {
    cancelOcrJobsForWorkingCopy,
    recoverOcrJobManager,
    shutdownOcrJobManager,
} from '@electron/features/ocr/main/jobManager';
export {
    discardOcrResultsForDocument,
    findOcrResultForDocument,
} from '@electron/features/ocr/main/jobManager';
export {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
export {
    rebindDocumentTextCatalogRevision,
    resolveDocumentTextCatalogWindow,
} from '@electron/features/ocr/main/documentTextCatalog';
export {visitDocumentOcrCatalogPages} from '@electron/features/ocr/public/catalog';
export type {
    IDocumentOcrReadOptions,
    IResolveDocumentTextCatalogOptions,
} from '@electron/features/ocr/main/documentTextCatalog';
export {
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/pipeline/indexWriterV4';
export type {
    IPublishOcrCatalogV4PreparedOptions,
    IRollbackOcrCatalogV4PreparedOptions,
} from '@electron/features/ocr/pipeline/indexWriterV4';
export {resolveTesseractLanguageConfig} from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
