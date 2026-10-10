import type { TDocumentRef } from '@contracts/documentRef';
import type { TRequestId } from '@contracts/shared';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    TOcrProgressPhase,
    IOcrModelDownloadProgress,
    TOcrPreprocessingMode,
    TOcrQualityProfile,
    TOcrTextSupersessionPolicy,
} from '@contracts/electronApiOcr';

export type TOcrPageRange = 'all' | 'current' | 'custom';

export interface IOcrSettings {
    pageRange: TOcrPageRange;
    customRange: string;
    selectedLanguages: string[];
    qualityProfile: TOcrQualityProfile;
    preprocessingMode: TOcrPreprocessingMode;
    pageSegmentationMode: number | null;
    supersessionPolicy: TOcrTextSupersessionPolicy;
    replaceAllAcknowledged: boolean;
}

export interface IOcrUiProgress {
    isRunning: boolean;
    status?: 'idle' | 'running' | 'cancel-requested' | 'cancelled';
    phase: TOcrProgressPhase;
    currentPage: number;
    totalPages: number;
    processedCount: number;
    phaseProgress: number | null;
    modelDownload?: IOcrModelDownloadProgress | undefined;
}

export interface IOcrSearchablePdfResult {
    requestId: TRequestId;
    pdfPath: TDocumentRef;
    sourceDocumentRevisionToken: TDocumentRevisionToken;
    requiresCleanupAck: boolean;
}

export interface IOcrResults {
    pages: Map<number, string>;
    languages: string[];
    completedAt: number | null;
    searchablePdfResult: IOcrSearchablePdfResult | null;
}
