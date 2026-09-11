import { getErrorMessage } from '@electron/utils/error';
import {
    readFile,
    stat,
    writeFile,
} from 'fs/promises';
import {
    decodePDFRawStream,
    PDFContentStream,
    PDFArray,
    PDFDocument,
    PDFName,
    PDFRawStream,
    PDFRef,
    PDFStream,
} from 'pdf-lib';
import type {
    PDFDict,
    PDFPage,
} from 'pdf-lib';
import type {
    IOcrPageGeometry,
    TWorkerLog,
} from '@electron/ocr/worker/types';
import {
    runOcrCommand,
    type TOcrRunCommandOptions,
} from '@electron/features/ocr/worker/runOcrCommand';
import { abortErrorFromSignal } from '@electron/utils/abort';
import {
    safePdfContextLookupArray,
    safePdfContextLookupStream,
    safePdfDictLookupDict,
    safePdfPageInheritableDict,
} from '@pdf-core';
import { assembleSearchablePdfStreaming } from '@electron/features/ocr/worker/assembleSearchablePdfStreaming';

// Removal condition: pdf-page-ops gains an N-source Form XObject composition
// operation and content-stream cleanup primitives for OCR layer replacement.

const QPDF_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_OCR_PAGE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const TESSERACT_IMAGE_PAINT_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+\/Im\d+\s+Do\s+Q\r?\n/gm;
const TESSERACT_IMAGE_XOBJECT_RE = /\n\s*\/XObject\s*<<\s*\n(?:\s*\/Im\d+\s+\d+\s+\d+\s+R\s*\n)+\s*>>/g;
const XOBJECT_DRAW_LINE_RE = /^[^\r\n]*\/[A-Za-z0-9._-]+\s+Do\b[^\r\n]*(?:\r?\n)?/gm;
const OCR_LAYER_MARKER = 'EVB_VIEWER_OCR_LAYER';
const MAX_OCR_OUTPUT_ABSOLUTE_GROWTH_BYTES = 100 * 1024 * 1024;
const MAX_OCR_OUTPUT_GROWTH_MULTIPLIER = 4;
const INVISIBLE_TEXT_RENDERING_RE = /(?:^|\s)3(?:\.0+)?\s+Tr\b/;
const TEXT_RENDERING_MODE_RE = /(^|\s)[0-7](?:\.0+)?\s+Tr\b/gm;
const TEXT_OBJECT_BEGIN_RE = /\bBT\b/g;
const TESSERACT_HIDDEN_TEXT_OBJECT_RE = /BT[\s\S]*?(?:^|\s)3(?:\.0+)?\s+Tr\b[\s\S]*?ET\s*/gm;
const TEXT_SHOW_OPERATOR_RE = /\b(?:Tj|TJ)\b|(?:^|\s)['"](?=\s|$)/m;
const TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE = /^q\s+[\d.]+\s+0\s+0\s+[\d.]+\s+0\s+0\s+cm\s+Q\s*$/;
const CONTENTS_NAME = PDFName.of('Contents');
const RESOURCES_NAME = PDFName.of('Resources');
const FONT_NAME = PDFName.of('Font');
const XOBJECT_NAME = PDFName.of('XObject');
const EXT_G_STATE_NAME = PDFName.of('ExtGState');
const EXT_G_STATE_TYPE_NAME = PDFName.of('ExtGState');
const IMAGE_OR_FORM_DRAW_TEST_RE = /\/[^\s]+\s+Do\b/;
export type TOcrPageEntryValue = string | {
    path: string;
    pageGeometry?: IOcrPageGeometry;
};

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export class OcrGeneratedPageArtifactLimitError extends RangeError {
    readonly code = 'OCR_GENERATED_PAGE_ARTIFACT_TOO_LARGE' as const;
    readonly path: string;
    readonly size: number;

    constructor(path: string, size: number) {
        super(`Generated OCR page artifact exceeds ${MAX_OCR_PAGE_ARTIFACT_BYTES}-byte limit: ${path}`);
        this.name = 'OcrGeneratedPageArtifactLimitError';
        this.path = path;
        this.size = size;
    }
}

export class OcrPageGeometryError extends TypeError {
    readonly code = 'OCR_PAGE_GEOMETRY_INVALID' as const;

    constructor(detail: string) {
        super(`OCR page geometry is invalid: ${detail}`);
        this.name = 'OcrPageGeometryError';
    }
}

/**
 * Generated one-page PDFs are the only PDF bytes loaded into pdf-lib during
 * assembly. Keep this trust boundary bounded even when a sidecar was produced
 * by an external command or changed after its initial validation.
 */
export async function loadBoundedGeneratedPagePdf(path: string, label: string) {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
        throw new Error(`${label} is not a regular file: ${path}`);
    }
    if (fileStat.size > MAX_OCR_PAGE_ARTIFACT_BYTES) {
        throw new OcrGeneratedPageArtifactLimitError(path, fileStat.size);
    }

    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_OCR_PAGE_ARTIFACT_BYTES) {
        throw new OcrGeneratedPageArtifactLimitError(path, bytes.byteLength);
    }
    return PDFDocument.load(bytes, {ignoreEncryption: true});
}

async function assertNonEmptyFile(path: string, label: string) {
    const fileStat = await stat(path);
    if (fileStat.size <= 0) {
        throw new Error(`${label} is empty: ${path}`);
    }
}

async function assertReasonableOcrOutputSize(inputPath: string, outputPath: string) {
    const [
        inputStat,
        outputStat,
    ] = await Promise.all([
        stat(inputPath),
        stat(outputPath),
    ]);
    const maxAllowedSize = Math.max(
        inputStat.size * MAX_OCR_OUTPUT_GROWTH_MULTIPLIER,
        inputStat.size + MAX_OCR_OUTPUT_ABSOLUTE_GROWTH_BYTES,
    );
    if (outputStat.size > maxAllowedSize) {
        throw new Error(
            `Assembled OCR PDF is unexpectedly large (${outputStat.size} bytes from ${inputStat.size} bytes)`,
        );
    }
}

export async function getPageCount(
    qpdfBinary: string,
    pdfPath: string,
    fallback: number,
    signal?: AbortSignal,
) {
    try {
        const commandOptions: TOcrRunCommandOptions = {
            timeoutMs: QPDF_TIMEOUT_MS,
            commandLabel: 'qpdf(show-npages)',
        };
        if (signal !== undefined) {
            commandOptions.signal = signal;
        }

        const result = await runOcrCommand(qpdfBinary, [
            '--show-npages',
            pdfPath,
        ], commandOptions);
        const parsed = parseInt(result.stdout.trim(), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return {
                pageCount: parsed,
                warnings: [],
            };
        }
    } catch (err) {
        return {
            pageCount: fallback,
            warnings: [`qpdf page-count failed; using OCR page fallback ${fallback}: ${getErrorMessage(err)}`],
        };
    }
    return {
        pageCount: fallback,
        warnings: [`qpdf page-count returned no usable page count; using OCR page fallback ${fallback}`],
    };
}

export function stripTesseractImageLayer(qdfSource: string) {
    const withoutImagePaint = qdfSource.replace(TESSERACT_IMAGE_PAINT_RE, '');
    return withoutImagePaint.replace(TESSERACT_IMAGE_XOBJECT_RE, '');
}

export function sanitizeOcrContentStreamForEmbedding(streamText: string) {
    const withoutGeneratedImagePaint = streamText
        .replace(TESSERACT_IMAGE_PAINT_RE, '')
        .replace(XOBJECT_DRAW_LINE_RE, '');
    return withoutGeneratedImagePaint
        .replace(TEXT_RENDERING_MODE_RE, (_match, prefix: string) => `${prefix}3 Tr`)
        .replace(TEXT_OBJECT_BEGIN_RE, 'BT\n3 Tr');
}

function decodeContentStream(stream: PDFStream) {
    if (stream instanceof PDFRawStream) {
        return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    }
    if (stream instanceof PDFContentStream) {
        return Buffer.from(stream.getUnencodedContents()).toString('latin1');
    }
    return '';
}

type TResourceReferenceOperator = 'Do' | 'Tf' | 'gs';

interface IResourceReferenceScan {
    names: Set<string>;
    complete: boolean;
}

function isPdfWhitespace(code: number) {
    return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isPdfDelimiter(code: number) {
    return isPdfWhitespace(code) || '()<>[]{}/%'.includes(String.fromCharCode(code));
}

function decodePdfNameToken(source: string, start: number): {
    name: string;
    end: number;
    complete: boolean
} {
    let end = start + 1;
    let name = '';
    let complete = true;
    while (end < source.length && !isPdfDelimiter(source.charCodeAt(end))) {
        if (source[end] === '#') {
            const hex = source.slice(end + 1, end + 3);
            if (!/^[0-9A-Fa-f]{2}$/u.test(hex)) {
                complete = false;
                name += source[end];
                end += 1;
                continue;
            }
            name += String.fromCharCode(Number.parseInt(hex, 16));
            end += 3;
            continue;
        }
        name += source[end];
        end += 1;
    }
    return {
        name,
        end,
        complete,
    };
}

function skipPdfString(source: string, start: number): {
    end: number;
    complete: boolean
} {
    let depth = 1;
    let end = start + 1;
    while (end < source.length) {
        const char = source[end];
        if (char === '\\') {
            end += 2;
            continue;
        }
        if (char === '(') depth += 1;
        if (char === ')' && --depth === 0) {
            return {
                end: end + 1,
                complete: true,
            };
        }
        end += 1;
    }
    return {
        end,
        complete: false,
    };
}

function skipPdfToken(source: string, start: number) {
    let end = start;
    while (end < source.length && !isPdfDelimiter(source.charCodeAt(end))) end += 1;
    return end;
}

function scanResourceReferences(source: string, operator: TResourceReferenceOperator): IResourceReferenceScan {
    const names = new Set<string>();
    let complete = true;
    let previousName: string | null = null;
    let index = 0;
    while (index < source.length) {
        const code = source.charCodeAt(index);
        if (isPdfWhitespace(code)) {
            index += 1;
            continue;
        }
        if (source[index] === '%') {
            const lineEnd = source.indexOf('\n', index + 1);
            index = lineEnd === -1 ? source.length : lineEnd + 1;
            previousName = null;
            continue;
        }
        if (source[index] === '(') {
            const skipped = skipPdfString(source, index);
            complete &&= skipped.complete;
            index = skipped.end;
            previousName = null;
            continue;
        }
        if (source[index] === '<') {
            const end = source[index + 1] === '<' ? skipPdfToken(source, index + 2) : source.indexOf('>', index + 1);
            if (end === -1) complete = false;
            index = end === -1 ? source.length : end + 1;
            previousName = null;
            continue;
        }
        if (source[index] === '/') {
            const token = decodePdfNameToken(source, index);
            complete &&= token.complete;
            previousName = token.name;
            index = token.end;
            continue;
        }
        const end = skipPdfToken(source, index);
        const token = source.slice(index, end);
        if (token === operator) {
            if (previousName !== null) names.add(previousName);
            previousName = null;
        }
        index = end === index ? end + 1 : end;
    }
    return {
        names,
        complete,
    };
}

function deleteProvenUnusedEntries(
    dict: PDFDict,
    candidates: Set<string>,
    referencedNames: IResourceReferenceScan,
) {
    if (!referencedNames.complete) {
        return;
    }
    for (const key of dict.keys()) {
        const name = key.asString().replace(/^\//u, '');
        if (candidates.has(name) && !referencedNames.names.has(name)) {
            dict.delete(key);
        }
    }
}

function filterOwnedOcrResourceNames(names: Set<string>) {
    return new Set([...names].filter(name => name.replace(/^\//u, '').startsWith('EvbOcr')));
}

function hasKeptFormXObject(resources: PDFDict, removedXObjectNames: Set<string>) {
    const xObject = safePdfDictLookupDict(resources, XOBJECT_NAME);
    if (!xObject) {
        return false;
    }
    for (const key of xObject.keys()) {
        const name = key.asString().replace(/^\//u, '');
        if (removedXObjectNames.has(name)) {
            continue;
        }
        try {
            const value = xObject.lookup(key);
            if (value instanceof PDFStream && value.dict.get(PDFName.of('Subtype'))?.toString() === '/Form') {
                return true;
            }
        } catch {
            return true;
        }
    }
    return false;
}

function cloneMutablePageResources(page: PDFPage) {
    const context = page.doc.context;
    const resources = safePdfPageInheritableDict(page, RESOURCES_NAME)?.clone(context) ?? context.obj({});
    const font = safePdfDictLookupDict(resources, FONT_NAME)?.clone(context) ?? context.obj({});
    const xObject = safePdfDictLookupDict(resources, XOBJECT_NAME)?.clone(context) ?? context.obj({});
    const extGState = safePdfDictLookupDict(resources, EXT_G_STATE_NAME)?.clone(context) ?? context.obj({});
    resources.set(FONT_NAME, font);
    resources.set(XOBJECT_NAME, xObject);
    resources.set(EXT_G_STATE_NAME, extGState);
    page.node.set(RESOURCES_NAME, resources);
    return {
        extGState,
        font,
        resources,
        xObject,
    };
}

function resolvePageContentsArray(page: PDFPage) {
    const context = page.doc.context;
    const contentsValue = page.node.get(CONTENTS_NAME);
    if (contentsValue instanceof PDFArray) {
        return contentsValue;
    }
    if (contentsValue instanceof PDFRef) {
        const contents = safePdfContextLookupArray(context, contentsValue);
        if (contents) {
            return contents;
        }
    }

    const contents = context.obj([]);
    if (contentsValue instanceof PDFRef || contentsValue instanceof PDFStream) {
        contents.push(contentsValue);
    }
    page.node.set(CONTENTS_NAME, contents);
    return contents;
}

function lookupPageContentStream(page: PDFPage, value: unknown) {
    if (value instanceof PDFStream) {
        return value;
    }
    if (value instanceof PDFRef) {
        return safePdfContextLookupStream(page.doc.context, value);
    }
    return null;
}

function isTextOnlyOcrStream(streamText: string, strippedText: string) {
    if (IMAGE_OR_FORM_DRAW_TEST_RE.test(streamText)) {
        return false;
    }
    return strippedText.trim().replace(TESSERACT_EMPTY_TEXT_ONLY_PREAMBLE_RE, '').trim() === '';
}

function removeSupportedHiddenTextObjects(streamText: string) {
    let removedText = '';
    const sanitizedText = streamText.replace(TESSERACT_HIDDEN_TEXT_OBJECT_RE, (textObject) => {
        const hiddenModeIndex = textObject.search(INVISIBLE_TEXT_RENDERING_RE);
        const textShowIndex = textObject.search(TEXT_SHOW_OPERATOR_RE);
        if (hiddenModeIndex < 0 || textShowIndex < hiddenModeIndex) {
            return textObject;
        }
        removedText += textObject;
        return '';
    });
    return {
        removedText,
        sanitizedText,
    };
}

function removePreviousOcrLayer(page: PDFPage) {
    // Keep pdf-lib until native PDF assembly can merge OCR text Form XObjects
    // while preserving the existing sanitization behavior.
    const {
        extGState,
        font,
        resources,
        xObject,
    } = cloneMutablePageResources(page);
    const context = page.doc.context;
    const contents = resolvePageContentsArray(page);

    const keptContentText: string[] = [];
    const removedFontNames = new Set<string>();
    const removedXObjectNames = new Set<string>();
    const removedExtGStateNames = new Set<string>();
    let canProveKeptContent = true;
    for (let index = contents.size() - 1; index >= 0; index -= 1) {
        const contentRef = contents.get(index);
        const contentStream = lookupPageContentStream(page, contentRef);
        if (!contentStream) {
            canProveKeptContent = false;
            continue;
        }
        const streamText = decodeContentStream(contentStream);

        if (streamText.includes(OCR_LAYER_MARKER)) {
            const markedXObjects = scanResourceReferences(streamText, 'Do');
            const markedFonts = scanResourceReferences(streamText, 'Tf');
            const markedExtGStates = scanResourceReferences(streamText, 'gs');
            contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            if (markedXObjects.complete && markedFonts.complete && markedExtGStates.complete) {
                markedXObjects.names.forEach(name => removedXObjectNames.add(name));
                markedFonts.names.forEach(name => removedFontNames.add(name));
                markedExtGStates.names.forEach(name => removedExtGStateNames.add(name));
            }
            continue;
        }

        if (!INVISIBLE_TEXT_RENDERING_RE.test(streamText)) {
            keptContentText.push(streamText);
            continue;
        }

        const {
            removedText,
            sanitizedText,
        } = removeSupportedHiddenTextObjects(streamText);
        if (removedText.length > 0) {
            scanResourceReferences(removedText, 'Tf').names.forEach(name => removedFontNames.add(name));
            scanResourceReferences(removedText, 'Do').names.forEach(name => removedXObjectNames.add(name));
            scanResourceReferences(removedText, 'gs').names.forEach(name => removedExtGStateNames.add(name));
            if (sanitizedText.trim().length === 0) {
                contents.remove(index);
                if (contentRef instanceof PDFRef) {
                    context.delete(contentRef);
                }
            } else {
                const sanitizedRef = context.register(context.flateStream(sanitizedText));
                contents.set(index, sanitizedRef);
                if (contentRef instanceof PDFRef) {
                    context.delete(contentRef);
                }
                keptContentText.push(sanitizedText);
            }
            continue;
        }

        const strippedText = streamText.replace(TESSERACT_HIDDEN_TEXT_OBJECT_RE, '');
        if (isTextOnlyOcrStream(streamText, strippedText)) {
            scanResourceReferences(streamText, 'Tf').names.forEach(name => removedFontNames.add(name));
            scanResourceReferences(streamText, 'Do').names.forEach(name => removedXObjectNames.add(name));
            scanResourceReferences(streamText, 'gs').names.forEach(name => removedExtGStateNames.add(name));
            contents.remove(index);
            if (contentRef instanceof PDFRef) {
                context.delete(contentRef);
            }
            continue;
        }

        // Mixed image/text streams sometimes use a single leading `3 Tr`
        // preamble to keep all following text invisible. Removing just that
        // preamble makes the original OCR layer paint over the scanned page.
        keptContentText.push(streamText);
    }

    const keptText = keptContentText.join('\n');
    if (canProveKeptContent) {
        // A kept source Form makes nested reachability ambiguous for every
        // resource category. Preserve all candidates in that case. The
        // direct-page path may prune only names proven unused by the kept
        // streams, and only after restricting candidates to EVB-owned names.
        if (!hasKeptFormXObject(resources, removedXObjectNames)) {
            deleteProvenUnusedEntries(extGState, filterOwnedOcrResourceNames(removedExtGStateNames), scanResourceReferences(keptText, 'gs'));
            deleteProvenUnusedEntries(font, removedFontNames, scanResourceReferences(keptText, 'Tf'));
            deleteProvenUnusedEntries(xObject, filterOwnedOcrResourceNames(removedXObjectNames), scanResourceReferences(keptText, 'Do'));
        }
    }
}

function sanitizeOcrPageForEmbedding(page: PDFPage) {
    const context = page.doc.context;
    const contents = resolvePageContentsArray(page);

    for (let index = 0; index < contents.size(); index += 1) {
        const contentRef = contents.get(index);
        const contentStream = lookupPageContentStream(page, contentRef);
        if (!contentStream) {
            continue;
        }

        const sanitizedText = sanitizeOcrContentStreamForEmbedding(decodeContentStream(contentStream));
        const sanitizedRef = context.register(context.flateStream(sanitizedText));
        contents.set(index, sanitizedRef);

        if (contentRef instanceof PDFRef) {
            context.delete(contentRef);
        }
    }

    // The generated page is embedded as a Form. Keeping unused sidecar
    // resources is cheap and avoids guessing about names used by nested Forms.
}

function normalizeRotation(angle: number): IOcrPageGeometry['rotation'] {
    const normalized = ((angle % 360) + 360) % 360;
    if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
        throw new OcrPageGeometryError(`unsupported source rotation ${angle}`);
    }
    return normalized;
}

function validatePageGeometry(geometry: IOcrPageGeometry) {
    if (
        !Number.isFinite(geometry.xPoints)
        || !Number.isFinite(geometry.yPoints)
        || !Number.isFinite(geometry.widthPoints)
        || !Number.isFinite(geometry.heightPoints)
        || geometry.widthPoints <= 0
        || geometry.heightPoints <= 0
    ) {
        throw new OcrPageGeometryError('box must have finite coordinates and positive extents');
    }
    if (geometry.preprocessInverseTransform !== undefined && (
        !Number.isFinite(geometry.rasterWidthPx)
        || !Number.isFinite(geometry.rasterHeightPx)
        || geometry.rasterWidthPx! <= 0
        || geometry.rasterHeightPx! <= 0
    )) {
        throw new OcrPageGeometryError('preprocessed pages must carry positive raster dimensions');
    }
    const matrix = geometry.preprocessInverseTransform?.matrix;
    if (matrix !== undefined) {
        if (
            matrix.length !== 3
            || matrix.some(row => row.length !== 3 || row.some(value => !Number.isFinite(value)))
        ) {
            throw new OcrPageGeometryError('preprocessing inverse transform must be a finite 3x3 matrix');
        }
        const validatedMatrix = matrix as TMatrix3;
        const determinant = (
            validatedMatrix[0][0] * (validatedMatrix[1][1] * validatedMatrix[2][2] - validatedMatrix[1][2] * validatedMatrix[2][1])
            - validatedMatrix[0][1] * (validatedMatrix[1][0] * validatedMatrix[2][2] - validatedMatrix[1][2] * validatedMatrix[2][0])
            + validatedMatrix[0][2] * (validatedMatrix[1][0] * validatedMatrix[2][1] - validatedMatrix[1][1] * validatedMatrix[2][0])
        );
        if (Math.abs(determinant) <= 1e-12) {
            throw new OcrPageGeometryError('preprocessing inverse transform must be invertible');
        }
    }
    return {
        ...geometry,
        rotation: normalizeRotation(geometry.rotation),
    };
}

type TMatrix3 = [
    [number, number, number],
    [number, number, number],
    [number, number, number],
];

function multiplyMatrix3(left: TMatrix3, right: TMatrix3): TMatrix3 {
    return [
        0,
        1,
        2,
    ].map(row => [
        0,
        1,
        2,
    ].map(column => (
        left[row]![0] * right[0][column]!
        + left[row]![1] * right[1][column]!
        + left[row]![2] * right[2][column]!
    ))) as TMatrix3;
}

function composePreprocessInverse(
    embeddedPage: Awaited<ReturnType<PDFDocument['embedPage']>>,
    geometry: IOcrPageGeometry,
): TMatrix3 | undefined {
    const inverse = geometry.preprocessInverseTransform?.matrix;
    const rasterWidthPx = geometry.rasterWidthPx;
    const rasterHeightPx = geometry.rasterHeightPx;
    if (inverse === undefined || rasterWidthPx === undefined || rasterHeightPx === undefined) {
        return undefined;
    }
    const outputToPixels: TMatrix3 = [
        [
            rasterWidthPx / embeddedPage.width,
            0,
            0,
        ],
        [
            0,
            -rasterHeightPx / embeddedPage.height,
            rasterHeightPx,
        ],
        [
            0,
            0,
            1,
        ],
    ];
    const sourcePixelsToForm: TMatrix3 = [
        [
            embeddedPage.width / rasterWidthPx,
            0,
            0,
        ],
        [
            0,
            -embeddedPage.height / rasterHeightPx,
            embeddedPage.height,
        ],
        [
            0,
            0,
            1,
        ],
    ];
    const nativeInverse = inverse as TMatrix3;
    return multiplyMatrix3(sourcePixelsToForm, multiplyMatrix3(nativeInverse, outputToPixels));
}

function resolvePageGeometry(page: PDFPage, geometry?: IOcrPageGeometry) {
    if (geometry !== undefined) {
        return validatePageGeometry(geometry);
    }

    const media = page.getMediaBox();
    const crop = page.getCropBox();
    const left = Math.max(media.x, crop.x);
    const bottom = Math.max(media.y, crop.y);
    const right = Math.min(media.x + media.width, crop.x + crop.width);
    const top = Math.min(media.y + media.height, crop.y + crop.height);
    return validatePageGeometry({
        xPoints: left,
        yPoints: bottom,
        widthPoints: right - left,
        heightPoints: top - bottom,
        rotation: normalizeRotation(page.getRotation().angle),
    });
}

function appendOcrLayer(
    page: PDFPage,
    embeddedPage: Awaited<ReturnType<PDFDocument['embedPage']>>,
    pageGeometry?: IOcrPageGeometry,
) {
    const geometry = resolvePageGeometry(page, pageGeometry);
    const rotation = geometry.rotation;

    const {
        extGState,
        xObject,
    } = cloneMutablePageResources(page);
    const xObjectName = xObject.uniqueKey('EvbOcrLayer');
    xObject.set(xObjectName, embeddedPage.ref);
    const invisibleStateName = extGState.uniqueKey('EvbOcrInvisible');
    extGState.set(invisibleStateName, page.doc.context.obj({
        Type: EXT_G_STATE_TYPE_NAME,
        CA: 0,
        ca: 0,
    }));
    const xObjectToken = xObjectName.toString();
    const invisibleStateToken = invisibleStateName.toString();
    const displayedWidth = rotation === 90 || rotation === 270 ? geometry.heightPoints : geometry.widthPoints;
    const displayedHeight = rotation === 90 || rotation === 270 ? geometry.widthPoints : geometry.heightPoints;
    const xScale = displayedWidth / embeddedPage.width;
    const yScale = displayedHeight / embeddedPage.height;
    const baseTransform = rotation === 0
        ? [
            xScale,
            0,
            0,
            yScale,
            geometry.xPoints,
            geometry.yPoints,
        ]
        : rotation === 90
            ? [
                0,
                xScale,
                -yScale,
                0,
                geometry.xPoints + geometry.widthPoints,
                geometry.yPoints,
            ]
            : rotation === 180
                ? [
                    -xScale,
                    0,
                    0,
                    -yScale,
                    geometry.xPoints + geometry.widthPoints,
                    geometry.yPoints + geometry.heightPoints,
                ]
                : [
                    0,
                    -xScale,
                    yScale,
                    0,
                    geometry.xPoints,
                    geometry.yPoints + geometry.heightPoints,
                ];
    const preprocessTransform = composePreprocessInverse(embeddedPage, geometry);
    const transform = preprocessTransform === undefined
        ? baseTransform
        : (() => {
            const pageMatrix: TMatrix3 = [
                [
                    baseTransform[0]!,
                    baseTransform[2]!,
                    baseTransform[4]!,
                ],
                [
                    baseTransform[1]!,
                    baseTransform[3]!,
                    baseTransform[5]!,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ];
            const composed = multiplyMatrix3(pageMatrix, preprocessTransform);
            return [
                composed[0][0],
                composed[1][0],
                composed[0][1],
                composed[1][1],
                composed[0][2],
                composed[1][2],
            ];
        })();
    const stream = [
        `% ${OCR_LAYER_MARKER}_BEGIN`,
        'q',
        `${invisibleStateToken} gs`,
        `${transform.join(' ')} cm`,
        `${xObjectToken} Do`,
        'Q',
        `% ${OCR_LAYER_MARKER}_END`,
        '',
    ].join('\n');

    const contentRef = page.doc.context.register(page.doc.context.flateStream(stream));
    resolvePageContentsArray(page).push(contentRef);
}

export async function assembleSearchablePdf(
    qpdfBinary: string,
    originalPdfPath: string,
    ocrPdfEntries: ReadonlyMap<number, TOcrPageEntryValue> | AsyncIterable<readonly [number, TOcrPageEntryValue]>,
    pageCount: number,
    tempDir: string,
    sessionId: string,
    log: TWorkerLog,
    trackTempFile: (path: string) => string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const mapEntries = ocrPdfEntries instanceof Map
        ? ocrPdfEntries as ReadonlyMap<number, TOcrPageEntryValue>
        : null;
    const mapPageEntries = mapEntries
        ? Array.from(mapEntries.entries())
            .filter(([pageNumber]) => pageNumber >= 1 && pageNumber <= pageCount)
            .sort(([left], [right]) => left - right)
        : null;
    const geometryByOcrPath = new Map<string, IOcrPageGeometry>();
    const normalizeEntry = (entry: TOcrPageEntryValue) => {
        if (typeof entry === 'string') {
            return entry;
        }
        if (entry.pageGeometry !== undefined) geometryByOcrPath.set(entry.path, entry.pageGeometry);
        return entry.path;
    };
    const ocrPageEntries: ReadonlyArray<readonly [number, string]> | AsyncIterable<readonly [number, string]> = mapPageEntries
        ? mapPageEntries.map(([
            pageNumber,
            entry,
        ]) => [
            pageNumber,
            normalizeEntry(entry),
        ] as const)
        : (async function* () {
            for await (const [
                pageNumber,
                entry,
            ] of ocrPdfEntries as AsyncIterable<readonly [number, TOcrPageEntryValue]>) {
                yield [
                    pageNumber,
                    normalizeEntry(entry),
                ] as const;
            }
        })();
    const entryCount = mapPageEntries?.length ?? 'streaming';
    log('debug', `Replacing OCR text layer for ${String(entryCount)} page(s) while preserving original PDF pages`);
    await assertNonEmptyFile(originalPdfPath, 'Original PDF');
    if (mapPageEntries) {
        await Promise.all(mapPageEntries.map(
            ([
                pageNumber,
                ocrEntry,
            ]) => assertNonEmptyFile(typeof ocrEntry === 'string' ? ocrEntry : ocrEntry.path, `OCR PDF page ${pageNumber}`),
        ));
        if (mapPageEntries.length === 0) {
            throw new Error('No valid OCR pages were available to assemble');
        }
    }

    const replacementPdfPath = await assembleSearchablePdfStreaming({
        qpdfBinary,
        originalPdfPath,
        ocrPageEntries,
        pageCount,
        tempDir,
        sessionId,
        trackTempFile,
        ...(signal ? {signal} : {}),
        mutatePage: async (sourcePagePath, ocrPagePath, outputPath) => {
            const pdf = await loadBoundedGeneratedPagePdf(sourcePagePath, 'Extracted source PDF page');
            const page = pdf.getPage(0);
            removePreviousOcrLayer(page);
            const ocrPdf = await loadBoundedGeneratedPagePdf(ocrPagePath, 'Generated OCR PDF page');
            const ocrPage = ocrPdf.getPage(0);
            sanitizeOcrPageForEmbedding(ocrPage);
            appendOcrLayer(page, await pdf.embedPage(ocrPage), geometryByOcrPath.get(ocrPagePath));
            throwIfAborted(signal);
            await writeFile(outputPath, await pdf.save({useObjectStreams: true}));
        },
    });
    await assertReasonableOcrOutputSize(originalPdfPath, replacementPdfPath);
    throwIfAborted(signal);
    return replacementPdfPath;
}
