import {
    dirname,
    join,
} from 'node:path';
import type {
    TScanCleanupProgress,
    TScanCleanupSummary,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
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
    type TWorkerLog,
} from '@electron/features/ocr/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    requirePublishedRaster,
    runScanCleanupSidecar,
} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {readAvailableScratchBytes} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {createPdfPageSizeStore} from '@evb/scan-cleanup/core/pdfPageSizes';
import {attachScanCleanupPageOverrideDefaults} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {runtimeConfig} from '@electron/runtimeConfig';
import {isScanCleanupRunReportFile} from '@evb/scan-cleanup/core/preserveScanCleanupJsonEvidence';
import {
    runScanCleanupConversion,
    type IRunScanCleanupPipelineDependencies,
    type IRunScanCleanupPipelineRequest,
    type IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/runScanCleanupConversion';

const SCAN_CLEANUP_RUN_REPORT_DIRECTORY = 'report';

const defaultDependencies: IRunScanCleanupPipelineDependencies = {
    evidenceDirectory: runtimeConfig.test.scanCleanupEvidenceDirectory,
    getPageCount: getPdfPageCount,
    getPageSizeStore: (pdfPath, options) => createPdfPageSizeStore(pdfPath, options),
    detectSourceDpi: detectSourceDpiDetails,
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
    // Without the developer evidence directory, the run's compact report stays
    // beside its generated PDF and shares that output's lifetime, so a support
    // question about a finished run can still be answered from disk.
    return runScanCleanupConversion(
        request,
        paths,
        signal,
        onProgress,
        policy,
        log,
        dependencies.evidenceDirectory === undefined
            ? {
                ...dependencies,
                evidenceDirectory: join(dirname(request.outputPdfPath), SCAN_CLEANUP_RUN_REPORT_DIRECTORY),
                evidenceFileFilter: isScanCleanupRunReportFile,
            }
            : dependencies,
    );
}

export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';
