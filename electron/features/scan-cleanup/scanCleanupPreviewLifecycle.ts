import type {
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupDetectionStartResult,
    TScanCleanupPreviewWireResult,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
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
import {createPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import {atomicReplace} from '@electron/utils/atomicReplace';
import {
    renderPdfPageToPng,
    renderPdfPageToPpm,
} from '@electron/features/ocr/publicNative';
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {runScanCleanupSidecar} from '@electron/features/scan-cleanup/worker/runScanCleanupSidecar';
import {createScanCleanupRasterBatchRenderer} from '@electron/features/scan-cleanup/createScanCleanupRasterBatchRenderer';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {onSenderLifetimeEnd} from '@electron/utils/onSenderLifetimeEnd';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {
    getWorkingCopyBackingEntry,
    getWorkingCopyBackingMetadata,
} from '@electron/file-access/workingCopyStore';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
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
import type {
    IScanCleanupDetectionSubscriber,
    IScanCleanupDetectionOwnerDependencies,
    IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    scanCleanupDetectionOwner,
    type IScanCleanupDetectionOwner,
} from '@electron/features/scan-cleanup/scanCleanupDetectionLifecycle';
import {
    scanCleanupPreviewRenderingOwner,
    type IScanCleanupPreviewRenderingOwner,
} from '@electron/features/scan-cleanup/scanCleanupPreviewRenderingOwner';
import {scanCleanupRasterRetention} from '@electron/features/scan-cleanup/scanCleanupRasterRetention';
import {
    RENDERER_DESTROYED_CANCELLATION_REASON,
    RENDER_PROCESS_GONE_CANCELLATION_REASON,
} from '@electron/operation-lifecycle/createMainJobRegistry';
import {
    type IScanCleanupRasterAdmissionPolicy,
    resolveScanCleanupPreviewRasterAdmissionPolicy,
    resolveScanCleanupPreviewRasterSlotResidentBytes,
    resolveScanCleanupPreviewPath,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import {logScanCleanupMessage} from '@electron/features/scan-cleanup/scanCleanupRasterRetentionIo';

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
    resolveRasterAdmissionPolicy: (supportsRasterStreaming, options) => resolveScanCleanupPreviewRasterAdmissionPolicy(
        mainJobBroker.getSnapshot().capacity,
        supportsRasterStreaming,
        options,
    ),
    getPageCount: getPdfPageCount,
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
        return (await result.getPageRaster(pageNumber))?.dpi ?? null;
    },
    detectRasterPages: async (sourcePdfPath, signal, pageNumbers) => {
        const paths = getPdfNativeToolPaths();
        return detectSourceDpiDetails(sourcePdfPath, paths.pdfimages, logScanCleanupMessage, undefined, signal, pageNumbers);
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
    acquireDetectionLease: (
        ownerId,
        signal,
        rasterPolicy: IScanCleanupRasterAdmissionPolicy,
        options,
    ) => mainJobBroker.acquire({
        ownerId,
        kind: 'scan-cleanup-detect-all',
        priority: 'user',
        resources: {
            cpuTokens: rasterPolicy.rasterConcurrency,
            estimatedResidentBytes: rasterPolicy.rasterConcurrency
                * resolveScanCleanupPreviewRasterSlotResidentBytes(options, rasterPolicy.rasterMaxPixels),
            nativeProcesses: rasterPolicy.rasterConcurrency + Number(rasterPolicy.rasterStreaming),
            ioWeight: 2,
        },
        perOwnerLimit: 1,
        signal,
    }),
    acquirePreviewLease: (
        ownerId,
        visibility,
        signal,
        options,
        rasterMaxPixels,
    ) => {
        const effectiveRasterMaxPixels = rasterMaxPixels ?? resolveScanCleanupPreviewRasterAdmissionPolicy(
            mainJobBroker.getSnapshot().capacity,
            process.platform !== 'win32',
            options,
        ).rasterMaxPixels;
        return mainJobBroker.acquire({
            ownerId,
            kind: 'scan-cleanup-preview',
            priority: visibility === 'prefetch' ? 'background' : 'visible',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: resolveScanCleanupPreviewRasterSlotResidentBytes(
                    options,
                    effectiveRasterMaxPixels,
                ),
                nativeProcesses: 1,
                ioWeight: 1,
            },
            signal,
        });
    },
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

export interface IScanCleanupPreviewService
    extends IScanCleanupPreviewRenderingOwner, IScanCleanupDetectionOwner {
    preview: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewRequest,
    ) => Promise<TScanCleanupPreviewWireResult>;
    cancel: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupPreviewCancelRequest,
    ) => boolean;
    detectAll: (
        sender: IScanCleanupDetectionSubscriber,
        request: IScanCleanupDetectionRequest,
    ) => Promise<TScanCleanupDetectionStartResult>;
    cancelDetection: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => boolean;
    getDetectionJobState: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
    subscribeDetectionJob: (
        sender: IScanCleanupDetectionSubscriber,
        jobId: string,
        owner: IScanCleanupOwnerContext,
    ) => TScanCleanupDetectionJobState | null;
}

export function scanCleanupPreviewLifecycle(
    dependencies: IScanCleanupPreviewDependencies,
): IScanCleanupPreviewService {
    const detectionDependencies: IScanCleanupDetectionOwnerDependencies = dependencies;
    const rawRasterRetention = scanCleanupRasterRetention(dependencies);
    const detection = scanCleanupDetectionOwner(detectionDependencies, rawRasterRetention);
    const rendering = scanCleanupPreviewRenderingOwner(dependencies, rawRasterRetention);
    interface IWatchedSender {
        sender: IScanCleanupDetectionSubscriber;
        handleGone: () => void;
        stop: () => void;
    }
    const watchedSenders = new Map<number, IWatchedSender>();
    const pendingPreviews = new Map<number, Set<Promise<unknown>>>();
    let disposed = false;
    const isRendererGoneError = (error: unknown) => error instanceof Error
        && (error.message === RENDERER_DESTROYED_CANCELLATION_REASON
            || error.message === RENDER_PROCESS_GONE_CANCELLATION_REASON);
    const watchSender = (sender: IScanCleanupDetectionSubscriber) => {
        if (disposed) return;
        const previous = watchedSenders.get(sender.id);
        if (previous?.sender === sender) return;
        previous?.stop();
        const handleGone = () => {
            const watched = watchedSenders.get(sender.id);
            if (watched?.handleGone !== handleGone) return;
            watchedSenders.delete(sender.id);
            watched.stop();
            rendering.invalidateSender?.(sender.id);
            rawRasterRetention.invalidateSender(sender.id);
        };
        watchedSenders.set(sender.id, {
            sender,
            handleGone,
            stop: onSenderLifetimeEnd(sender, handleGone),
        });
        if (sender.isDestroyed()) handleGone();
    };
    const watchSenderAfterPreviewsSettle = (
        sender: IScanCleanupDetectionSubscriber,
        preview: Promise<unknown>,
    ) => {
        const previews = pendingPreviews.get(sender.id) ?? new Set<Promise<unknown>>();
        previews.add(preview);
        pendingPreviews.set(sender.id, previews);
        const settle = (watch: boolean) => {
            const current = pendingPreviews.get(sender.id);
            if (current === undefined) return;
            current.delete(preview);
            if (current.size > 0) return;
            pendingPreviews.delete(sender.id);
            if (watch) watchSender(sender);
        };
        void preview.then(
            () => settle(true),
            error => settle(!isRendererGoneError(error)),
        ).catch(() => undefined);
    };

    return {
        ...rendering,
        ...detection,
        preview(sender, request) {
            const preview = rendering.preview(sender, request);
            watchSenderAfterPreviewsSettle(sender, preview);
            return preview;
        },
        detectAll(sender, request) {
            watchSender(sender);
            return detection.detectAll(sender, request);
        },
        async dispose() {
            disposed = true;
            pendingPreviews.clear();
            for (const {stop} of watchedSenders.values()) {
                stop();
            }
            watchedSenders.clear();
            await rendering.dispose();
            await detection.dispose();
            await rawRasterRetention.dispose();
        },
    };
}
