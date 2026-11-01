import type {
    IDocumentMutationRevisionOptions,
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
    IPdfOptimizeResult,
} from '@contracts/electronApiDocuments';
import type {IPdfValidationResult} from '@contracts/pdfConformance';
import type {TDocumentRef} from '@contracts/documentRef';
import {
    createRequestId,
    type TRequestId,
} from '@contracts/shared';
import type {IReplacePageImagesInstructions} from '@contracts/browserPageOpsWriters';
import type {IPdfDocument} from '@app/modules/pdf-viewer/engine/pdf-document-source/pdfDocumentSource';
import {BROWSER_PAGE_OPS_MAX_REQUEST_BYTES} from '@contracts/browserPageOpsLimits';
import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {INSTRUCTED_REQUEST_HEADER} from '@contracts/browserPageOpsWasm.generated';
import {BROWSER_PDF_COMBINE_MAX_IMAGE_PIXELS} from '@contracts/browserPdfCombineWorker';
import {getPdfLosslessOptimizationSkipReason} from '@pdf-core/pdfConformanceHelpers';
import {
    MAX_BYTE_RATIO,
    PDF_OPTIMIZE_ENCODE_TIMEOUT_MS,
    PDF_OPTIMIZE_PASS_TIMEOUT_MS,
    PDF_OPTIMIZE_RENDER_TIMEOUT_MS,
    RASTER_PRESETS,
    resolvePdfOptimizePercent,
    type IPdfOptimizePageWork,
    type IPdfRasterOptimizePreset,
} from '@pdf-core/pdfOptimization';
import {AnnotationMode} from '@app/services/pdfjs/runtimeLib';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    createBrowserStoreStagedArtifact,
    sha256Hex,
} from '@app/platform/browser/browserStagedArtifact';
import {
    reserveBrowserDocumentWorkingCopy,
    retireBrowserDocumentWorkingCopy,
} from '@app/platform/browserWindowTabs';
import {
    analyzeBrowserPdfConformanceData,
    BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES,
    validateBrowserPdfData,
} from '@app/platform/browser-api/browserPdfValidation';
import {
    finishBrowserPdfCandidate,
    savePdfAsFromWorkingCopy,
    type IBrowserFinalizedPublication,
} from '@app/platform/browser-api/browserSaveTargets';
import {renderBrowserOcrRaster} from '@app/platform/browser-api/browserOcrRaster';
import {runBrowserPdfCombineWorkerRequest} from '@app/platform/browser-api/browserPdfCombineWorkerClient';
import {
    recompressPdfImages,
    replacePdfPageImages,
} from '@app/platform/browser-api/browserPageOpsCore';
import {
    createPdfjsDocumentInit,
    getPdfjsLib,
} from '@app/platform/browser-api/browserPdfjsDocumentInit';
import {buildBrowserByteLimitError} from '@app/platform/browser-api/browserPlatformHelpers';
import {ensurePdfExtension} from '@app/platform/browser-api/browserFileName';
import {emitBrowserPdfOptimizeProgress} from '@app/platform/browser-api/documentsMenuCapability';

interface IOptimizeRun {
    requestId: TRequestId;
    preset: IPdfOptimizeOptions['preset'];
    signal: AbortSignal;
    fileName: string;
    pages?: IPdfOptimizePageWork;
}

interface ICandidate {
    bytes: Uint8Array;
    optimizedPages: number;
}

function emit(run: IOptimizeRun, phase: IPdfOptimizeProgress['phase'], processed: number, total: number) {
    const normalizedTotal = Math.max(1, Math.trunc(total));
    emitBrowserPdfOptimizeProgress({
        requestId: run.requestId,
        preset: run.preset,
        phase,
        processed: Math.max(0, Math.min(normalizedTotal, Math.trunc(processed))),
        total: normalizedTotal,
        percent: resolvePdfOptimizePercent(phase, run.pages),
    });
}

/** The size of one instructed page-ops request, exactly as the engine frames it. */
function instructedRequestBytes(base: Uint8Array, instructionsJsonBytes: number, attachmentBytes = 0) {
    return INSTRUCTED_REQUEST_HEADER.bytes + base.byteLength + instructionsJsonBytes + attachmentBytes;
}

function assertInstructedRequestFits(bytes: number) {
    if (bytes > BROWSER_PAGE_OPS_MAX_REQUEST_BYTES) {
        throw buildBrowserByteLimitError('Optimize PDF', BROWSER_PAGE_OPS_MAX_REQUEST_BYTES, 'inputs');
    }
}

/**
 * A writer returns the revision to append; an empty one leaves `base` as it
 * is. The whole document must fit the next consumer before it is allocated.
 */
function append(base: Uint8Array, suffix: Uint8Array, nextConsumerMaxBytes: number) {
    if (!suffix.byteLength) return base;
    if (base.byteLength + suffix.byteLength > nextConsumerMaxBytes) {
        throw buildBrowserByteLimitError('Optimize PDF', nextConsumerMaxBytes, 'inputs');
    }
    const next = new Uint8Array(base.byteLength + suffix.byteLength);
    next.set(base);
    next.set(suffix, base.byteLength);
    return next;
}

function readNetpbmSize(image: Uint8Array) {
    const header = new TextDecoder('latin1').decode(image.subarray(0, 40));
    const match = /^P[56]\n(\d+) (\d+)\n255\n/u.exec(header);
    if (!match) throw new Error('Optimize rendered a page that is not an 8-bit Netpbm image');
    return {
        width: Number(match[1]),
        height: Number(match[2]),
    };
}

function physicalPoints(pixels: number, dpi: number) {
    return Number((pixels / dpi * 72).toFixed(6));
}

/** One page: render, then encode it with desktop's combiner route. */
async function encodePage(
    pdf: IPdfDocument,
    pageNumber: number,
    preset: IPdfRasterOptimizePreset,
    run: IOptimizeRun,
) {
    const grayscale = preset.encoding.kind === 'black-and-white' || preset.encoding.grayscale;
    const page = await pdf.getPage(pageNumber);
    let image: Uint8Array;
    try {
        // As desktop's pdftoppm -cropbox -hide-annotations: the page view on
        // white, annotations left live on the page.
        ({image} = await renderBrowserOcrRaster(
            page,
            preset.dpi,
            AbortSignal.any([
                run.signal,
                AbortSignal.timeout(PDF_OPTIMIZE_RENDER_TIMEOUT_MS),
            ]),
            {
                netpbm: grayscale ? 'gray' : 'rgb',
                annotationMode: AnnotationMode.DISABLE,
                maxPixels: BROWSER_PDF_COMBINE_MAX_IMAGE_PIXELS,
            },
        ));
    } finally {
        page.cleanup();
    }
    run.pages!.rendered = pageNumber;
    emit(run, 'rendering', pageNumber, run.pages!.total);
    const {
        width, height,
    } = readNetpbmSize(image);
    const pageSize = {
        widthPoints: physicalPoints(width, preset.dpi),
        heightPoints: physicalPoints(height, preset.dpi),
    };
    const pageImage = {
        fileName: grayscale ? 'page.pgm' : 'page.ppm',
        data: image,
    };
    const {data} = await runBrowserPdfCombineWorkerRequest('combinePdfs', {
        inputs: [],
        wasmImagePreprocessing: {pageSpecs: [preset.encoding.kind === 'black-and-white'
            ? {
                kind: 'image-bw',
                pageSize,
                image: pageImage,
            }
            : {
                kind: 'image-jpeg-with-flate-fallback',
                pageSize,
                jpegQuality: preset.encoding.quality,
                image: pageImage,
            }]},
    }, run.signal, {timeoutMs: PDF_OPTIMIZE_ENCODE_TIMEOUT_MS});
    run.pages!.assembled = pageNumber;
    emit(run, 'assembling', pageNumber, run.pages!.total);
    return data;
}

/**
 * Desktop's raster pass in the browser: every page rendered and encoded one at
 * a time, so one raw page is resident, then one page-replacement pass and one
 * image-recompression pass over the whole document.
 */
async function optimizeRaster(
    source: Uint8Array,
    preset: IPdfRasterOptimizePreset,
    run: IOptimizeRun,
): Promise<ICandidate & {pageCount: number}> {
    const pdfjsLib = await getPdfjsLib();
    // PDF.js takes its input over, so it gets its own copy.
    const loadingTask = pdfjsLib.getDocument(createPdfjsDocumentInit(pdfjsLib, source.slice()));
    const attachments: Uint8Array[] = [];
    const pages: IReplacePageImagesInstructions['pages'] = [];
    let pageCount: number;
    try {
        const pdf: IPdfDocument = await loadingTask.promise;
        pageCount = pdf.numPages;
        run.pages = {
            total: pageCount,
            rendered: 0,
            assembled: 0,
        };
        emit(run, 'rendering', 0, pageCount);
        const emptyInstructionsBytes = JSON.stringify({
            maxByteRatio: MAX_BYTE_RATIO,
            pages: [],
        }).length;
        let instructionsBytes = emptyInstructionsBytes;
        let attachmentBytes = 0;
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
            run.signal.throwIfAborted();
            const encoded = await encodePage(pdf, pageNumber, preset, run);
            const mapping = {
                pageNumber,
                replacement: attachments.length,
                replacementPageNumber: 1,
            };
            const nextInstructionsBytes = instructionsBytes + JSON.stringify(mapping).length + (pages.length ? 1 : 0);
            const nextAttachmentBytes = attachmentBytes + 4 + encoded.byteLength;
            // The replacement request carries the base and every encoded page;
            // past the engine's frame, the remaining pages keep their content.
            if (instructedRequestBytes(source, nextInstructionsBytes, nextAttachmentBytes) > BROWSER_PAGE_OPS_MAX_REQUEST_BYTES) {
                break;
            }
            attachments.push(encoded);
            pages.push(mapping);
            instructionsBytes = nextInstructionsBytes;
            attachmentBytes = nextAttachmentBytes;
        }
    } finally {
        await loadingTask.destroy().catch(() => undefined);
    }

    emit(run, 'compressingImages', pageCount, pageCount);
    const passOptions = {
        signal: run.signal,
        timeoutMs: PDF_OPTIMIZE_PASS_TIMEOUT_MS,
        requireWorker: true,
    };
    const replaceInstructions = {
        maxByteRatio: MAX_BYTE_RATIO,
        pages,
    };
    assertInstructedRequestFits(instructedRequestBytes(
        source,
        new TextEncoder().encode(JSON.stringify(replaceInstructions)).byteLength,
        attachments.reduce((total, attachment) => total + 4 + attachment.byteLength, 0),
    ));
    const replaced = pages.length
        ? await replacePdfPageImages(source, attachments, replaceInstructions, passOptions)
        : null;
    attachments.length = 0;
    const replacedPages = replaced?.report.pages
        .filter(page => page.outcome === 'replaced')
        .map(page => page.pageNumber) ?? [];
    const recompressInstructions = {
        maxByteRatio: MAX_BYTE_RATIO,
        targetDpi: preset.images.dpi,
        quality: preset.images.quality,
        skipPages: replacedPages,
    };
    const recompressMaxBytes = BROWSER_PAGE_OPS_MAX_REQUEST_BYTES - instructedRequestBytes(
        new Uint8Array(),
        new TextEncoder().encode(JSON.stringify(recompressInstructions)).byteLength,
    );
    const afterReplace = append(source, replaced?.data ?? new Uint8Array(), recompressMaxBytes);
    const recompressed = await recompressPdfImages(afterReplace, recompressInstructions, passOptions);
    // qpdf and the full check take the whole document next.
    const candidate = append(afterReplace, recompressed.data, BROWSER_QPDF_MAX_INPUT_BYTES);
    return {
        bytes: candidate,
        optimizedPages: new Set([
            ...replacedPages,
            ...recompressed.report.pages,
        ]).size,
        pageCount,
    };
}

async function publishCandidate(
    path: TDocumentRef,
    bytes: Uint8Array,
    validation: IPdfValidationResult,
    revision: NonNullable<IDocumentMutationRevisionOptions['expectedDocumentRevisionToken']>,
    publication: IBrowserFinalizedPublication,
) {
    const stagedName = `${publication.target.fileName}.staged-optimize.pdf`;
    const stagedPath = await reserveBrowserDocumentWorkingCopy(stagedName);
    try {
        await browserDocumentStore.createStoredDocument(stagedName, bytes, {
            ref: stagedPath,
            mimeType: 'application/pdf',
            saveKind: 'pdf',
            kind: 'output',
            retention: 'transient',
        });
        const stagedOutput = await createBrowserStoreStagedArtifact(browserDocumentStore, stagedPath, {
            leaseId: crypto.randomUUID(),
            sha256: await sha256Hex(bytes),
            validations: {
                qpdfCheck: true,
                qpdfResult: validation,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
        });
        return await savePdfAsFromWorkingCopy(path, {stagedOutput}, {expectedDocumentRevisionToken: revision}, publication);
    } finally {
        await retireBrowserDocumentWorkingCopy(stagedPath);
    }
}

/**
 * Desktop's Optimize PDF in the browser, published to a target picked during
 * the request's user gesture. It optimizes the working copy's bytes as they
 * were when it started and publishes only a valid, strictly smaller result.
 * The signal cancels every phase until the external write commits.
 */
export async function optimizeBrowserPdfAsCopy(
    path: TDocumentRef,
    options: IPdfOptimizeOptions,
    requestId: TRequestId | undefined,
    revisionOptions: IDocumentMutationRevisionOptions | undefined,
    {
        target, signal = new AbortController().signal,
    }: {
        target: IBrowserFinalizedPublication['target'];
        signal?: AbortSignal;
    },
): Promise<IPdfOptimizeResult> {
    const {preset} = options;
    if (target.canceled) {
        return {
            outcome: 'cancelled',
            path: null,
            validation: null,
            preset,
            originalBytes: null,
            optimizedBytes: null,
            optimizedPages: null,
            pageCount: null,
        };
    }
    const run: IOptimizeRun = {
        requestId: requestId ?? createRequestId('pdf-optimize'),
        preset,
        signal,
        fileName: ensurePdfExtension(target.fileName),
    };
    emit(run, 'preparing', 0, 1);

    // Capture the frontier once; every pass reads these bytes, and publication
    // is checked against this revision and source.
    const revision = revisionOptions?.expectedDocumentRevisionToken
        ?? (await browserDocumentStore.getDocumentRevision(path)).token;
    await browserDocumentStore.assertDocumentRevisionCurrent(path, revision);
    const sourceRef = await browserDocumentStore.getSourceRef(path);
    const source = await browserDocumentStore.read(path, {maxBytes: BROWSER_PDF_CONFORMANCE_MAX_INPUT_BYTES});
    await browserDocumentStore.assertDocumentRevisionCurrent(path, revision);
    signal.throwIfAborted();

    const skipReason = getPdfLosslessOptimizationSkipReason(await analyzeBrowserPdfConformanceData(source, {signal}));
    if (skipReason) {
        throw new Error(`Optimize PDF does not rewrite a ${skipReason}: it would no longer be one.`);
    }

    const raster = preset === 'lossless' ? null : await optimizeRaster(source, RASTER_PRESETS[preset], run);
    const pageCount = raster?.pageCount ?? null;
    const progressTotal = pageCount ?? 1;
    emit(run, 'optimizing', progressTotal, progressTotal);
    const rasterBytes = raster?.bytes ?? source;
    const optimized = await finishBrowserPdfCandidate(rasterBytes, {
        fileName: run.fileName,
        signal,
    }) ?? rasterBytes;
    emit(run, 'validating', progressTotal, progressTotal);
    const validation = await validateBrowserPdfData(optimized, {
        fileName: run.fileName,
        signal,
    });
    const result = {
        preset,
        originalBytes: source.byteLength,
        pageCount,
        validation,
        optimizedPages: raster?.optimizedPages ?? 0,
    };
    if (!validation.isValid) {
        return {
            ...result,
            outcome: 'invalid',
            path: null,
            optimizedBytes: null,
        };
    }
    if (optimized.byteLength >= source.byteLength) {
        emit(run, 'complete', 1, 1);
        return {
            ...result,
            outcome: 'not-smaller',
            path: null,
            optimizedBytes: optimized.byteLength,
        };
    }

    const savedRef = await publishCandidate(path, optimized, validation, revision, {
        kind: 'finalized',
        target,
        sourceRef,
        signal,
    });
    emit(run, 'complete', 1, 1);
    return {
        ...result,
        outcome: savedRef ? 'saved' : 'cancelled',
        path: savedRef,
        optimizedBytes: savedRef ? optimized.byteLength : null,
    };
}
