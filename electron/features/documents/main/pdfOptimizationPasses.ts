import { writeFile } from 'fs/promises';
import { join } from 'path';
import * as v from 'valibot';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import { resolveNativePageOpsPath } from '@electron/features/page-ops/public';

/**
 * The in-place passes of a raster optimization. Each rewrites what pages
 * draw, keeps every page dictionary, writes nothing when nothing got smaller,
 * and reports the pages it changed.
 */

const PASS_TIMEOUT_MS = 30 * 60 * 1000;
const PASS_MAX_STDOUT_BYTES = 64 * 1024 * 1024;
/**
 * A page or image is re-encoded only when that saves at least a tenth of its
 * bytes: a smaller gain is not worth replacing its own image with a lossy one.
 */
const MAX_BYTE_RATIO = 0.9;

const pageNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const REPLACE_PAGE_IMAGES_REPORT_SCHEMA = v.object({
    format: v.literal('evb-pdf-replace-page-images'),
    pages: v.array(v.object({
        pageNumber,
        outcome: v.picklist([
            'replaced',
            'not-smaller',
            'no-images',
            'visible-text',
            'visible-drawing',
            'form-xobject',
            'unsupported-text',
        ]),
        sourceBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
        replacementBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    })),
});
const RECOMPRESS_IMAGES_REPORT_SCHEMA = v.object({
    format: v.literal('evb-pdf-recompress-images'),
    pages: v.array(pageNumber),
});

export interface IReplacementPage {
    pageNumber: number;
    replacement: string;
    replacementPageNumber: number;
}

/**
 * How a preset recompresses the JPEG images that pages draw, such as the
 * photos of a typeset book: each is shrunk to `dpi` at the largest size a
 * page shows it and encoded again at `quality`. Text and drawings around
 * them are not touched.
 */
export interface IPdfImageRecompression {
    dpi: number;
    quality: number;
}

interface IPassCancellation {
    signal?: AbortSignal;
    cancelGroup?: string;
}

interface IPassPaths {
    input: string;
    output: string;
    scratchDir: string;
}

async function runPageOpsPass(
    command: 'replace-page-images' | 'recompress-images',
    paths: IPassPaths,
    instructions: Record<string, unknown>,
    cancellation: IPassCancellation,
): Promise<unknown> {
    const pageOpsPath = resolveNativePageOpsPath();
    if (!pageOpsPath) {
        throw new Error('Native PDF page tool is unavailable');
    }
    const instructionsPath = join(paths.scratchDir, `${command}.json`);
    await writeFile(instructionsPath, JSON.stringify({
        maxByteRatio: MAX_BYTE_RATIO,
        ...instructions,
    }), 'utf8');
    const result = await runNativeToolCommand(pageOpsPath, [
        command,
        '--input',
        paths.input,
        '--output',
        paths.output,
        '--instructions-file',
        instructionsPath,
        '--qpdf',
        getPdfNativeToolPaths().qpdf,
    ], {
        commandLabel: `evb-pdf-page-ops(${command})`,
        timeoutMs: PASS_TIMEOUT_MS,
        maxStdoutBytes: PASS_MAX_STDOUT_BYTES,
        rejectOnStdoutTruncation: true,
        ...cancellation,
    });
    return JSON.parse(result.stdout);
}

/**
 * Puts each re-encoded page into its source page when that saves enough
 * bytes. A page keeps its own content otherwise, and when it shows text or
 * vector content that its image would flatten.
 */
export async function replacePageImages(
    paths: IPassPaths,
    pages: IReplacementPage[],
    cancellation: IPassCancellation,
) {
    const report = v.parse(
        REPLACE_PAGE_IMAGES_REPORT_SCHEMA,
        await runPageOpsPass('replace-page-images', paths, {pages}, cancellation),
    );
    return report.pages
        .filter(page => page.outcome === 'replaced')
        .map(page => page.pageNumber);
}

/**
 * Recompresses the JPEG images the pages draw when that saves enough bytes.
 * `skipPages` were already re-encoded whole.
 */
export async function recompressImages(
    paths: IPassPaths,
    skipPages: number[],
    images: IPdfImageRecompression,
    cancellation: IPassCancellation,
) {
    const report = v.parse(
        RECOMPRESS_IMAGES_REPORT_SCHEMA,
        await runPageOpsPass('recompress-images', paths, {
            targetDpi: images.dpi,
            quality: images.quality,
            skipPages,
        }, cancellation),
    );
    return report.pages;
}
