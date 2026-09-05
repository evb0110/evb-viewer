export { browserAgentCapability } from '@app/platform/browser-api/browserAgentCapability';
export { browserDjvuCapability } from '@app/platform/browser-api/browserDjvuCapability';
export { browserHostCapability } from '@app/platform/browser-api/browserHostCapability';
export { browserOcrCapability } from '@app/platform/browser-api/browserOcrCapability';
export { browserScanCleanupCapability } from '@app/platform/browser-api/browserScanCleanupCapability';
export { browserSettingsCapability } from '@app/platform/browser-api/browserSettingsCapability';
export { createBrowserDocumentsCapability } from '@app/platform/browser-api/createBrowserDocumentsCapability';
export { isBrowserFilePickerSetupDeniedError } from '@app/platform/browser-api/browserFilePickerAdapter';
export { createBrowserSearchCapability } from '@app/platform/browser-api/createBrowserSearchCapability';
export { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/createDjvuWorkerFromPath';
export { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/createNativePdfPreviewSourceFromPath';
export { decodeBrowserImageBlob } from '@app/platform/browser-api/decodeBrowserImageBlob';
export {
    ASSISTANT_IMAGE_RESOURCE_LIMITS,
    createStaticBrowserImagePreview,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
    probeBrowserImageFile,
    readBlobAsDataUrl,
} from '@app/platform/browser-api/browserImageResourcePolicy';
export type { IProbedBrowserImage } from '@app/platform/browser-api/browserImageResourcePolicy';
export { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
