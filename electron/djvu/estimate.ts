import { join } from 'path';
import { app } from 'electron';
import {
    mkdir,
    rm,
} from 'fs/promises';
import { convertDjvuPageToImage } from '@electron/djvu/convert';
import { getDjvuResolution } from '@electron/djvu/metadata';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import { te } from '@electron/i18n';
import { createLogger } from '@electron/utils/logger';

interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

const estimateCache = new Map<string, IDjvuSizeEstimate[]>();
const logger = createLogger('djvu-estimate');

export async function estimateSizes(
    djvuPath: string,
    pageCount: number,
): Promise<IDjvuSizeEstimate[]> {
    const cached = estimateCache.get(djvuPath);
    if (cached) {
        return cached;
    }

    const sourceDpi = await getDjvuResolution(djvuPath);

    // Sample a page from the middle third of the document for accurate estimation.
    // First/last pages (covers, end matter) are typically much smaller than content pages.
    const samplePage = Math.max(1, Math.floor(pageCount * 0.33));

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

    const tempDir = join(app.getPath('temp'), `djvu-estimate-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });

    const estimates: IDjvuSizeEstimate[] = [];

    try {
        for (const preset of presets) {
            const imagePath = join(tempDir, `sample-s${preset.subsample}.ppm`);
            const effectiveDpi = Math.round(sourceDpi / preset.subsample);

            try {
                const result = await convertDjvuPageToImage(
                    djvuPath,
                    imagePath,
                    samplePage,
                    `estimate-${preset.subsample}`,
                    {
                        subsample: preset.subsample > 1 ? preset.subsample : undefined,
                        format: 'ppm',
                    },
                );

                if (result.success) {
                    const pdfBytes = await buildOptimizedPdf([imagePath], effectiveDpi);

                    estimates.push({
                        subsample: preset.subsample,
                        label: preset.label,
                        description: preset.description,
                        resultingDpi: effectiveDpi,
                        estimatedBytes: Math.round(pdfBytes.length * pageCount),
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
        try {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        } catch (cleanupError) {
            logger.debug(`Failed to cleanup DjVu estimate temp dir ${tempDir}: ${String(cleanupError)}`);
        }
    }

    estimateCache.set(djvuPath, estimates);
    return estimates;
}
