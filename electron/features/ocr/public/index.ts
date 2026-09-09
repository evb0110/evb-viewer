export {cancelOcrJobsForWorkingCopy} from '@electron/features/ocr/main/jobManager';
export {findPendingOcrResultFileForPath} from '@electron/features/ocr/main/createPendingResultFileStore';
export {
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/worker/indexWriterV4';
export {readOcrIndexV3ManifestMetadata} from '@electron/features/ocr/main/ocrIndexV3Stream';
export {rebindDocumentTextCatalogRevision} from '@electron/features/ocr/main/documentTextCatalog';
export type {IOcrPendingResultFile} from '@electron/features/ocr/main/jobManager.types';
