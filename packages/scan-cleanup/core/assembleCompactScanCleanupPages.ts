import {createReadStream} from 'node:fs';
import * as v from 'valibot';
import {isRecord} from '@contracts/runtimeGuards';
import {
    PDF_ANNOTATION_PARSE_ENTRY_SCHEMA,
    PDF_ANNOTATION_PARSE_SIDECAR_HEADER_SCHEMA,
} from '@contracts/pdfAnnotationParseSchemas';
import {createScanCleanupSidecarProtocolHandler} from '@evb/scan-cleanup/core/createScanCleanupSidecarProtocolHandler';
import {
    rename,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import type {
    INativeScanCleanupOutputMetadataV3,
    INativeScanCleanupPageMetadataV3,
    INativeScanCleanupPdfPlacementV3,
    TScanCleanupOutputMode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {getScanCleanupPageOverride} from '@contracts/scan-cleanup/scanCleanupPageOverrides';
import { requirePageNumber } from '@contracts/pageNumbers';
import type {
    IDetectedPageRaster,
    IPdfMrcLayers,
    IPdfPageSize,
    TScanCleanupLog,
    IRunScanCleanupPipelineDependencies,
    IRunScanCleanupPipelineRequest,
    IScanCleanupWorkerPaths,
    IScanCleanupRunCommandOptions,
} from '@evb/scan-cleanup/core/types';
import {buildScanCleanupSourceMrcForegroundPdfMatrix} from '@evb/scan-cleanup/core/buildScanCleanupSourceMrcForegroundPdfMatrix';
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

export interface IRenderedCleanupOutputPage {
    sourcePageNumber: number;
    path: string;
    bilevelPath?: string;
    backgroundPath?: string;
    foregroundMaskPath?: string;
    foregroundAlphaPath?: string;
    backgroundIsColor?: boolean;
    dpi: number;
    resolvedOutputMode: TScanCleanupOutputMode;
    metadata: INativeScanCleanupOutputMetadataV3;
    preservedSource?: {
        reason:
            | 'auto-color-compact-layered-no-raster-change'
            | 'auto-mixed-trusted-mrc-tone-preserved'
            | 'mixed-layer-validation-fallback';
        sourcePageIndex: number;
        rotationQuarterTurns: number;
        cropRect: INativeScanCleanupPdfPlacementV3['cropRect'];
        contentTransform: NonNullable<INativeScanCleanupPdfPlacementV3['contentTransform']>;
    };
}

export function sourceMrcForegroundPdfMatrix(
    output: IRenderedCleanupOutputPage,
    layers: IPdfMrcLayers,
    pageWidthPoints: number,
    pageHeightPoints: number,
) {
    const metadata = output.metadata;
    const matrix = metadata.forwardTransform?.matrix;
    if (
        matrix === undefined
        || metadata.inputWidthPx === undefined
        || metadata.inputHeightPx === undefined
        || metadata.outputWidthPx <= 0
        || metadata.outputHeightPx <= 0
        || (metadata.intrinsicRasterWidthPx !== undefined && metadata.intrinsicRasterWidthPx <= 0)
        || (metadata.intrinsicRasterHeightPx !== undefined && metadata.intrinsicRasterHeightPx <= 0)
        || metadata.rotationDegrees !== 0
        || metadata.dewarpMapping != null
    ) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} cannot preserve its source MRC foreground `
            + 'because its cleanup geometry is not affine in the source orientation',
        );
    }
    const pdfMatrix = buildScanCleanupSourceMrcForegroundPdfMatrix(
        metadata,
        layers,
        pageWidthPoints,
        pageHeightPoints,
    );
    if (!pdfMatrix.every(Number.isFinite)) {
        throw new Error(
            `Page ${String(output.sourcePageNumber)} produced a non-finite source MRC transform`,
        );
    }
    return pdfMatrix;
}

export function resolveCompactSourcePreservation(
    request: IRunScanCleanupPipelineRequest,
    sourcePageNumber: number,
    pageMetadata: INativeScanCleanupPageMetadataV3,
    output: Omit<IRenderedCleanupOutputPage, 'preservedSource'>,
    pageSize: IPdfPageSize | undefined,
    sourceRaster: IDetectedPageRaster | undefined,
) {
    const pageOverride = getScanCleanupPageOverride(
        request.options.pageOverrides,
        requirePageNumber(sourcePageNumber),
        request.options.pageOverrideDefaults,
        request.options.marginsMm,
    );
    // Auto is allowed to retain a compact source page when cleanup made no
    // raster change. JPX/JBIG2 are supported by EVB Viewer's configured PDF.js
    // runtime and by the reference desktop renderers; transcoding them merely
    // for a separate no-WASM review surface adds no quality and can multiply
    // the document size. That review surface is classified separately by the
    // generated-PDF verifier.
    const configuredMode = pageOverride.outputModeOverride ?? request.options.outputMode;
    const manualZones = pageOverride.manualZones;
    const preservesTrustedMrcTone = output.resolvedOutputMode === 'mixed'
        && output.metadata.trustedMrcBackgroundPreserved === true;
    if (
        configuredMode !== 'auto'
        || (output.resolvedOutputMode !== 'color' && !preservesTrustedMrcTone)
        || sourceRaster?.hasBilevelLayer !== true
        || sourceRaster.backgroundDpi === undefined
        || !Number.isFinite(sourceRaster.backgroundDpi)
        || sourceRaster.backgroundDpi <= 0
        || pageSize === undefined
        || pageSize.rotation !== 0
        || pageOverride.rotationDegrees !== 0
        || pageMetadata.layoutClassification !== 'single-uncut-page'
        || pageMetadata.outputCount !== 1
        || output.metadata.half !== 'full'
        || output.metadata.skewApplied
        || output.metadata.dewarpModel != null
        || (!preservesTrustedMrcTone && output.metadata.illuminationNormalized === true)
        || (!preservesTrustedMrcTone && output.metadata.textToneDiagnostics?.applied === true)
        || (!preservesTrustedMrcTone && output.metadata.binarizationMode != null)
        || pageOverride.manualSkewDegrees !== undefined
        || (manualZones?.picture.length ?? 0) > 0
        || (manualZones?.fill.length ?? 0) > 0
        || output.metadata.sourcePdfPlacement?.contentTransform === undefined
    ) {
        return undefined;
    }
    return {
        reason: preservesTrustedMrcTone
            ? 'auto-mixed-trusted-mrc-tone-preserved' as const
            : 'auto-color-compact-layered-no-raster-change' as const,
        sourcePageIndex: sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        cropRect: output.metadata.sourcePdfPlacement.cropRect,
        contentTransform: output.metadata.sourcePdfPlacement.contentTransform,
    };
}

export function resolveFullSourcePagePreservation(
    sourcePageNumber: number,
    pageSize: IPdfPageSize | undefined,
) {
    if (
        pageSize === undefined
        || !Number.isFinite(pageSize.xPoints)
        || !Number.isFinite(pageSize.yPoints)
        || !Number.isFinite(pageSize.widthPoints)
        || pageSize.widthPoints <= 0
        || !Number.isFinite(pageSize.heightPoints)
        || pageSize.heightPoints <= 0
    ) {
        return undefined;
    }
    return {
        reason: 'mixed-layer-validation-fallback' as const,
        sourcePageIndex: sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        cropRect: {
            x: pageSize.xPoints,
            y: pageSize.yPoints,
            width: pageSize.widthPoints,
            height: pageSize.heightPoints,
        },
        contentTransform: {
            scale: 1,
            translateX: 0,
            translateY: 0,
        },
    };
}

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
    const sidecarPath = join(scratch, 'source-annotations.jsonl');
    await dependencies.runCommand(paths.pdfPageOpsBinary, [
        'parse-annotations',
        '--input',
        sourcePagesPath,
        '--qpdf',
        paths.qpdfBinary,
        '--output',
        sidecarPath,
        '--modified-at',
        'D:19700101000000Z',
    ], {
        signal,
        commandLabel: 'evb-pdf-page-ops(parse-annotations:scan-cleanup)',
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
                v.parse(PDF_ANNOTATION_PARSE_SIDECAR_HEADER_SCHEMA, value);
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
                const annotation = v.parse(PDF_ANNOTATION_PARSE_ENTRY_SCHEMA, entry);
                const pageNumber = pages[annotation.pageIndex];
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
        })), provenanceStampHex);
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
            // The rasterized PDF is the primary input so its document-level Info
            // dictionary — the native writer's provenance stamp — survives the
            // interleave; --empty would emit a document without any Info entry.
            rasterizedPdfPath,
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
            const path = output.preservedSource === undefined
                ? rasterizedPdfPath
                : preservedPdfPath;
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
    if (
        textLayerPlan.pages.length > 0
        && paths.pdfPageOpsBinary !== undefined
        && !isScanCleanupCliFallbackSentinel(paths.pdfPageOpsBinary)
    ) {
        const textLayerInstructionsPath = join(scratch, 'source-text-layer.json');
        const textLayerPdfPath = join(scratch, 'text-layer-cleaned.pdf');
        await writeFile(
            textLayerInstructionsPath,
            serializeScanCleanupTextLayerInstructions(textLayerPlan.pages),
        );
        await dependencies.runCommand(paths.pdfPageOpsBinary, [
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
            `Scan cleanup retained source text and annotations on ${String(textLayerPlan.pages.length)} output page(s)`,
        );
    } else if (textLayerPlan.pages.length > 0) {
        throw new ScanCleanupNativeToolUnavailableError('evb-pdf-page-ops');
    }

}
