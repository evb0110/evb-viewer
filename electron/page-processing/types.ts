/**
 * Page Processing Types
 *
 * Defines all interfaces for the page processing subsystem.
 */

import type { Worker } from 'worker_threads';

export type TProcessingOperation =
    | 'split'      // Split facing pages
    | 'dewarp'     // Remove page curvature
    | 'deskew'     // Correct rotation
    | 'crop';      // Trim margins

export interface IProcessingOptions {
    /** Operations to perform (order matters) */
    operations: TProcessingOperation[];

    /** Auto-detect facing pages vs manual split */
    autoDetectFacingPages: boolean;

    /** Force split even if not detected as facing pages */
    forceSplit: boolean;

    /** Minimum skew angle (degrees) to trigger deskewing */
    minSkewAngle: number;

    /** Minimum curvature score to trigger dewarping */
    minCurvatureThreshold: number;

    /** Padding around detected content (pixels) */
    cropPadding: number;

    /** Output DPI for processed images */
    outputDpi: number;

    /** Render DPI for extracting pages from PDF */
    extractionDpi: number;
}

export interface IProcessingRequest {
    /** Unique job identifier */
    jobId: string;

    /** Path to the PDF file */
    pdfPath: string;

    /** Page numbers to process (1-indexed) */
    pages: number[];

    /** Processing options */
    options: IProcessingOptions;

    /** Working copy path for saving results */
    workingCopyPath?: string;
}

export interface IProcessingProgress {
    /** Job identifier */
    jobId: string;

    /** Current page being processed */
    currentPage: number;

    /** Current operation on the page */
    currentOperation: TProcessingOperation | 'extracting' | 'merging';

    /** Number of pages completed */
    processedCount: number;

    /** Total pages to process */
    totalPages: number;

    /** Estimated percentage complete */
    percentage: number;

    /** Human-readable status message */
    message: string;
}

export interface IPageResult {
    /** Original page number */
    pageNumber: number;

    /** Operations actually performed */
    operationsApplied: TProcessingOperation[];

    /** Detection results */
    detection: {
        wasFacingPages: boolean;
        skewAngle: number;
        curvatureScore: number;
        contentBounds: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    };

    /** Output page numbers (may be 2 if split) */
    outputPageNumbers: number[];

    /** Warnings or notes */
    notes: string[];
}

export interface IProcessingResult {
    /** Job identifier */
    jobId: string;

    /** Overall success */
    success: boolean;

    /** Path to processed PDF (if saved to file) */
    pdfPath?: string;

    /** PDF data (if returned in memory) */
    pdfData?: number[];

    /** Per-page results */
    pageResults: IPageResult[];

    /** Errors encountered */
    errors: string[];

    /** Processing statistics */
    stats: {
        totalPagesInput: number;
        totalPagesOutput: number;
        processingTimeMs: number;
    };
}

export interface IProcessingJob {
    jobId: string;
    worker: Worker;
    webContentsId: number;
    completed: boolean;
    terminatedByUs: boolean;
    startTime: number;
}

// Default processing options
export const DEFAULT_PROCESSING_OPTIONS: IProcessingOptions = {
    operations: [
        'split',
        'deskew',
        'dewarp',
        'crop',
    ],
    autoDetectFacingPages: true,
    forceSplit: false,
    minSkewAngle: 0.5,
    minCurvatureThreshold: 0.1,
    cropPadding: 30,
    outputDpi: 300,
    extractionDpi: 300,
};
