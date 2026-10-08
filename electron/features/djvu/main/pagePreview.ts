import { randomUUID } from 'crypto';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {
    readFile,
    stat,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
    IDjvuPagePreview,
    IDjvuPagePreviewOptions,
    IDjvuPageSize,
    IDjvuPageSourceInfo,
} from '@contracts/electronApiDjvu';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    getDjvuPageCount,
    getDjvuResolution,
} from '@electron/features/djvu/main/metadata';
import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {
    getDjvuNativeToolPaths,
    runDjvuSourceCommand,
} from '@electron/features/djvu/main/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    isNativePdfImageCombineDisabled,
    resolveNativePdfImageCombinePath,
} from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { convertDjvuPageToImage } from '@electron/features/djvu/main/ddjvuConversion';
import { readPpmDimensions } from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {
    clearDjvuPageSourceInfoCacheForTests,
    getCachedDjvuPageSizes,
    getOrProbeDjvuPageSourceInfo,
    readDjvuSourceRevision,
    storeDjvuPageSourceInfos,
} from '@electron/features/djvu/main/djvuPageSourceInfoCache';

const DJVU_PAGE_SIZE_TIMEOUT_MS = 30_000;
const DJVU_PAGE_SIZE_MAX_STDOUT_BYTES = 1_048_576;
const DJVU_PAGE_SIZE_WINDOW_PAGES = 256;
const DJVU_PREVIEW_SUBSAMPLE_MAX = 12;
const DJVU_PREVIEW_MAX_PIXELS = 45_000_000;
const DJVU_PREVIEW_MAX_NETPBM_BYTES = 192 * 1024 * 1024;

// The legacy page-size API returns one object per page. Keep that compatibility
// result bounded; callers that need larger documents must use the windowed API.
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

function parsePositiveInteger(value: string | undefined) {
    if (!value) {
        return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
    if (!pageSize) {
        return 1;
    }
    if (pageSize.width <= 0 || pageSize.height <= 0) {
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

    // ddjvu's over-native `-size` path softens text on low-resolution scans.
    // Downsample in the native process when the viewport needs fewer pixels so
    // rapid scrolling does not decode every preview at archival resolution.
    return requestedTargetWidth;
}

async function resolvePreviewRenderPlan(
    djvuPath: string,
    pageNumber: number,
    options: IDjvuPagePreviewOptions | undefined,
    lifecycleOptions: IDjvuPagePreviewLifecycleOptions,
): Promise<IDjvuPreviewRenderPlan> {
    const requestedSubsample = normalizePreviewSubsample(options) ?? 1;
    const requestedTargetWidth = normalizePreviewTargetWidth(options);
    const pageSize = await getDjvuPageSizeForViewing(djvuPath, pageNumber, lifecycleOptions).catch(() => null);
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

function parseSizeLine(line: string): Omit<IDjvuPageSize, 'dpi'> | null {
    const attributeMatch = line.match(/\bwidth=(\d+)\b.*\bheight=(\d+)\b/iu);
    const pairMatch = attributeMatch ?? line.match(/\b(\d+)\s*x\s*(\d+)\b/iu) ?? line.match(/^\s*(\d+)\s+(\d+)\s*$/u);
    const width = parsePositiveInteger(pairMatch?.[1]);
    const height = parsePositiveInteger(pairMatch?.[2]);
    if (width === null || height === null) {
        return null;
    }
    return {
        width,
        height,
    };
}

export function parseDjvuPageSizeOutput(stdout: string, dpi: number): IDjvuPageSize[] {
    return stdout
        .split(/\r?\n/u)
        .flatMap((line) => {
            const size = parseSizeLine(line);
            return size ? [size] : [];
        })
        .map(size => ({
            ...size,
            dpi,
        }));
}

interface IDjvuPagePreviewLifecycleOptions {
    cancelGroup?: string;
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

async function probeDjvuPageSize(
    djvuPath: string,
    pageNumber: number,
    dpi: number,
    options: IDjvuPagePreviewLifecycleOptions,
) {
    throwIfAborted(options.signal);
    const { djvused } = getDjvuNativeToolPaths();
    const result = await runDjvuSourceCommand(djvused, [
        djvuPath,
        '-e',
        `select ${pageNumber}; size`,
    ], 0, {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
        maxStdoutBytes: DJVU_PAGE_SIZE_MAX_STDOUT_BYTES,
        commandLabel: 'djvused(page-size)',
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
        rejectOnStdoutTruncation: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
    });
    throwIfAborted(options.signal);
    return parseDjvuPageSizeOutput(result.stdout, dpi)[0] ?? null;
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
            const metadataOptions = options.signal ? {signal: options.signal} : {};
            const [
                pageCount,
                dpi,
            ] = documentInfo
                ? [
                    documentInfo.pageCount,
                    documentInfo.dpi,
                ]
                : await Promise.all([
                    getDjvuPageCount(djvuPath, metadataOptions),
                    getDjvuResolution(djvuPath, metadataOptions),
                ]);
            throwIfAborted(options.signal);
            if (pageCount < 1) {
                throw new Error('DjVu document has no pages');
            }
            const effectivePageNumber = Math.min(pageNumber, pageCount);
            const pageSize = await probeDjvuPageSize(djvuPath, effectivePageNumber, dpi, options);
            throwIfAborted(options.signal);
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
    const sizes: IDjvuPageSize[] = [];
    const {
        pageNumbers: _pageNumbers,
        ...fullScanOptions
    } = options;
    for await (const window of getDjvuPageSizeWindowsForViewingInternal(
        djvuPath,
        expectedPageCount,
        fullScanOptions,
        sourceRevision,
    )) {
        sizes.push(...window.sizes);
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

function createPageSizeWindowScript(firstPage: number, lastPage: number) {
    let script = '';
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
        if (script.length > 0) {
            script += '; ';
        }
        script += `select ${pageNumber}; size`;
    }
    return script;
}

async function* getDjvuPageSizeWindowsForViewingInternal(
    djvuPath: string,
    expectedPageCount: number,
    options: IDjvuPagePreviewLifecycleOptions,
    knownSourceRevision?: Awaited<ReturnType<typeof readDjvuSourceRevision>>,
): AsyncGenerator<IDjvuPageSizeWindow> {
    if (!Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1) {
        throw new Error('expectedPageCount must be a positive safe integer');
    }

    throwIfAborted(options.signal);
    if (knownSourceRevision === undefined) {
        await readDjvuSourceRevision(djvuPath);
    }
    const dpi = await getDjvuResolution(djvuPath, options.signal ? { signal: options.signal } : {});
    throwIfAborted(options.signal);
    const { djvused } = getDjvuNativeToolPaths();

    const runWindow = async (firstPage: number, lastPage: number) => {
        throwIfAborted(options.signal);
        const result = await runDjvuSourceCommand(djvused, [
            djvuPath,
            '-e',
            createPageSizeWindowScript(firstPage, lastPage),
        ], 0, {
            env: buildDjvuRuntimeEnv(),
            timeoutMs: DJVU_PAGE_SIZE_TIMEOUT_MS,
            maxStdoutBytes: DJVU_PAGE_SIZE_MAX_STDOUT_BYTES,
            commandLabel: 'djvused(size-window)',
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            includeProcessEnv: true,
            windowsHide: true,
            rejectOnStdoutTruncation: true,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.cancelGroup ? { cancelGroup: options.cancelGroup } : {}),
        });
        throwIfAborted(options.signal);
        const sizes = parseDjvuPageSizeOutput(result.stdout, dpi);
        const expectedWindowPageCount = lastPage - firstPage + 1;
        if (sizes.length !== expectedWindowPageCount) {
            throw new Error(
                `DjVu page size probe returned ${sizes.length} page(s) for ${firstPage}-${lastPage}, expected ${expectedWindowPageCount}`,
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

    return usingManagedScratchScope('djvu-image-export-', tmpdir(), async (tempDir) => {
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
        // The encoder writes the raster at its own size, so the bounded header
        // read gives the preview dimensions without a full-raster probe.
        const {
            height,
            width,
        } = await readPpmDimensions(ppmPath);
        await runNativeToolCommand(nativeEncoderPath, [
            '--output',
            pngPath,
            '--format',
            'png',
            '--',
            ppmPath,
        ], {
            commandLabel: 'evb-pdf-image-combine(djvu-preview)',
            ...(lifecycleOptions.signal ? {signal: lifecycleOptions.signal} : {}),
            timeoutMs: 60_000,
        });
        return {
            bytes: await readFile(pngPath),
            height,
            width,
        };
    });
}
