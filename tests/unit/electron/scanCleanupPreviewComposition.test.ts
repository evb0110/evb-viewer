import {
    describe, it, expect, afterEach, vi,
} from 'vitest';
import {
    lstat, mkdtemp, readFile, rm, writeFile, readdir, stat,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
    defaultDependencies, scanCleanupPreviewLifecycle,
} from '@electron/features/scan-cleanup/scanCleanupPreviewLifecycle';
import type {IPdfPageSizeStore} from '@electron/pdf/pdfPageSizes';
import {requirePageNumber} from '@contracts/pageNumbers';
import {requireRequestId} from '@contracts/shared';
import {resolveScanCleanupPlacementOffset} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import {writeScanCleanupDetectionMetadata as writeDetectionMetadata} from '@tests/unit/electron/writeScanCleanupDetectionMetadata';
import {SCAN_CLEANUP_PLATFORM_FEATURE} from '@contracts/scan-cleanup/scanCleanupPlatformFeature';
import {
    resolveScanCleanupPreviewRasterAdmissionPolicy,
    resolveScanCleanupPreviewRasterSlotResidentBytes,
    type TScanCleanupRasterBudgetOptions,
} from '@electron/features/scan-cleanup/scanCleanupPreviewPolicy';
import type {TPreviewVisibility} from '@electron/features/scan-cleanup/scanCleanupPreviewShared';
import {
    createScanCleanupPreviewTestContext,
    createScanCleanupPageRasterSource,
    detectionRequest,
    DOCUMENT_CANVAS,
    DOCUMENT_PAGE_SIZES,
    lifecycleSender,
    PNG,
    previewOf,
    request,
    SETTLED_SINGLE_LAYOUT_BY_PAGE,
    sender,
    waitForRelease,
} from '@tests/unit/electron/scanCleanupPreviewHarness';
import {mainJobBroker} from '@electron/resources/jobBroker';
import {cancelMainOperationsForClosingWorkingCopy} from '@electron/operation-lifecycle/mainOperationLifecycle';

// pdftoppm rasterizes the same pixels whichever container it is asked for, so
// the fake renderers write one deterministic pattern in either format.
const dirs: string[] = [];
const scanCleanupPreviewRasterSlotResidentBytes = resolveScanCleanupPreviewRasterSlotResidentBytes();
const dependenciesOverride = {
    acquirePreviewLease: (ownerId: string, visibility: TPreviewVisibility, signal: AbortSignal) => mainJobBroker.acquire({
        ownerId,
        kind: 'scan-cleanup-preview',
        priority: visibility === 'prefetch' ? 'background' as const : 'visible' as const,
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: scanCleanupPreviewRasterSlotResidentBytes,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        signal,
    }),
    acquireDetectionLease: (ownerId: string, signal: AbortSignal, policy: {
        rasterConcurrency: number;
        rasterStreaming: boolean
    }) => mainJobBroker.acquire({
        ownerId,
        kind: 'scan-cleanup-detect-all',
        priority: 'user' as const,
        resources: {
            cpuTokens: policy.rasterConcurrency,
            estimatedResidentBytes: policy.rasterConcurrency * scanCleanupPreviewRasterSlotResidentBytes,
            nativeProcesses: policy.rasterConcurrency + Number(policy.rasterStreaming),
            ioWeight: 2,
        },
        perOwnerLimit: 1,
        signal,
    }),
};

async function previewFixture() {
    const {
        dir, deps,
    } = await createScanCleanupPreviewTestContext(dirs, dependenciesOverride);
    const service = scanCleanupPreviewLifecycle(deps);
    return {
        dir,
        deps,
        service,
    };
}

async function previewDependencies() {
    return createScanCleanupPreviewTestContext(dirs, dependenciesOverride);
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

async function runTrustedMrcPreview(outputMode: 'auto' | 'bw', outputModeRecommendation: 'mixed' | undefined): Promise<void> {
    const {deps} = await previewDependencies();
    deps.detectRasterPages = vi.fn(async () => createScanCleanupPageRasterSource({
        pages: [1],
        bilevelLayerPages: [1],
        backgroundDpiByPage: new Map([[
            1,
            100,
        ]]),
    }));
    deps.extractMrcLayers = vi.fn(async (
        _sourcePdfPath,
        _pageNumber,
        selectionMaskOutputPath,
        backgroundOutputPath,
    ) => {
        const foregroundPath = `${backgroundOutputPath}.foreground.jp2`;
        await Promise.all([
            writeFile(selectionMaskOutputPath, PNG),
            writeFile(backgroundOutputPath, PNG),
            writeFile(foregroundPath, 'JP2-SOURCE'),
        ]);
        return {
            backgroundDpi: 100,
            backgroundPath: backgroundOutputPath,
            foregroundDpi: 600,
            foregroundHeight: 2_800,
            foregroundPath,
            foregroundWidth: 2_000,
            selectionMaskDecode: 'default' as const,
            selectionMaskPath: selectionMaskOutputPath,
        };
    });
    const originalSidecar = deps.runSidecar;
    let trustedPaths: {
        trustedForegroundMaskPath?: string;
        trustedMrcBackgroundPath?: string
    } | null = null;
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
            trustedForegroundMaskPath?: string;
            trustedMrcBackgroundPath?: string
        }>};
        trustedPaths = manifest.pages[0] ?? null;
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
    });

    await previewOf(scanCleanupPreviewLifecycle(deps), sender(), {
        ...request,
        options: {
            ...request.options,
            outputMode,
        },
        ...(outputModeRecommendation === undefined
            ? {}
            : {outputModeRecommendation}),
    });

    expect(deps.extractMrcLayers).toHaveBeenCalledTimes(1);
    expect(trustedPaths).toMatchObject({
        trustedForegroundMaskPath: expect.stringMatching(/source-mrc-selection\.png$/u),
        trustedMrcBackgroundPath: expect.stringMatching(/source-mrc-background\.png$/u),
    });
}

async function runCanvasCacheOrderPreview(lossless: boolean): Promise<void> {
    const {deps} = await previewDependencies();
    deps.getPageCount = vi.fn(async () => 2);
    const originalSidecar = deps.runSidecar;
    const previewManifests: Array<{
        canvasScope: string;
        documentCanvas?: unknown
    }> = [];
    deps.runSidecar = vi.fn(async (binary, manifestPath, signal, log, onProgress) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation: string;
            canvasScope: string;
            documentCanvas?: {
                widthPoints: number;
                heightPoints: number
            };
            pages: Array<{
                sourcePageIndex: number;
                pageMetadataPath: string;
                outputs: Array<{
                    outputPath: string;
                    metadataPath: string
                }>;
            }>;
        };
        if (manifest.pages.length === 2) {
            for (const page of manifest.pages) {
                const pageNumber = page.sourcePageIndex + 1;
                const widthPx = pageNumber === 1 ? 60 : 100;
                const heightPx = pageNumber === 1 ? 120 : 140;
                const sourceRegion = {
                    xPx: 0,
                    yPx: 0,
                    widthPx,
                    heightPx,
                };
                await writeFile(page.pageMetadataPath, JSON.stringify({
                    canvasScope: 'page',
                    layoutClassification: 'single-uncut-page',
                    layoutConfidence: 0.9,
                    cutterXPx: null,
                    rotationDegrees: 0,
                    excluded: false,
                    blankOutputsSkipped: 0,
                    outputCount: 1,
                    outputs: [{
                        half: 'full',
                        sourceRegion,
                        contentBox: null,
                        cropRect: sourceRegion,
                        appliedMargins: {
                            leftPx: 0,
                            topPx: 0,
                            rightPx: 0,
                            bottomPx: 0,
                        },
                        inputWidthPx: widthPx,
                        inputHeightPx: heightPx,
                    }],
                }));
                onProgress({
                    stage: 'page-complete',
                    completedPages: pageNumber,
                    totalPages: 2,
                    pageNumber,
                    classification: 'single-uncut-page',
                    confidence: 0.9,
                });
            }
            return;
        }
        previewManifests.push({
            canvasScope: manifest.canvasScope,
            documentCanvas: manifest.documentCanvas,
        });
        const page = manifest.pages[0]!;
        const intrinsicWidth = page.sourcePageIndex === 0 ? 60 : 100;
        const intrinsicHeight = page.sourcePageIndex === 0 ? 120 : 140;
        if (lossless) {
            await writeFile(page.pageMetadataPath, JSON.stringify({
                canvasScope: 'page',
                layoutClassification: 'single-uncut-page',
                layoutConfidence: 0.9,
                cutterXPx: null,
                rotationDegrees: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
                outputs: [{
                    half: 'full',
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: intrinsicWidth,
                        heightPx: intrinsicHeight,
                    },
                    contentBox: null,
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: intrinsicWidth,
                        heightPx: intrinsicHeight,
                    },
                    appliedMargins: {
                        leftPx: 0,
                        topPx: 0,
                        rightPx: 0,
                        bottomPx: 0,
                    },
                    inputWidthPx: intrinsicWidth,
                    inputHeightPx: intrinsicHeight,
                }],
            }));
            return;
        }
        await originalSidecar(binary, manifestPath, signal, log, onProgress);
        const output = page.outputs[0]!;
        const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
        await writeFile(output.metadataPath, JSON.stringify({
            ...metadata,
            outputWidthPx: intrinsicWidth,
            outputHeightPx: intrinsicHeight,
            canvasWidthPx: 100,
            canvasHeightPx: 140,
            matchedCanvasTargetWidthPx: 100,
            matchedCanvasTargetHeightPx: 140,
            canvasPolicy: 'strict-maximum',
        }));
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const detectRequest = {
        ...detectionRequest,
        options: {
            ...detectionRequest.options,
            preserveOriginalQuality: lossless,
        },
    };
    const started = await service.detectAll(owner, detectRequest);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        detectRequest,
    )?.status).toBe('completed'));

    const second = await previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        options: detectRequest.options,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });
    const first = await previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(1),
        options: detectRequest.options,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
    });

    // The raster path reads the canvas the sidecar wrote; the lossless path
    // places the analysed crop on the same document rectangle itself.
    const matchedCanvas = lossless
        ? {
            canvasWidthPx: DOCUMENT_CANVAS.widthPx,
            canvasHeightPx: DOCUMENT_CANVAS.heightPx,
        }
        : {
            canvasWidthPx: 100,
            canvasHeightPx: 140,
        };
    expect([
        first.outputs[0]?.metadata,
        second.outputs[0]?.metadata,
    ]).toEqual([
        expect.objectContaining({
            ...matchedCanvas,
            canvasScope: 'page',
        }),
        expect.objectContaining({
            ...matchedCanvas,
            canvasScope: 'page',
        }),
    ]);
    expect(previewManifests).toEqual([
        {
            canvasScope: 'page',
            documentCanvas: DOCUMENT_CANVAS,
        },
        {
            canvasScope: 'page',
            documentCanvas: DOCUMENT_CANVAS,
        },
    ]);

    if (lossless) {
        // This is the preserveOriginalQuality row in the harness table:
        // preview reports the same free-space offset that the lossless PDF
        // assembler consumes, with pixel flooring only at the metadata
        // boundary. A sign or rounding mutation makes this identity red.
        for (const output of [
            first.outputs[0]!.metadata,
            second.outputs[0]!.metadata,
        ]) {
            const contentWidthPx = output.matchedCanvasContentWidthPx!;
            const contentHeightPx = output.matchedCanvasContentHeightPx!;
            const innerWidthPx = output.canvasWidthPx
                    - output.appliedMargins.leftPx
                    - output.appliedMargins.rightPx;
            const innerHeightPx = output.canvasHeightPx
                    - output.appliedMargins.topPx
                    - output.appliedMargins.bottomPx;
            const exportPlacement = resolveScanCleanupPlacementOffset(
                innerWidthPx - contentWidthPx,
                innerHeightPx - contentHeightPx,
                detectRequest.options.pageAlignment,
            );
            expect({
                previewX: output.placementOffsetXPx - output.appliedMargins.leftPx,
                previewY: output.placementOffsetYPx - output.appliedMargins.topPx,
                exportX: Math.floor(exportPlacement.x),
                exportY: Math.floor(exportPlacement.y),
            }).toEqual({
                previewX: Math.floor(exportPlacement.x),
                previewY: Math.floor(exportPlacement.y),
                exportX: Math.floor(exportPlacement.x),
                exportY: Math.floor(exportPlacement.y),
            });
        }
    }
}

async function runRendererCancellation(eventName: 'destroyed' | 'render-process-gone'): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const releaseLease = vi.fn(() => true);
    deps.acquirePreviewLease = vi.fn(async () => ({release: releaseLease}));
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal) => {
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    const pending = previewOf(service, owner, request);
    await entered.promise;

    expect(owner.listenerCount('destroyed')).toBe(1);
    expect(owner.listenerCount('render-process-gone')).toBe(1);
    owner.emit(eventName);

    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(owner.listenerCount('destroyed')).toBe(0);
    expect(owner.listenerCount('render-process-gone')).toBe(0);
    await vi.waitFor(async () => {
        const entries = await readdir(dir, {recursive: true});
        expect(entries.filter(entry => entry.endsWith('.png'))).toHaveLength(0);
    });
    await service.dispose();
    await expect(readdir(dir)).resolves.toHaveLength(0);
}

export async function scenarioReleasesPreviewArtifactsAfterExplicitCancellation(): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal) => {
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    const pending = previewOf(service, owner, request);
    await entered.promise;

    expect(service.cancel(owner, request)).toBe(true);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(async () => {
        const entries = await readdir(dir, {recursive: true});
        expect(entries.filter(entry => entry.endsWith('.png'))).toHaveLength(0);
        expect(entries.some(entry => entry.includes('scan-cleanup-preview-'))).toBe(false);
    });
    await service.dispose();
    await expect(readdir(dir)).resolves.toHaveLength(0);
}

export async function scenarioReleasesPreviewArtifactsWhenItsWorkingCopyCloses(): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (_binary, _manifestPath, signal) => {
        entered.resolve(undefined);
        await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        });
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = lifecycleSender();
    const pending = previewOf(service, owner, request);
    await entered.promise;

    const canceled = cancelMainOperationsForClosingWorkingCopy(
        request.sourcePdfPath,
        'Scan cleanup working copy closed',
        {isRegistrationCurrent: () => true},
    );
    expect(canceled).toHaveLength(1);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(canceled?.[0]?.settled).resolves.toBeUndefined();
    await vi.waitFor(async () => {
        const entries = await readdir(dir, {recursive: true});
        expect(entries.filter(entry => entry.endsWith('.png'))).toHaveLength(0);
        expect(entries.some(entry => entry.includes('scan-cleanup-preview-'))).toBe(false);
    });
    await service.dispose();
    await expect(readdir(dir)).resolves.toHaveLength(0);
}

export async function scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const releasePrefetch = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(releasePrefetch.promise, args[7]!);
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const prefetch = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await entered.promise;
    const visible = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });

    // The visible page does not queue behind the neighbour's raster.
    await expect(visible).resolves.toMatchObject({pageNumber: 1});
    releasePrefetch.resolve(undefined);
    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});

}

export async function scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        entered.resolve(undefined);
        await release.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const prefetch = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await entered.promise;
    const navigatedTo = previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(2),
    });

    release.resolve(undefined);
    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
    await expect(navigatedTo).resolves.toMatchObject({pageNumber: 2});

}

export async function scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'bw',
    });
    await entered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            outputMode: 'auto',
        },
        outputModeRecommendation: 'color',
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({
        pageNumber: 1,
        outputs: [{metadata: {outputMode: 'color'}}],
    });

}

export async function scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    let calls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        calls += 1;
        if (calls === 1) {
            entered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await entered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered: Array<Promise<undefined>> = [];
    const enteredPages = new Map<number, PromiseWithResolvers<undefined>>();
    deps.renderPage = vi.fn(async (_paths, _log, pageNumber, _source, _outputPath, _dpi, _env, signal) => {
        enteredPages.get(pageNumber)?.resolve(undefined);
        await waitForRelease(Promise.withResolvers<never>().promise, signal!);
    });
    for (const pageNumber of [
        1,
        2,
        3,
    ]) {
        const resolvers = Promise.withResolvers<undefined>();
        enteredPages.set(pageNumber, resolvers);
        entered.push(resolvers.promise);
    }
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pages = [
        1,
        2,
        3,
    ].map(pageNumber => previewOf(service, previewSender, {
        ...request,
        pageNumber: requirePageNumber(pageNumber),
    }));
    await Promise.all(entered);

    expect(service.cancel(previewSender, {
        ...request,
        invalidateRawCache: false,
        retainPages: [
            2,
            3,
        ],
    })).toBe(true);

    await expect(pages[0]).rejects.toMatchObject({name: 'AbortError'});
    expect(await Promise.race([
        pages[1]!.then(() => 'settled', () => 'settled'),
        Promise.resolve('pending'),
    ])).toBe('pending');
    expect(service.cancel(previewSender, request)).toBe(true);
    await expect(pages[1]).rejects.toMatchObject({name: 'AbortError'});
    await expect(pages[2]).rejects.toMatchObject({name: 'AbortError'});

}

export async function scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const entered = Promise.withResolvers<undefined>();
    deps.renderPage = vi.fn(async (_paths, _log, _page, _source, _outputPath, _dpi, _env, signal) => {
        entered.resolve(undefined);
        await waitForRelease(Promise.withResolvers<never>().promise, signal!);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const raw = previewOf(service, previewSender, {
        ...request,
        visible: true,
    });
    await entered.promise;

    service.cancel(previewSender, {
        ...request,
        invalidateRawCache: false,
        retainPages: [1],
    });
    expect(await Promise.race([
        raw.then(() => 'settled', () => 'settled'),
        Promise.resolve('pending'),
    ])).toBe('pending');

    expect(service.cancel(previewSender, request)).toBe(true);
    await expect(raw).rejects.toMatchObject({name: 'AbortError'});

}

export async function scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.detectSourceDpi = vi.fn(async () => 300);
    const baseRenderEntered = Promise.withResolvers<undefined>();
    const releaseBaseRender = Promise.withResolvers<undefined>();
    const originalSidecar = deps.runSidecar;
    let sidecarCalls = 0;
    const pendingBaseSignals: AbortSignal[] = [];
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        sidecarCalls += 1;
        if (sidecarCalls === 2) {
            pendingBaseSignals.push(args[2]);
            baseRenderEntered.resolve(undefined);
            await waitForRelease(releaseBaseRender.promise, args[2]);
        }
        await originalSidecar(...args);
    });
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        if (args[5] !== 150) {
            throw new Error('detail lane executed');
        }
        await originalRenderPage(...args);
    });
    deps.renderPagePpm = vi.fn(async () => {
        throw new Error('detail lane executed');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();

    await previewOf(service, previewSender, request);
    const pendingBase = previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    });
    await baseRenderEntered.promise;
    const detail = previewOf(service, previewSender, {
        ...request,
        detail: {
            viewports: {full: {
                xNormalized: 0.25,
                yNormalized: 0.2,
                widthNormalized: 0.5,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    });

    await expect(detail).rejects.toThrow('detail lane executed');
    expect(pendingBaseSignals[0]?.aborted).toBe(false);
    releaseBaseRender.resolve(undefined);
    await expect(pendingBase).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const rasterEntered = Promise.withResolvers<undefined>();
    const releaseRaster = Promise.withResolvers<undefined>();
    let renderCalls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renderCalls += 1;
        if (renderCalls === 1) {
            rasterEntered.resolve(undefined);
            await releaseRaster.promise;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pending = previewOf(service, previewSender, request);
    await rasterEntered.promise;

    expect(service.cancel(previewSender, request)).toBe(true);
    releaseRaster.resolve(undefined);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalSidecar = deps.runSidecar;
    const sidecarEntered = Promise.withResolvers<undefined>();
    const releaseSidecar = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn(async (...args: Parameters<typeof originalSidecar>) => {
        sidecarEntered.resolve(undefined);
        await releaseSidecar.promise;
        await originalSidecar(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const pending = previewOf(service, previewSender, request);
    await sidecarEntered.promise;

    expect(service.cancel(previewSender, request)).toBe(true);
    releaseSidecar.resolve(undefined);
    await expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await expect(previewOf(service, previewSender, {
        ...request,
        detail: {
            viewports: {full: {
                xNormalized: 0,
                yNormalized: 0,
                widthNormalized: 1,
                heightNormalized: 1,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    })).rejects.toThrow('detail geometry is unavailable');

}

export async function scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const staleEntered = Promise.withResolvers<undefined>();
    const currentEntered = Promise.withResolvers<undefined>();
    const releaseCurrent = Promise.withResolvers<undefined>();
    const currentSignals: AbortSignal[] = [];
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        const signal = args[7]!;
        if (args[3] === request.sourcePdfPath) {
            staleEntered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, signal);
            return;
        }
        currentSignals.push(signal);
        currentEntered.resolve(undefined);
        await waitForRelease(releaseCurrent.promise, signal);
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await staleEntered.promise;
    const currentRequest = {
        ...request,
        sourcePdfPath: '/replacement.pdf',
    };
    const current = previewOf(service, previewSender, currentRequest);
    await currentEntered.promise;

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    expect(service.cancel(previewSender, request)).toBe(false);
    expect(currentSignals[0]?.aborted).toBe(false);
    releaseCurrent.resolve(undefined);
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const staleEntered = Promise.withResolvers<undefined>();
    let renderCalls = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renderCalls += 1;
        if (renderCalls === 1) {
            staleEntered.resolve(undefined);
            await waitForRelease(Promise.withResolvers<never>().promise, args[7]!);
            return;
        }
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();
    const stale = previewOf(service, previewSender, request);
    await staleEntered.promise;
    const current = previewOf(service, previewSender, {
        ...request,
        documentRevision: 'revision-2',
    });

    await expect(stale).rejects.toMatchObject({name: 'AbortError'});
    await expect(current).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated(): Promise<void> {

    const {service} = await previewFixture();
    const previewSender = sender();

    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});
    service.cancel(previewSender, {
        ...request,
        invalidateRawCache: false,
    });
    await expect(previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 1,
        },
    })).resolves.toMatchObject({pageNumber: 1});

    service.cancel(previewSender, request);
    await expect(previewOf(service, previewSender, {
        ...request,
        options: {
            ...request.options,
            thickness: 2,
        },
    })).resolves.toMatchObject({pageNumber: 1});
    const rawEvents = previewSender.send.mock.calls
        .filter(([channel]) => channel === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw)
        .map(([
            , event,
        ]) => event);
    expect(rawEvents).toEqual([
        expect.objectContaining({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        }),
        expect.objectContaining({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        }),
        expect.objectContaining({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        }),
    ]);

}

export async function scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.runSidecar = vi.fn(async () => {
        throw new Error('invalid cleaned preview');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const previewSender = sender();

    await expect(previewOf(service, previewSender, {
        ...request,
        visible: true,
    })).rejects.toThrow('invalid cleaned preview');
    expect(previewSender.send).toHaveBeenCalledWith(
        SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
        expect.objectContaining({
            pageNumber: 1,
            totalPages: 3,
            rawWidthPx: 1,
            rawHeightPx: 1,
        }),
    );

}

export async function scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges(): Promise<void> {

    const {service} = await previewFixture();

    await expect(previewOf(service, sender(), request)).resolves.toMatchObject({pageNumber: 1});
    await expect(previewOf(service, sender(), {
        ...request,
        documentRevision: 'revision-2',
    })).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision(): Promise<void> {

    const {deps} = await previewDependencies();
    const statIdentities = [
        '100:1000',
        '100:1000',
        '100:2000',
    ];
    deps.getSourceStatIdentity = vi.fn(async () => statIdentities.shift() ?? '100:2000');
    const service = scanCleanupPreviewLifecycle(deps);

    const previewSender = sender();
    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});
    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});

    await expect(previewOf(service, previewSender, request)).resolves.toMatchObject({pageNumber: 1});
    expect(previewSender.send.mock.calls.filter(([channel]) => (
        channel === SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw
    ))).toHaveLength(3);

}

export async function scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const firstEntered = Promise.withResolvers<undefined>();
    const secondEntered = Promise.withResolvers<undefined>();
    const releaseSecond = Promise.withResolvers<undefined>();
    let callCount = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        callCount += 1;
        if (callCount === 1) {
            firstEntered.resolve(undefined);
            await new Promise<void>((_resolve, reject) => args[7]?.addEventListener('abort', () => reject(args[7]?.reason), {once: true}));
            return;
        }
        secondEntered.resolve(undefined);
        await releaseSecond.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const firstSender = sender(1);
    const secondSender = sender(2);
    const first = previewOf(service, firstSender, request);
    await firstEntered.promise;
    const second = previewOf(service, secondSender, {
        ...request,
        ownerId: 'preview-owner-2',
    });
    await secondEntered.promise;

    expect(service.cancel(firstSender, request)).toBe(true);
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    releaseSecond.resolve(undefined);
    await expect(second).resolves.toMatchObject({pageNumber: 1});

}

export async function scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate(): Promise<void> {

    const {deps} = await previewDependencies();
    const originalRenderPage = deps.renderPage;
    const gate = Promise.withResolvers<undefined>();
    let renders = 0;
    deps.renderPage = vi.fn(async (...args: Parameters<typeof originalRenderPage>) => {
        renders += 1;
        await gate.promise;
        await originalRenderPage(...args);
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const previewWith = (thickness: number) => previewOf(service, owner, {
        ...request,
        options: {
            ...request.options,
            thickness,
        },
    });

    // Three lingering keys for the same page, each superseding the ones
    // before it, and then a replacement that reuses the second key. The
    // lane now holds an older entry carrying the generation a counter taken
    // from the superseded list would hand to the live one.
    const first = previewWith(0);
    const second = previewWith(1);
    const third = previewWith(2);
    const replacement = previewWith(1);
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    await expect(second).rejects.toMatchObject({name: 'AbortError'});
    await expect(third).rejects.toMatchObject({name: 'AbortError'});
    await vi.waitFor(() => expect(renders).toBe(1));

    // The retired generation must not have taken the live replacement out
    // of the registry with it: an identical request adopts the run in
    // flight instead of starting a second render of the same page.
    const adopting = previewWith(1);
    expect(renders).toBe(1);
    gate.resolve(undefined);
    await expect(replacement).resolves.toMatchObject({pageNumber: 1});
    await expect(adopting).resolves.toMatchObject({pageNumber: 1});
    expect(renders).toBe(1);

}

export async function scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.prefetchLeaseTimeoutMs = 30_000;
    const admissions: Array<{
        visibility: string;
        granted: boolean;
    }> = [];
    const granted = Promise.withResolvers<undefined>();
    // One native process is free, which is what a detection run at
    // capacity-1 leaves behind: a visible request fits, a prefetch does not.
    deps.acquirePreviewLease = vi.fn(async (ownerId, visibility, signal) => {
        expect(ownerId).toBe('scan-cleanup:1:preview-owner');
        const admission = {
            visibility,
            granted: false,
        };
        admissions.push(admission);
        if (visibility === 'prefetch') {
            return new Promise<{release: () => boolean}>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException('aborted', 'AbortError'),
                ), {once: true});
            });
        }
        admission.granted = true;
        granted.resolve(undefined);
        return {release: vi.fn(() => true)};
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    // Page 1 is what the user is looking at, so page 2 is a prefetch.
    await previewOf(service, owner, {
        ...request,
        visible: true,
    });
    const prefetch = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
    });
    await vi.waitFor(() => expect(admissions).toHaveLength(2));
    // Navigating onto the prefetched page adopts its run, which is then
    // readmitted as the page the user is waiting on rather than left in a
    // queue behind detection.
    const navigated = previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        visible: true,
    });
    await granted.promise;

    await expect(prefetch).resolves.toMatchObject({pageNumber: 2});
    await expect(navigated).resolves.toMatchObject({pageNumber: 2});
    expect(admissions.map(admission => admission.visibility)).toEqual([
        'visible',
        'prefetch',
        'visible',
    ]);

}

export async function scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt(): Promise<void> {

    const {deps} = await previewDependencies();
    deps.prefetchLeaseTimeoutMs = 20;
    deps.acquirePreviewLease = vi.fn((_ownerId, visibility, signal) => {
        if (visibility === 'prefetch') {
            return new Promise<{release: () => boolean}>((_resolve, reject) => {
                signal.addEventListener('abort', () => reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : new DOMException('aborted', 'AbortError'),
                ), {once: true});
            });
        }
        return Promise.resolve({release: vi.fn(() => true)});
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    await previewOf(service, owner, {
        ...request,
        visible: true,
    });
    const prefetch = service.preview(owner, {
        ...request,
        pageNumber: requirePageNumber(2),
    });

    await expect(prefetch).resolves.toEqual({canceled: true});
    // The dropped run is not adopted by the page turn that follows it: the
    // visible request renders page 2 for itself.
    await expect(previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(2),
        visible: true,
    })).resolves.toMatchObject({pageNumber: 2});

}

export async function scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes(): Promise<void> {

    const {deps} = await previewDependencies();
    const materializing = Promise.withResolvers<undefined>();
    const finishMaterializing = Promise.withResolvers<undefined>();
    // Materialization is the one await between the run's abort check and the
    // lease it queues for, so a cancellation that lands here is the one the
    // lease has to see.
    deps.materializeWorkingCopy = vi.fn(async (sourcePdfPath: string) => {
        materializing.resolve(undefined);
        await finishMaterializing.promise;
        return {
            logicalRef: sourcePdfPath,
            physicalWorkingCopyPath: sourcePdfPath,
            sourceFingerprint: '',
        };
    });
    const acquirePreviewLease = vi.fn(async () => ({release: vi.fn(() => true)}));
    deps.acquirePreviewLease = acquirePreviewLease;
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    const pending = service.preview(owner, {
        ...request,
        visible: true,
    });
    await materializing.promise;
    expect(service.cancel(owner, request)).toBe(true);
    finishMaterializing.resolve(undefined);

    await expect(pending).resolves.toEqual({canceled: true});
    expect(acquirePreviewLease).not.toHaveBeenCalled();

}

export async function scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization(): Promise<void> {

    const {deps} = await previewDependencies();
    const materializing = Promise.withResolvers<undefined>();
    const finishMaterializing = Promise.withResolvers<undefined>();
    deps.materializeWorkingCopy = vi.fn(async () => {
        materializing.resolve(undefined);
        await finishMaterializing.promise;
        throw new Error('Working copy path is not managed by this owner');
    });
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();

    const pending = service.preview(owner, {
        ...request,
        visible: true,
    });
    await materializing.promise;
    expect(service.cancel(owner, request)).toBe(true);
    finishMaterializing.resolve(undefined);

    await expect(pending).resolves.toEqual({canceled: true});

}

export async function scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost(): Promise<void> {

    const {deps} = await previewDependencies();
    const {capacity} = mainJobBroker.getSnapshot();
    deps.getPageCount = vi.fn(async () => 8);
    deps.getPageSizes = vi.fn(async () => Array.from({length: 8}, (_, index) => ({
        ...DOCUMENT_PAGE_SIZES[0]!,
        pageNumber: index + 1,
    })));
    let liveNatives = 0;
    let peakNatives = 0;
    const trackNative = async <T>(run: () => Promise<T>) => {
        liveNatives += 1;
        peakNatives = Math.max(peakNatives, liveNatives);
        try {
            return await run();
        } finally {
            liveNatives -= 1;
        }
    };
        // Detection parks on the pages the previews never ask for, so its lease
        // is held by exactly `rasterConcurrency` live rasterisers while the page
        // switch arrives.
    const heldDetectionRasters = Promise.withResolvers<undefined>();
    const originalRenderPage = deps.renderPage;
    deps.renderPage = vi.fn((...args) => trackNative(async () => {
        if (args[2] > 3) await heldDetectionRasters.promise;
        await originalRenderPage(
            args[0],
            args[1],
            args[2],
            args[3],
            args[4],
            args[5],
            args[6],
            args[7],
        );
    }));
    const originalRunSidecar = deps.runSidecar;
    const heldPreviewSidecars = Promise.withResolvers<undefined>();
    deps.runSidecar = vi.fn((...args) => trackNative(async () => {
        const manifestPath = args[1];
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation: string;
            pages: unknown[];
        };
        if (manifest.operation !== 'analyze') {
            await heldPreviewSidecars.promise;
            await originalRunSidecar(
                args[0],
                args[1],
                args[2],
                args[3],
                args[4],
            );
            return;
        }
        await writeDetectionMetadata(manifestPath);
        for (let pageNumber = 1; pageNumber <= manifest.pages.length; pageNumber += 1) {
            args[4]({
                stage: 'page-complete',
                completedPages: pageNumber,
                totalPages: manifest.pages.length,
                pageNumber,
                classification: 'single-uncut-page',
                confidence: 0.9,
            });
        }
    }));
    const service = scanCleanupPreviewLifecycle(deps);
    const owner = sender();
    const started = await service.detectAll(owner, detectionRequest);
    await vi.waitFor(() => expect(liveNatives).toBe(capacity.nativeProcesses - 1));

    const previewPage = (pageNumber: number, visible = false) => previewOf(service, owner, {
        ...request,
        pageNumber: requirePageNumber(pageNumber),
        ...(visible ? {visible: true} : {}),
    });
    const visiblePreview = previewPage(1, true);
    // The page the user navigates onto is served while detection still holds
    // its lease: its raw raster reaches the renderer without waiting for the
    // job, and a whole sidecar run before the cleaned outputs.
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(
        SCAN_CLEANUP_PLATFORM_FEATURE.eventChannels.onPreviewRaw,
        expect.objectContaining({pageNumber: 1}),
    ));
    const prefetched = [
        previewPage(2),
        previewPage(3),
    ];
        // The visible page reaches its sidecar; the two prefetches are scheduled
        // behind the machine rather than added to it.
    await vi.waitFor(() => expect(deps.runSidecar).toHaveBeenCalledTimes(1));
    expect(liveNatives).toBe(capacity.nativeProcesses);
    expect(peakNatives).toBe(capacity.nativeProcesses);
    expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');

    heldPreviewSidecars.resolve(undefined);
    expect((await visiblePreview).pageNumber).toBe(1);
    expect(service.getDetectionJobState(owner, started.jobId, request)?.status).toBe('running');
    heldDetectionRasters.resolve(undefined);
    await vi.waitFor(() => expect(service.getDetectionJobState(
        owner,
        started.jobId,
        request,
    )?.status).toBe('completed'));
    expect((await Promise.all(prefetched)).map(result => result.pageNumber)).toEqual([
        2,
        3,
    ]);
    expect(peakNatives).toBe(capacity.nativeProcesses);

}

export async function scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument(): Promise<void> {

    const {deps} = await previewDependencies();
    const acquire = vi.spyOn(mainJobBroker, 'acquire');
    try {
        const service = scanCleanupPreviewLifecycle(deps);
        const owner = sender();
        await previewOf(service, owner, {
            ...request,
            visible: true,
        });
        await previewOf(service, owner, {
            ...request,
            pageNumber: requirePageNumber(2),
        });

        const priorities = acquire.mock.calls
            .filter(([request_]) => request_.kind === 'scan-cleanup-preview')
            .map(([request_]) => ({
                admissionClass: request_.admissionClass,
                ownerId: request_.ownerId,
                perOwnerLimit: request_.perOwnerLimit,
                priority: request_.priority,
                nativeProcesses: request_.resources.nativeProcesses,
            }));
        expect(priorities).toEqual([
            {
                admissionClass: undefined,
                ownerId: 'scan-cleanup:1:preview-owner',
                perOwnerLimit: undefined,
                priority: 'visible',
                nativeProcesses: 1,
            },
            {
                admissionClass: undefined,
                ownerId: 'scan-cleanup:1:preview-owner',
                perOwnerLimit: undefined,
                priority: 'background',
                nativeProcesses: 1,
            },
        ]);
    } finally {
        acquire.mockRestore();
    }

}

export async function scenarioTrustedMrcAutomaticBwPreview(): Promise<void> {
    await runTrustedMrcPreview('auto', 'mixed');
}

export async function scenarioTrustedMrcExplicitBwPreview(): Promise<void> {
    await runTrustedMrcPreview('bw', undefined);
}

export async function scenarioRasterCanvasCacheOrderIndependence(): Promise<void> {
    await runCanvasCacheOrderPreview(false);
}

export async function scenarioLosslessCanvasCacheOrderIndependence(): Promise<void> {
    await runCanvasCacheOrderPreview(true);
}

export async function scenarioDestroyedInFlightCancellation(): Promise<void> {
    await runRendererCancellation('destroyed');
}

export async function scenarioRenderProcessGoneInFlightCancellation(): Promise<void> {
    await runRendererCancellation('render-process-gone');
}

export async function scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem(): Promise<void> {
    const {
        dir,
        deps,
    } = await previewDependencies();
    const owner1 = lifecycleSender(101);
    const owner2 = lifecycleSender(202);
    const stores: Array<{
        store: IPdfPageSizeStore;
        closed: boolean;
        reads: number
    }> = [];
    const handles = new Set<{close: () => Promise<void>}>();
    let activeLeases = 0;
    const detailEntered = Promise.withResolvers<undefined>();
    const detailRelease = Promise.withResolvers<undefined>();
    const detectionEntered = Promise.withResolvers<undefined>();
    const detectionRelease = Promise.withResolvers<undefined>();
    const ownerOneEntered = Promise.withResolvers<undefined>();
    const ownerOneRelease = Promise.withResolvers<undefined>();
    const originalOpen = deps.fileSystem!.open;
    const originalLegacyOpen = deps.open;
    const originalSidecar = deps.runSidecar;
    let ownerOneActive = false;
    let detailMetadataPath: string | undefined;
    let detailRasterPath: string | undefined;
    let detailBasePath: string | undefined;
    let detailResultPath: string | undefined;
    let ownerTwoRasterPath: string | undefined;

    deps.detectSourceDpi = vi.fn(async () => 300);

    deps.getPageSizeStore = async () => {
        const closed = {value: false};
        let reads = 0;
        const assertOpen = () => {
            if (closed.value) throw new Error('page-size store is closed');
        };
        const store: IPdfPageSizeStore = {
            pageCount: DOCUMENT_PAGE_SIZES.length,
            getPage: async pageNumber => {
                assertOpen();
                reads += 1;
                return DOCUMENT_PAGE_SIZES[pageNumber - 1]!;
            },
            readRange: async (first, last) => {
                assertOpen();
                reads += 1;
                return DOCUMENT_PAGE_SIZES.slice(first - 1, last - 1);
            },
            forEachChunk: async onChunk => {
                assertOpen();
                reads += 1;
                await onChunk({
                    chunkIndex: 0,
                    firstPageNumber: 1,
                    pageCount: DOCUMENT_PAGE_SIZES.length,
                    offset: 0,
                    byteLength: DOCUMENT_PAGE_SIZES.length,
                    pages: DOCUMENT_PAGE_SIZES,
                });
            },
            close: async () => {
                closed.value = true;
            },
        };
        stores.push({
            store,
            get closed() { return closed.value; },
            get reads() { return reads; },
        });
        return store;
    };
    const trackHandle = async <T extends {close: () => Promise<void>}>(handle: T) => {
        const close = handle.close.bind(handle);
        let closed = false;
        handles.add(handle);
        handle.close = async () => {
            if (!closed) {
                closed = true;
                handles.delete(handle);
                await close();
            }
        };
        return handle;
    };
    deps.fileSystem = {
        ...deps.fileSystem!,
        open: async (...args) => trackHandle(await originalOpen(...args)),
    };
    deps.open = async (...args) => trackHandle(await originalLegacyOpen!(...args));
    deps.acquirePreviewLease = async (..._args) => {
        activeLeases += 1;
        let released = false;
        return {release: () => {
            if (released) {
                return false;
            }
            released = true;
            activeLeases = Math.max(0, activeLeases - 1);
            return true;
        }};
    };
    deps.acquireDetectionLease = async (..._args) => {
        activeLeases += 1;
        let released = false;
        return {release: () => {
            if (released) {
                return false;
            }
            released = true;
            activeLeases = Math.max(0, activeLeases - 1);
            return true;
        }};
    };
    deps.runSidecar = vi.fn(async (binaryPath, manifestPath, signal, log, onProgress, options) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
            operation?: string;
            pages: Array<{
                inputPath?: string;
                detailRenderPlan?: {
                    baseMetadataPath?: string;
                    baseRasterPath?: string;
                    baseCleanedRasterPath?: string;
                };
                outputs: Array<{outputPath: string}>;
            }>;
        };
        const page = manifest.pages[0]!;
        if (manifest.operation === 'analyze') {
            await writeDetectionMetadata(manifestPath);
            detectionEntered.resolve(undefined);
            await waitForRelease(detectionRelease.promise, signal);
        } else if (ownerOneActive) {
            ownerOneEntered.resolve(undefined);
            await waitForRelease(ownerOneRelease.promise, signal);
        } else if (page.detailRenderPlan !== undefined) {
            const plan = page.detailRenderPlan;
            for (const path of [
                plan.baseMetadataPath,
                plan.baseRasterPath,
                plan.baseCleanedRasterPath,
            ]) {
                if (path !== undefined) {
                    expect(path.startsWith(`${dir}/`)).toBe(true);
                }
            }
            detailMetadataPath = plan.baseMetadataPath;
            detailRasterPath = plan.baseRasterPath;
            detailBasePath = plan.baseCleanedRasterPath;
            detailEntered.resolve(undefined);
            await waitForRelease(detailRelease.promise, signal);
        } else {
            ownerTwoRasterPath = page.inputPath;
        }
        detailResultPath = page.outputs[0]?.outputPath;
        await originalSidecar(binaryPath, manifestPath, signal, log, onProgress, options);
    });

    const service = scanCleanupPreviewLifecycle(deps);
    const composedRequest = {
        ...request,
        layoutByPage: SETTLED_SINGLE_LAYOUT_BY_PAGE,
        layoutDetectionComplete: true,
    };
    await previewOf(service, owner2, composedRequest);
    const detail = previewOf(service, owner2, {
        ...composedRequest,
        requestId: requireRequestId('preview-detail-request'),
        detail: {
            viewports: {full: {
                xNormalized: 0.25,
                yNormalized: 0.2,
                widthNormalized: 0.5,
                heightNormalized: 0.45,
                rotationDegrees: 0,
            }},
            outputMode: 'bw',
        },
    });
    await detailEntered.promise;
    ownerOneActive = true;
    const ownerOnePreview = previewOf(service, owner1, {
        ...composedRequest,
        ownerId: 'owner-1',
        pageNumber: requirePageNumber(2),
    });
    await ownerOneEntered.promise;
    expect(service.cancel(owner1, {
        ownerId: 'owner-1',
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    })).toBe(true);
    await expect(ownerOnePreview).rejects.toMatchObject({name: 'AbortError'});
    const detection = await service.detectAll(owner2, detectionRequest);
    await detectionEntered.promise;
    expect(detailBasePath).toBeDefined();
    expect(ownerTwoRasterPath).toBeDefined();
    await expect(stat(ownerTwoRasterPath!)).resolves.toBeDefined();
    await expect(stat(detailMetadataPath!)).resolves.toBeDefined();
    await expect(stat(detailRasterPath!)).resolves.toBeDefined();
    await expect(stat(detailBasePath!)).resolves.toBeDefined();
    const resultStorePaths = (await readdir(dir)).filter(name => name.startsWith('scan-cleanup-results-'));
    expect(resultStorePaths).not.toHaveLength(0);
    expect(stores.some(entry => entry.reads > 0)).toBe(true);
    expect(stores.some(entry => !entry.closed)).toBe(true);
    expect(service.getDetectionJobState(owner2, detection.jobId, detectionRequest)?.status).toBe('running');
    detailRelease.resolve(undefined);
    await expect(detail).resolves.toMatchObject({pageNumber: 1});
    await service.dispose();
    expect(activeLeases).toBe(0);
    expect(handles.size).toBe(0);
    expect(stores.every(entry => entry.closed)).toBe(true);
    expect(owner1.listenerCount('destroyed')).toBe(0);
    expect(owner1.listenerCount('render-process-gone')).toBe(0);
    expect(owner2.listenerCount('destroyed')).toBe(0);
    expect(owner2.listenerCount('render-process-gone')).toBe(0);
    expect(detailResultPath).toContain(dir);
    await expect(readdir(dir)).resolves.toHaveLength(0);
}
describe('scanCleanupPreviewCompositionTest', () => {
    it('composes the public owners and exposes their disposal handoff', async () => {
        const composition = scanCleanupPreviewLifecycle(defaultDependencies);
        expect(composition).toHaveProperty('preview');
        expect(composition).toHaveProperty('detectAll');
        await expect(composition.dispose()).resolves.toBeUndefined();
    });
    it('keeps the native, filesystem, and policy capabilities composed at one boundary', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-defaults-test-'));
        try {
            const sourcePath = join(scratch, 'source.pdf');
            await writeFile(sourcePath, 'fixture');
            const entries = await defaultDependencies.fileSystem!.readdir(scratch, {withFileTypes: true});
            expect(entries.map(entry => entry.name)).toEqual(['source.pdf']);
            await expect(defaultDependencies.getSourceStatIdentity!(sourcePath)).resolves.toMatch(/^\d+:\d+$/u);
            expect(defaultDependencies.getPageSizes).toBeUndefined();
            expect(defaultDependencies.getPageSizeStore).toBeDefined();
            const rasterPolicy = defaultDependencies.resolveRasterAdmissionPolicy(true);
            expect(rasterPolicy.rasterConcurrency).toBeGreaterThan(0);
            const signal = new AbortController().signal;
            if (process.platform !== 'win32') {
                const pipePath = join(scratch, 'detection.pipe');
                await defaultDependencies.createRasterPipes!([pipePath], signal, () => undefined);
                expect((await lstat(pipePath)).isFIFO()).toBe(true);
            }
            const detectionLease = await defaultDependencies.acquireDetectionLease!(
                'scan-cleanup-defaults-test',
                signal,
                rasterPolicy,
            );
            expect(detectionLease.release()).toBe(true);
            const previewLease = await defaultDependencies.acquirePreviewLease!(
                'scan-cleanup-defaults-test',
                'visible',
                signal,
            );
            expect(previewLease.release()).toBe(true);
            expect(defaultDependencies.resolvePageOpsBinary()).toSatisfy(
                value => value === null || typeof value === 'string',
            );
            expect(defaultDependencies.resolveQpdfBinary!()).toEqual(expect.any(String));
            expect(defaultDependencies.resolvePdfInfoBinary!()).toEqual(expect.any(String));
            expect(defaultDependencies.getPdftoppmBinary()).toEqual(expect.any(String));
            expect(defaultDependencies.isRasterDetectionAvailable!()).toBeTypeOf('boolean');
            await expect(readFile(sourcePath, 'utf8')).resolves.toBe('fixture');
        } finally {
            await rm(scratch, {
                recursive: true,
                force: true,
            });
        }
    });
    it('derives raster residency from the configured canvas pixel budget', () => {
        const bilevel: TScanCleanupRasterBudgetOptions = {
            preserveOriginalQuality: false,
            outputMode: 'bw',
            pageOverrides: {},
        };
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes(bilevel)).toBe(640_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            outputMode: 'color',
        }))
            .toBe(320_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            preserveOriginalQuality: true,
        }))
            .toBe(320_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            outputMode: 'auto',
        }))
            .toBe(640_000_000);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes({
            ...bilevel,
            outputMode: 'color',
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                outputModeOverride: 'bw',
            }},
        }))
            .toBe(640_000_000);
    });
    it('caps the admitted raster budget to a low-memory broker capacity', () => {
        const capacity = {
            cpuTokens: 2,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 4,
        };
        const policy = resolveScanCleanupPreviewRasterAdmissionPolicy(
            capacity,
            false,
            {
                preserveOriginalQuality: false,
                outputMode: 'color',
                pageOverrides: {},
            },
        );
        expect(policy.rasterConcurrency).toBe(1);
        expect(policy.rasterMaxPixels).toBe(67_108_864);
        expect(resolveScanCleanupPreviewRasterSlotResidentBytes(
            undefined,
            policy.rasterMaxPixels,
        )).toBe(capacity.estimatedResidentBytes);
    });
    it('admits a low-memory preview lease with its reduced raster reservation', async () => {
        const previousCapacity = mainJobBroker.getSnapshot().capacity;
        const capacity = {
            cpuTokens: 2,
            estimatedResidentBytes: 256 * 1024 * 1024,
            nativeProcesses: 2,
            ioWeight: 4,
        };
        mainJobBroker.reconfigureCapacity(capacity);
        try {
            const signal = new AbortController().signal;
            const rasterPolicy = defaultDependencies.resolveRasterAdmissionPolicy!(false);
            const detectionLease = await defaultDependencies.acquireDetectionLease!(
                'scan-cleanup-low-memory-test',
                signal,
                rasterPolicy,
            );
            expect(detectionLease.release()).toBe(true);
            const lease = await defaultDependencies.acquirePreviewLease!(
                'scan-cleanup-low-memory-test',
                'visible',
                signal,
            );
            expect(lease.release()).toBe(true);
        } finally {
            mainJobBroker.reconfigureCapacity(previousCapacity);
        }
    });
    const scenarios = [
        [
            'visible beside adjacent prefetch',
            scenarioLetsAVisibleRequestRunBesideTheAdjacentPrefetchInsteadOfAbortingIt,
        ],
        [
            'adopt identical in-flight preview',
            scenarioAdoptsAnIdenticalInFlightPreviewInsteadOfRenderingThePageASecondTime,
        ],
        [
            'supersede Auto preview after detection',
            scenarioSupersedesAnInFlightAutoPreviewWhenDetectionResolvesAnotherOutputMode,
        ],
        [
            'supersede stale options generation',
            scenarioSupersedesAStaleOptionsGenerationForThePageItIsRendering,
        ],
        [
            'cancel pages outside navigation window',
            scenarioCancelsOnlyThePreviewPagesANavigationNoLongerWants,
        ],
        [
            'retain navigation raster until full cancellation',
            scenarioLeavesTheRasterOfARetainedNavigationAloneAndRetiresItOnAFullCancellation,
        ],
        [
            'keep detail in its own lane',
            scenarioRunsDetailTilesInASeparateLaneThatNeverCancelsTheVisibleBasePreview,
        ],
        [
            'fence invalidated raw raster publication',
            scenarioDoesNotRepublishAnInvalidatedRawRasterAfterItsRendererIgnoresCancellation,
        ],
        [
            'fence invalidated base geometry publication',
            scenarioDoesNotRepublishInvalidatedBaseGeometryAfterItsSidecarIgnoresCancellation,
        ],
        [
            'abort when the source path changes',
            scenarioAbortsACleanedRequestWhenTheSameOwnerMovesToAnotherSourcePath,
        ],
        [
            'abort when the revision changes',
            scenarioAbortsAnInFlightRequestWhenTheSameOwnerMovesToAnotherDocumentRevision,
        ],
        [
            'reuse raw raster until session invalidation',
            scenarioReusesTheRawPageRasterAcrossOptionChangesUntilTheDialogSessionIsInvalidated,
        ],
        [
            'publish raw raster before cleaned failure',
            scenarioHasAlreadyPublishedTheRawPageWhenCleanedRenderingFails,
        ],
        [
            'invalidate stale raster on revision change',
            scenarioInvalidatesAStaleRawRasterWhenTheDocumentRevisionChanges,
        ],
        [
            'invalidate stale raster on source change',
            scenarioInvalidatesAStaleRawRasterWhenTheSourceBytesChangeUnderAnUnchangedRevision,
        ],
        [
            'isolate two windows on one document',
            scenarioDoesNotCrossCancelPreviewsFromTwoWindowsOnTheSameDocument,
        ],
        [
            'keep a late replacement reachable',
            scenarioKeepsALiveReplacementReachableWhenAnOlderGenerationRetiresLate,
        ],
        [
            'readmit adopted prefetch',
            scenarioReadmitsAnAdoptedPrefetchAsTheVisiblePageAndDropsOneNothingCanAdmit,
        ],
        [
            'drop a prefetch that cannot be admitted',
            scenarioDropsAPrefetchNothingAdmitsInsteadOfLeavingThePageCommittedToIt,
        ],
        [
            'cancel during working-copy materialization',
            scenarioDoesNotQueueForAPreviewLeaseWhenTheRunIsCanceledWhileItsWorkingCopyMaterializes,
        ],
        [
            'settle after working-copy retirement',
            scenarioSettlesACanceledPreviewWhenItsWorkingCopyRegistrationDisappearsDuringMaterialization,
        ],
        [
            'schedule a page switch during detection',
            scenarioSchedulesAPageSwitchDuringDetectionInsteadOfPilingNativeProcessesOntoTheHost,
        ],
        [
            'admit visible preview ahead of prefetch',
            scenarioLeasesAVisiblePreviewAheadOfAPrefetchOfTheSameDocument,
        ],
        [
            'preserve two-owner resources through cancellation',
            scenarioPreservesComposedResourcesAcrossTwoOwnersAndDisposesThem,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});

describe('parameterized fixture executions', () => {
    const scenarios = [
        [
            'forward trusted MRC layers for automatic B/W',
            scenarioTrustedMrcAutomaticBwPreview,
        ],
        [
            'forward trusted MRC layers for explicit B/W',
            scenarioTrustedMrcExplicitBwPreview,
        ],
        [
            'keep raster canvas cache order independent',
            scenarioRasterCanvasCacheOrderIndependence,
        ],
        [
            'keep lossless canvas cache order independent',
            scenarioLosslessCanvasCacheOrderIndependence,
        ],
        [
            'cancel active work on destroyed',
            scenarioDestroyedInFlightCancellation,
        ],
        [
            'cancel active work on render-process-gone',
            scenarioRenderProcessGoneInFlightCancellation,
        ],
        [
            'release artifacts after explicit cancellation',
            scenarioReleasesPreviewArtifactsAfterExplicitCancellation,
        ],
        [
            'release artifacts when working copy closes',
            scenarioReleasesPreviewArtifactsWhenItsWorkingCopyCloses,
        ],
    ] as const;
    it.each(scenarios)('%s', async (_name, scenario) => {
        await scenario();
    });
});
