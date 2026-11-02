import { join } from 'path';
import { randomUUID } from 'crypto';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupPreviewRequest,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import { decodeNativeScanCleanupPreviewOutputMetadataJson } from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    planScanCleanupDetailPreview,
    projectScanCleanupDetailOutputMetadata,
} from '@evb/scan-cleanup/core/policy/scanCleanupPreviewPolicy';
import {
    logRasterHandoff,
    resolveRasterHandoff,
} from '@evb/scan-cleanup/core/resolveRasterHandoff';
import {renderScanCleanupRasterToDisk as renderRasterToDisk} from '@evb/scan-cleanup/core/rasterValidation';
import { getErrorMessage } from '@electron/utils/error';
import {createLogger} from '@electron/utils/createLogger';
import { buildRunnableNativeScanCleanupManifest } from '@evb/scan-cleanup/core/policy/buildNativeScanCleanupManifest';
import {SCAN_CLEANUP_MAX_DIMENSION_PX} from '@evb/scan-cleanup/core/policy/effectiveOptions';
import type {
    IRawPreview,
    IBasePreviewAnalysis,
    IScanCleanupRenderingDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {readPreviewBytes} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';
import {
    BASE_ANALYSIS_CACHE_PAGE_LIMIT,
    BASE_ANALYSIS_CACHE_BYTE_LIMIT,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
const logger = createLogger('scan-cleanup-preview-pipeline');
export function logScanCleanupMessage(level: 'debug' | 'error' | 'info' | 'warn', message: string) {
    if (level === 'error') {
        logger.error(message, {code: 'MAIN_SCAN_CLEANUP_FAILED'});
        return;
    }
    logger[level](message);
}
export async function persistBaseAnalysisArtifacts(
    outputs: IBasePreviewAnalysis['outputs'],
    canonicalRasters: Partial<Record<IScanCleanupPreviewMetadata['half'], Uint8Array>>,
    signal: AbortSignal,
    dependencies: IScanCleanupRenderingDependencies,
) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup pipeline requires injected filesystem capabilities');
    if (!dependencies.readFile) throw new Error('Scan cleanup pipeline requires injected readFile capability');
    const analysisDirectory = join(
        dependencies.getTempDir(),
        `scan-cleanup-base-analysis-${randomUUID()}-${process.pid}`,
    );
    await fileSystem.mkdir(analysisDirectory, {recursive: true});
    const canonicalRasterPaths: IBasePreviewAnalysis['canonicalRasterPaths'] = {};
    const baseMetadataPaths: IBasePreviewAnalysis['baseMetadataPaths'] = {};
    try {
        for (const half of [
            'full',
            'left',
            'right',
        ] as const) {
            const raster = canonicalRasters[half];
            const metadata = outputs[half];
            if (!raster || !metadata) continue;
            signal.throwIfAborted();
            const rasterPath = join(analysisDirectory, `base-cleaned-${half}.png`);
            const metadataPath = join(analysisDirectory, `base-metadata-${half}.json`);
            await fileSystem.writeFile(rasterPath, raster);
            await fileSystem.writeFile(metadataPath, JSON.stringify(metadata));
            canonicalRasterPaths[half] = rasterPath;
            baseMetadataPaths[half] = metadataPath;
        }
        signal.throwIfAborted();
        return {
            analysisDirectory,
            canonicalRasterPaths,
            baseMetadataPaths,
        };
    } catch (error) {
        await fileSystem.rm(analysisDirectory, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}
export function removeBaseAnalysisArtifacts(analysis: IBasePreviewAnalysis, dependencies: IScanCleanupRenderingDependencies) {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) {
        return Promise.reject(new Error('Scan cleanup pipeline requires injected filesystem capabilities'));
    }
    return fileSystem.rm(analysis.analysisDirectory, {
        recursive: true,
        force: true,
    }).catch(error => {
        logger.warn(`Failed to drop scan cleanup base analysis artifacts: ${getErrorMessage(error)}`);
    });
}
export async function pruneBaseAnalysisCache(
    cache: Map<string, IBasePreviewAnalysis>,
    pinnedKeys: ReadonlySet<string> = new Set(),
    dependencies: IScanCleanupRenderingDependencies,
) {
    let retainedBytes = [...cache.values()]
        .reduce((total, analysis) => total + analysis.retainedBytes, 0);
    while (
        cache.size > BASE_ANALYSIS_CACHE_PAGE_LIMIT
        || retainedBytes > BASE_ANALYSIS_CACHE_BYTE_LIMIT
    ) {
        const oldest = [...cache.entries()].find(([key]) => !pinnedKeys.has(key));
        if (!oldest) {
            return;
        }
        cache.delete(oldest[0]);
        await removeBaseAnalysisArtifacts(oldest[1], dependencies);
        retainedBytes -= oldest[1].retainedBytes;
    }
}
export async function runDetailPreview(
    request: IScanCleanupPreviewRequest & {detail: NonNullable<IScanCleanupPreviewRequest['detail']>},
    signal: AbortSignal,
    baseRaw: IRawPreview,
    baseRasterPath: string,
    analysis: IBasePreviewAnalysis,
    sourceDpiCandidate: number | null | undefined,
    sourceRasterDetected: boolean,
    scratch: string,
    dependencies: IScanCleanupRenderingDependencies,
    rasterMaxPixels?: number,
): Promise<TScanCleanupPreviewWireResult> {
    const fileSystem = dependencies.fileSystem;
    if (!fileSystem) throw new Error('Scan cleanup pipeline requires injected filesystem capabilities');
    const getAvailableScratchBytes = dependencies.getAvailableScratchBytes;
    if (!getAvailableScratchBytes) throw new Error('Scan cleanup pipeline requires injected scratch-budget capability');
    if (!dependencies.readFile) throw new Error('Scan cleanup pipeline requires injected readFile capability');
    const plan = planScanCleanupDetailPreview({
        request,
        baseRaw,
        baseOutputs: analysis.outputs,
        baseRenderDpi: analysis.baseRenderDpi,
        sourceDpiCandidate,
        sourceRasterDetected,
        ...(rasterMaxPixels === undefined ? {} : {rasterMaxPixels}),
    });
    if (plan.kind === 'base-suffices') {
        return {
            pageNumber: request.pageNumber,
            totalPages: baseRaw.totalPages,
            rawWidthPx: baseRaw.width,
            rawHeightPx: baseRaw.height,
            pageMetadata: analysis.pageMetadata,
            outputs: [],
        };
    }
    const binary = dependencies.resolveBinary();
    if (!binary) throw new Error('Scan cleanup native tool is unavailable');
    const effectiveOptions = request.options.matchPageSize
        ? {
            ...request.options,
            matchPageSize: false,
        }
        : request.options;
    const pageInputs = [];
    const outputFiles: Array<{
        outputPath: string;
        metadataPath: string;
    }> = [];
    for (const {
        half, renderRegion, sampledRegion, sourceCrop: plannedCrop,
    } of plan.halves) {
        const sourceCrop = {...plannedCrop};
        const handoff = await resolveRasterHandoff([{
            renderDpi: plan.renderDpi,
            raster: {
                dpi: plan.renderDpi,
                width: sourceCrop.width,
                height: sourceCrop.height,
            },
        }], scratch, getAvailableScratchBytes);
        logRasterHandoff(logScanCleanupMessage, 'detail tile', handoff);
        const inputPath = join(scratch, `detail-source-${half}.${handoff.format}`);
        const renderedSource = await renderRasterToDisk(
            request.sourcePdfPath,
            request.pageNumber,
            inputPath,
            signal,
            {
                ...dependencies,
                fileSystem: {open: fileSystem.open},
            },
            logScanCleanupMessage,
            plan.renderDpi,
            plan.maxSourcePixels,
            sourceCrop,
            handoff.format,
            {
                expectedWidthPx: sourceCrop.width,
                expectedHeightPx: sourceCrop.height,
                maxPixels: plan.maxSourcePixels,
                maxDimensionPx: SCAN_CLEANUP_MAX_DIMENSION_PX,
            },
            'raster',
            'preview',
        );
        sourceCrop.width = renderedSource.width;
        sourceCrop.height = renderedSource.height;
        const baseMetadataPath = analysis.baseMetadataPaths[half];
        const baseCleanedRasterPath = analysis.canonicalRasterPaths[half];
        if (!baseMetadataPath || !baseCleanedRasterPath) {
            throw new Error(`Scan cleanup detail has no canonical ${half} base raster`);
        }
        const output = {
            outputPath: join(scratch, `detail-clean-${half}.png`),
            metadataPath: join(scratch, `detail-clean-${half}.json`),
        };
        outputFiles.push(output);
        pageInputs.push({
            inputPath,
            pageNumber: request.pageNumber,
            dpi: plan.renderDpi,
            sourceDpi: plan.sourceDpi,
            requestedRenderDpi: plan.requestedRenderDpi,
            resolvedOutputMode: request.detail.outputMode,
            pageMetadataPath: join(scratch, `detail-page-${half}.json`),
            outputs: [output],
            detailRenderPlan: {
                baseMetadataPath,
                baseRasterPath,
                baseCleanedRasterPath,
                sourceCrop: {
                    xPx: sourceCrop.x,
                    yPx: sourceCrop.y,
                    widthPx: sourceCrop.width,
                    heightPx: sourceCrop.height,
                },
                fullSourceWidthPx: plan.fullSourceWidthPx,
                fullSourceHeightPx: plan.fullSourceHeightPx,
                scale: plan.renderScale,
                renderRegion,
                sampledRegion,
            },
        });
    }
    const manifest = buildRunnableNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: effectiveOptions,
        ...(rasterMaxPixels === undefined ? {} : {rasterMaxPixels}),
        experimental: {autoDewarp: false},
        pages: pageInputs,
        allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir(),
    });
    const manifestPath = join(scratch, 'detail-manifest.json');
    await fileSystem.writeFile(manifestPath, JSON.stringify(manifest));
    await dependencies.runSidecar(
        binary,
        manifestPath,
        signal,
        logScanCleanupMessage,
        () => undefined,
        {allowedPathRoot: dependencies.nativeAllowedPathRoot ?? dependencies.getTempDir()},
    );
    const cleaned = [] as IScanCleanupPreviewResult['outputs'];
    for (const output of outputFiles) {
        const nativeMetadata = decodeNativeScanCleanupPreviewOutputMetadataJson(
            String(await dependencies.readFile(output.metadataPath, 'utf8')),
        );
        cleaned.push({
            imageData: await readPreviewBytes(output.outputPath, dependencies),
            metadata: projectScanCleanupDetailOutputMetadata(nativeMetadata),
        });
    }
    return {
        pageNumber: request.pageNumber,
        totalPages: baseRaw.totalPages,
        rawWidthPx: baseRaw.width,
        rawHeightPx: baseRaw.height,
        pageMetadata: analysis.pageMetadata,
        outputs: cleaned,
    };
}
