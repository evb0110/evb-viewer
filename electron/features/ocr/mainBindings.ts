/* eslint-disable custom/file-naming -- Existing OCR feature binding entrypoint is retained for compatibility. */

import type { IpcMainInvokeEvent } from 'electron';
import type { OCR_PLATFORM_FEATURE } from '@contracts/ocrPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import {
    handleOcrAcknowledgeResultFileValidated,
    handleOcrCancelValidated,
    handleOcrCreateSearchablePdf,
    handleOcrGetLanguages,
    handleResolveDocumentOcrAvailability,
    handleResolveDocumentOcrPage,
    handleResolveDocumentTextCatalogWindow,
    handleResolveDocumentTextCatalog,
} from '@electron/features/ocr/main/ocrOperations';
import { subscribeManagedOcrProgress } from '@electron/features/ocr/main/jobManager';

export const ocrMainBindings = {
    cancel: handleOcrCancelValidated,
    getLanguages: handleOcrGetLanguages,
    resolveDocumentTextCatalog: handleResolveDocumentTextCatalog,
    resolveDocumentTextCatalogWindow: handleResolveDocumentTextCatalogWindow,
    resolveDocumentOcrAvailability: handleResolveDocumentOcrAvailability,
    resolveDocumentOcrPage: handleResolveDocumentOcrPage,
    acknowledgeResultFile: handleOcrAcknowledgeResultFileValidated,
    createSearchablePdf: handleOcrCreateSearchablePdf,
    subscribeProgress: subscribeManagedOcrProgress,
} satisfies TFeatureMainBindings<typeof OCR_PLATFORM_FEATURE, IpcMainInvokeEvent>;
