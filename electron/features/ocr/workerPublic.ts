// Keep worker imports separate from the main-process lifecycle exports. The
// worker bundle must not pull the job manager or Electron's native module into
// its CommonJS runtime.
export {buildTesseractEnv} from '@electron/features/ocr/main/buildTesseractEnv';
export {createTesseractFinalize} from '@electron/features/ocr/main/createTesseractFinalize';
export {resolveTesseractLanguageConfig} from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
export {
    readOcrIndexV3ManifestMetadata,
    streamOcrIndexV3ManifestMappings,
} from '@electron/features/ocr/main/ocrIndexV3Stream';
export type {
    IOcrIndexV3ManifestStreamMapping,
    IOcrIndexV3ManifestStreamMetadata,
} from '@electron/features/ocr/main/ocrIndexV3Stream';
export {resolveCatalogPath} from '@electron/features/ocr/main/ocrCatalogV4';
