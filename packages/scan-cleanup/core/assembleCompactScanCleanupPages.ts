import * as v from 'valibot';
import {PDF_ANNOTATION_INDEX_SIDECAR_HEADER_SCHEMA} from '@contracts/pdfAnnotationParseSchemas';
import {decodeScanCleanupPageOpsResult} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {createReadStream} from 'node:fs';
import {isRecord} from '@contracts/runtimeGuards';
import {createScanCleanupSidecarProtocolHandler} from '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler';
import {
    rename,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    TScanCleanupLog,
    IRunScanCleanupPipelineDependencies,
    IScanCleanupWorkerPaths,
    IScanCleanupRunCommandOptions,
} from '@evb/scan-cleanup/core/types';
import type {IScanCleanupRenderedOutput} from '@evb/scan-cleanup/core/scanCleanupOutputComposition';
import {
    buildScanCleanupPageOpsInstructions,
    serializeLegacyScanCleanupPageOpsInstructions,
    serializeScanCleanupPageOpsInstructions,
    serializeScanCleanupTextLayerInstructions,
    isScanCleanupCliFallbackSentinel,
} from '@evb/scan-cleanup/core/compactManifest';
import type {IScanCleanupTextLayerPlan} from '@evb/scan-cleanup/core/sourceTextLayer';
import {
    ScanCleanupContractError, ScanCleanupNativeToolUnavailableError,
} from '@evb/scan-cleanup/core/errors';

export type IRenderedCleanupOutputPage = IScanCleanupRenderedOutput<string>;

function appendQpdfPageSelection(
    args: string[],
    path: string,
    firstPage: number,
    lastPage: number,
) {
    args.push(path, firstPage === lastPage
        ? String(firstPage)
        : `${String(firstPage)}-${String(lastPage)}`);
}

/** Non-affine pixels cannot inherit positioned annotations without data loss. */
async function assertSourceAnnotationsHaveGeometry(
    pages: readonly number[],
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    scratch: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    dependencies: IRunScanCleanupPipelineDependencies,
    onTerminationProof?: IScanCleanupRunCommandOptions['onTerminationProof'],
) {
    if (pages.length === 0) return;
    if (!paths.pdfPageOpsBinary || isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)) {
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
    }
    const sourcePagesPath = join(scratch, 'source-annotation-pages.pdf');
    await dependencies.runCommand(paths.qpdfBinary, [
        '--empty',
        '--pages',
        preparedPdfPath,
        pages.join(','),
        '--',
        sourcePagesPath,
    ], {
        signal,
        log,
        ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
        commandLabel: 'qpdf(scan-cleanup:refused-annotation-pages)',
        timeoutMs: 10 * 60 * 1000,
    });
    // Every annotation the pages carry, links and form fields included: the
    // editor's parser leaves those out, and none survives non-affine geometry.
    const sidecarPath = join(scratch, 'source-annotations.jsonl');
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'annotation-index',
        '--input',
        sourcePagesPath,
        '--qpdf',
        paths.qpdfBinary,
        '--output',
        sidecarPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(annotation-index:scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        log,
        ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
    });
    const source = createReadStream(sidecarPath, {signal});
    let protocolError: Error | undefined;
    const protocol = createScanCleanupSidecarProtocolHandler({
        stdout: source,
        stderr: undefined,
        onProtocolError: error => { protocolError = error; },
        log,
    });
    source.on('error', error => protocol.failProtocol(error, '[annotation sidecar read failed]'));
    let headerRead = false;
    let expectedChunkIndex = 0;
    try {
        for await (const line of protocol.lines) {
            signal.throwIfAborted();
            const value: unknown = JSON.parse(line);
            if (!headerRead) {
                if (!v.safeParse(PDF_ANNOTATION_INDEX_SIDECAR_HEADER_SCHEMA, value).success) {
                    throw new ScanCleanupContractError('Invalid source annotation header');
                }
                headerRead = true;
                continue;
            }
            if (!isRecord(value) || !Array.isArray(value.entries)
                || value.chunkIndex !== expectedChunkIndex
                || Object.keys(value).some(key => key !== 'chunkIndex' && key !== 'entries')) {
                throw new ScanCleanupContractError('Invalid source annotation chunk');
            }
            expectedChunkIndex += 1;
            for (const entry of value.entries) {
                const pageNumber = isRecord(entry) && typeof entry.pageIndex === 'number' ? pages[entry.pageIndex] : undefined;
                if (pageNumber === undefined) throw new ScanCleanupContractError('Invalid source annotation page index');
                throw new ScanCleanupContractError(
                    `Cannot preserve annotations on source page ${String(pageNumber)} `
                    + 'without affine cleanup geometry. Disable dewarping or preserve original quality.',
                );
            }
        }
        if (protocolError) throw protocolError;
        if (!headerRead) throw new ScanCleanupContractError('Missing source annotation header');
    } finally {
        protocol.lines.close();
        source.destroy();
    }
}

/**
 * Overlay the source's text and annotations once over the staged output, where
 * every destination resolves. Link-only pages copy nothing but name targets.
 */
export async function overlayScanCleanupTextLayer(
    pages: IScanCleanupTextLayerPlan['pages'],
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    stagedPdfPath: string,
    scratch: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    dependencies: IRunScanCleanupPipelineDependencies,
    onTerminationProof?: IScanCleanupRunCommandOptions['onTerminationProof'],
    provenanceStampHex?: string,
) {
    // Every output participates in the final catalog map, including non-affine rasters.
    if (pages.length === 0) return null;
    if (paths.pdfPageOpsBinary === undefined || isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)) {
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
    }
    const textLayerInstructionsPath = join(scratch, 'source-text-layer.json');
    const textLayerPdfPath = join(scratch, 'text-layer-cleaned.pdf');
    await writeFile(
        textLayerInstructionsPath,
        serializeScanCleanupTextLayerInstructions(pages, paths.provenanceStampSupport === false ? undefined : provenanceStampHex),
    );
    const pageOps = await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'overlay-text',
        '--input',
        stagedPdfPath,
        '--source',
        preparedPdfPath,
        '--qpdf',
        paths.qpdfBinary,
        '--output',
        textLayerPdfPath,
        '--instructions-file',
        textLayerInstructionsPath,
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(overlay-text:scan-cleanup)',
        timeoutMs: 10 * 60 * 1000,
        log,
        ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
    });
    await rename(textLayerPdfPath, stagedPdfPath);
    log(
        'debug',
        `Scan cleanup retained source text and annotations on ${String(pages.length)} output page(s)`,
    );
    return decodeScanCleanupPageOpsResult(pageOps.stdout);
}

export async function assembleWithCompactSourcePages(
    outputPages: readonly IRenderedCleanupOutputPage[],
    paths: IScanCleanupWorkerPaths,
    preparedPdfPath: string,
    rasterizedPdfPath: string,
    stagedPdfPath: string,
    scratch: string,
    signal: AbortSignal,
    log: TScanCleanupLog,
    dependencies: IRunScanCleanupPipelineDependencies,
    provenanceStampHex: string | undefined,
    textLayerPlan: IScanCleanupTextLayerPlan,
    onTerminationProof?: IScanCleanupRunCommandOptions['onTerminationProof'],
) {
    await assertSourceAnnotationsHaveGeometry(
        textLayerPlan.skippedNonAffine, paths, preparedPdfPath, scratch, signal, log, dependencies, onTerminationProof,
    );
    const preservedPages = outputPages.flatMap(output => (
        output.preservedSource === undefined ? [] : [output.preservedSource]
    ));
    if (preservedPages.length === 0) {
        if (rasterizedPdfPath !== stagedPdfPath) {
            await rename(rasterizedPdfPath, stagedPdfPath);
        }
    } else {
        if (!paths.pdfPageOpsBinary) {
            throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
        }
        const instructionsPath = join(scratch, 'preserved-source-pages.json');
        const preservedPdfPath = join(scratch, 'preserved-source-pages.pdf');
        const instructions = buildScanCleanupPageOpsInstructions(preservedPages.map(page => ({
            sourcePageIndex: page.sourcePageIndex,
            rotationQuarterTurns: page.rotationQuarterTurns,
            outputs: [{
                cropRect: page.cropRect,
                contentTransform: page.contentTransform,
            }],
        })), provenanceStampHex, 'assembly');
        await writeFile(
            instructionsPath,
            paths.provenanceStampSupport === false
                ? serializeLegacyScanCleanupPageOpsInstructions(instructions)
                : serializeScanCleanupPageOpsInstructions(instructions),
        );
        await dependencies.runCommand(paths.pdfPageOpsBinary, [
            'split-pages',
            '--input',
            preparedPdfPath,
            '--qpdf',
            paths.qpdfBinary,
            '--output',
            preservedPdfPath,
            '--instructions-file',
            instructionsPath,
        ], {
            signal,
            commandLabel: 'evb-pdf-page-ops(split-pages:compact-scan-cleanup-pages)',
            timeoutMs: 10 * 60 * 1000,
            log,
            ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
        });

        const qpdfArgs = [
            // The preserved split is the primary input: it carries the output's
            // catalog and provenance stamp, and each note is copied once.
            preservedPdfPath,
            // Some otherwise capable PDF consumers only render the first stream in
            // a page Contents array. split-pages wraps preserved source content in
            // separate graphics-state streams, so leaving the array intact can make
            // the page appear blank outside spec-compliant renderers. Coalescing is
            // lossless: image objects and their compact JPX/JBIG2 data are retained.
            '--coalesce-contents',
            '--pages',
        ];
        let preservedPageNumber = 0;
        let runPath = '';
        let runFirst = 0;
        let runLast = 0;
        const flush = () => {
            if (runPath !== '') {
                appendQpdfPageSelection(qpdfArgs, runPath, runFirst, runLast);
            }
        };
        outputPages.forEach((output, index) => {
            const pageNumber = output.preservedSource === undefined
                ? index + 1
                : ++preservedPageNumber;
            // qpdf's name for the primary input, which is the preserved split.
            const path = output.preservedSource === undefined
                ? rasterizedPdfPath
                : '.';
            if (path === runPath && pageNumber === runLast + 1) {
                runLast = pageNumber;
                return;
            }
            flush();
            runPath = path;
            runFirst = pageNumber;
            runLast = pageNumber;
        });
        flush();
        qpdfArgs.push('--', stagedPdfPath);
        await dependencies.runCommand(paths.qpdfBinary, qpdfArgs, {
            signal,
            commandLabel: 'qpdf(scan-cleanup:retain-compact-source-pages)',
            timeoutMs: 10 * 60 * 1000,
            log,
            ...(onTerminationProof === undefined ? {} : {onTerminationProof}),
        });
        log(
            'debug',
            `Scan cleanup retained the original compact image layers for ${String(preservedPages.length)} automatic no-raster-change page(s)`,
        );
    }
}
