import type {
    IOcrWord,
    TJobId,
    TRequestId,
} from '@contracts/shared';
import type {
    IOcrErrorEnvelope,
    IOcrDiagnostic,
    IOcrSearchablePdfOptions,
    TOcrSearchablePdfPages,
    TOcrProgressPhase,
} from '@contracts/electronApiOcr';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {IScanCleanupPreviewAffine} from '@contracts/scan-cleanup/geometry';
export type { IRunCommandResult } from '@electron/utils/runElectronCommand';

export interface IWorkerPaths {
    tesseractBinary: string;
    tessdataPath: string;
    pdftoppmBinary: string;
    pdftotextBinary?: string;
    pdfimagesBinary?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdfBinary: string;
    pdfPageOpsBinary?: string;
    scanCleanupBinary?: string;
    unpaperBinary?: string;
    tempDir: string;
}

export type TOcrWorkerLogLevel = 'debug' | 'warn' | 'error';

export type TWorkerLog = (level: TOcrWorkerLogLevel, message: string) => void;

export interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

export type TOcrPdfPageSelection = TOcrSearchablePdfPages;

export interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
}

/**
 * The unrotated PDF rectangle that Poppler rendered for an OCR page.
 * Raster coordinates start at the top-left of this rectangle. The assembler
 * composes this with the source page rotation before embedding the hidden
 * layer.
 */
export interface IOcrPageGeometry {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: 0 | 90 | 180 | 270;
    rasterWidthPx?: number;
    rasterHeightPx?: number;
    preprocessInverseTransform?: IScanCleanupPreviewAffine;
}

export interface IOcrPageTerminationUnproven {
    pageNumber: number;
    detail: string;
}

export interface IOcrPageProcessingResult {
    pageData?: IOcrPageWithWords;
    pageGeometry?: IOcrPageGeometry;
    pdfPath?: string;
    checkpointJsonPath: string;
    checkpointPdfPath: string;
    effectiveDpi?: number;
    diagnostics?: IOcrDiagnostic[];
    error?: string;
    /** Tesseract stopped before its native process tree was proven dead. */
    terminationUnproven?: IOcrPageTerminationUnproven;
}

export interface IOcrFileResult {
    success: boolean;
    pageData: IOcrPageWithWords | null;
    pdfPath: string | null;
    error?: string;
    /** The worker stopped before proving that Tesseract's native tree died. */
    terminationUnproven?: string;
}

export type TOcrNativeChildProcessIdentityKind =
    | 'linux-proc-start-time'
    | 'posix-start-time'
    | 'windows-creation-time'
    | 'opaque';

export interface IOcrNativeChildProcessIdentity {
    kind: TOcrNativeChildProcessIdentityKind;
    value: string;
}

export interface IOcrNativeChildRegistration {
    childId: TRequestId;
    pid: number;
    processIdentity: IOcrNativeChildProcessIdentity;
}

export interface IOcrWorkerStartPayload {
    sourcePdfPath: string;
    documentRevision: IDocumentRevisionInfo;
    pages: TOcrPdfPageSelection;
    renderDpi?: number;
    options?: IOcrSearchablePdfOptions;
}

export type TOcrWorkerInboundMessage =
    | {
        type: 'start';
        jobId: TJobId;
        data: IOcrWorkerStartPayload;
    }
    | {
        type: 'cancel';
        jobId: TJobId;
    }
    | {
        type: 'resource-acquired';
        jobId: TJobId;
        requestId: TRequestId;
        token: string;
        effectiveDpi: number;
    }
    | {
        type: 'resource-denied';
        jobId: TJobId;
        requestId: TRequestId;
        reason: string;
    }
    | {
        type: 'native-child-intent-ack';
        jobId: TJobId;
        childId: TRequestId;
        accepted: boolean;
        reason?: string;
    }
    | {
        type: 'native-child-register-ack';
        jobId: TJobId;
        childId: TRequestId;
        accepted: boolean;
        reason?: string;
    }
    | {
        type: 'native-child-exit-ack';
        jobId: TJobId;
        childId: TRequestId;
        accepted: boolean;
        reason?: string;
    };

interface IOcrWorkerProgressPayload {
    requestId: TRequestId;
    currentPage: number;
    processedCount: number;
    totalPages: number;
    phase?: TOcrProgressPhase;
    phaseProgress?: number;
}

export type TOcrWorkerCompleteResult =
    | {
        success: true;
        pdfPath: string;
        sourceDocumentRevisionToken: TDocumentRevisionToken;
        resultSha256: string;
        requiresCleanupAck: boolean;
        errors: string[];
        diagnostics?: IOcrDiagnostic[];
    }
    | {
        success: false;
        errors: string[];
        diagnostics?: IOcrDiagnostic[];
        errorEnvelope?: IOcrErrorEnvelope;
        terminationUnproven?: string;
    };

export interface IOcrWorkerProgressMessage {
    type: 'progress';
    jobId: TJobId;
    progress: IOcrWorkerProgressPayload;
}

export interface IOcrWorkerCompleteMessage {
    type: 'complete';
    jobId: TJobId;
    result: TOcrWorkerCompleteResult;
}

export interface IOcrWorkerCleanupCompleteMessage {
    type: 'cleanup-complete';
    jobId: TJobId;
}

export interface IOcrWorkerNativeChildIntentMessage {
    type: 'native-child-intent';
    jobId: TJobId;
    childId: TRequestId;
    commandLabel: string;
}

export interface IOcrWorkerNativeChildRegisterMessage {
    type: 'native-child-register';
    jobId: TJobId;
    childId: TRequestId;
    pid: number;
    processIdentity: IOcrNativeChildProcessIdentity;
}

export interface IOcrWorkerNativeChildExitMessage {
    type: 'native-child-exit';
    jobId: TJobId;
    childId: TRequestId;
    pid: number;
    processIdentity: IOcrNativeChildProcessIdentity;
}

export interface IOcrWorkerNativeChildNoSpawnMessage {
    type: 'native-child-no-spawn';
    jobId: TJobId;
    childId: TRequestId;
}

export interface IOcrWorkerNativeChildUnprovenMessage {
    type: 'native-child-unproven';
    jobId: TJobId;
    childId: TRequestId;
    detail: string;
}

export interface IOcrWorkerLogMessage {
    type: 'log';
    level: TOcrWorkerLogLevel;
    message: string;
}

export interface IOcrWorkerResourceAcquireMessage {
    type: 'resource-acquire';
    jobId: TJobId;
    requestId: TRequestId;
    pageNumber: number;
    requestedDpi: number;
    pageWidthIn?: number;
    pageHeightIn?: number;
}

export interface IOcrWorkerResourceReleaseMessage {
    type: 'resource-release';
    jobId: TJobId;
    token: string;
}

export type TOcrWorkerOutboundMessage =
    | IOcrWorkerProgressMessage
    | IOcrWorkerCompleteMessage
    | IOcrWorkerCleanupCompleteMessage
    | IOcrWorkerNativeChildIntentMessage
    | IOcrWorkerNativeChildRegisterMessage
    | IOcrWorkerNativeChildExitMessage
    | IOcrWorkerNativeChildNoSpawnMessage
    | IOcrWorkerNativeChildUnprovenMessage
    | IOcrWorkerLogMessage
    | IOcrWorkerResourceAcquireMessage
    | IOcrWorkerResourceReleaseMessage;
