import { join } from 'path';
import { app } from 'electron';
import {
    mkdir,
    rm,
} from 'fs/promises';
import { convertDjvuPageToImage } from '@electron/djvu/convert';
import { getDjvuResolution } from '@electron/djvu/metadata';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';

interface IDjvuSizeEstimate {
    subsample: number;
    label: string;
    description: string;
    resultingDpi: number;
    estimatedBytes: number;
}

const estimateCache = new Map<string, IDjvuSizeEstimate[]>();

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
            label: 'Full Quality',
            description: 'Original',
        },
        {
            subsample: 2,
            label: 'Good Quality',
            description: 'Half resolution',
        },
        {
            subsample: 4,
            label: 'Compact',
            description: 'Quarter resolution',
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
            } catch {
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
        } catch {
            // Ignore cleanup errors
        }
    }

    estimateCache.set(djvuPath, estimates);
    return estimates;
}
