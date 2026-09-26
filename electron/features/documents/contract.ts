import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';

/** Channels outside the platform-feature specs: file-open grants and the streamed PDF save. */
export const DOCUMENTS_CHANNELS = {
    registerRendererFileOpenToken: 'dialog:registerRendererFileOpenToken',
    registerRendererFileOpenTokens: 'dialog:registerRendererFileOpenTokens',
    allowRendererFileOpen: 'dialog:allowRendererFileOpen',
    allowRendererFileOpenBatch: 'dialog:allowRendererFileOpenBatch',
    fileSavePdfDataBegin: 'file:savePdfData:begin',
    fileSavePdfDataPort: 'file:savePdfData:port',
    fileCommitStagedSerializedPdf: 'file:commitStagedSerializedPdf',
    fileCancelStagedSerializedPdf: 'file:cancelStagedSerializedPdf',
} as const;

export const DOCUMENTS_EVENT_CHANNELS = {
    documentRevisionChanged: DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onDocumentRevisionChanged,
    nativePrintDialogOpened: DOCUMENT_PDF_PLATFORM_FEATURE.eventChannels.onNativePrintDialogOpened,
    workingCopyBackingStatusChanged:
        DOCUMENT_FILES_PLATFORM_FEATURE.eventChannels.onWorkingCopyBackingStatusChanged,
} as const;
