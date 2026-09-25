import {
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
} from '@contracts/documentsPlatformFeature';
import type {
    IPdfCommittedSaveAsResult,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import type {IBeginSerializedPdfPersistenceResult} from '@electron/features/documents/serializedPdfPersistenceContract';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TSessionId } from '@contracts/shared';
import type {IDocxExportInvokeMap} from '@contracts/docxExport';

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

interface IDocumentsDirectPersistenceInvokeMap {
    [DOCUMENTS_CHANNELS.registerRendererFileOpenToken]: {
        args: [token: string];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.registerRendererFileOpenTokens]: {
        args: [tokens: string[]];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpen]: {
        args: [request: {
            filePath: string;
            token: string;
        }];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.allowRendererFileOpenBatch]: {
        args: [requests: Array<{
            filePath: string;
            token: string;
        }>];
        result: boolean;
    };
    [DOCUMENTS_CHANNELS.fileSavePdfDataBegin]: {
        args: [path: TDocumentRef, totalBytes: number, options?: IPdfSerializedSaveOptions];
        result: IBeginSerializedPdfPersistenceResult;
    };
    [DOCUMENTS_CHANNELS.fileCommitStagedSerializedPdf]: {
        args: [
            sessionId: TSessionId,
            stagedOutput: ITypedStagedArtifact,
        ];
        result: IPdfCommittedSaveAsResult;
    };
    [DOCUMENTS_CHANNELS.fileCancelStagedSerializedPdf]: {
        args: [
            sessionId: TSessionId,
            stagedOutput: ITypedStagedArtifact,
        ];
        result: boolean;
    };
}

export type IDocumentsInvokeMap = IDocumentsDirectPersistenceInvokeMap & IDocxExportInvokeMap;

export type { TOpenFileResult } from '@contracts/electronApiDocuments';
