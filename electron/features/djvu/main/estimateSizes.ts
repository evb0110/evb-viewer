import { join } from 'path';
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import {
    mkdtemp,
    rm,
    stat,
} from 'fs/promises';
import { sortBy } from 'es-toolkit/array';
import {
    cancelConversion,
    convertDjvuPageToImage,
    createDjvuPdfEstimateTask,
    DjvuPdfWorkerStartupError,
    getDjvuPageSizeForViewing,
} from '@electron/features/djvu/public';
import { getDjvuResolution } from '@electron/features/djvu/main/metadata';
import { buildOptimizedPdf } from '@electron/features/djvu/main/buildOptimizedPdf';
import { te } from '@electron/te';
import { createLogger } from '@electron/utils/createLogger';
import { measureElectronPerfAsync } from '@electron/utils/measureElectronPerfAsync';
import type { IDjvuSizeEstimate } from '@contracts/electronApiDjvu';
import { abortErrorFromSignal } from '@electron/utils/abort';

const logger = createLogger('djvu-estimate');
const DJVU_ESTIMATE_MAX_SAMPLE_PIXELS = 12_000_000;
const DJVU_ESTIMATE_MAX_SAMPLE_BYTES = 48 * 1024 * 1024;
const DJVU_ESTIMATE_LOCAL_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;
const DJVU_ESTIMATE_CACHE_MAX_ENTRIES = 64;
const DJVU_ESTIMATE_CACHE_TTL_MS = 10 * 60 * 1000;

interface IDjvuEstimateCacheEntry {
    estimates: IDjvuSizeEstimate[];
    cachedAt: number;
    accessedAt: number;
}

interface IDjvuEstimateInFlightEntry {
    controller: AbortController;
    promise: Promise<IDjvuSizeEstimate[]>;
    settled: boolean;
    waiterCount: number;
}

interface IDjvuEstimateOptions { signal?: AbortSignal; }

const estimateCache = new Map<string, IDjvuEstimateCacheEntry>();
const inFlightEstimates = new Map<string, IDjvuEstimateInFlightEntry>();

async function estimatePdfSizeBytes(
    imagePath: string,
    dpi: number,
    signal: AbortSignal,
) {
    return measureElectronPerfAsync('djvu:estimate-pdf-size', async () => {
        throwIfAborted(signal);
        const imageStat = await stat(imagePath);
        if (!imageStat.isFile() || imageStat.size > DJVU_ESTIMATE_MAX_SAMPLE_BYTES) {
            throw new Error('DjVu estimate sample exceeds the bounded worker input limit');
        }
        try {
            const task = createDjvuPdfEstimateTask(imagePath, dpi, { signal });
            return await task.promise;
        } catch (error) {
            if (!(error instanceof DjvuPdfWorkerStartupError)) {
                throw error;
            }
            throwIfAborted(signal);

            if (imageStat.size > DJVU_ESTIMATE_LOCAL_FALLBACK_MAX_BYTES) {
                throw new Error('DjVu estimate worker unavailable and the sample is too large for main-process fallback');
            }

            logger.warn(`DjVu PDF worker unavailable, falling back to in-process estimate build: ${error.message}`);
            const pdfBytes = await buildOptimizedPdf([imagePath], dpi, undefined, { signal });
            return pdfBytes.length;
        }
    }, {
        thresholdMs: 25,
        details: { dpi },
    });
}

function resolveEstimateRenderPlan(
    width: number,
    height: number,
    presetSubsample: number,
) {
    const requestedWidth = Math.max(1, Math.round(width / presetSubsample));
    const requestedHeight = Math.max(1, Math.round(height / presetSubsample));
    const requestedPixels = requestedWidth * requestedHeight;
    const scale = requestedPixels > DJVU_ESTIMATE_MAX_SAMPLE_PIXELS
        ? Math.sqrt(DJVU_ESTIMATE_MAX_SAMPLE_PIXELS / requestedPixels)
        : 1;
    const targetWidthPx = Math.max(1, Math.floor(requestedWidth * scale));
    const targetHeightPx = Math.max(1, Math.floor(requestedHeight * scale));
    const renderedPixels = targetWidthPx * targetHeightPx;

    return {
        pixelExpansion: requestedPixels / renderedPixels,
        targetHeightPx,
        targetWidthPx,
    };
}

function pruneEstimateCache(now = Date.now()) {
    for (const [
        cacheKey,
        entry,
    ] of estimateCache.entries()) {
        if (now - entry.cachedAt > DJVU_ESTIMATE_CACHE_TTL_MS) {
            estimateCache.delete(cacheKey);
        }
    }

    if (estimateCache.size <= DJVU_ESTIMATE_CACHE_MAX_ENTRIES) {
        return;
    }

    const sortedByLeastRecentlyUsed = sortBy(
        [...estimateCache.entries()],
        [entry => entry[1].accessedAt],
    );
    const overflowCount = estimateCache.size - DJVU_ESTIMATE_CACHE_MAX_ENTRIES;
    for (let index = 0; index < overflowCount; index += 1) {
        const entry = sortedByLeastRecentlyUsed[index];
        if (!entry) {
            break;
        }
        estimateCache.delete(entry[0]);
    }
}

function createEstimateCacheKey(djvuPath: string, pageCount: number) {
    return `${djvuPath}\u0000${pageCount}`;
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

function waitForInFlightEstimate(
    entry: IDjvuEstimateInFlightEntry,
    signal?: AbortSignal,
): Promise<IDjvuSizeEstimate[]> {
    if (signal?.aborted) {
        return Promise.reject(abortErrorFromSignal(signal));
    }

    entry.waiterCount += 1;
    return new Promise((resolve, reject) => {
        let released = false;
        let handleAbort: (() => void) | null = null;

        const release = (abortReason?: Error) => {
            if (released) {
                return;
            }
            released = true;
            if (signal && handleAbort) {
                signal.removeEventListener('abort', handleAbort);
            }
            entry.waiterCount = Math.max(0, entry.waiterCount - 1);
            if (entry.waiterCount === 0 && abortReason && !entry.settled && !entry.controller.signal.aborted) {
                entry.controller.abort(abortReason);
            }
        };

        handleAbort = () => {
            const abortReason = signal ? abortErrorFromSignal(signal) : new Error('DjVu estimate canceled');
            release(abortReason);
            reject(abortReason);
        };

        if (signal) {
            signal.addEventListener('abort', handleAbort, { once: true });
        }

        entry.promise.then(
            (estimates) => {
                release();
                resolve(estimates);
            },
            (error: unknown) => {
                release();
                reject(error);
            },
        );
    });
}

async function computeEstimateSizes(
    djvuPath: string,
    pageCount: number,
    signal: AbortSignal,
): Promise<IDjvuSizeEstimate[]> {
    throwIfAborted(signal);
    const sourceDpi = await getDjvuResolution(djvuPath, { signal });
    throwIfAborted(signal);

    // Sample a page from the middle third of the document for accurate estimation.
    // First/last pages (covers, end matter) are typically much smaller than content pages.
    const samplePage = Math.max(1, Math.floor(pageCount * 0.33));
    const samplePageSize = await getDjvuPageSizeForViewing(djvuPath, samplePage, {signal});

    const presets = [
        {
            subsample: 1,
            label: te('djvu.convertDialog.fullQuality'),
            description: te('djvu.convertDialog.original'),
        },
        {
            subsample: 2,
            label: te('djvu.convertDialog.goodQuality'),
            description: te('djvu.convertDialog.halfResolution'),
        },
        {
            subsample: 4,
            label: te('djvu.convertDialog.compact'),
            description: te('djvu.convertDialog.quarterResolution'),
        },
    ];

    const tempDir = await mkdtemp(join(app.getPath('temp'), 'djvu-estimate-'));

    const estimates: IDjvuSizeEstimate[] = [];
    const estimateJobIdPrefix = `estimate-${randomUUID()}`;
    const activeEstimateJobIds = new Set<string>();
    const cancelActiveEstimateJobs = () => {
        for (const jobId of activeEstimateJobIds) {
            void cancelConversion(jobId);
        }
    };

    try {
        signal.addEventListener('abort', cancelActiveEstimateJobs, { once: true });
        for (const preset of presets) {
            throwIfAborted(signal);
            const imagePath = join(tempDir, `sample-s${preset.subsample}.ppm`);
            const effectiveDpi = Math.round(sourceDpi / preset.subsample);
            const estimateJobId = `${estimateJobIdPrefix}-${preset.subsample}`;
            const renderPlan = resolveEstimateRenderPlan(
                samplePageSize.width,
                samplePageSize.height,
                preset.subsample,
            );

            try {
                activeEstimateJobIds.add(estimateJobId);
                const result = await convertDjvuPageToImage(
                    djvuPath,
                    imagePath,
                    samplePage,
                    estimateJobId,
                    {
                        format: 'ppm',
                        signal,
                        targetHeightPx: renderPlan.targetHeightPx,
                        targetWidthPx: renderPlan.targetWidthPx,
                    },
                );
                activeEstimateJobIds.delete(estimateJobId);
                throwIfAborted(signal);

                if (result.success) {
                    estimates.push({
                        subsample: preset.subsample,
                        label: preset.label,
                        description: preset.description,
                        resultingDpi: effectiveDpi,
                        estimatedBytes: Math.round(
                            (await estimatePdfSizeBytes(imagePath, effectiveDpi, signal))
                            * pageCount
                            * renderPlan.pixelExpansion,
                        ),
                    });
                } else {
                    estimates.push({
                        subsample: preset.subsample,
                        label: preset.label,
                        description: preset.description,
                        resultingDpi: effectiveDpi,
                        estimatedBytes: 0,
                    });
                }
            } catch (error) {
                activeEstimateJobIds.delete(estimateJobId);
                if (signal.aborted) {
                    throw abortErrorFromSignal(signal);
                }
                logger.debug(`Failed to estimate DjVu size (subsample=${preset.subsample}) for ${djvuPath}: ${String(error)}`);
                estimates.push({
                    subsample: preset.subsample,
                    label: preset.label,
                    description: preset.description,
                    resultingDpi: effectiveDpi,
                    estimatedBytes: 0,
                });
            }
        }
    } finally {
        signal.removeEventListener('abort', cancelActiveEstimateJobs);
        cancelActiveEstimateJobs();
        try {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        } catch (cleanupError) {
            logger.debug(`Failed to cleanup DjVu estimate temp dir ${tempDir}: ${String(cleanupError)}`);
        }
    }

    const cacheTimestamp = Date.now();
    estimateCache.set(createEstimateCacheKey(djvuPath, pageCount), {
        estimates,
        cachedAt: cacheTimestamp,
        accessedAt: cacheTimestamp,
    });
    pruneEstimateCache(cacheTimestamp);
    return estimates;
}

export async function estimateSizes(
    djvuPath: string,
    pageCount: number,
    options: IDjvuEstimateOptions = {},
): Promise<IDjvuSizeEstimate[]> {
    throwIfAborted(options.signal);
    const now = Date.now();
    pruneEstimateCache(now);

    const cacheKey = createEstimateCacheKey(djvuPath, pageCount);
    const cached = estimateCache.get(cacheKey);
    if (cached && now - cached.cachedAt <= DJVU_ESTIMATE_CACHE_TTL_MS) {
        cached.accessedAt = now;
        return cached.estimates;
    }
    if (cached) {
        estimateCache.delete(cacheKey);
    }

    const existing = inFlightEstimates.get(cacheKey);
    if (existing) {
        return waitForInFlightEstimate(existing, options.signal);
    }

    const controller = new AbortController();
    const entry: IDjvuEstimateInFlightEntry = {
        controller,
        promise: Promise.resolve([]),
        settled: false,
        waiterCount: 0,
    };
    entry.promise = computeEstimateSizes(djvuPath, pageCount, controller.signal)
        .finally(() => {
            entry.settled = true;
            if (inFlightEstimates.get(cacheKey) === entry) {
                inFlightEstimates.delete(cacheKey);
            }
        });
    inFlightEstimates.set(cacheKey, entry);
    return waitForInFlightEstimate(entry, options.signal);
}
