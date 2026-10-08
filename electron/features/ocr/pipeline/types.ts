import type {IOcrWord} from '@contracts/shared';
import type {
    IOcrErrorEnvelope,
    IOcrDiagnostic,
    TOcrSearchablePdfPages,
    TOcrCompletionOutcome,
} from '@contracts/electronApiOcr';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
export type { IRunCommandResult } from '@electron/utils/runElectronCommand';

export interface IOcrPipelinePaths {
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
    tempDir: string;
}

type TOcrLogLevel = 'debug' | 'warn' | 'error';

export type TWorkerLog = (
    level: TOcrLogLevel,
    message: string,
    data?: Record<string, unknown>,
) => void;

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
 * A recognized word in Tesseract's own numbering: `ordinal` counts the page's
 * non-empty words, which is also the order of their text in Tesseract's PDF.
 */
export interface ITesseractWord {
    ordinal: number;
    lineKey: string;
    text: string;
}

/** Replaces a word's text in Tesseract's PDF with text of the same length. */
export interface IOcrWordEdit {
    word: number;
    from: string;
    to: string;
}

export interface IOcrPageProcessingResult {
    pageData?: IOcrPageWithWords;
    pdfPath?: string;
    effectiveDpi?: number;
    diagnostics?: IOcrDiagnostic[];
    error?: string;
}

export interface IOcrFileResult {
    success: boolean;
    pageData: IOcrPageWithWords | null;
    pdfPath: string | null;
    error?: string;
    /** Tesseract parameters the engine rejected; the run continued without them. */
    unsupportedOptions?: string[];
    /** Edits that pageData already carries and Tesseract's PDF does not. */
    wordEdits?: IOcrWordEdit[];
    /** Why a page that looks printed with the long s was read without the long-s models. */
    longSUnavailable?: string;
}

export type TOcrJobResult =
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
        outcome?: TOcrCompletionOutcome;
        diagnostics?: IOcrDiagnostic[];
        errorEnvelope?: IOcrErrorEnvelope;
    };
