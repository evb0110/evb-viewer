import {
    dirname,
    join,
} from 'node:path';
import {runNativeCommand} from '@electron/native-tools/runNativeCommand';
import {getErrorMessage} from '@electron/utils/error';
import {readPngDimensions} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import type {TScanCleanupOpenFile} from '@evb/scan-cleanup/core/rasterLayerDimensions';
import {SCAN_CLEANUP_STREAMING_BATCH_PAGES} from '@evb/scan-cleanup/core/pageBatches';
import type {
    IScanCleanupRasterRenderLimits,
    TScanCleanupLog,
    TScanCleanupRunCommand,
} from '@evb/scan-cleanup/core/types';

const PDFTOPPM_BATCH_TIMEOUT_MS = 3 * 60 * 1_000;
// Analyze already owns a bounded 1,024-page manifest. Keeping the Poppler
// range at that same boundary removes the page-tree seek and process startup
// from every small staging window without making the detector's manifest or
// native input window larger.
const MAX_RASTER_BATCH_PAGES = SCAN_CLEANUP_STREAMING_BATCH_PAGES;

interface IScanCleanupRasterBatchTarget {
    limits: IScanCleanupRasterRenderLimits;
    outputPath: string;
    pageNumber: number;
}

interface IScanCleanupRasterBatchResult {
    height: number;
    pageNumber: number;
    width: number;
}

interface IScanCleanupRasterBatchInput {
    dpi: number;
    log: TScanCleanupLog;
    pdftoppmBinary: string;
    signal: AbortSignal;
    sourcePdfPath: string;
    targets: readonly IScanCleanupRasterBatchTarget[];
}

export interface IScanCleanupRasterBatchFileSystem {
    mkdtemp: (prefix: string) => Promise<string>;
    open: TScanCleanupOpenFile;
    readdir: (
        path: string,
        options: {withFileTypes: true},
    ) => Promise<ReadonlyArray<{
        isFile: () => boolean;
        name: string;
    }>>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    rm: (
        path: string,
        options: {
            force: boolean;
            recursive: boolean;
        },
    ) => Promise<void>;
}

function validateTargets(targets: readonly IScanCleanupRasterBatchTarget[]) {
    if (targets.length < 1 || targets.length > MAX_RASTER_BATCH_PAGES) {
        throw new RangeError(`Poppler raster batch must contain 1-${String(MAX_RASTER_BATCH_PAGES)} pages`);
    }
    for (const [
        index,
        target,
    ] of targets.entries()) {
        if (
            !Number.isSafeInteger(target.pageNumber)
            || target.pageNumber < 1
            || (index > 0 && target.pageNumber !== targets[index - 1]!.pageNumber + 1)
        ) {
            throw new RangeError('Poppler raster batch pages must be contiguous and ordered');
        }
        if (
            target.limits.expectedWidthPx > target.limits.maxDimensionPx
            || target.limits.expectedHeightPx > target.limits.maxDimensionPx
            || target.limits.expectedWidthPx * target.limits.expectedHeightPx > target.limits.maxPixels
        ) {
            throw new RangeError(`Poppler raster batch page ${String(target.pageNumber)} exceeds limits`);
        }
    }
}

export function createScanCleanupRasterBatchRenderer(
    runCommand: TScanCleanupRunCommand = runNativeCommand,
    fileSystem: IScanCleanupRasterBatchFileSystem,
) {
    return async (input: IScanCleanupRasterBatchInput): Promise<IScanCleanupRasterBatchResult[]> => {
        validateTargets(input.targets);
        const firstPage = input.targets[0]!.pageNumber;
        const lastPage = input.targets.at(-1)!.pageNumber;
        const scratch = await fileSystem.mkdtemp(
            join(dirname(input.targets[0]!.outputPath), 'pdftoppm-batch-'),
        );
        const prefix = join(scratch, 'page');
        try {
            await runCommand(input.pdftoppmBinary, [
                '-png',
                '-cropbox',
                '-r',
                String(input.dpi),
                '-f',
                String(firstPage),
                '-l',
                String(lastPage),
                input.sourcePdfPath,
                prefix,
            ], {
                commandLabel: `pdftoppm(pages=${String(firstPage)}-${String(lastPage)},dpi=${String(input.dpi)})`,
                timeoutMs: PDFTOPPM_BATCH_TIMEOUT_MS,
                signal: input.signal,
                log: input.log,
            });
            const generatedByPage = new Map<number, string>();
            for (const entry of await fileSystem.readdir(scratch, {withFileTypes: true})) {
                const match = /^page-(\d+)\.png$/u.exec(entry.name);
                if (!entry.isFile() || match === null) continue;
                generatedByPage.set(Number.parseInt(match[1]!, 10), join(scratch, entry.name));
            }
            const results: IScanCleanupRasterBatchResult[] = [];
            for (const target of input.targets) {
                const generatedPath = generatedByPage.get(target.pageNumber);
                if (generatedPath === undefined) {
                    throw new Error(`Poppler raster batch did not produce page ${String(target.pageNumber)}`);
                }
                const dimensions = await readPngDimensions(generatedPath, fileSystem.open);
                if (
                    dimensions.width > target.limits.maxDimensionPx
                    || dimensions.height > target.limits.maxDimensionPx
                    || dimensions.width * dimensions.height > target.limits.maxPixels
                ) {
                    throw new RangeError(
                        `PNG raster ${String(dimensions.width)}x${String(dimensions.height)} exceeds limits`,
                    );
                }
                await fileSystem.rename(generatedPath, target.outputPath);
                results.push({
                    height: dimensions.height,
                    pageNumber: target.pageNumber,
                    width: dimensions.width,
                });
            }
            return results;
        } finally {
            await fileSystem.rm(scratch, {
                force: true,
                recursive: true,
            }).catch(error => {
                input.log(
                    'warn',
                    `Scan cleanup could not remove raster batch scratch directory: ${getErrorMessage(error)}`,
                );
            });
        }
    };
}
