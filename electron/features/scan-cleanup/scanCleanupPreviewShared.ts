import type {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    rm,
    stat,
    writeFile,
} from 'fs/promises';


import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
    TScanCleanupDetectionJobState,
    TScanCleanupOutputMode,
} from '@contracts/electronApiScanCleanup';

import type { TNativeScanCleanupPreviewOutputArtifactMetadataV3 } from '@contracts/scan-cleanup/nativeArtifactCodecs';

import {scanCleanupLayoutSignature} from '@contracts/scanCleanupPageOverrides';
import type { getPdfPageCount } from '@electron/pdf/pdfPageCount';
import type {
    createPdfPageSizeStore,
    readPdfPageSizes,
    IPdfPageSize,
    IPdfPageSizeStore,
} from '@electron/pdf/pdfPageSizes';
import type {IScanCleanupDocumentRasterPages} from '@evb/scan-cleanup/core/detection';

import type {IScanCleanupDocumentCanvasAccumulator} from '@evb/scan-cleanup/core/policy/documentCanvas';

import type { atomicReplace } from '@electron/utils/atomicReplace';
import type {
    renderPdfPageToPng,
    renderPdfPageToPpm,
    TWorkerLog,
} from '@electron/features/ocr/publicNative';
import type {createScanCleanupRasterBatchRenderer} from '@electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer';

import type {
    IScanCleanupJobErrorEnvelope,
    IScanCleanupRasterAdmissionPolicy,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';





import type {
    IPdfMrcLayers,
    IScanCleanupDetectionResultStore,
    IScanCleanupPageRasterSource,
    TScanCleanupRunSidecar,
} from '@evb/scan-cleanup/core/types';


import type {
    IMainJobScratch,
    IMainJobSender,
    TMainJobSnapshot,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import type { ensureWorkingCopyMaterialized } from '@electron/file-access/workingCopyMaterialization';



export const PAGE_SIZE_COMPATIBILITY_CHUNK_PAGES = 1_024;

/** Stable identity for two equivalent preview requests. */
export function previewIdentityKey(request: Omit<IScanCleanupPreviewRequest, 'detail'>) {
    return JSON.stringify({
        sourcePdfPath: request.sourcePdfPath,
        documentRevision: request.documentRevision,
        pageNumber: request.pageNumber,
        options: request.options,
        documentPrior: request.documentPrior ?? null,
        outputModeRecommendation: request.outputModeRecommendation ?? null,
        softAlphaForegroundRecommendation: request.softAlphaForegroundRecommendation ?? null,
        pagePlanEvidence: request.pagePlanEvidence ?? null,
        placementAnchors: request.placementAnchors ?? null,
        layoutDetectionComplete: request.options.matchPageSize
            ? request.layoutDetectionComplete === true
            : false,
        layouts: request.options.matchPageSize
            ? scanCleanupLayoutSignature(request.layoutByPage ?? {})
            : '',
    });
}

export interface IRetainedDocument {
    dir: Promise<string>;
    documentRevision: string;
    // Aborted when the document is discarded. Every measurement of this
    // document runs under it, so closing the session stops the native work
    // nobody is waiting for any more, without any one caller's cancellation
    // reaching work the others share.
    lifetime: AbortController;
    // Byte size and nanosecond mtime of the source file at admission. An
    // equal-millisecond replacement of the file must not serve rasters
    // rendered from the bytes it replaced.
    sourceStatIdentity: string;
    pageCount: Promise<number> | null;
    // One bounded page-geometry source is shared by every preview and
    // detection consumer. Cursor-capable stores hand out forked views while
    // retention keeps the source lifetime on the document.
    pageSizeStore: Promise<IPdfPageSizeStore> | null;
    // Legacy preview compatibility keeps its injected page-size array here.
    // Production detection and preview geometry use pageSizeStore instead, so
    // a retained document never allocates one record per source page.
    previewPageSizes: Promise<IPdfPageSize[]> | null;
    // Source DPI is a page fact, not a request fact. Keep one native probe per
    // page for this retained document, just like pageCount and preview geometry.
    sourceDpiByPage: Map<number, Promise<number | null>>;
    // Which pages carry a raster of their own, and whether that could be
    // detected at all. A matched lossless run has to re-render a document whose
    // rasters would otherwise sit on the shared sheet at two resolutions, so a
    // preview that promises lossless needs the same answer the run will reach.
    rasterPages: Promise<IScanCleanupDocumentRasterPages> | null;
    // Detection uses this bounded accessor. It is deliberately separate from
    // the legacy aggregate kept by preview compatibility paths.
    rasterPageSource: Promise<IScanCleanupPageRasterSource> | null;
    rasterPageSourceStore: IPdfPageSizeStore | null;
    // Page geometry can carry the only bounded DPI evidence available before
    // pdfimages has visited a page. Keep that evidence as one scalar so the
    // raster source can expose it without retaining a page-indexed map.
    pageGeometryDpi: number | null;
    // Core owns the detection loop, so retention owns every store it asks us
    // to open and closes them when the retained document leaves the cache.
    // Keeping this set small is also what makes repeated direct reads safe.
    pageSizeStores: Set<IPdfPageSizeStore>;
    // Ordinary previews need only the requested page's raster facts. The
    // whole-document result remains separate and lazy for matched lossless
    // decisions.
    rasterPageByPage: Map<number, Promise<IScanCleanupDocumentRasterPages>>;
    // Sender ownership survives a released preview claim while the document
    // remains in the bounded retention cache, so renderer death can evict the
    // cache entry even after its last active job settled.
    rendererOwners: Set<number>;
    pinned: number;
    claims: Map<string, number>;
    removeWhenIdle: boolean;
    sourcePdfPath: string;
}

export interface IRetainedRawRaster {
    document: IRetainedDocument;
    dpi: number;
    height: number;
    pageNumber: number;
    path: string;
    sizeBytes: number;
    width: number;
}

export interface IScanCleanupRasterRetention {
    openDocument(
        request: Pick<IScanCleanupPreviewRequest, 'sourcePdfPath' | 'documentRevision'>,
        claimId?: string,
    ): Promise<IRetainedDocument>;
    pageCount(document: IRetainedDocument, signal: AbortSignal): Promise<number>;
    previewPageSizes(document: IRetainedDocument, signal: AbortSignal): Promise<IPdfPageSize[]>;
    pageSizeStore(document: IRetainedDocument, signal: AbortSignal): Promise<IPdfPageSizeStore>;
    sourceDpi(document: IRetainedDocument, pageNumber: number, signal: AbortSignal): Promise<number | null>;
    previewRasterPages(document: IRetainedDocument, signal: AbortSignal): Promise<IScanCleanupDocumentRasterPages>;
    rasterPageSource(document: IRetainedDocument, signal: AbortSignal): Promise<IScanCleanupPageRasterSource>;
    rasterPage(
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
    ): Promise<IScanCleanupDocumentRasterPages>;
    rasterScratchPath(document: IRetainedDocument, pageNumber: number, dpi: number): Promise<string>;
    stagedRasterPath(document: IRetainedDocument, pageNumber: number, dpi: number): Promise<string>;
    releaseRaster(
        document: IRetainedDocument,
        pageNumber: number,
        dpi: number,
        claimId?: string,
    ): Promise<void>;
    claimRaster(document: IRetainedDocument, pageNumber: number, dpi: number, claimId: string): boolean;
    retainedPaths(
        document: IRetainedDocument,
        pageNumbers: readonly number[],
        dpi: number,
    ): Promise<Map<number, IRetainedRawRaster>>;
    read(
        document: IRetainedDocument,
        pageNumber: number,
        dpi: number,
    ): Promise<{
        bytes: Uint8Array;
        raster: IRetainedRawRaster
    } | null>;
    readPath(document: IRetainedDocument, pageNumber: number, dpi: number): Promise<IRetainedRawRaster | null>;
    materializeRawRaster(
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
        dependencies: IScanCleanupRasterDependencies,
        knownTotalPages?: number,
        dpi?: number,
        pageSize?: IPdfPageSize,
        claimId?: string,
    ): Promise<IRawPreview>;
    materializeRawRasterPath(
        document: IRetainedDocument,
        pageNumber: number,
        signal: AbortSignal,
        dependencies: IScanCleanupRasterDependencies,
        knownTotalPages?: number,
        dpi?: number,
        pageSize?: IPdfPageSize,
        claimId?: string,
    ): Promise<IRetainedRawRaster>;
    retain(
        rendered: Omit<IRetainedRawRaster, 'path'> & {scratchPath: string},
        claimId?: string,
    ): Promise<IRetainedRawRaster>;
    remove(path: string): void;
    release(document: IRetainedDocument, claimId?: string): Promise<void>;
    invalidate(sourcePdfPath: string, documentRevision: string, claimId?: string): void;
    invalidateSender(senderId: number): void;
    dispose(): Promise<void>;
}

export interface IScanCleanupRenderingRetention extends Pick<IScanCleanupRasterRetention,
    | 'openDocument'
    | 'pageCount'
    | 'previewPageSizes'
    | 'pageSizeStore'
    | 'sourceDpi'
    | 'previewRasterPages'
    | 'rasterPageSource'
    | 'rasterPage'
    | 'materializeRawRaster'
    | 'materializeRawRasterPath'
    | 'claimRaster'
    | 'releaseRaster'
    | 'release'> {}

export interface IRawPreview extends IRetainedRawRaster {
    bytes: Uint8Array;
    totalPages: number;
}

export type INativePreviewOutputMetadata = TNativeScanCleanupPreviewOutputArtifactMetadataV3;

export interface IBasePreviewAnalysis {
    sourcePdfPath: string;
    documentRevision: string;
    sourceStatIdentity: string;
    outputMode?: TScanCleanupOutputMode;
    pageMetadata: IScanCleanupPreviewResult['pageMetadata'];
    outputs: Partial<Record<IScanCleanupPreviewMetadata['half'], INativePreviewOutputMetadata>>;
    analysisDirectory: string;
    canonicalRasterPaths: Partial<Record<IScanCleanupPreviewMetadata['half'], string>>;
    baseMetadataPaths: Partial<Record<IScanCleanupPreviewMetadata['half'], string>>;
    canonicalRasterBytes: number;
    baseRenderDpi: number;
}

// A run's admission is mutable for as long as it is still waiting for one: a
// prefetch the user navigates onto becomes the visible page and must be
// readmitted as one, because the reservation a background run asks for can be
// ungrantable for as long as detection holds the machine.
export interface IPreviewAdmission {
    granted: boolean;
    reissue: (() => void) | null;
    visibility: TPreviewVisibility;
}

export interface IPreviewEntry {
    admission: IPreviewAdmission;
    canceledAsResult: boolean;
    signal: AbortSignal;
    cancel: (reason?: string) => boolean;
    generation: number;
    pageNumber: number;
    claimId: string;
    sourcePdfPath?: string;
    tail: Promise<TScanCleanupPreviewWireResult>;
}


export interface IBoundedPreviewGeometry {
    accumulator: IScanCleanupDocumentCanvasAccumulator;
    pageSize: IPdfPageSize | undefined;
    previewDpi: number;
    pageSourceDpi: number | undefined;
}
export interface IDetectionResult {
    results: TScanCleanupDetectionJobState['results'];
    resultStore: IScanCleanupDetectionResultStore;
    resultStoreId?: string;
    placementAnchorSummary?: TScanCleanupDetectionJobState['placementAnchorSummary'];
}

export type TDetectionError = IScanCleanupJobErrorEnvelope;
export type TDetectionSnapshot = TMainJobSnapshot<TScanCleanupDetectionJobState, IDetectionResult, TDetectionError>;
export interface IScanCleanupDetectionSubscriber extends IMainJobSender {id: number;}

export type TPreviewVisibility = 'visible' | 'detail' | 'prefetch';
export interface IScanCleanupReadFile {
    (path: string): Promise<Uint8Array>;
    (path: string, encoding: 'utf8'): Promise<string>;
}

export interface IScanCleanupFileSystem {
    copyFile: typeof copyFile;
    mkdir: typeof mkdir;
    mkdtemp: typeof mkdtemp;
    open: typeof open;
    readFile: IScanCleanupReadFile;
    readdir: (
        path: string,
        options: {withFileTypes: true},
    ) => Promise<ReadonlyArray<{
        isFile: () => boolean;
        name: string;
    }>>;
    rm: typeof rm;
    stat: typeof stat;
    writeFile: typeof writeFile;
}

export interface IScanCleanupPreviewDependencies {
    mainJobScratch?: IMainJobScratch;
    nativeAllowedPathRoot?: string;
    readFile?: IScanCleanupReadFile;
    stat?: typeof stat;
    open?: typeof open;
    getAvailableScratchBytes?: (directory: string) => Promise<number | null>;
    resolveRasterAdmissionPolicy: (
        supportsRasterStreaming: boolean,
    ) => IScanCleanupRasterAdmissionPolicy;
    getPageCount: typeof getPdfPageCount;
    getPageSizes: typeof readPdfPageSizes;
    /** Native-backed bounded geometry reader used by production detection. */
    getPageSizeStore?: (
        pdfPath: Parameters<typeof createPdfPageSizeStore>[0],
        options: Parameters<typeof createPdfPageSizeStore>[1],
    ) => IPdfPageSizeStore | Promise<IPdfPageSizeStore>;
    prefetchLeaseTimeoutMs?: number;
    publishRaster: typeof atomicReplace;
    renderPage: typeof renderPdfPageToPng;
    renderPagePpm: typeof renderPdfPageToPpm;
    renderPageBatch?: ReturnType<typeof createScanCleanupRasterBatchRenderer>;
    createRasterPipes?: (
        paths: readonly string[],
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<void>;
    runSidecar: TScanCleanupRunSidecar;
    resolveBinary: () => string | null;
    resolvePageOpsBinary: () => string | null;
    resolveQpdfBinary?: () => string;
    resolvePdfInfoBinary?: () => string | undefined;
    getTempDir: () => string;
    getPdftoppmBinary: () => string;
    detectSourceDpi?: (sourcePdfPath: string, pageNumber: number, signal: AbortSignal) => Promise<number | null>;
    detectRasterPages?: (
        sourcePdfPath: string,
        signal: AbortSignal,
        pageNumbers?: readonly number[],
    ) => Promise<IScanCleanupDocumentRasterPages>;
    /** Whether bounded pdfimages probes can distinguish raster from vector pages. */
    isRasterDetectionAvailable?: () => boolean;
    extractMrcLayers?: (
        sourcePdfPath: string,
        pageNumber: number,
        selectionMaskOutputPath: string,
        backgroundOutputPath: string,
        signal: AbortSignal,
        log: TWorkerLog,
    ) => Promise<IPdfMrcLayers | null>;
    acquireDetectionLease?: (
        jobId: string,
        signal: AbortSignal,
        rasterPolicy: IScanCleanupRasterAdmissionPolicy,
    ) => Promise<{release: () => boolean}>;
    acquirePreviewLease?: (
        ownerId: string,
        visibility: TPreviewVisibility,
        signal: AbortSignal,
    ) => Promise<{release: () => boolean}>;
    getSourceStatIdentity?: (sourcePdfPath: string) => Promise<string>;
    materializeWorkingCopy: typeof ensureWorkingCopyMaterialized;
    materializeRequest: <T extends IScanCleanupPreviewRequest | IScanCleanupDetectionRequest>(
        request: T,
        senderId: number,
        signal: AbortSignal,
        dependencies: Pick<IScanCleanupPreviewDependencies, 'materializeWorkingCopy'>,
    ) => Promise<T>;
    fileSystem?: IScanCleanupFileSystem;
}

export type IScanCleanupRasterDependencies = Pick<IScanCleanupPreviewDependencies,
    | 'getPageCount' | 'getPageSizes' | 'getPageSizeStore' | 'publishRaster' | 'readFile'
    | 'stat' | 'open'
    | 'renderPage' | 'resolvePageOpsBinary' | 'resolvePdfInfoBinary'
    | 'getTempDir' | 'getPdftoppmBinary' | 'detectSourceDpi' | 'getAvailableScratchBytes'
    | 'detectRasterPages' | 'isRasterDetectionAvailable' | 'getSourceStatIdentity' | 'fileSystem'
    | 'resolveQpdfBinary'>;

export type IScanCleanupDetectionOwnerDependencies = Pick<IScanCleanupPreviewDependencies,
    | 'acquireDetectionLease' | 'createRasterPipes' | 'getPdftoppmBinary' | 'fileSystem' | 'resolveRasterAdmissionPolicy'
    | 'getTempDir' | 'renderPage' | 'renderPagePpm' | 'renderPageBatch' | 'getAvailableScratchBytes'
    | 'resolveBinary' | 'runSidecar' | 'materializeWorkingCopy' | 'materializeRequest'>;

export type IScanCleanupDetectionRetentionView = Pick<IScanCleanupRasterRetention,
    | 'openDocument' | 'pageCount' | 'pageSizeStore' | 'rasterPageSource'
    | 'retainedPaths' | 'claimRaster' | 'rasterScratchPath' | 'stagedRasterPath'
    | 'retain' | 'releaseRaster' | 'release' | 'invalidateSender'>;

export type IScanCleanupPreviewOwnerRetention = IScanCleanupRenderingRetention & Pick<
    IScanCleanupRasterRetention,
    'invalidate' | 'invalidateSender'
>;

export type IScanCleanupRenderingDependencies = Pick<IScanCleanupPreviewDependencies,
    | 'acquirePreviewLease' | 'prefetchLeaseTimeoutMs' | 'extractMrcLayers' | 'mainJobScratch'
    | 'getPageSizeStore' | 'getTempDir' | 'resolveBinary' | 'runSidecar'
    | 'getPdftoppmBinary' | 'renderPage' | 'renderPagePpm' | 'getPageCount'
    | 'getPageSizes' | 'publishRaster' | 'resolvePageOpsBinary'
    | 'resolvePdfInfoBinary' | 'detectSourceDpi' | 'detectRasterPages'
    | 'isRasterDetectionAvailable' | 'getSourceStatIdentity' | 'materializeWorkingCopy' | 'materializeRequest' | 'readFile'
    | 'stat' | 'getAvailableScratchBytes' | 'fileSystem'> & {nativeAllowedPathRoot?: string;};

// Turning a page cancels the render of the page being left. That is the normal
// course of a session, not a failure, so it answers the invoke instead of
// rejecting it: a rejected invoke is logged by Electron as a handler error and
// would bury the failures worth reading.
export function isPreviewCancellation(error: unknown) {
    return error instanceof Error
        && (error.name === 'AbortError'
            || (error as {code?: unknown}).code === 'WORKING_COPY_MATERIALIZATION_CANCELLED');
}

// Detection and preview render the same page at the same DPI with the same
// arguments, so a rendered raster is kept in a document-scoped directory keyed
// by the source path, the document revision and the source byte-size and
// nanosecond-mtime snapshot, and whoever asks for that page next reads the
// file instead of spawning pdftoppm again.
// The directory holds paths and dimensions only: the bytes are read on demand
// and never held, and the retained footprint is bounded by the same scratch
// budget the final-run pipeline spends through resolveRasterHandoff.
// Exported because this is the object detection's bounded window drives as its
// retention: its ownership rules are a contract between the two and are pinned
// directly rather than through whichever window happens to exercise them.
