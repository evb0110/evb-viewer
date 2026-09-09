import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    open,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {
    createPdfPageSizeStore,
    readPdfPageSizes,
} from '@electron/pdf/pdfPageSizes';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/features/ocr/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {createScanCleanupRasterBatchRenderer} from '@electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyBackingMetadata,
} from '@electron/file-access/workingCopyStore';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {createLogger} from '@electron/utils/createLogger';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {resolveNativePdfImageCombinePath} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
} from '@evb/scan-cleanup/adapters/extractPdfMrcLayers';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {readAvailableScratchBytes} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createScanCleanupDocumentRasterPages} from '@evb/scan-cleanup/core/detection';
import type {
    IScanCleanupDetectionRequest,
    IScanCleanupPreviewRequest,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupPreviewDependencies} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
    type IScanCleanupRasterAdmissionPolicy,
    resolveScanCleanupPreviewRasterAdmissionPolicy,
    resolveScanCleanupPreviewPath,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
const logger = createLogger('scan-cleanup-preview-defaults');
function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {
            code: 'MAIN_SCAN_CLEANUP_FAILED',
            context: {},
        });
        return;
    }
    logger[level](message);
}

const fileSystem = {
    copyFile,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir: async (path: string, options: {withFileTypes: true}) => readdir(path, options),
    rm,
    stat,
    writeFile,
};

export const defaultDependencies: IScanCleanupPreviewDependencies = {
    fileSystem,
    readFile,
    open,
    stat,
    getAvailableScratchBytes: readAvailableScratchBytes,
    resolveRasterAdmissionPolicy: supportsRasterStreaming => resolveScanCleanupPreviewRasterAdmissionPolicy(
        mainJobBroker.getSnapshot().capacity,
        supportsRasterStreaming,
    ),
    getPageCount: getPdfPageCount,
    getPageSizes: readPdfPageSizes,
    getPageSizeStore: createPdfPageSizeStore,
    publishRaster: atomicReplace,
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    renderPageBatch: createScanCleanupRasterBatchRenderer(undefined, {
        ...fileSystem,
        rename,
    }),
    createRasterPipes: async (paths, signal, log) => {
        await runNativeToolCommand('mkfifo', [...paths], {
            signal,
            commandLabel: 'mkfifo(scan-cleanup-detection-streams)',
            log,
        });
    },
    runSidecar: runScanCleanupSidecar,
    resolveBinary: resolveScanCleanupPreviewPath,
    resolvePageOpsBinary: () => (isNativePageOpsDisabled() ? null : resolveNativePageOpsPath()),
    resolveQpdfBinary: () => getPdfNativeToolPaths().qpdf,
    resolvePdfInfoBinary: () => getPdfNativeToolPaths().pdfinfo,
    getTempDir: getAppTempDir,
    getPdftoppmBinary: () => getPdfNativeToolPaths().pdftoppm,
    detectSourceDpi: async (sourcePdfPath, pageNumber, signal) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(sourcePdfPath, paths.pdfimages, logScanCleanupMessage, undefined, signal, [pageNumber]);
        return result.pageDpiByNumber.get(pageNumber) ?? null;
    },
    detectRasterPages: async (sourcePdfPath, signal, pageNumbers) => {
        const paths = getPdfNativeToolPaths();
        const result = await detectSourceDpiDetails(sourcePdfPath, paths.pdfimages, logScanCleanupMessage, undefined, signal, pageNumbers);
        return createScanCleanupDocumentRasterPages(paths.pdfimages !== undefined, result.pageRasterByNumber);
    },
    isRasterDetectionAvailable: () => getPdfNativeToolPaths().pdfimages !== undefined,
    extractMrcLayers: async (sourcePdfPath, pageNumber, selectionMaskOutputPath, backgroundOutputPath, signal, log) => {
        const paths = getPdfNativeToolPaths();
        const pdfImageCombineBinary = resolveNativePdfImageCombinePath();
        if (pdfImageCombineBinary !== null) {
            const extracted = await extractPdfMrcLayersBatch({
                pdfPath: sourcePdfPath,
                targets: [{
                    pageNumber,
                    selectionMaskOutputPath: `${selectionMaskOutputPath}.jb2e`,
                    backgroundOutputPath: `${backgroundOutputPath}.ppm`,
                    foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
                }],
                pdfimagesBinary: paths.pdfimages,
                qpdfBinary: paths.qpdf,
                pdfImageCombineBinary,
                pdftoppmBinary: paths.pdftoppm,
                runCommand: runNativeToolCommand,
                log,
                rasterConcurrency: 1,
                signal,
            });
            return extracted.get(pageNumber) ?? null;
        }
        return extractPdfMrcLayers({
            pdfPath: sourcePdfPath,
            pageNumber,
            selectionMaskOutputPath,
            backgroundOutputPath,
            foregroundOutputPath: `${backgroundOutputPath}.foreground.jp2`,
            pdfimagesBinary: paths.pdfimages,
            runCommand: runNativeToolCommand,
            log,
            signal,
        });
    },
    acquireDetectionLease: (ownerId, signal, rasterPolicy: IScanCleanupRasterAdmissionPolicy) => mainJobBroker.acquire({
        ownerId,
        kind: 'scan-cleanup-detect-all',
        priority: 'user',
        resources: {
            cpuTokens: rasterPolicy.rasterConcurrency,
            estimatedResidentBytes: rasterPolicy.rasterConcurrency
                * SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
            nativeProcesses: rasterPolicy.rasterConcurrency + Number(rasterPolicy.rasterStreaming),
            ioWeight: 2,
        },
        perOwnerLimit: 1,
        signal,
    }),
    acquirePreviewLease: (ownerId, visibility, signal) => mainJobBroker.acquire({
        ownerId,
        kind: 'scan-cleanup-preview',
        priority: visibility === 'prefetch' ? 'background' : 'visible',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: SCAN_CLEANUP_PREVIEW_RASTER_SLOT_RESIDENT_BYTES,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal,
    }),
    getSourceStatIdentity: async sourcePdfPath => {
        const sourceStat = await stat(sourcePdfPath, {bigint: true});
        return `${sourceStat.size}:${sourceStat.mtimeNs}`;
    },
    materializeWorkingCopy: (logicalRef, options) => {
        if (
            !getWorkingCopyBackingEntry(logicalRef, options.ownerWebContentsId)
            && getWorkingCopyBackingMetadata(logicalRef, options.ownerWebContentsId)?.retired === true
        ) {
            return Promise.reject(new DOMException('Scan cleanup source is no longer available', 'AbortError'));
        }
        return ensureWorkingCopyMaterialized(logicalRef, options);
    },
    materializeRequest: materializeScanCleanupPreviewRequest,
};

export async function materializeScanCleanupPreviewRequest<T extends IScanCleanupPreviewRequest | IScanCleanupDetectionRequest>(
    request: T,
    senderId: number,
    signal: AbortSignal,
    dependencies: Pick<IScanCleanupPreviewDependencies, 'materializeWorkingCopy'>,
): Promise<T> {
    signal.throwIfAborted();
    const materialized = await dependencies.materializeWorkingCopy(request.sourcePdfPath, {
        ownerWebContentsId: senderId,
        reason: 'scan-cleanup',
        signal,
    });
    return {
        ...request,
        sourcePdfPath: materialized.physicalWorkingCopyPath,
    };
}
