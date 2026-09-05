import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type {IDocumentRevisionInfo} from '@contracts/documentRevision';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import type {
    IPdfConformanceAnalysisOptions,
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import type {
    IDocumentMutationRevisionOptions,
    IManagedTempFileHandle,
    IPdfNativeMutationSet,
    IPdfNativeStagedCommitOptions,
    IPdfNativeNoteChanges,
    IPdfNativeSaveResult,
    IPdfNativeNoteTextSaveResult,
    IPdfNativePagePreview,
    IPdfNativePagePreviewOptions,
    TPdfNativePageSizes,
    IPdfOpeningGeometry,
    IPdfNoteTextUpdate,
    IPdfOptimizeOptions,
    IPdfOptimizeResult,
    IPdfPathPrintOptions,
    IPdfPathValidationOptions,
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
    IPdfAnnotationIndexChunk,
    IPdfAnnotationIndexChunkOptions,
    IPdfAnnotationIndexOptions,
    IPdfAnnotationIndexSession,
    IPdfAnnotationParseChunk,
    IPdfAnnotationParseChunkOptions,
    IPdfAnnotationParseOptions,
    IPdfAnnotationParseResult,
    IPdfAnnotationParseSession,
    IPdfDataPrintOptions,
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexSession,
    IWorkingCopyBackingStatus,
    TDocumentSaveResult,
} from '@contracts/electronApiDocuments';
import type { IRecentFile } from '@contracts/shared';
import type { TOpenFileResult } from '@electron/features/documents/contract';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import type {
    IBeginSerializedPdfPersistenceResult,
    IBeginSerializedPdfSaveAsResult,
} from '@electron/features/documents/serializedPdfPersistenceContract';
import type { TOpenPathOwner } from '@electron/features/documents/main/openPathOwner';

export interface IDocumentsWebContentsContext {
    sender: WebContents;
    senderId: number;
}

export interface IDocumentsDialogContext extends IDocumentsWebContentsContext { parentWindow: BrowserWindow | null; }

export interface IDocumentsSenderIdContext {
    sender?: WebContents;
    senderId?: number;
}

export interface IDocumentsWindowContext {
    onNativePrintDialogOpened?: (requestId: string) => void;
    senderId?: number;
    window: BrowserWindow | null;
}

export interface IDocumentsOpenPathContext { owner?: TOpenPathOwner; }

export interface IWorkingCopyBackingStatusServiceEvent {
    ownerWebContentsId?: number;
    status: IWorkingCopyBackingStatus;
}

export interface IDocumentsService {
    openDocumentDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openCombineDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openFolderDialog: (context: IDocumentsDialogContext) => Promise<TOpenFileResult | null>;
    openImageDialog: (context: IDocumentsDialogContext) => Promise<string | null>;
    openDocumentDirect: (
        context: IDocumentsWebContentsContext,
        filePath: string,
        password?: string,
    ) => Promise<TOpenFileResult | null>;
    openDocumentDirectBatch: (
        context: IDocumentsWebContentsContext,
        filePaths: string[],
        requestId?: string,
        options?: {forceCombine?: boolean},
    ) => Promise<TOpenFileResult | null>;
    cancelOpenDocumentDirectBatch: (context: IDocumentsWebContentsContext, requestId: string) => boolean;
    createWorkingCopyFromData: (
        context: IDocumentsSenderIdContext,
        fileName: string,
        data: Uint8Array,
        originalPath?: string,
        password?: string,
    ) => Promise<string>;
    createWorkingCopyFromPath: (
        context: IDocumentsSenderIdContext,
        sourcePath: TOpenPath,
        originalPath?: string,
        password?: string,
    ) => Promise<string>;
    parsePdfAnnotations: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options: IPdfAnnotationParseOptions,
    ) => Promise<IPdfAnnotationParseResult>;
    savePdfAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        options: IPdfSaveAsOptions | undefined,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<string | null>;
    savePdfDataAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        data: Uint8Array,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
    ) => Promise<{
        path: string | null;
        validation: IPdfValidationResult | null;
    }>;
    beginSavePdfDataAs: (
        context: IDocumentsDialogContext,
        workingPath: string,
        totalBytes: number,
        options?: IPdfSaveAsOptions,
        serializedSaveOptions?: IPdfSerializedSaveOptions,
    ) => Promise<IBeginSerializedPdfSaveAsResult>;
    savePdfDialog: (context: IDocumentsDialogContext, suggestedName: string) => Promise<string | null>;
    saveDocxAs: (context: IDocumentsDialogContext, workingPath: string) => Promise<string | null>;
    readFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<Uint8Array>;
    statFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<{
        size: number;
        modifiedAt: number;
    }>;
    readFileRange: (context: IDocumentsSenderIdContext, filePath: string, offset: number, length: number) => Promise<Uint8Array>;
    createManagedTempFileHandle: (context: IDocumentsSenderIdContext, filePath: string) => Promise<IManagedTempFileHandle>;
    releaseManagedTempFileHandle: (context: IDocumentsSenderIdContext, leaseId: string) => boolean;
    getPdfOpeningGeometry: (
        context: IDocumentsSenderIdContext,
        filePath: string,
    ) => Promise<IPdfOpeningGeometry | null>;
    getPdfNativePageSizes: (
        context: IDocumentsSenderIdContext,
        filePath: string,
    ) => Promise<TPdfNativePageSizes>;
    cancelPdfNativePagePreview: (
        context: IDocumentsSenderIdContext,
        requestId: string,
    ) => Promise<{ canceled: boolean }>;
    renderPdfNativePagePreview: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        pageNumber: number,
        options?: IPdfNativePagePreviewOptions,
    ) => Promise<IPdfNativePagePreview>;
    beginPdfAnnotationIndex: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options: IPdfAnnotationIndexOptions,
    ) => Promise<IPdfAnnotationIndexSession>;
    readPdfAnnotationIndexChunk: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
        offset: number,
        options?: IPdfAnnotationIndexChunkOptions,
    ) => Promise<IPdfAnnotationIndexChunk>;
    releasePdfAnnotationIndex: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<boolean>;
    cancelPdfAnnotationIndex: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<{canceled: boolean}>;
    beginPdfAnnotationParse: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options: IPdfAnnotationParseOptions,
    ) => Promise<IPdfAnnotationParseSession>;
    readPdfAnnotationParseChunk: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
        offset: number,
        options?: IPdfAnnotationParseChunkOptions,
    ) => Promise<IPdfAnnotationParseChunk>;
    releasePdfAnnotationParse: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<boolean>;
    cancelPdfAnnotationParse: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<{canceled: boolean}>;
    beginPdfEmbeddedShapeIndex: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options: IPdfEmbeddedShapeIndexOptions,
    ) => Promise<IPdfEmbeddedShapeIndexSession>;
    readPdfEmbeddedShapeIndexChunk: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
        offset: number,
        options?: IPdfEmbeddedShapeIndexChunkOptions,
    ) => Promise<IPdfEmbeddedShapeIndexChunk>;
    releasePdfEmbeddedShapeIndex: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<boolean>;
    cancelPdfEmbeddedShapeIndex: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
    ) => Promise<{canceled: boolean}>;
    readTextFile: (context: IDocumentsSenderIdContext, filePath: string) => Promise<string>;
    fileExists: (context: IDocumentsSenderIdContext, filePath: string) => boolean;
    getDocumentRevision: (context: IDocumentsSenderIdContext, filePath: string) => Promise<IDocumentRevisionInfo>;
    getWorkingCopyBackingStatus: (
        context: IDocumentsSenderIdContext,
        filePath: string,
    ) => IWorkingCopyBackingStatus | null;
    onWorkingCopyBackingStatusChanged: (
        listener: (event: IWorkingCopyBackingStatusServiceEvent) => void,
    ) => () => void;
    analyzePdfConformance: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options?: IPdfConformanceAnalysisOptions,
    ) => Promise<IPdfConformanceProfile>;
    validatePdfData: (data: Uint8Array, fileName?: string) => Promise<IPdfValidationResult>;
    validatePdfPath: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        options?: IPdfPathValidationOptions,
    ) => Promise<IPdfValidationResult>;
    openPdfInDefaultAppData: (data: Uint8Array, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    openPdfInDefaultAppPath: (context: IDocumentsSenderIdContext, filePath: string, fileName?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    printPdfData: (context: IDocumentsWindowContext, data: Uint8Array, fileName?: string, options?: IPdfDataPrintOptions) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    cancelPdfPrint: (
        context: IDocumentsSenderIdContext,
        requestId: string,
    ) => Promise<{canceled: boolean}>;
    printPdfPath: (context: IDocumentsWindowContext, filePath: string, fileName?: string, options?: IPdfPathPrintOptions) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
    }>;
    writeFile: (
        context: IDocumentsSenderIdContext,
        filePath: string,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<boolean>;
    resyncWorkingCopy: (context: IDocumentsSenderIdContext, workingPath: string) => Promise<TDocumentSaveResult>;
    replaceWorkingCopyFromPath: (
        context: IDocumentsSenderIdContext,
        workingCopyPath: string,
        sourcePath: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<boolean>;
    writeDocxFile: (context: IDocumentsSenderIdContext, filePath: string, data: Uint8Array) => Promise<boolean>;
    saveFileStructured: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<TDocumentSaveResult>;
    repairPdf: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfValidationResult>;
    optimizePdfForInteraction: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        options?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfValidationResult>;
    optimizePdfAsCopy: (
        context: IDocumentsDialogContext,
        workingPath: string,
        options: IPdfOptimizeOptions,
        requestId?: string,
        revisionOptions?: IDocumentMutationRevisionOptions,
    ) => Promise<IPdfOptimizeResult>;
    savePdfData: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        data: Uint8Array,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfValidationResult>;
    savePdfNoteTextUpdates: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        updates: IPdfNoteTextUpdate[],
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNoteChanges: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        changes: IPdfNativeNoteChanges,
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeNoteTextSaveResult>;
    savePdfNativeMutations: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeSaveResult>;
    applyPdfNativeMutationsToWorkingCopy: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        mutations: IPdfNativeMutationSet,
        modifiedAt: string,
        options: IPdfSerializedSaveOptions,
    ) => Promise<IPdfNativeSaveResult>;
    commitStagedPdfNativeMutations: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        stagedOutput: ITypedStagedArtifact,
        options?: IPdfNativeStagedCommitOptions,
    ) => Promise<IPdfNativeSaveResult>;
    cloneStagedPdfNativeMutationToWorkingCopy: (
        context: IDocumentsSenderIdContext,
        stagedOutput: ITypedStagedArtifact,
        originalPath?: string,
    ) => Promise<string>;
    replaceWorkingCopyFromStagedPdfNativeMutation: (
        context: IDocumentsSenderIdContext,
        workingPath: string,
        stagedOutput: ITypedStagedArtifact,
        options: IDocumentMutationRevisionOptions,
    ) => Promise<boolean>;
    beginSavePdfData: (
        context: IDocumentsWebContentsContext,
        workingPath: string,
        totalBytes: number,
        options?: IPdfSerializedSaveOptions,
    ) => Promise<IBeginSerializedPdfPersistenceResult>;
    commitStagedSerializedPdf: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
        stagedOutput: ITypedStagedArtifact,
    ) => Promise<{
        path: string | null;
        validation: IPdfValidationResult;
    }>;
    cancelStagedSerializedPdf: (
        context: IDocumentsSenderIdContext,
        sessionId: string,
        stagedOutput: ITypedStagedArtifact,
    ) => Promise<boolean>;
    cleanupFile: (context: IDocumentsSenderIdContext, workingPath: string) => Promise<void>;
    cleanupOcrTemp: (context: IDocumentsSenderIdContext, filePath: string) => Promise<void>;
    setWindowTitle: (context: IDocumentsWindowContext, title: string) => void;
    showItemInFolder: (context: IDocumentsOpenPathContext, filePath: string) => Promise<boolean>;
    setMenuDocumentState: (
        context: IDocumentsWindowContext,
        state: boolean | {
            hasDocument: boolean;
            canPrint?: boolean;
            canSave: boolean;
            canSaveAs?: boolean;
            canRepairSave?: boolean;
            canOptimizePdf?: boolean;
            interactive?: boolean;
            canContinuousScroll?: boolean;
            continuousScroll?: boolean;
        },
    ) => void;
    setMenuTabCount: (context: IDocumentsWindowContext, tabCount: number) => void;
    getRecentFiles: (context: IDocumentsWebContentsContext) => Promise<IRecentFile[]>;
    removeRecentFile: (originalPath: string) => Promise<void>;
    removeRecentFileIfMissing: (originalPath: string) => Promise<boolean>;
    clearRecentFiles: () => Promise<void>;
}
