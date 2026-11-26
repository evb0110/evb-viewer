import { randomUUID } from 'node:crypto';
import {
    readFile,
    stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
    IDjvuPagePreview,
    IDjvuPagePreviewOptions,
    IDjvuPageSize,
    IDjvuPageSourceInfo,
} from '@contracts/electronApiDjvu';
import { requirePageNumber } from '@contracts/pageNumbers';
import { runDjvuEngine } from '@electron/features/djvu/main/djvuEnginePool';
import { getDjvuPageCount } from '@electron/features/djvu/main/metadata';
import {
    convertDjvuPageToImage,
    withDjvuNativeResourceLease,
} from '@electron/features/djvu/main/ddjvuConversion';
import {
    clearDjvuPageSourceInfoCacheForTests,
    getCachedDjvuPageSizes,
    getOrProbeDjvuPageSourceInfo,
    readDjvuSourceRevision,
    storeDjvuPageSourceInfos,
} from '@electron/features/djvu/main/djvuPageSourceInfoCache';
import { DJVU_PREVIEW_MAX_PIXELS } from '@electron/features/djvu/main/djvuPreviewBudget';
import {
    isNativePdfImageCombineDisabled,
    resolveNativePdfImageCombinePath,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { usingManagedScratchScope } from '@electron/utils/managedScratchTemp';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import { readPpmDimensions } from '@evb/scan-cleanup/core/rasterLayerDimensions';

const DJVU_PAGE_SIZE_TIMEOUT_MS = 30_000;
const DJVU_PAGE_SIZE_WINDOW_PAGES = 1024;
const DJVU_PREVIEW_SUBSAMPLE_MAX = 12;
const DJVU_PREVIEW_MAX_NETPBM_BYTES = 192 * 1024 * 1024;

export const DJVU_PAGE_SIZE_ARRAY_MAX_PAGES = 10_000;

export class DjvuPageSizeArrayLimitError extends Error {
    // fallow-ignore-next-line unused-class-member -- callers inspect this stable limit code after Electron IPC serialization.
    public readonly code = 'too-large' as const;

    public constructor(
        public readonly pageCount: number,
        public readonly maxPages: number = DJVU_PAGE_SIZE_ARRAY_MAX_PAGES,
    ) {
        super(
            `DjVu page-size arrays are limited to ${maxPages} pages; use windowed page-size access for ${pageCount} pages`,
        );
        this.name = 'DjvuPageSizeArrayLimitError';
    }
}

function normalizePreviewSubsample(options: IDjvuPagePreviewOptions | undefined) {
    const subsample = options?.subsample;
    if (subsample === undefined) {
        return undefined;
    }
    if (
        !Number.isFinite(subsample)
        || !Number.isInteger(subsample)
        || subsample < 1
        || subsample > DJVU_PREVIEW_SUBSAMPLE_MAX
    ) {
        throw new Error(`Invalid DjVu preview subsample value (expected 1-${DJVU_PREVIEW_SUBSAMPLE_MAX})`);
    }
    return subsample;
}

function normalizePreviewTargetWidth(options: IDjvuPagePreviewOptions | undefined) {
    const targetWidthPx = options?.targetWidthPx;
    if (targetWidthPx === undefined) {
        return undefined;
    }
    if (
        !Number.isFinite(targetWidthPx)
        || !Number.isInteger(targetWidthPx)
        || targetWidthPx < 1
    ) {
        throw new Error('Invalid DjVu preview target width value (expected a positive integer)');
    }
    return targetWidthPx;
}

function getMinimumPreviewSubsample(pageSize: Omit<IDjvuPageSize, 'dpi'> | null) {
    if (!pageSize || pageSize.width <= 0 || pageSize.height <= 0) {
        return 1;
    }
    const pixels = pageSize.width * pageSize.height;
    if (!Number.isFinite(pixels) || pixels <= DJVU_PREVIEW_MAX_PIXELS) {
        return 1;
    }
    return Math.min(
        DJVU_PREVIEW_SUBSAMPLE_MAX,
        Math.max(1, Math.ceil(Math.sqrt(pixels / DJVU_PREVIEW_MAX_PIXELS))),
    );
}

interface IDjvuPreviewRenderPlan {
    subsample: number;
    targetHeightPx?: number;
    targetWidthPx?: number;
}

function clampPreviewTargetWidth(
    requestedTargetWidth: number,
    pageSize: Omit<IDjvuPageSize, 'dpi'>,
    subsample: number,
) {
    const renderedNativeWidth = Math.max(1, Math.round(pageSize.width / subsample));
    if (requestedTargetWidth >= renderedNativeWidth) {
        return undefined;
    }
    return requestedTargetWidth;
}

interface IDjvuPagePreviewLifecycleOptions {
    cancelGroup?: string;
    onTerminationProof?: (proof: Promise<boolean>) => void;
    pageNumbers?: readonly number[];
    signal?: AbortSignal;
}

interface IDjvuPageSizeWindow {
    firstPage: number;
    sizes: IDjvuPageSize[];
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
    }
}

async function resolvePreviewRenderPlan(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewOptions | undefined,
    lifecycleOptions: IDjvuPagePreviewLifecycleOptions,
): Promise<IDjvuPreviewRenderPlan> {
    const requestedSubsample = normalizePreviewSubsample(options) ?? 1;
    const requestedTargetWidth = normalizePreviewTargetWidth(options);
    const pageSize = await getDjvuPageSizeForViewing(djvuPath, pageNumber, lifecycleOptions).catch((error: unknown) => {
        if (getUnprovenNativeTerminationDetail(error) !== undefined) {
            throw error;
        }
        return null;
    });
    const subsample = Math.max(requestedSubsample, getMinimumPreviewSubsample(pageSize));
    if (!pageSize || requestedTargetWidth === undefined) {
        return { subsample };
    }

    const targetWidthPx = clampPreviewTargetWidth(requestedTargetWidth, pageSize, subsample);
    if (targetWidthPx === undefined) {
        return { subsample };
    }

    return {
        subsample,
        targetHeightPx: Math.max(1, Math.round(targetWidthPx * pageSize.height / pageSize.width)),
        targetWidthPx,
    };
}

async function assertPreviewNetpbmReadSafe(ppmPath: string) {
    const ppmStat = await stat(ppmPath);
    if (!ppmStat.isFile()) {
        throw new Error(`DjVu preview output is not a regular file: ${ppmPath}`);
    }
    if (ppmStat.size > DJVU_PREVIEW_MAX_NETPBM_BYTES) {
        const maxMb = Math.floor(DJVU_PREVIEW_MAX_NETPBM_BYTES / (1024 * 1024));
        throw new Error(`DjVu preview output exceeds safe read limit (${maxMb}MB): ${ppmPath}`);
    }
}

function normalizeRequestedPageNumbers(
    pageNumbers: readonly number[] | undefined,
    expectedPageCount: number,
) {
    if (pageNumbers === undefined) {
        return null;
    }
    const uniquePageNumbers = [...new Set(pageNumbers)];
    if (uniquePageNumbers.some(pageNumber => (
        !Number.isSafeInteger(pageNumber)
        || pageNumber < 1
        || pageNumber > expectedPageCount
    ))) {
        throw new Error(`Requested DjVu page numbers must be between 1 and ${expectedPageCount}`);
    }
    uniquePageNumbers.sort((left, right) => left - right);
    return uniquePageNumbers;
}

function* iterateRequestedPageRanges(pageNumbers: readonly number[]) {
    if (pageNumbers.length === 0) {
        return;
    }
    let firstPage = pageNumbers[0]!;
    let lastPage = firstPage;
    for (const pageNumber of pageNumbers.slice(1)) {
        if (
            pageNumber === lastPage + 1
            && pageNumber - firstPage < DJVU_PAGE_SIZE_WINDOW_PAGES
        ) {
            lastPage = pageNumber;
            continue;
        }
        yield [
            firstPage,
            lastPage,
        ] as const;
        firstPage = pageNumber;
        lastPage = pageNumber;
    }
    yield [
        firstPage,
        lastPage,
    ] as const;
}

export async function getDjvuPageSourceInfoForViewing(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
): Promise<IDjvuPageSourceInfo> {
    throwIfAborted(options.signal);
    const sourceRevision = await readDjvuSourceRevision(djvuPath);
    throwIfAborted(options.signal);
    return getOrProbeDjvuPageSourceInfo(
        djvuPath,
        sourceRevision.revision,
        pageNumber,
        async (documentInfo) => {
            const runProbe = async (onTerminationProof?: (proof: Promise<boolean>) => void) => {
                let pageCount: number;
                if (documentInfo) {
                    pageCount = documentInfo.pageCount;
                } else {
                    pageCount = await getDjvuPageCount(djvuPath, {
                        ...(options.signal ? { signal: options.signal } : {}),
                        ...(onTerminationProof ? { onTerminationProof } : {}),
                    });
                }
                throwIfAborted(options.signal);
                if (pageCount < 1) {
                    throw new Error('DjVu document has no pages');
                }
                const effectivePageNumber = Math.min(pageNumber, pageCount);
                const pageSizes = await runDjvuEngine<'getPageSizes'>({
                    type: 'getPageSizes',
                    djvuPath,
                    pageNumbers: [effectivePageNumber],
                }, {
                    ...(options.signal ? { signal: options.signal } : {}),
                    timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
                });
                throwIfAborted(options.signal);
                const pageSize = pageSizes[0];
                if (!pageSize) {
                    throw new Error(`DjVu page size probe returned no size for page ${effectivePageNumber}`);
                }
                return {
                    pageCount,
                    pageNumber: requirePageNumber(effectivePageNumber, pageCount),
                    pageSize,
                    sourceSize: sourceRevision.sourceSize,
                    sourceModifiedAt: sourceRevision.sourceModifiedAt,
                };
            };
            if (options.onTerminationProof !== undefined) {
                return runProbe(options.onTerminationProof);
            }
            return withDjvuNativeResourceLease({
                jobId: `djvu-page-source-info:${djvuPath}`,
                kind: 'metadata',
                ...(options.signal ? { signal: options.signal } : {}),
                task: (onTerminationProof) => runProbe(onTerminationProof),
            });
        },
    );
}

export async function getDjvuPageSizeForViewing(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
) {
    return (await getDjvuPageSourceInfoForViewing(djvuPath, pageNumber, options)).pageSize;
}

export async function getDjvuPageSizesForViewing(
    djvuPath: string,
    expectedPageCount: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
): Promise<IDjvuPageSize[]> {
    if (expectedPageCount > DJVU_PAGE_SIZE_ARRAY_MAX_PAGES) {
        throw new DjvuPageSizeArrayLimitError(expectedPageCount);
    }
    throwIfAborted(options.signal);
    const sourceRevision = await readDjvuSourceRevision(djvuPath);
    throwIfAborted(options.signal);
    const cachedSizes = getCachedDjvuPageSizes(
        djvuPath,
        sourceRevision.revision,
        expectedPageCount,
    );
    if (cachedSizes) {
        return cachedSizes;
    }
    const sizes = await runDjvuEngine<'getPageSizes'>({
        type: 'getPageSizes',
        djvuPath,
    }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
    });
    throwIfAborted(options.signal);
    if (sizes.length !== expectedPageCount) {
        throw new Error(`DjVu page size probe returned ${sizes.length} page(s), expected ${expectedPageCount}`);
    }
    storeDjvuPageSourceInfos(
        djvuPath,
        sourceRevision.revision,
        sizes.map((pageSize, index) => ({
            pageCount: expectedPageCount,
            pageNumber: requirePageNumber(index + 1, expectedPageCount),
            pageSize,
            sourceSize: sourceRevision.sourceSize,
            sourceModifiedAt: sourceRevision.sourceModifiedAt,
        })),
    );
    return sizes;
}

async function* getDjvuPageSizeWindowsForViewingInternal(
    djvuPath: string,
    expectedPageCount: number,
    options: IDjvuPagePreviewLifecycleOptions,
): AsyncGenerator<IDjvuPageSizeWindow> {
    if (!Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1) {
        throw new Error('expectedPageCount must be a positive safe integer');
    }

    throwIfAborted(options.signal);
    await readDjvuSourceRevision(djvuPath);
    throwIfAborted(options.signal);

    const runWindow = async (firstPage: number, lastPage: number) => {
        throwIfAborted(options.signal);
        const pageNumbers = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage + i);
        const sizes = await runDjvuEngine<'getPageSizes'>({
            type: 'getPageSizes',
            djvuPath,
            pageNumbers,
        }, {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
        });
        if (sizes.length !== pageNumbers.length) {
            throw new Error(
                `DjVu page size probe returned ${sizes.length} page(s) for ${firstPage}-${lastPage}, expected ${pageNumbers.length}`,
            );
        }
        return sizes;
    };

    const requestedPageNumbers = normalizeRequestedPageNumbers(options.pageNumbers, expectedPageCount);
    if (requestedPageNumbers) {
        for (const [
            firstPage,
            lastPage,
        ] of iterateRequestedPageRanges(requestedPageNumbers)) {
            yield {
                firstPage,
                sizes: await runWindow(firstPage, lastPage),
            };
        }
        return;
    }

    for (let firstPage = 1; firstPage <= expectedPageCount;) {
        const lastPage = Math.min(expectedPageCount, firstPage + DJVU_PAGE_SIZE_WINDOW_PAGES - 1);
        yield {
            firstPage,
            sizes: await runWindow(firstPage, lastPage),
        };
        firstPage = lastPage + 1;
    }
}

export function getDjvuPageSizeWindowsForViewing(
    djvuPath: string,
    expectedPageCount: number,
    options: IDjvuPagePreviewLifecycleOptions = {},
) {
    return getDjvuPageSizeWindowsForViewingInternal(djvuPath, expectedPageCount, options);
}

export function clearDjvuPageSizeCacheForTests() {
    clearDjvuPageSourceInfoCacheForTests();
}

export async function renderDjvuPagePreview(
    djvuPath: string,
    pageNumber: number,
    options?: IDjvuPagePreviewOptions,
    lifecycleOptions: IDjvuPagePreviewLifecycleOptions = {},
): Promise<IDjvuPagePreview> {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error(`Invalid DjVu page number: ${pageNumber}`);
    }
    const renderPlan = await resolvePreviewRenderPlan(djvuPath, pageNumber, options, lifecycleOptions);

    return usingManagedScratchScope('djvu-image-export-', getAppTempDir(), async (tempDir) => {
        const ppmPath = join(tempDir, `page-${pageNumber}-${randomUUID()}.ppm`);
        const pngPath = join(tempDir, `page-${pageNumber}-${randomUUID()}.png`);

        throwIfAborted(lifecycleOptions.signal);
        const processId = lifecycleOptions.cancelGroup ?? `djvu-preview-page-${pageNumber}-${randomUUID()}`;
        const result = await convertDjvuPageToImage(
            djvuPath,
            ppmPath,
            pageNumber,
            processId,
            {
                format: 'ppm',
                ...(renderPlan.subsample > 1 ? { subsample: renderPlan.subsample } : {}),
                ...(renderPlan.targetWidthPx && renderPlan.targetHeightPx
                    ? {
                        targetHeightPx: renderPlan.targetHeightPx,
                        targetWidthPx: renderPlan.targetWidthPx,
                    }
                    : {}),
                ...(lifecycleOptions.signal ? { signal: lifecycleOptions.signal } : {}),
                ...(lifecycleOptions.onTerminationProof ? { onTerminationProof: lifecycleOptions.onTerminationProof } : {}),
            },
        );
        if (getUnprovenNativeTerminationDetail(result.cause) !== undefined) throw result.cause;
        throwIfAborted(lifecycleOptions.signal);
        if (!result.success) {
            throw new Error(result.error ?? `Failed to render DjVu page ${pageNumber}`);
        }

        await assertPreviewNetpbmReadSafe(ppmPath);
        throwIfAborted(lifecycleOptions.signal);
        const nativeEncoderPath = isNativePdfImageCombineDisabled() ? null : resolveNativePdfImageCombinePath();
        if (!nativeEncoderPath) {
            throw new Error('Native DjVu preview encoding is unavailable; the large Netpbm fallback is intentionally disabled');
        }
        const {
            height,
            width,
        } = await readPpmDimensions(ppmPath);
        if (width * height > DJVU_PREVIEW_MAX_PIXELS) {
            throw new Error(
                `DjVu preview of page ${pageNumber} is ${width}x${height}, above the ${DJVU_PREVIEW_MAX_PIXELS} pixel preview limit`,
            );
        }
        await runNativeToolCommand(nativeEncoderPath, [
            '--output',
            pngPath,
            '--format',
            'png',
            '--',
            ppmPath,
        ], {
            commandLabel: 'evb-pdf-image-combine(djvu-preview)',
            ...(lifecycleOptions.signal ? { signal: lifecycleOptions.signal } : {}),
            ...(lifecycleOptions.onTerminationProof ? { onTerminationProof: lifecycleOptions.onTerminationProof } : {}),
            timeoutMs: 60_000,
        });
        return {
            bytes: await readFile(pngPath),
            height,
            width,
        };
    });
}
