import {dirname, join} from 'node:path';
import type {TScanCleanupProgress, TScanCleanupSummary} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {IScanCleanupRuntimePolicy} from '@contracts/resourcePolicies';
import {getPdfPageCount} from '@electron/pdf/pdfPageCount';
import {detectSourceDpiDetails} from '@electron/pdf/sourceDpiDetection';
import {detectSourceDpiDetails as detectCoreSourceDpiDetails} from '@evb/scan-cleanup/core/sourceDpiDetection';
import {createScanCleanupRenderers} from '@evb/scan-cleanup/adapters/createScanCleanupRenderers';
import {extractPdfMrcLayers, extractPdfMrcLayersBatch} from '@evb/scan-cleanup/adapters/extractPdfMrcLayers';
import {renderPdfPageToPng, renderPdfPageToPpm, type TWorkerLog} from '@electron/features/ocr/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES} from '@electron/native-tools/pdfImageCombineBudget';
import {
    chainJobBrokerRunContext,
    mergeTerminationProofSinks,
    type IJobBrokerRequest,
    type IJobBrokerRunContext,
    type IJobResourceVector,
    type JobBroker,
    type TTerminationProofSink,
} from '@electron/resources/jobBroker';
import {getUnprovenNativeTerminationDetail, markUnprovenNativeTermination} from '@electron/utils/nativeTerminationProof';
import {resolveScanCleanupPreviewRasterSlotResidentBytes} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {requirePublishedRaster, runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
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
const SCAN_CLEANUP_COMBINE_PREVIEW_RESERVE = 1;

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

export interface IScanCleanupConversionPhaseBroker {
    getCurrentBrokerRun: () => IJobBrokerRunContext | undefined;
    runWithCombineLease: <T>(
        outputPageCount: number,
        signal: AbortSignal,
        work: (combineBrokerRun: IJobBrokerRunContext) => Promise<T>,
    ) => Promise<T>;
}

/**
 * Sizes the multi-page `evb-pdf-image-combine` phase lease within broker
 * capacity and host core budget (`logicalCpus - 1` floor 1 so 2-core / 4 GiB
 * hosts stay bounded to 1 combine thread while high-core hosts fan out),
 * reserving one CPU token and one I/O unit so a concurrent visible preview is
 * never blocked behind combine.
 */
export function resolveScanCleanupCombineLeaseResources(
    capacity: IJobResourceVector,
    outputPageCount: number,
    logicalCpus: number,
): IJobResourceVector {
    const normalizedPages = Math.max(1, Math.floor(outputPageCount));
    const hostMaxThreads = logicalCpus > 0 ? Math.max(1, Math.floor(logicalCpus) - 1) : 1;
    const cpuCap = Math.max(1, Math.floor(capacity.cpuTokens) - SCAN_CLEANUP_COMBINE_PREVIEW_RESERVE);
    const previewReserveBytes = resolveScanCleanupPreviewRasterSlotResidentBytes();
    const combineMemoryBudget = Math.max(PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES, capacity.estimatedResidentBytes - previewReserveBytes);
    const memoryCap = Math.max(1, Math.floor(combineMemoryBudget / PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES));
    const threads = Math.max(1, Math.min(normalizedPages, hostMaxThreads, cpuCap, memoryCap));
    const ioCap = Math.max(1, Math.min(4, Math.floor(capacity.ioWeight) - SCAN_CLEANUP_COMBINE_PREVIEW_RESERVE));
    return {
        cpuTokens: Math.min(capacity.cpuTokens, threads),
        estimatedResidentBytes: Math.min(capacity.estimatedResidentBytes, threads * PDF_IMAGE_COMBINE_THREAD_RESIDENT_BYTES),
        nativeProcesses: Math.min(capacity.nativeProcesses, 1),
        ioWeight: Math.min(capacity.ioWeight, ioCap),
    };
}

interface IHeldBrokerPhase {
    brokerRun: IJobBrokerRunContext;
    release: () => Promise<void>;
}

async function acquireBrokerPhase(broker: JobBroker, request: IJobBrokerRequest): Promise<IHeldBrokerPhase> {
    let resolveAcquired!: (brokerRun: IJobBrokerRunContext) => void;
    let rejectAcquired!: (error: unknown) => void;
    const acquired = new Promise<IJobBrokerRunContext>((resolve, reject) => {
        resolveAcquired = resolve;
        rejectAcquired = reject;
    });
    let releaseWork!: () => void;
    const workDone = new Promise<void>((resolve) => {
        releaseWork = resolve;
    });
    const runPromise = broker.run(request, async (brokerRun) => {
        resolveAcquired(brokerRun);
        await workDone;
    });
    const settledRun = runPromise.then(
        () => undefined,
        (error: unknown) => {
            rejectAcquired(error);
            return undefined;
        },
    );
    const brokerRun = await acquired;
    let released = false;
    return {
        brokerRun,
        release: async () => {
            if (!released) {
                released = true;
                releaseWork();
            }
            await settledRun;
        },
    };
}

/**
 * Owns sequential, non-overlapping broker phases for a Scan Cleanup conversion:
 * the per-page conversion lease is released to completion at the phase boundary
 * before a combine-sized lease is acquired for multi-page `evb-pdf-image-combine`,
 * and re-acquired only after the combine lease settles. Never nests two leases.
 */
export async function runWithScanCleanupConversionPhaseBroker<T>(
    input: {
        broker: JobBroker;
        ownerId: string;
        conversionResources: IJobResourceVector;
        logicalCpus: number;
        signal: AbortSignal;
    },
    work: (phaseBroker: IScanCleanupConversionPhaseBroker) => Promise<T>,
): Promise<T> {
    const {broker, ownerId, conversionResources, logicalCpus, signal} = input;
    const conversionRequest: IJobBrokerRequest = {
        ownerId,
        kind: 'scan-cleanup',
        priority: 'user',
        resources: conversionResources,
        perOwnerLimit: 1,
        signal,
    };
    let activeConversionPhase: IHeldBrokerPhase | null = await acquireBrokerPhase(broker, conversionRequest);
    const phaseBroker: IScanCleanupConversionPhaseBroker = {
        getCurrentBrokerRun: () => activeConversionPhase?.brokerRun,
        runWithCombineLease: async (outputPageCount, combineSignal, combineWork) => {
            const effectiveSignal = combineSignal === signal ? signal : AbortSignal.any([signal, combineSignal]);
            effectiveSignal.throwIfAborted();
            const previousPhase = activeConversionPhase;
            activeConversionPhase = null;
            if (previousPhase !== null) {
                await previousPhase.release();
                // Ask the broker directly whether the settled phase lease is
                // still active (retained for any pending or unproven proof
                // recorded via `onTerminationProof` or `leaseTerminationProof`).
                // Enqueueing a same-owner combine lease while it is retained
                // would block behind `perOwnerLimit: 1`.
                if (broker.isActive(previousPhase.brokerRun.lease)) {
                    throw markUnprovenNativeTermination(
                        new Error('Scan cleanup conversion phase retained its broker lease after unproven native termination'),
                        'conversion phase lease retained after unproven native termination',
                    );
                }
            }
            effectiveSignal.throwIfAborted();
            const combinePhase = await acquireBrokerPhase(broker, {
                ownerId,
                kind: 'scan-cleanup',
                priority: 'user',
                resources: resolveScanCleanupCombineLeaseResources(broker.getSnapshot().capacity, outputPageCount, logicalCpus),
                perOwnerLimit: 1,
                signal: effectiveSignal,
            });
            let result: TResult;
            type TResult = Awaited<ReturnType<typeof combineWork>>;
            try {
                result = await combineWork(combinePhase.brokerRun);
            } finally {
                await combinePhase.release();
            }
            if (broker.isActive(combinePhase.brokerRun.lease)) {
                throw markUnprovenNativeTermination(
                    new Error('Scan cleanup combine phase retained its broker lease after unproven native termination'),
                    'combine phase lease retained after unproven native termination',
                );
            }
            effectiveSignal.throwIfAborted();
            activeConversionPhase = await acquireBrokerPhase(broker, conversionRequest);
            return result;
        },
    };
    try {
        return await work(phaseBroker);
    } finally {
        const remainingPhase = activeConversionPhase;
        activeConversionPhase = null;
        if (remainingPhase !== null) {
            await remainingPhase.release();
        }
    }
}

function createScopedRunCommand(
    baseRunCommand: IRunScanCleanupPipelineDependencies['runCommand'],
    getBrokerRun: () => IJobBrokerRunContext | undefined,
    onTerminationProof: TTerminationProofSink | undefined,
): IRunScanCleanupPipelineDependencies['runCommand'] {
    return (command, args, commandOptions) => {
        const {onTerminationProof: innerProof, ...restOptions} = commandOptions ?? {};
        const currentBrokerRun = getBrokerRun();
        const outerProofSink = mergeTerminationProofSinks(currentBrokerRun?.onTerminationProof, onTerminationProof);
        const baseBrokerRun = chainJobBrokerRunContext(currentBrokerRun, onTerminationProof);
        const scopedBrokerRun = chainJobBrokerRunContext(baseBrokerRun, innerProof);
        if (scopedBrokerRun !== undefined && baseRunCommand === runNativeToolCommand) {
            return runNativeToolCommand(command, args, {
                ...restOptions,
                brokerRun: scopedBrokerRun,
            });
        }
        const mergedProof = mergeTerminationProofSinks(outerProofSink, innerProof);
        return baseRunCommand(command, args, {
            ...restOptions,
            ...(mergedProof === undefined ? {} : {onTerminationProof: mergedProof}),
        });
    };
}

function scopeDependenciesToLease(
    dependencies: IRunScanCleanupPipelineDependencies,
    brokerRun: IJobBrokerRunContext | undefined,
    phaseBroker: IScanCleanupConversionPhaseBroker | undefined,
    onTerminationProof: TTerminationProofSink | undefined,
): IRunScanCleanupPipelineDependencies {
    const getBrokerRun = phaseBroker !== undefined ? () => phaseBroker.getCurrentBrokerRun() : () => brokerRun;
    const hasBrokerContext = phaseBroker !== undefined || brokerRun !== undefined;
    if (!hasBrokerContext && onTerminationProof === undefined) {
        return dependencies;
    }
    const runCommand = createScopedRunCommand(dependencies.runCommand, getBrokerRun, onTerminationProof);
    const scopedRenderers =
        dependencies.renderPage === renderPdfPageToPng || dependencies.renderPagePpm === renderPdfPageToPpm
            ? createScanCleanupRenderers(runCommand, undefined, (error) => getUnprovenNativeTerminationDetail(error) !== undefined)
            : null;
    const runWithCombineLease: IRunScanCleanupPipelineDependencies['runWithCombineLease'] =
        dependencies.runWithCombineLease ??
        (phaseBroker === undefined
            ? undefined
            : (outputPageCount, combineSignal, work) =>
                  phaseBroker.runWithCombineLease(outputPageCount, combineSignal, (combineBrokerRun) =>
                      work(createScopedRunCommand(dependencies.runCommand, () => combineBrokerRun, onTerminationProof)),
                  ));
    return {
        ...dependencies,
        runCommand,
        ...(runWithCombineLease === undefined ? {} : {runWithCombineLease}),
        getPageCount:
            dependencies.getPageCount === getPdfPageCount
                ? (pdfPath, pageCountOptions) => {
                      const proofSink = mergeTerminationProofSinks(getBrokerRun()?.onTerminationProof, onTerminationProof);
                      return getPdfPageCount(pdfPath, {
                          ...pageCountOptions,
                          ...(proofSink === undefined ? {} : {onTerminationProof: proofSink}),
                      });
                  }
                : dependencies.getPageCount,
        detectSourceDpi:
            dependencies.detectSourceDpi === detectSourceDpiDetails
                ? (pdfPath, pdfimagesBinary, log, commandEnv, signal, pages, onProgress) =>
                      detectCoreSourceDpiDetails(pdfPath, pdfimagesBinary, log, commandEnv, signal, pages, onProgress, runCommand)
                : dependencies.detectSourceDpi,
        renderPage:
            dependencies.renderPage === renderPdfPageToPng && scopedRenderers ? scopedRenderers.renderPage : dependencies.renderPage,
        renderPagePpm:
            dependencies.renderPagePpm === renderPdfPageToPpm && scopedRenderers
                ? scopedRenderers.renderPagePpm
                : dependencies.renderPagePpm,
        runSidecar:
            dependencies.runSidecar === runScanCleanupSidecar
                ? (binary, manifestPath, sidecarSignal, log, onProgress, sidecarOptions) => {
                      const {onTerminationProof: innerProof, ...restSidecarOptions} = sidecarOptions ?? {};
                      const currentBrokerRun = getBrokerRun();
                      const outerProofSink = mergeTerminationProofSinks(currentBrokerRun?.onTerminationProof, onTerminationProof);
                      const baseBrokerRun = chainJobBrokerRunContext(currentBrokerRun, onTerminationProof);
                      const scopedBrokerRun = chainJobBrokerRunContext(baseBrokerRun, innerProof);
                      const mergedProof =
                          scopedBrokerRun === undefined ? mergeTerminationProofSinks(outerProofSink, innerProof) : undefined;
                      return runScanCleanupSidecar(binary, manifestPath, sidecarSignal, log, onProgress, {
                          ...restSidecarOptions,
                          ...(scopedBrokerRun !== undefined
                              ? {brokerRun: scopedBrokerRun}
                              : mergedProof === undefined
                                ? {}
                                : {onTerminationProof: mergedProof}),
                      });
                  }
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
        brokerRun?: IJobBrokerRunContext;
        phaseBroker?: IScanCleanupConversionPhaseBroker;
        onTerminationProof?: TTerminationProofSink;
    },
): Promise<TScanCleanupSummary> {
    attachScanCleanupPageOverrideDefaults(request.options.pageOverrides, request.options.pageOverrideDefaults, request.options.marginsMm);
    const scopedDependencies = scopeDependenciesToLease(
        dependencies,
        options?.brokerRun,
        options?.phaseBroker,
        options?.onTerminationProof,
    );
    const resolvedDependencies: IRunScanCleanupPipelineDependencies = {
        ...scopedDependencies,
        ...(scopedDependencies.evidenceDirectory === undefined
            ? {
                  evidenceDirectory: join(dirname(request.outputPdfPath), SCAN_CLEANUP_RUN_REPORT_DIRECTORY),
                  evidenceFileFilter: isScanCleanupRunReportFile,
              }
            : {}),
        ...(options?.onCheckpointReadyForCleanup === undefined ? {} : {onCheckpointReadyForCleanup: options.onCheckpointReadyForCleanup}),
    };
    // Without the developer evidence directory, the run's compact report stays
    // beside its generated PDF and shares that output's lifetime, so a support
    // question about a finished run can still be answered from disk.
    return runScanCleanupConversion(request, paths, signal, onProgress, policy, log, resolvedDependencies);
}

export type {
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
} from '@evb/scan-cleanup/core/types';
