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
import {detectSourceDpiDetails as detectCoreSourceDpiDetails} from '@evb/scan-cleanup/core/sourceDpiDetection';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';
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
    chainTerminationProofSink,
    type TTerminationProofSink,
} from '@electron/resources/jobBroker';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
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

function scopeDependenciesToLease(
    dependencies: IRunScanCleanupPipelineDependencies,
    onTerminationProof: TTerminationProofSink | undefined,
): IRunScanCleanupPipelineDependencies {
    if (onTerminationProof === undefined) {
        return dependencies;
    }
    const mergeProofSink = (inner: TTerminationProofSink | undefined) => (
        inner === undefined
            ? onTerminationProof
            : chainTerminationProofSink(onTerminationProof, inner)
    );
    const runCommand: IRunScanCleanupPipelineDependencies['runCommand'] = (command, args, commandOptions) => dependencies.runCommand(command, args, {
        ...commandOptions,
        onTerminationProof: mergeProofSink(commandOptions?.onTerminationProof),
    });
    const scopedRenderers = dependencies.renderPage === renderPdfPageToPng || dependencies.renderPagePpm === renderPdfPageToPpm
        ? createScanCleanupRenderers(
            runCommand,
            undefined,
            error => getUnprovenNativeTerminationDetail(error) !== undefined,
            chainTerminationProofSink,
        )
        : null;
    return {
        ...dependencies,
        runCommand,
        getPageCount: dependencies.getPageCount === getPdfPageCount
            ? (pdfPath, pageCountOptions) => getPdfPageCount(pdfPath, {
                ...pageCountOptions,
                onTerminationProof,
            })
            : dependencies.getPageCount,
        detectSourceDpi: dependencies.detectSourceDpi === detectSourceDpiDetails
            ? (pdfPath, pdfimagesBinary, log, commandEnv, signal, pages, onProgress) => detectCoreSourceDpiDetails(
                pdfPath,
                pdfimagesBinary,
                log,
                commandEnv,
                signal,
                pages,
                onProgress,
                runCommand,
            )
            : dependencies.detectSourceDpi,
        renderPage: dependencies.renderPage === renderPdfPageToPng && scopedRenderers
            ? scopedRenderers.renderPage
            : dependencies.renderPage,
        renderPagePpm: dependencies.renderPagePpm === renderPdfPageToPpm && scopedRenderers
            ? scopedRenderers.renderPagePpm
            : dependencies.renderPagePpm,
        runSidecar: dependencies.runSidecar === runScanCleanupSidecar
            ? (binary, manifestPath, sidecarSignal, log, onProgress, sidecarOptions) => runScanCleanupSidecar(
                binary,
                manifestPath,
                sidecarSignal,
                log,
                onProgress,
                {
                    ...sidecarOptions,
                    onTerminationProof: mergeProofSink(sidecarOptions?.onTerminationProof),
                },
            )
            : dependencies.runSidecar,
    };
}

export async function runScanCleanupPipeline(
    request: IRunScanCleanupPipelineRequest,
    paths: IScanCleanupWorkerPaths,
    signal: AbortSignal,
    onProgress: (progress: TScanCleanupProgress) => void,
    policy: IScanCleanupRuntimePolicy,
    log: TWorkerLog = () => undefined,
    dependencies: IRunScanCleanupPipelineDependencies = defaultDependencies,
    options?: {
        onCheckpointReadyForCleanup?: (entryDir: string) => void;
        onTerminationProof?: TTerminationProofSink;
    },
): Promise<TScanCleanupSummary> {
    attachScanCleanupPageOverrideDefaults(
        request.options.pageOverrides,
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    const scopedDependencies = scopeDependenciesToLease(dependencies, options?.onTerminationProof);
    const resolvedDependencies: IRunScanCleanupPipelineDependencies = {
        ...scopedDependencies,
        ...(scopedDependencies.evidenceDirectory === undefined
            ? {
                evidenceDirectory: join(dirname(request.outputPdfPath), SCAN_CLEANUP_RUN_REPORT_DIRECTORY),
                evidenceFileFilter: isScanCleanupRunReportFile,
            }
            : {}),
        ...(options?.onCheckpointReadyForCleanup === undefined
            ? {}
            : {onCheckpointReadyForCleanup: options.onCheckpointReadyForCleanup}),
    };
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
        resolvedDependencies,
    );
}

export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';
