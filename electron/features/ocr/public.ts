export {
    cancelOcrJobsForWorkingCopy,
    recoverOcrJobManager,
    shutdownOcrJobManager,
} from '@electron/features/ocr/main/jobManager';
export {
    claimPendingOcrResultForDocument,
    findPendingOcrResultFileForPath,
    releasePendingOcrResultClaim,
} from '@electron/features/ocr/main/createPendingResultFileStore';
export {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
export {createTesseractFinalize} from '@electron/features/ocr/main/createTesseractFinalize';
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
    readOcrIndexV3ManifestMetadata,
    streamOcrIndexV3ManifestMappings,
} from '@electron/features/ocr/main/ocrIndexV3Stream';
export type {
    IOcrIndexV3ManifestStreamMapping,
    IOcrIndexV3ManifestStreamMetadata,
} from '@electron/features/ocr/main/ocrIndexV3Stream';
export {
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/worker/indexWriterV4';
export type {
    IPublishOcrCatalogV4PreparedOptions,
    IRollbackOcrCatalogV4PreparedOptions,
} from '@electron/features/ocr/worker/indexWriterV4';
export {resolveTesseractLanguageConfig} from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
export type {IOcrPendingResultFile} from '@electron/features/ocr/main/jobManager.types';
