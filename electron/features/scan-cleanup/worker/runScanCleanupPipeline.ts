import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {
    extractPdfMrcLayers,
    extractPdfMrcLayersBatch,
} from '@evb/scan-cleanup/adapters/extractPdfMrcLayers';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/features/ocr/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import type {TWorkerLog} from '@electron/ocr/worker/types';
import {
    requirePublishedRaster,
    runScanCleanupSidecar,
} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {readAvailableScratchBytes} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scanCleanupPageOverrides';
import {
    runScanCleanupConversion,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/runScanCleanupConversion';

const defaultDependencies: IRunScanCleanupPipelineDependencies = {
    getPageCount: getPdfPageCount,
    getPageSizeStore: (pdfPath, options) => createPdfPageSizeStore(pdfPath, options),
    detectSourceDpi: detectSourceDpiDetails,
    createRasterPipes: async (paths, signal, log) => {
        await runNativeToolCommand('mkfifo', [...paths], {
            signal,
            commandLabel: 'mkfifo(scan-cleanup-raster-streams)',
            log,
        });
    },
    renderPage: renderPdfPageToPng,
    renderPagePpm: renderPdfPageToPpm,
    runSidecar: runScanCleanupSidecar,
    runCommand: runNativeToolCommand,
    getAvailableScratchBytes: readAvailableScratchBytes,
    extractMrcLayers: extractPdfMrcLayers,
    extractMrcLayersBatch: extractPdfMrcLayersBatch,
    requirePublishedRaster,
};

export async function runScanCleanupPipeline(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    policy: IScanCleanupRuntimePolicy,
    log: TWorkerLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies = defaultDependencies,
): Promise<TScanCleanupSummary> {
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    return runScanCleanupConversion(
        request,
        paths,
        signal,
        onProgress,
        policy,
        log,
        dependencies,
    );
}

export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';
