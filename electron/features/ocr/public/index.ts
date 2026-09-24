export {cancelOcrJobsForWorkingCopy} from '@electron/features/ocr/main/jobManager';
export {
    discardOcrResultsForDocument,
    findOcrResultForDocument,
} from '@electron/features/ocr/main/jobManager';
export {
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/pipeline/indexWriterV4';
export {readOcrIndexV3ManifestMetadata} from '@electron/features/ocr/main/ocrIndexV3Stream';
export {rebindDocumentTextCatalogRevision} from '@electron/features/ocr/main/documentTextCatalog';
