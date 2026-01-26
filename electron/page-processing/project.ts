/**
 * Page Processing Project Types
 *
 * Defines all interfaces for the stage-based processing pipeline.
 * A processing project represents the full state of a PDF being processed,
 * including per-page parameters, global settings, and output configuration.
 */

import { randomUUID } from 'crypto';

// ============================================================================
// Stage Types
// ============================================================================

/**
 * The 6 stages of the processing pipeline, in order.
 * Users progress through stages sequentially, though they can revisit earlier stages.
 */
export type TProcessingStage =
    | 'rotation'   // Manual rotation (0, 90, 180, 270)
    | 'split'      // Split facing pages
    | 'deskew'     // Correct skew angle
    | 'dewarp'     // Remove page curvature
    | 'content'    // Detect/adjust content boundaries
    | 'margins'    // Set output margins
    | 'output';    // Final output settings

/**
 * Rotation values - only 90-degree increments are supported.
 */
export type TRotation = 0 | 90 | 180 | 270;

/**
 * Page processing status
 */
export type TPageStatus = 'pending' | 'processing' | 'complete' | 'error';

/**
 * Output source region when a page is split
 */
export type TSourceRegion = 'full' | 'left' | 'right' | 'top' | 'bottom';

// ============================================================================
// Parameter Interfaces
// ============================================================================

/**
 * Split parameters - how to divide facing pages
 */
export interface ISplitParams {
    /** Split type */
    type: 'none' | 'vertical' | 'horizontal';

    /** Split position, 0-1 normalized (0.5 = center) */
    position: number;

    /** Detection confidence, 0-1 */
    confidence: number;
}

/**
 * Deskew parameters - correct page rotation
 */
export interface IDeskewParams {
    /** Degrees to rotate (positive = clockwise) */
    angle: number;

    /** Detection confidence, 0-1 */
    confidence: number;
}

/**
 * Dewarp grid point for mesh-based perspective correction
 */
export interface IDewarpGridPoint {
    /** Original x position, 0-1 normalized */
    srcX: number;

    /** Original y position, 0-1 normalized */
    srcY: number;

    /** Corrected x position, 0-1 normalized */
    dstX: number;

    /** Corrected y position, 0-1 normalized */
    dstY: number;
}

/**
 * Dewarp parameters - remove page curvature
 */
export interface IDewarpParams {
    /** Whether dewarp is enabled for this page */
    enabled: boolean;

    /** Dewarp strength, 0-1 (0 = no correction, 1 = full correction) */
    strength: number;

    /** Curvature score detected, 0-1 (higher = more curved) */
    curvatureScore: number;

    /** Optional mesh grid for perspective correction */
    grid?: IDewarpGridPoint[];

    /** Detection confidence, 0-1 */
    confidence: number;
}

/**
 * Content rectangle - defines the content area within a page
 * All coordinates are normalized 0-1
 */
export interface IContentRect {
    /** Left edge, 0-1 normalized */
    x: number;

    /** Top edge, 0-1 normalized */
    y: number;

    /** Width, 0-1 normalized */
    width: number;

    /** Height, 0-1 normalized */
    height: number;

    /** Detection confidence, 0-1 */
    confidence: number;
}

/**
 * Margin unit type
 */
export type TMarginUnit = 'px' | 'percent' | 'mm' | 'inch';

/**
 * Margin parameters - padding around content
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

    /** Unit for all margin values */
    unit: TMarginUnit;
}

// ============================================================================
// Auto-Detection Results
// ============================================================================

/**
 * Cached auto-detection results for a page.
 * These are computed once and cached; user overrides are stored separately.
 */
export interface IAutoDetectedParams {
    /** Auto-detected rotation */
    rotation?: TRotation;

    /** Auto-detected split parameters */
    split?: ISplitParams;

    /** Auto-detected deskew parameters */
    deskew?: IDeskewParams;

    /** Auto-detected dewarp parameters */
    dewarp?: IDewarpParams;

    /** Auto-detected content rectangle */
    contentRect?: IContentRect;
}

// ============================================================================
// Output Types
// ============================================================================

/**
 * Represents a single output page (after potential splits)
 */
export interface IOutputPage {
    /** Position in final PDF (1-indexed) */
    outputIndex: number;

    /** Which region of the source page this represents */
    sourceRegion: TSourceRegion;

    /** Path to temporary processed image (during processing) */
    processedImagePath?: string;
}

/**
 * Output format options
 */
export type TOutputFormat = 'pdf' | 'images';

/**
 * Color mode for output
 */
export type TColorMode = 'color' | 'grayscale' | 'bw';

/**
 * Compression type for output
 */
export type TCompression = 'none' | 'lossless' | 'lossy';

/**
 * Output settings for final PDF/image generation
 */
export interface IOutputSettings {
    /** Output format */
    format: TOutputFormat;

    /** Output DPI */
    dpi: number;

    /** Color mode */
    colorMode: TColorMode;

    /** Compression type */
    compression: TCompression;

    /** JPEG quality (1-100), only used when compression is 'lossy' */
    jpegQuality: number;

    /** Output file path (null = prompt user) */
    outputPath: string | null;

    /** Whether to preserve bookmarks from original PDF */
    preserveBookmarks: boolean;

    /** Whether to preserve metadata from original PDF */
    preserveMetadata: boolean;
}

// ============================================================================
// Global Settings
// ============================================================================

/**
 * Global processing settings - defaults applied to all pages
 */
export interface IGlobalProcessingSettings {
    /** Default DPI for rendering pages */
    defaultDpi: number;

    /** Whether to auto-detect split (facing pages) */
    autoDetectSplit: boolean;

    /** Whether to auto-detect deskew */
    autoDetectDeskew: boolean;

    /** Whether to auto-detect dewarp */
    autoDetectDewarp: boolean;

    /** Whether to auto-detect content boundaries */
    autoDetectContent: boolean;

    /** Confidence threshold for auto-split (0-1) */
    splitThreshold: number;

    /** Minimum skew angle (degrees) to trigger auto-deskew */
    minSkewAngle: number;

    /** Minimum curvature score to trigger auto-dewarp */
    minCurvatureThreshold: number;

    /** Default margin settings */
    defaultMargins: IMarginParams;
}

// ============================================================================
// Per-Page State
// ============================================================================

/**
 * Complete processing state for a single page.
 * Stores both auto-detected values and manual overrides.
 */
export interface IPageProcessingState {
    /** Original page number in source PDF (1-indexed) */
    originalPageNumber: number;

    /**
     * Manual rotation override (null = use auto-detected or global default).
     * This is applied BEFORE other processing.
     */
    rotation: TRotation | null;

    /** Manual split override (null = use auto-detected or global default) */
    split: ISplitParams | null;

    /** Manual deskew override (null = use auto-detected or global default) */
    deskew: IDeskewParams | null;

    /** Manual dewarp override (null = use auto-detected or global default) */
    dewarp: IDewarpParams | null;

    /** Manual content rect override (null = use auto-detected or global default) */
    contentRect: IContentRect | null;

    /** Manual margin override (null = use global default) */
    margins: IMarginParams | null;

    /** Cached auto-detection results */
    autoDetected: IAutoDetectedParams;

    /** Current processing status */
    status: TPageStatus;

    /** Error message if status is 'error' */
    error?: string;

    /**
     * Output page mapping (after split, one original page may become multiple).
     * Empty array means page hasn't been processed yet.
     */
    outputPages: IOutputPage[];

    /** Whether user has explicitly locked this page's settings */
    locked: boolean;
}

// ============================================================================
// Page Mapping (for bookmark remapping)
// ============================================================================

/**
 * Page mapping for bookmark remapping after splits.
 * Maps original page numbers to output page numbers.
 */
export interface IPageMapping {
    /**
     * Original page number -> array of output page numbers.
     * Example: { 1: [1, 2], 2: [3, 4], 3: [5] }
     * means page 1 split into 2, page 2 split into 2, page 3 not split
     */
    mapping: Record<number, number[]>;

    /** Total number of output pages */
    totalOutputPages: number;
}

// ============================================================================
// Processing Project
// ============================================================================

/**
 * Complete processing project state - persisted to disk.
 */
export interface IProcessingProject {
    /** Unique project identifier */
    id: string;

    /** Schema version for migration support */
    schemaVersion: number;

    /** Path to the original PDF file */
    originalPdfPath: string;

    /** Path to the working copy we actually process */
    workingCopyPath: string;

    /** Creation timestamp (ms since epoch) */
    createdAt: number;

    /** Last modification timestamp (ms since epoch) */
    modifiedAt: number;

    /** Per-page processing state */
    pages: IPageProcessingState[];

    /** Global settings (defaults for all pages) */
    globalSettings: IGlobalProcessingSettings;

    /** Current stage in the workflow */
    currentStage: TProcessingStage;

    /** Output settings */
    outputSettings: IOutputSettings;

    /** Total number of pages in original PDF */
    totalPages: number;

    /** Project name (defaults to PDF filename) */
    name: string;

    /** Optional notes/description */
    notes?: string;
}

// ============================================================================
// Serialization Types
// ============================================================================

/**
 * Serialized project format for JSON storage.
 * Same as IProcessingProject but explicitly typed for clarity.
 */
export type TSerializedProject = IProcessingProject;

/**
 * Serialized page mapping (uses object instead of Map for JSON compatibility)
 */
export type TSerializedPageMapping = IPageMapping;

// ============================================================================
// Constants
// ============================================================================

/** Current schema version */
export const CURRENT_SCHEMA_VERSION = 1;

/** Default global processing settings */
export const DEFAULT_GLOBAL_SETTINGS: IGlobalProcessingSettings = {
    defaultDpi: 300,
    autoDetectSplit: true,
    autoDetectDeskew: true,
    autoDetectDewarp: true,
    autoDetectContent: true,
    splitThreshold: 0.7,
    minSkewAngle: 0.5,
    minCurvatureThreshold: 0.1,
    defaultMargins: {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        unit: 'px',
    },
};

/** Default output settings */
export const DEFAULT_OUTPUT_SETTINGS: IOutputSettings = {
    format: 'pdf',
    dpi: 300,
    colorMode: 'color',
    compression: 'lossy',
    jpegQuality: 85,
    outputPath: null,
    preserveBookmarks: true,
    preserveMetadata: true,
};

/** Default split params (no split) */
export const DEFAULT_SPLIT_PARAMS: ISplitParams = {
    type: 'none',
    position: 0.5,
    confidence: 0,
};

/** Default deskew params (no rotation) */
export const DEFAULT_DESKEW_PARAMS: IDeskewParams = {
    angle: 0,
    confidence: 0,
};

/** Default dewarp params (disabled) */
export const DEFAULT_DEWARP_PARAMS: IDewarpParams = {
    enabled: false,
    strength: 1.0,
    curvatureScore: 0,
    confidence: 0,
};

/** Default content rect (full page) */
export const DEFAULT_CONTENT_RECT: IContentRect = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    confidence: 0,
};

/** Default margin params (no margins) */
export const DEFAULT_MARGIN_PARAMS: IMarginParams = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    unit: 'px',
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates a new processing project with default state.
 *
 * @param originalPdfPath - Path to the original PDF file
 * @param totalPages - Total number of pages in the PDF
 * @param workingCopyPath - Path where the working copy will be stored
 * @returns New processing project
 */
export function createProject(
    originalPdfPath: string,
    totalPages: number,
    workingCopyPath: string,
): IProcessingProject {
    const now = Date.now();
    const name = originalPdfPath.split('/').pop()?.replace(/\.pdf$/i, '') ?? 'Untitled';

    return {
        id: randomUUID(),
        schemaVersion: CURRENT_SCHEMA_VERSION,
        originalPdfPath,
        workingCopyPath,
        createdAt: now,
        modifiedAt: now,
        pages: Array.from({ length: totalPages }, (_, i) => createPageState(i + 1)),
        globalSettings: { ...DEFAULT_GLOBAL_SETTINGS },
        currentStage: 'rotation',
        outputSettings: { ...DEFAULT_OUTPUT_SETTINGS },
        totalPages,
        name,
    };
}

/**
 * Creates a default page processing state.
 *
 * @param pageNumber - Original page number (1-indexed)
 * @returns New page processing state
 */
export function createPageState(pageNumber: number): IPageProcessingState {
    return {
        originalPageNumber: pageNumber,
        rotation: null,
        split: null,
        deskew: null,
        dewarp: null,
        contentRect: null,
        margins: null,
        autoDetected: {},
        status: 'pending',
        outputPages: [],
        locked: false,
    };
}

/**
 * Gets the effective rotation for a page, considering overrides and auto-detection.
 *
 * @param page - Page processing state
 * @returns Effective rotation value
 */
export function getEffectiveRotation(page: IPageProcessingState): TRotation {
    if (page.rotation !== null) {
        return page.rotation;
    }
    return page.autoDetected.rotation ?? 0;
}

/**
 * Gets the effective split params for a page, considering overrides and auto-detection.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns Effective split params
 */
export function getEffectiveSplit(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): ISplitParams {
    // Manual override takes precedence
    if (page.split !== null) {
        return page.split;
    }

    // Auto-detected value if auto-detect is enabled and meets threshold
    if (globalSettings.autoDetectSplit && page.autoDetected.split) {
        if (page.autoDetected.split.confidence >= globalSettings.splitThreshold) {
            return page.autoDetected.split;
        }
    }

    // Default: no split
    return { ...DEFAULT_SPLIT_PARAMS };
}

/**
 * Gets the effective deskew params for a page, considering overrides and auto-detection.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns Effective deskew params
 */
export function getEffectiveDeskew(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): IDeskewParams {
    // Manual override takes precedence
    if (page.deskew !== null) {
        return page.deskew;
    }

    // Auto-detected value if auto-detect is enabled and meets threshold
    if (globalSettings.autoDetectDeskew && page.autoDetected.deskew) {
        if (Math.abs(page.autoDetected.deskew.angle) >= globalSettings.minSkewAngle) {
            return page.autoDetected.deskew;
        }
    }

    // Default: no deskew
    return { ...DEFAULT_DESKEW_PARAMS };
}

/**
 * Gets the effective dewarp params for a page, considering overrides and auto-detection.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns Effective dewarp params
 */
export function getEffectiveDewarp(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): IDewarpParams {
    // Manual override takes precedence
    if (page.dewarp !== null) {
        return page.dewarp;
    }

    // Auto-detected value if auto-detect is enabled and meets threshold
    if (globalSettings.autoDetectDewarp && page.autoDetected.dewarp) {
        if (page.autoDetected.dewarp.curvatureScore >= globalSettings.minCurvatureThreshold) {
            return page.autoDetected.dewarp;
        }
    }

    // Default: no dewarp
    return { ...DEFAULT_DEWARP_PARAMS };
}

/**
 * Gets the effective content rect for a page, considering overrides and auto-detection.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns Effective content rect
 */
export function getEffectiveContentRect(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): IContentRect {
    // Manual override takes precedence
    if (page.contentRect !== null) {
        return page.contentRect;
    }

    // Auto-detected value if auto-detect is enabled
    if (globalSettings.autoDetectContent && page.autoDetected.contentRect) {
        return page.autoDetected.contentRect;
    }

    // Default: full page
    return { ...DEFAULT_CONTENT_RECT };
}

/**
 * Gets the effective margin params for a page, considering overrides and global defaults.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns Effective margin params
 */
export function getEffectiveMargins(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): IMarginParams {
    // Manual override takes precedence
    if (page.margins !== null) {
        return page.margins;
    }

    // Use global default
    return { ...globalSettings.defaultMargins };
}

/**
 * Combined type for all effective parameters for a page.
 */
export interface IEffectivePageParams {
    rotation: TRotation;
    split: ISplitParams;
    deskew: IDeskewParams;
    dewarp: IDewarpParams;
    contentRect: IContentRect;
    margins: IMarginParams;
}

/**
 * Gets all effective parameters for a page.
 *
 * @param page - Page processing state
 * @param globalSettings - Global processing settings
 * @returns All effective parameters
 */
export function getEffectiveParams(
    page: IPageProcessingState,
    globalSettings: IGlobalProcessingSettings,
): IEffectivePageParams {
    return {
        rotation: getEffectiveRotation(page),
        split: getEffectiveSplit(page, globalSettings),
        deskew: getEffectiveDeskew(page, globalSettings),
        dewarp: getEffectiveDewarp(page, globalSettings),
        contentRect: getEffectiveContentRect(page, globalSettings),
        margins: getEffectiveMargins(page, globalSettings),
    };
}

/**
 * Builds a page mapping from processed pages.
 * This is used for bookmark remapping when pages are split.
 *
 * @param pages - Array of page processing states
 * @returns Page mapping for bookmark remapping
 */
export function buildPageMapping(pages: IPageProcessingState[]): IPageMapping {
    const mapping: Record<number, number[]> = {};
    let outputIndex = 1;

    for (const page of pages) {
        const outputPages: number[] = [];

        if (page.outputPages.length === 0) {
            // Page hasn't been processed yet, assume 1:1 mapping
            outputPages.push(outputIndex++);
        }
        else {
            // Use actual output pages
            for (const _outputPage of page.outputPages) {
                outputPages.push(outputIndex++);
            }
        }

        mapping[page.originalPageNumber] = outputPages;
    }

    return {
        mapping,
        totalOutputPages: outputIndex - 1,
    };
}

/**
 * Calculates the output page number for a bookmark pointing to an original page.
 * When a page is split, bookmarks point to the first output page.
 *
 * @param pageMapping - Page mapping from buildPageMapping
 * @param originalPageNumber - Original page number (1-indexed)
 * @returns Output page number (1-indexed), or 1 if not found
 */
export function remapBookmarkPage(pageMapping: IPageMapping, originalPageNumber: number): number {
    const outputPages = pageMapping.mapping[originalPageNumber];
    if (outputPages && outputPages.length > 0) {
        const firstPage = outputPages[0];
        return firstPage !== undefined ? firstPage : 1;
    }
    // Fallback to page 1 if mapping not found
    return 1;
}

/**
 * Checks if a page has any manual overrides.
 *
 * @param page - Page processing state
 * @returns True if page has any manual overrides
 */
export function hasOverrides(page: IPageProcessingState): boolean {
    return (
        page.rotation !== null
        || page.split !== null
        || page.deskew !== null
        || page.dewarp !== null
        || page.contentRect !== null
        || page.margins !== null
    );
}

/**
 * Clears all manual overrides for a page, reverting to auto-detected/global defaults.
 *
 * @param page - Page processing state (mutated in place)
 */
export function clearOverrides(page: IPageProcessingState): void {
    page.rotation = null;
    page.split = null;
    page.deskew = null;
    page.dewarp = null;
    page.contentRect = null;
    page.margins = null;
    page.locked = false;
}

/**
 * Updates the project's modification timestamp.
 *
 * @param project - Processing project (mutated in place)
 */
export function touchProject(project: IProcessingProject): void {
    project.modifiedAt = Date.now();
}

/**
 * Gets the count of pages that will be output (accounting for splits).
 *
 * @param pages - Array of page processing states
 * @param globalSettings - Global processing settings
 * @returns Estimated output page count
 */
export function getEstimatedOutputPageCount(
    pages: IPageProcessingState[],
    globalSettings: IGlobalProcessingSettings,
): number {
    let count = 0;

    for (const page of pages) {
        const split = getEffectiveSplit(page, globalSettings);
        if (split.type !== 'none') {
            count += 2; // Split pages produce 2 outputs
        }
        else {
            count += 1;
        }
    }

    return count;
}

/**
 * Validates a processing project structure.
 *
 * @param project - Project to validate
 * @returns Array of validation error messages (empty if valid)
 */
export function validateProject(project: IProcessingProject): string[] {
    const errors: string[] = [];

    if (!project.id) {
        errors.push('Project ID is required');
    }

    if (!project.originalPdfPath) {
        errors.push('Original PDF path is required');
    }

    if (!project.workingCopyPath) {
        errors.push('Working copy path is required');
    }

    if (project.totalPages < 1) {
        errors.push('Total pages must be at least 1');
    }

    if (project.pages.length !== project.totalPages) {
        errors.push(`Page count mismatch: ${project.pages.length} pages but totalPages is ${project.totalPages}`);
    }

    for (let i = 0; i < project.pages.length; i++) {
        const page = project.pages[i]!;
        if (page.originalPageNumber !== i + 1) {
            errors.push(`Page ${i} has incorrect originalPageNumber: ${page.originalPageNumber}, expected ${i + 1}`);
        }
    }

    const validStages: TProcessingStage[] = [
        'rotation',
        'split',
        'deskew',
        'dewarp',
        'content',
        'margins',
        'output',
    ];
    if (!validStages.includes(project.currentStage)) {
        errors.push(`Invalid current stage: ${project.currentStage}`);
    }

    return errors;
}

/**
 * Serializes a project for JSON storage.
 *
 * @param project - Project to serialize
 * @returns Serialized project (JSON-safe)
 */
export function serializeProject(project: IProcessingProject): TSerializedProject {
    // IProcessingProject is already JSON-safe (no Maps, Sets, or circular refs)
    return JSON.parse(JSON.stringify(project));
}

/**
 * Deserializes a project from JSON storage.
 *
 * @param data - Serialized project data
 * @returns Deserialized project
 * @throws Error if data is invalid
 */
export function deserializeProject(data: unknown): IProcessingProject {
    if (!data || typeof data !== 'object') {
        throw new Error('Invalid project data: expected object');
    }

    const project = data as IProcessingProject;
    const errors = validateProject(project);

    if (errors.length > 0) {
        throw new Error(`Invalid project data: ${errors.join(', ')}`);
    }

    return project;
}

/**
 * Migrates a project from an older schema version.
 *
 * @param project - Project to migrate
 * @returns Migrated project
 */
export function migrateProject(project: IProcessingProject): IProcessingProject {
    // Currently only version 1 exists, so no migrations needed
    if (project.schemaVersion === CURRENT_SCHEMA_VERSION) {
        return project;
    }

    // Future migrations would go here
    // if (project.schemaVersion === 1) {
    //     // Migrate from v1 to v2
    //     project = migrateV1ToV2(project);
    // }

    project.schemaVersion = CURRENT_SCHEMA_VERSION;
    return project;
}

// ============================================================================
// IPC Request/Response Types
// ============================================================================

/**
 * Request to create a new processing project.
 */
export interface ICreateProjectRequest {
    /** Path to the original PDF file */
    pdfPath: string;

    /** Optional path to a working copy */
    workingCopyPath?: string;

    /** Number of pages in the PDF (for pre-initialization) */
    pageCount?: number;

    /** Optional custom global settings */
    globalSettings?: Partial<IGlobalProcessingSettings>;

    /** Optional custom output settings */
    outputSettings?: Partial<IOutputSettings>;
}

/**
 * Result of creating a processing project.
 */
export interface ICreateProjectResult {
    success: boolean;
    projectId?: string;
    projectDir?: string;
    error?: string;
}

/**
 * Result of loading a processing project.
 */
export interface ILoadProjectResult {
    success: boolean;
    project?: IProcessingProject;
    error?: string;
}

/**
 * Result of saving a processing project.
 */
export interface ISaveProjectResult {
    success: boolean;
    error?: string;
}

/**
 * Request to run a processing stage.
 */
export interface IRunStageRequest {
    /** Project ID */
    projectId: string;

    /** Stage to run */
    stage: TProcessingStage;

    /** Optional list of page numbers to process (1-indexed). If not provided, processes all pages. */
    pages?: number[];

    /** Optional parameters for the stage */
    params?: Record<string, unknown>;
}

/**
 * Result of running a processing stage.
 */
export interface IRunStageResult {
    success: boolean;
    jobId: string;
    error?: string;
    results?: Array<{
        pageNumber: number;
        detected?: Record<string, unknown>;
        errors?: string[];
    }>;
}

/**
 * Request to generate a stage preview.
 */
export interface IPreviewStageRequest {
    /** Project ID */
    projectId: string;

    /** Stage to preview */
    stage: TProcessingStage;

    /** Page number to preview (1-indexed) */
    pageNumber: number;

    /** Optional parameters for the preview */
    params?: Record<string, unknown>;
}

/**
 * Result of generating a stage preview.
 */
export interface IPreviewStageResult {
    success: boolean;
    previewPath?: string;
    cached?: boolean;
    error?: string;
}

/**
 * Request to generate final output.
 */
export interface IGenerateOutputRequest {
    /** Project ID */
    projectId: string;

    /** Optional output path (overrides project settings) */
    outputPath?: string;

    /** Optional list of pages to include (1-indexed). If not provided, includes all pages. */
    pages?: number[];
}

/**
 * Result of generating final output.
 */
export interface IGenerateOutputResult {
    success: boolean;
    jobId: string;
    outputPath?: string;
    error?: string;
    stats?: {
        totalPagesInput: number;
        totalPagesOutput: number;
        processingTimeMs: number;
    };
}

/**
 * Result of getting project status.
 */
export interface IProjectStatusResult {
    success: boolean;
    status?: 'idle' | 'processing' | 'error' | 'complete';
    currentStage?: TProcessingStage;
    stats?: {
        totalPages: number;
        completedStages: number;
        totalStages: number;
        warnings: number;
    };
    error?: string;
}

/**
 * Progress update for stage processing.
 */
export interface IStageProgress {
    jobId: string;
    projectId: string;
    stage: TProcessingStage;
    currentPage: number;
    totalPages: number;
    percentage: number;
    message: string;
    phase?: 'detect' | 'apply' | 'output';
}
