/**
 * Renderer-side Page Processing Types
 */

export type TProcessingOperation =
    | 'split'
    | 'dewarp'
    | 'deskew'
    | 'crop';

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

export interface IProcessingSettings {
    /** Page range type */
    rangeType: 'all' | 'current' | 'custom';

    /** Custom page range (e.g., "1-5, 8, 10-12") */
    customRange: string;

    /** Operations to perform */
    operations: {
        split: boolean;
        dewarp: boolean;
        deskew: boolean;
        crop: boolean;
    };

    /** Auto-detect facing pages */
    autoDetect: boolean;

    /** Advanced options */
    advanced: {
        extractionDpi: number;
        outputDpi: number;
        cropPadding: number;
        minSkewAngle: number;
    };
}

export interface IProcessingProgress {
    jobId: string;
    currentPage: number;
    currentOperation: string;
    processedCount: number;
    totalPages: number;
    percentage: number;
    message: string;
}

export interface IProcessingResult {
    jobId: string;
    success: boolean;
    errors: string[];
    stats: {
        totalPagesInput: number;
        totalPagesOutput: number;
        processingTimeMs: number;
    };
    /** PDF data returned inline (for smaller results) */
    pdfData?: number[];
    /** Path to processed PDF (for larger results saved to file) */
    pdfPath?: string;
}

export const DEFAULT_PROCESSING_SETTINGS: IProcessingSettings = {
    // Safer default: most users want to test processing on the current page first.
    rangeType: 'current',
    customRange: '',
    operations: {
        split: true,
        dewarp: false,
        deskew: true,
        // Auto-crop can remove content on real-world scans. Keep it opt-in.
        crop: false,
    },
    autoDetect: true,
    advanced: {
        extractionDpi: 300,
        outputDpi: 300,
        cropPadding: 30,
        minSkewAngle: 0.5,
    },
};

/**
 * Processing Stage Types
 */
export type TProcessingStage =
    | 'rotation'
    | 'split'
    | 'deskew'
    | 'dewarp'
    | 'content'
    | 'margins'
    | 'output';

export type TStageStatus = 'pending' | 'processing' | 'complete' | 'error';

export type TPageStatus = 'pending' | 'processing' | 'complete' | 'error';

export type TProjectStatus = 'idle' | 'processing' | 'error' | 'complete';

export type TSplitMode = 'none' | 'auto' | 'manual';

/**
 * Rotation parameters for a page
 */
export interface IRotationParams {
    /** Rotation angle in degrees (0, 90, 180, 270) */
    angle: number;
    /** Confidence score from auto-detection (0-1) */
    confidence: number;
    /** Source of the value: 'auto' or 'manual' */
    source: 'auto' | 'manual';
}

/**
 * Split parameters for a page
 */
export interface ISplitParams {
    /** Split type: none, vertical, horizontal */
    type: 'none' | 'vertical' | 'horizontal';
    /** Split position (0-1 normalized) */
    position: number;
    /** Confidence score from auto-detection (0-1) */
    confidence: number;
    /** Detection method used */
    methodUsed: string;
}

/**
 * Deskew parameters for a page
 */
export interface IDeskewParams {
    /** Skew angle in degrees */
    angle: number;
    /** Confidence score from auto-detection (0-1) */
    confidence: number;
    /** Detection method used */
    methodUsed: string;
}

/**
 * Dewarp parameters for a page
 */
export interface IDewarpParams {
    /** Dewarp grid data (implementation-specific) */
    grid: number[][] | null;
    /** Dewarp strength (0-1) */
    strength: number;
    /** Confidence score from auto-detection (0-1) */
    confidence: number;
}

/**
 * Content rect (crop bounds) for a page
 */
export interface IContentRect {
    /** X position (0-1 normalized) */
    x: number;
    /** Y position (0-1 normalized) */
    y: number;
    /** Width (0-1 normalized) */
    width: number;
    /** Height (0-1 normalized) */
    height: number;
    /** Confidence score from auto-detection (0-1) */
    confidence: number;
}

/**
 * Margin parameters for a page
 */
export interface IMarginParams {
    /** Top margin */
    top: number;
    /** Right margin */
    right: number;
    /** Bottom margin */
    bottom: number;
    /** Left margin */
    left: number;
    /** Unit for margin values */
    unit: 'px' | 'mm' | 'in' | 'percent';
}

/**
 * Auto-detected values for a page (read-only reference)
 */
export interface IAutoDetectedParams {
    rotation: IRotationParams | null;
    split: ISplitParams | null;
    deskew: IDeskewParams | null;
    dewarp: IDewarpParams | null;
    contentRect: IContentRect | null;
}

/**
 * Manual overrides for a page (null means use auto-detected)
 */
export interface IManualOverrides {
    rotation: IRotationParams | null;
    split: ISplitParams | null;
    deskew: IDeskewParams | null;
    dewarp: IDewarpParams | null;
    contentRect: IContentRect | null;
    margins: IMarginParams | null;
}

/**
 * Output page reference (result of processing a single input page)
 */
export interface IOutputPage {
    /** Output index in final PDF */
    outputIndex: number;
    /** Source region if split (0 or 1 for left/right) */
    sourceRegion: number;
    /** Path to processed image (in cache) */
    processedImagePath: string | null;
    /** Final page dimensions */
    dimensions: {
        width: number;
        height: number;
    } | null;
}

/**
 * Per-page processing state
 */
export interface IPageProcessingState {
    /** Original page number (1-indexed) */
    originalPageNumber: number;
    /** Auto-detected parameters */
    autoDetected: IAutoDetectedParams;
    /** Manual override parameters */
    manualOverrides: IManualOverrides;
    /** Status per stage */
    stageStatus: Record<TProcessingStage, TStageStatus>;
    /** Errors per stage */
    stageErrors: Record<TProcessingStage, string | null>;
    /** Output pages (may be 1 or 2 if split) */
    outputPages: IOutputPage[];
    /** Hash of source image for cache validation */
    pageHash: string | null;
}

/**
 * Global processing settings (defaults for all pages)
 */
export interface IGlobalProcessingSettings {
    /** Default rotation mode */
    rotationMode: 'auto' | 'manual';
    /** Default split detection */
    splitDetection: 'auto' | 'manual' | 'none';
    /** Default deskew threshold */
    minSkewAngle: number;
    /** Default dewarp threshold */
    minCurvatureThreshold: number;
    /** Default crop padding */
    cropPadding: number;
    /** Default margins */
    defaultMargins: IMarginParams;
}

/**
 * Output settings for final PDF generation
 */
export interface IOutputSettings {
    /** Output DPI */
    dpi: number;
    /** Color mode */
    colorMode: 'color' | 'grayscale' | 'bw';
    /** Compression type */
    compression: 'lossless' | 'lossy';
    /** JPEG quality if lossy (0-100) */
    jpegQuality: number;
    /** Output format */
    format: 'pdf' | 'images';
    /** Whether to preserve bookmarks */
    preserveBookmarks: boolean;
}

/**
 * Project statistics
 */
export interface IProjectStats {
    /** Total input pages */
    totalPagesInput: number;
    /** Total output pages (after splits) */
    totalPagesOutput: number;
    /** Number of pages with splits */
    splitCount: number;
    /** Number of pages with manual overrides */
    overrideCount: number;
    /** Number of errors */
    errorCount: number;
    /** Processing time in ms */
    processingTimeMs: number;
}

/**
 * Processing project state
 */
export interface IProcessingProject {
    /** Unique project identifier */
    id: string;
    /** Schema version for migrations */
    schemaVersion: number;
    /** Project creation timestamp */
    createdAt: number;
    /** Last modified timestamp */
    updatedAt: number;
    /** Path to original PDF */
    originalPdfPath: string;
    /** Path to working copy */
    workingCopyPath: string;
    /** Path to backup (if created) */
    backupPath: string | null;
    /** Project directory path */
    projectDir: string;
    /** Current stage in workflow */
    currentStage: TProcessingStage;
    /** Overall project status */
    projectStatus: TProjectStatus;
    /** Per-page processing state */
    pages: IPageProcessingState[];
    /** Global settings */
    globalSettings: IGlobalProcessingSettings;
    /** Output settings */
    outputSettings: IOutputSettings;
    /** Project statistics */
    stats: IProjectStats;
    /** Non-fatal warnings */
    warnings: string[];
    /** Whether project has unsaved changes */
    isDirty: boolean;
}

/**
 * Default global processing settings
 */
export const DEFAULT_GLOBAL_SETTINGS: IGlobalProcessingSettings = {
    rotationMode: 'auto',
    splitDetection: 'auto',
    minSkewAngle: 0.5,
    minCurvatureThreshold: 0.1,
    cropPadding: 30,
    defaultMargins: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        unit: 'px',
    },
};

/**
 * Default output settings
 */
export const DEFAULT_OUTPUT_SETTINGS: IOutputSettings = {
    dpi: 300,
    colorMode: 'color',
    compression: 'lossless',
    jpegQuality: 85,
    format: 'pdf',
    preserveBookmarks: true,
};

/**
 * Stage display order and metadata
 */
export const PROCESSING_STAGES: Array<{
    key: TProcessingStage;
    label: string;
    description: string;
}> = [
    {
        key: 'rotation',
        label: 'Rotation',
        description: 'Fix page orientation (0/90/180/270 degrees)', 
    },
    {
        key: 'split',
        label: 'Split Pages',
        description: 'Split facing pages into single pages', 
    },
    {
        key: 'deskew',
        label: 'Deskew',
        description: 'Correct page skew/rotation', 
    },
    {
        key: 'dewarp',
        label: 'Dewarp',
        description: 'Remove page curvature from book scans', 
    },
    {
        key: 'content',
        label: 'Content',
        description: 'Detect and crop to content bounds', 
    },
    {
        key: 'margins',
        label: 'Margins',
        description: 'Set output margins and padding', 
    },
    {
        key: 'output',
        label: 'Output',
        description: 'Generate final processed PDF', 
    },
];

/**
 * Stage prerequisites (which stages must be complete before this one)
 */
export const STAGE_PREREQUISITES: Record<TProcessingStage, TProcessingStage[]> = {
    rotation: [],
    split: ['rotation'],
    deskew: [
        'rotation',
        'split',
    ],
    dewarp: [
        'rotation',
        'split',
        'deskew',
    ],
    content: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
    ],
    margins: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
        'content',
    ],
    output: [
        'rotation',
        'split',
        'deskew',
        'dewarp',
        'content',
        'margins',
    ],
};

/**
 * Preview request for a stage
 */
export interface IStagePreviewRequest {
    projectId: string;
    pageNumber: number;
    stage: TProcessingStage;
}

/**
 * Preview response
 */
export interface IStagePreviewResponse {
    success: boolean;
    imageUrl: string | null;
    error: string | null;
    cached: boolean;
}

/**
 * Output generation progress
 */
export interface IOutputProgress {
    /** Current phase */
    phase: 'preparing' | 'processing' | 'assembling' | 'finalizing';
    /** Current page being processed */
    currentPage: number;
    /** Total pages to process */
    totalPages: number;
    /** Percentage complete */
    percentage: number;
    /** Human-readable message */
    message: string;
}

/**
 * Output generation result
 */
export interface IOutputResult {
    success: boolean;
    /** Path to output PDF */
    outputPath: string | null;
    /** Output PDF data (if small enough) */
    outputData: Uint8Array | null;
    /** Errors encountered */
    errors: string[];
    /** Final statistics */
    stats: IProjectStats;
}
