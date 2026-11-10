import type { layoutPdfForPrint } from '@app/platform/browser-api/browserPageOpsCore';
export {isBrowserFullReadTooLargeError} from '@app/platform/browser/browserDocumentReadError';
export {isBrowserQpdfEngineUnavailableError} from '@app/platform/browser-api/browserQpdfEngineClient';
export {isBrowserWorkerResetError} from '@app/platform/browser-api/browserWorkerClientLifecycle';
export { browserAgentCapability } from '@app/platform/browser-api/browserAgentCapability';
export { browserDjvuCapability } from '@app/platform/browser-api/browserDjvuCapability';
export { browserHostCapability } from '@app/platform/browser-api/browserHostCapability';
export {
    browserOcrCapability,
    canUseBrowserOcr,
} from '@app/platform/browser-api/browserOcrCapability';
export { browserScanCleanupCapability } from '@app/platform/browser-api/browserScanCleanupCapability';
export { browserSettingsCapability } from '@app/platform/browser-api/browserSettingsCapability';
export { createBrowserDocumentsCapability } from '@app/platform/browser-api/createBrowserDocumentsCapability';
export { isBrowserFilePickerSetupDeniedError } from '@app/platform/browser-api/browserFilePickerAdapter';
export { matchBrowserSearchPageWindowInWorker } from '@app/platform/browser-api/matchBrowserSearchPageWindow';
export { createBrowserSearchCapability } from '@app/platform/browser-api/createBrowserSearchCapability';
export { createDjvuPagePreviewSourceFromPath } from '@app/platform/browser-api/createDjvuWorkerFromPath';
export {
    ASSISTANT_IMAGE_RESOURCE_LIMITS,
    createStaticBrowserImagePreview,
    PDF_IMAGE_PLACEMENT_RESOURCE_LIMITS,
    probeBrowserImageFile,
    readBlobAsDataUrl,
} from '@app/platform/browser-api/browserImageResourcePolicy';
export type { IProbedBrowserImage } from '@app/platform/browser-api/browserImageResourcePolicy';
export { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';

export async function layoutPdfForBrowserPrint(...args: Parameters<typeof layoutPdfForPrint>) {
    const core = await import('@app/platform/browser-api/browserPageOpsCore');
    return core.layoutPdfForPrint(...args);
}

/** Opens the document the Chrome extension launched this page with (packages/chrome-extension). */
export async function openBrowserExtensionLaunchDocument() {
    const launch = await import('@app/platform/browser-api/openBrowserExtensionDocument');
    return launch.openBrowserExtensionDocument();
}
