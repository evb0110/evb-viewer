import {stat, statfs} from 'fs/promises';
import {clamp} from 'es-toolkit/math';
import type {IHostResourceProfileSnapshot} from '@contracts/hostResourceProfile';
import type {IExportPageSize} from '@pdf-core/imageExportResolution';
import type {IJobResourceVector} from '@electron/resources/jobBroker';
export {IMAGE_EXPORT_MAX_NETPBM_READ_BYTES} from '@pdf-core/imageExportResolution';
export type {IExportPageSize} from '@pdf-core/imageExportResolution';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const IMAGE_EXPORT_MAX_PAGE_FILE_BYTES = 512 * MIB;
const IMAGE_EXPORT_MAX_STAGED_BYTES = 2 * GIB;
const IMAGE_EXPORT_CONSTRAINED_BROKER_RESIDENT_BYTES = 2 * GIB;
const IMAGE_EXPORT_DEFAULT_PER_TASK_RESIDENT_BYTES = 512 * MIB;
const IMAGE_EXPORT_DEFAULT_MAX_CONCURRENCY = 12;
const POINTS_PER_INCH = 72;

export interface IResolveImageExportConcurrencyOptions {
    capacity: IJobResourceVector;
    hostProfile?: Pick<IHostResourceProfileSnapshot, 'logicalCpus' | 'totalRamBytes' | 'tier' | 'performanceMode'> | null;
    perTaskResidentBytes?: number;
    perTaskIoWeight?: number;
    maxConcurrency?: number;
}

/**
 * Sizes concurrent image-export page work from the main job broker capacity
 * and host profile: bounded to 1 on constrained 2-core / 4 GiB or low-tier
 * hosts, scaling smoothly on 8-32 core hosts without oversubscribing RAM,
 * native processes, or I/O slots.
 */
export function resolveImageExportConcurrency({
    capacity,
    hostProfile = null,
    perTaskResidentBytes = IMAGE_EXPORT_DEFAULT_PER_TASK_RESIDENT_BYTES,
    perTaskIoWeight = 1,
    maxConcurrency = IMAGE_EXPORT_DEFAULT_MAX_CONCURRENCY,
}: IResolveImageExportConcurrencyOptions) {
    const safeMaxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    if (
        hostProfile &&
        (hostProfile.tier === 'low' ||
            hostProfile.performanceMode === 'low' ||
            hostProfile.logicalCpus <= 2 ||
            (hostProfile.totalRamBytes > 0 && hostProfile.totalRamBytes <= 4 * GIB))
    ) {
        return 1;
    }

    if (capacity.cpuTokens <= 2 || capacity.estimatedResidentBytes <= IMAGE_EXPORT_CONSTRAINED_BROKER_RESIDENT_BYTES) {
        return 1;
    }

    const safePerTaskBytes = Math.max(1, perTaskResidentBytes);
    const safePerTaskIoWeight = Math.max(1, perTaskIoWeight);
    // Reserve one CPU token for interactive UI/main-process responsiveness.
    const cpuBound = Math.max(1, Math.floor(capacity.cpuTokens) - 1);
    const processBound = Math.max(1, Math.floor(capacity.nativeProcesses));
    const memoryBound = Math.max(1, Math.floor(capacity.estimatedResidentBytes / safePerTaskBytes));
    const ioBound = Math.max(1, Math.floor(capacity.ioWeight / safePerTaskIoWeight));

    return clamp(Math.min(cpuBound, processBound, memoryBound, ioBound), 1, safeMaxConcurrency);
}

/**
 * Maximum number of exported file paths returned through one IPC result.
 * Matches the contract collection budget so an oversized export is refused
 * instead of shipping an unbounded path array to the renderer.
 */
const IMAGE_EXPORT_MAX_OUTPUT_PATHS = 100_000;
export const IMAGE_EXPORT_OUTPUT_BUDGET_ERROR_NAME = 'ImageExportOutputBudgetError';

export class ImageExportOutputBudgetError extends RangeError {
    public constructor(pathCount: number) {
        super(`Image export produced ${pathCount} output paths, exceeding the output-path budget of ${IMAGE_EXPORT_MAX_OUTPUT_PATHS}`);
        this.name = IMAGE_EXPORT_OUTPUT_BUDGET_ERROR_NAME;
    }
}

export function assertImageExportOutputPathBudget(paths: readonly string[] | number) {
    const pathCount = typeof paths === 'number' ? paths : paths.length;
    if (pathCount > IMAGE_EXPORT_MAX_OUTPUT_PATHS) {
        throw new ImageExportOutputBudgetError(pathCount);
    }
}

export function estimateImageExportStagedBytes(pageCount: number, renderDpi: number, pageSizes: readonly IExportPageSize[]) {
    const longestSidePts = pageSizes.reduce((longestSide, pageSize) => Math.max(longestSide, pageSize.widthPts, pageSize.heightPts), 0);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1 || !Number.isFinite(renderDpi) || renderDpi <= 0 || longestSidePts <= 0) {
        return IMAGE_EXPORT_MAX_STAGED_BYTES;
    }

    const pixelsPerSide = Math.max(1, Math.ceil((longestSidePts * renderDpi) / POINTS_PER_INCH));
    const pageBytes = pixelsPerSide * pixelsPerSide * 4;
    if (!Number.isSafeInteger(pageBytes)) {
        return IMAGE_EXPORT_MAX_STAGED_BYTES;
    }
    return Math.min(IMAGE_EXPORT_MAX_STAGED_BYTES, pageBytes * pageCount);
}

export async function assertImageExportFreeSpace(directory: string, projectedBytes: number) {
    let availableBytes: number;
    try {
        const filesystem = await statfs(directory);
        availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    } catch {
        return;
    }
    if (Number.isFinite(availableBytes) && availableBytes < projectedBytes) {
        throw new RangeError(
            `Image export does not have enough free space for projected staging: requires ${projectedBytes} bytes, but only ${availableBytes} bytes are available`,
        );
    }
}

export async function validateRenderedImagePageFiles(
    pageFiles: Array<{
        page: number;
        path: string;
    }>,
) {
    let renderedBytes = 0;
    for (const pageFile of pageFiles) {
        const fileStat = await stat(pageFile.path);
        if (fileStat.size > IMAGE_EXPORT_MAX_PAGE_FILE_BYTES) {
            throw new RangeError(`Rendered page ${pageFile.page} exceeds the 512 MiB file limit`);
        }
        renderedBytes += fileStat.size;
        if (renderedBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
            throw new RangeError('Rendered image chunk exceeds the 2 GiB scratch limit');
        }
    }
}

/** Add one staged file to an accumulator shared by the required scope. */
export async function addStagedImageFileBytes(currentBytes: number, path: string, errorMessage: string) {
    const nextBytes = currentBytes + (await stat(path)).size;
    if (nextBytes > IMAGE_EXPORT_MAX_STAGED_BYTES) {
        throw new RangeError(errorMessage);
    }
    return nextBytes;
}
