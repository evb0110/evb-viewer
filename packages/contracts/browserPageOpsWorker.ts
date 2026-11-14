import {
    normalizePdfNativeTextBoxAppearanceRequest,
    normalizePdfNativeTextBoxAppearanceMetadata,
    PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS,
} from '@contracts/nativePdfMutations';
import {PDF_DECRYPT_PASSWORD_SCHEMA} from '@contracts/pdfDecryptSchemas';
import {NATIVE_ERROR_ENVELOPE_SCHEMA} from '@contracts/nativeErrors';
import type {ICropMargins} from '@contracts/shared';
import {PAGE_GEOMETRY_SCHEMA} from '@contracts/decodePageGeometry';
import {decodeBrowserPdfCatalog} from '@contracts/browserPdfCatalog';
import type {
    IBrowserPdfCatalog,
    IBrowserPdfCatalogBookmark,
    IBrowserPdfCatalogPageLabelRange,
} from '@contracts/browserPdfCatalog';
import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import {PDF_OCR_TEXT_VISIBILITY_REPORT_SCHEMA} from '@contracts/pdfOcrTextVisibility';
import {
    OVERLAY_TEXT_INSTRUCTIONS_SCHEMA,
    RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA,
    RECOMPRESS_IMAGES_REPORT_SCHEMA,
    REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA,
    REPLACE_PAGE_IMAGES_REPORT_SCHEMA,
    SCAN_CLEANUP_PAGE_OPS_REPORT_SCHEMA,
    SPLIT_PAGES_INSTRUCTIONS_SCHEMA,
} from '@contracts/browserPageOpsWriters';
import * as v from 'valibot';

const workerRequestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonNegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const finiteNonNegativeSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const pdfBytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);

interface IBrowserWorkerSuccessEnvelope {
    id: number;
    ok: true;
    type: string;
    data: unknown;
}

interface IBrowserWorkerFailureEnvelope {
    id: number;
    ok: false;
    error: string;
    errorEnvelope?: unknown;
}

type TBrowserWorkerResponseEnvelope = IBrowserWorkerSuccessEnvelope | IBrowserWorkerFailureEnvelope;

// The worker message is already a structured clone. Validate its envelope
// without building another representation; the owner decodes data/errors.
export function isBrowserWorkerResponseEnvelope(value: unknown): value is TBrowserWorkerResponseEnvelope {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        && ((value.ok === true && typeof value.type === 'string' && 'data' in value)
            || (value.ok === false && typeof value.error === 'string'));
}

const cropMarginsSchema = v.object({
    physical: v.optional(v.boolean()),
    top: finiteNonNegativeSchema,
    bottom: finiteNonNegativeSchema,
    left: finiteNonNegativeSchema,
    right: finiteNonNegativeSchema,
});

/** Each word Tesseract's PDF shows, on its ink rectangle in the raster Tesseract read. */
export const OCR_WORD_GEOMETRY_SCHEMA = v.object({
    rasterWidthPx: v.pipe(v.number(), v.finite(), v.gtValue(0)),
    rasterHeightPx: v.pipe(v.number(), v.finite(), v.gtValue(0)),
    words: v.array(v.object({
        text: v.string(),
        x: finiteNonNegativeSchema,
        y: finiteNonNegativeSchema,
        width: v.pipe(v.number(), v.finite(), v.gtValue(0)),
        height: v.pipe(v.number(), v.finite(), v.gtValue(0)),
    })),
});
export type TOcrWordGeometry = v.InferOutput<typeof OCR_WORD_GEOMETRY_SCHEMA>;

/**
 * What the Rust OCR writer appends for each recognized page: the target page,
 * the index of its Tesseract page PDF in `pagePdfs`, the edits early-print
 * reading made to Tesseract's words, and, when preprocessing moved the pixels
 * Tesseract read, the matrix mapping them back to the rendered raster.
 */
const OCR_TEXT_LAYER_INSTRUCTIONS_SCHEMA = v.object({pages: v.pipe(v.array(v.object({
    pageNumber: positiveIntegerSchema,
    source: nonNegativeIntegerSchema,
    wordGeometry: v.optional(OCR_WORD_GEOMETRY_SCHEMA),
    preprocessInverse: v.optional(v.object({
        rasterWidthPx: v.pipe(v.number(), v.finite(), v.gtValue(0)),
        rasterHeightPx: v.pipe(v.number(), v.finite(), v.gtValue(0)),
        matrix: v.pipe(v.array(v.pipe(v.array(v.pipe(v.number(), v.finite())), v.length(3))), v.length(3)),
    })),
    normalizeGreekMicroSign: v.optional(v.boolean()),
    wordEdits: v.optional(v.array(v.object({
        word: nonNegativeIntegerSchema,
        from: v.string(),
        to: v.string(),
    }))),
})), v.minLength(1))});
export type IOcrTextLayerInstructions = v.InferOutput<typeof OCR_TEXT_LAYER_INSTRUCTIONS_SCHEMA>;

/** A Scan Cleanup source raster, requested as desktop asks `pdftoppm` for one. */
export const SCAN_CLEANUP_RASTER_REQUEST_SCHEMA = v.strictObject({
    pageNumber: positiveIntegerSchema,
    dpi: v.pipe(v.number(), v.finite(), v.minValue(1)),
    renderBox: v.picklist([
        'cropBox',
        'mediaBox',
    ]),
    slice: v.optional(v.strictObject({
        x: nonNegativeIntegerSchema,
        y: nonNegativeIntegerSchema,
        width: nonNegativeIntegerSchema,
        height: nonNegativeIntegerSchema,
    })),
    maxPixels: positiveIntegerSchema,
});

/** A page's raster size and how closely its samples match desktop's, or why it has no scan raster. */
const SCAN_CLEANUP_RASTER_REPORT_SCHEMA = v.union([
    v.strictObject({
        width: positiveIntegerSchema,
        height: positiveIntegerSchema,
        compatibility: v.picklist([
            'exact',
            'near',
        ]),
    }),
    v.strictObject({unsupported: v.string()}),
]);

const workerRequestPayloadSchemas = {
    textBoxAppearance: v.pipe(v.unknown(), v.transform(value => normalizePdfNativeTextBoxAppearanceRequest(value))),
    /**
     * A page-structure edit the engine reads from `sources` by range and writes to the new file at the store
     * path `output`, or returns as bytes when `output` is null (a document the browser keeps in memory).
     * Delete, extract and reorder edit the first source; insert puts the second after `afterPage` of the
     * first; merge joins every source.
     */
    pageStructure: v.object({
        edit: v.variant('kind', [
            v.object({
                kind: v.picklist([
                    'delete',
                    'extract',
                    'reorder',
                ]),
                pages: v.pipe(v.array(positiveIntegerSchema), v.minLength(1)),
            }),
            v.object({
                kind: v.literal('insert'),
                afterPage: nonNegativeIntegerSchema,
            }),
            v.object({kind: v.literal('merge')}),
        ]),
        sources: v.pipe(v.array(v.instance(Blob)), v.minLength(1)),
        output: v.nullable(v.string()),
    }),
    rotate: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
        angle: v.picklist([
            90,
            180,
            270,
        ]),
    }),
    crop: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
        margins: cropMarginsSchema,
    }),
    removeCrop: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
    }),
    getPageGeometry: v.object({
        data: pdfBytesSchema,
        pageNumber: positiveIntegerSchema,
    }),
    /** Reads take their document as a Blob the engine reads by range. */
    parseAnnotations: v.object({source: v.instance(Blob)}),
    readCatalog: v.object({source: v.instance(Blob)}),
    conformance: v.object({data: pdfBytesSchema}),
    decrypt: v.object({
        data: pdfBytesSchema,
        password: PDF_DECRYPT_PASSWORD_SCHEMA,
    }),
    printLayout: v.object({
        data: pdfBytesSchema,
        pageNumbers: v.array(positiveIntegerSchema),
        viewMode: v.picklist([
            'single',
            'facing',
            'facing-first-single',
        ]),
        orientation: v.picklist([
            'auto',
            'portrait',
            'landscape',
        ]),
    }),
    ocrTextVisibility: v.object({
        source: v.instance(Blob),
        pages: v.pipe(v.array(positiveIntegerSchema), v.minLength(1)),
        withEvbOcrText: v.boolean(),
    }),
    /** No pages lists every page. */
    inspectScanCleanupPdf: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
    }),
    renderScanCleanupRaster: v.object({
        data: pdfBytesSchema,
        request: SCAN_CLEANUP_RASTER_REQUEST_SCHEMA,
    }),
    splitPages: v.object({
        data: pdfBytesSchema,
        instructions: SPLIT_PAGES_INSTRUCTIONS_SCHEMA,
    }),
    // `data` is the staged output; `sourceData` the document its text comes from.
    overlayText: v.object({
        data: pdfBytesSchema,
        sourceData: pdfBytesSchema,
        instructions: OVERLAY_TEXT_INSTRUCTIONS_SCHEMA,
    }),
    recompressImages: v.object({
        data: pdfBytesSchema,
        instructions: RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA,
    }),
    replacePageImages: v.object({
        data: pdfBytesSchema,
        instructions: REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA,
        replacementPdfs: v.array(pdfBytesSchema),
    }),
};

const workerRequestSchema = v.union([
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('textBoxAppearance'),
        payload: workerRequestPayloadSchemas.textBoxAppearance,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('printLayout'),
        payload: workerRequestPayloadSchemas.printLayout,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('decrypt'),
        payload: workerRequestPayloadSchemas.decrypt,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('pageStructure'),
        payload: workerRequestPayloadSchemas.pageStructure,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('rotate'),
        payload: workerRequestPayloadSchemas.rotate,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('crop'),
        payload: workerRequestPayloadSchemas.crop,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('removeCrop'),
        payload: workerRequestPayloadSchemas.removeCrop,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('getPageGeometry'),
        payload: workerRequestPayloadSchemas.getPageGeometry,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('parseAnnotations'),
        payload: workerRequestPayloadSchemas.parseAnnotations,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('readCatalog'),
        payload: workerRequestPayloadSchemas.readCatalog,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('conformance'),
        payload: workerRequestPayloadSchemas.conformance,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextVisibility'),
        payload: workerRequestPayloadSchemas.ocrTextVisibility,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('inspectScanCleanupPdf'),
        payload: workerRequestPayloadSchemas.inspectScanCleanupPdf,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('renderScanCleanupRaster'),
        payload: workerRequestPayloadSchemas.renderScanCleanupRaster,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('splitPages'),
        payload: workerRequestPayloadSchemas.splitPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('overlayText'),
        payload: workerRequestPayloadSchemas.overlayText,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('recompressImages'),
        payload: workerRequestPayloadSchemas.recompressImages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('replacePageImages'),
        payload: workerRequestPayloadSchemas.replacePageImages,
    }),
]);

const pageMutationResultSchema = v.object({
    data: pdfBytesSchema,
    pageCount: v.pipe(v.number(), v.check((value: number) => Number.isInteger(value)), v.minValue(1)),
});
const annotationParseResultSchema = v.object({data: pdfBytesSchema});
// The whole rewritten PDF and the report its CLI command prints.
const reportedPdfResultSchema = v.object({
    ...pageMutationResultSchema.entries,
    report: SCAN_CLEANUP_PAGE_OPS_REPORT_SCHEMA,
});
// `data` is the revision the writer appends to the request's document, empty
// when the pass changed nothing; `report` is what its CLI command prints.
const reportedIncrementResultSchema = <TReport extends v.GenericSchema>(report: TReport) => v.object({
    ...pageMutationResultSchema.entries,
    report,
});
const conformanceFactsSchema = v.object({
    isSigned: v.boolean(),
    isEncrypted: v.boolean(),
    isTagged: v.boolean(),
    hasAcroForm: v.boolean(),
    hasXfa: v.boolean(),
});
// The shared decoder enforces recursive bookmark depth and aggregate item budgets.
const catalogResultSchema = v.pipe(
    v.unknown(),
    v.transform(value => decodeBrowserPdfCatalog(value)),
    v.check(value => value !== null),
    v.transform(value => value as IBrowserPdfCatalog),
);

export const BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA = v.object({
    status: v.literal('failed'),
    error: NATIVE_ERROR_ENVELOPE_SCHEMA,
});
export type IBrowserPageOpsWasmFailure = v.InferOutput<typeof BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA>;
export function isBrowserPageOpsWasmFailure(value: unknown): value is IBrowserPageOpsWasmFailure {
    return isRecord(value) && value.status === 'failed'
        && v.safeParse(BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA, value, {abortEarly: true}).success;
}

const workerResultSchemas = {
    textBoxAppearance: v.union([
        v.pipe(
            v.object({
                data: v.pipe(pdfBytesSchema, v.check(value => value.byteLength > 0
                && value.byteLength <= PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS.outputBytes)),
                textBoxes: v.unknown(),
            }),
            v.transform(value => ({
                ...normalizePdfNativeTextBoxAppearanceMetadata({textBoxes: value.textBoxes}),
                data: value.data,
            })),
        ),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    decrypt: v.union([
        pageMutationResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    printLayout: v.union([
        pageMutationResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    // `written`: the output's page count and length, and its bytes when the request named no file.
    pageStructure: v.union([
        v.object({
            status: v.literal('written'),
            pageCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
            length: nonNegativeIntegerSchema,
            data: v.optional(pdfBytesSchema),
        }),
        v.object({status: v.literal('storage-full')}),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    rotate: pageMutationResultSchema,
    crop: pageMutationResultSchema,
    removeCrop: pageMutationResultSchema,
    getPageGeometry: PAGE_GEOMETRY_SCHEMA,
    parseAnnotations: annotationParseResultSchema,
    readCatalog: catalogResultSchema,
    conformance: conformanceFactsSchema,
    ocrTextVisibility: v.union([
        PDF_OCR_TEXT_VISIBILITY_REPORT_SCHEMA,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    // Each record is the desktop page-size sidecar's; its reader decodes it.
    inspectScanCleanupPdf: v.union([
        v.object({
            pageCount: nonNegativeIntegerSchema,
            pages: v.array(v.custom<Record<string, unknown>>(isRecord)),
        }),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    // `data` is the page's RGB rows, top-down, empty when it has no scan raster.
    renderScanCleanupRaster: v.union([
        v.object({
            data: pdfBytesSchema,
            report: SCAN_CLEANUP_RASTER_REPORT_SCHEMA,
        }),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    splitPages: v.union([
        reportedPdfResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    overlayText: v.union([
        reportedPdfResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    recompressImages: v.union([
        reportedIncrementResultSchema(RECOMPRESS_IMAGES_REPORT_SCHEMA),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
    replacePageImages: v.union([
        reportedIncrementResultSchema(REPLACE_PAGE_IMAGES_REPORT_SCHEMA),
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ]),
};

const workerSuccessResponseSchema = v.union([
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('textBoxAppearance'),
        ok: v.literal(true),
        data: workerResultSchemas.textBoxAppearance,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('printLayout'),
        ok: v.literal(true),
        data: workerResultSchemas.printLayout,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('decrypt'),
        ok: v.literal(true),
        data: workerResultSchemas.decrypt,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('pageStructure'),
        ok: v.literal(true),
        data: workerResultSchemas.pageStructure,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('rotate'),
        ok: v.literal(true),
        data: workerResultSchemas.rotate,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('crop'),
        ok: v.literal(true),
        data: workerResultSchemas.crop,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('removeCrop'),
        ok: v.literal(true),
        data: workerResultSchemas.removeCrop,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('getPageGeometry'),
        ok: v.literal(true),
        data: workerResultSchemas.getPageGeometry,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('parseAnnotations'),
        ok: v.literal(true),
        data: workerResultSchemas.parseAnnotations,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('readCatalog'),
        ok: v.literal(true),
        data: workerResultSchemas.readCatalog,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('conformance'),
        ok: v.literal(true),
        data: workerResultSchemas.conformance,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextVisibility'),
        ok: v.literal(true),
        data: workerResultSchemas.ocrTextVisibility,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('inspectScanCleanupPdf'),
        ok: v.literal(true),
        data: workerResultSchemas.inspectScanCleanupPdf,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('renderScanCleanupRaster'),
        ok: v.literal(true),
        data: workerResultSchemas.renderScanCleanupRaster,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('splitPages'),
        ok: v.literal(true),
        data: workerResultSchemas.splitPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('overlayText'),
        ok: v.literal(true),
        data: workerResultSchemas.overlayText,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('recompressImages'),
        ok: v.literal(true),
        data: workerResultSchemas.recompressImages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('replacePageImages'),
        ok: v.literal(true),
        data: workerResultSchemas.replacePageImages,
    }),
]);

const workerResponseSchema = v.union([
    workerSuccessResponseSchema,
    v.object({
        id: workerRequestIdSchema,
        ok: v.literal(false),
        error: v.string(),
    }),
]);

type IBrowserPageOpsWorkerRequestMap = {
    [K in keyof typeof workerRequestPayloadSchemas]: v.InferOutput<(typeof workerRequestPayloadSchemas)[K]>;
};

type IBrowserPageOpsWorkerResultMap = {
    [K in keyof typeof workerResultSchemas]: v.InferOutput<(typeof workerResultSchemas)[K]>;
};

type TBrowserPageOpsWorkerRequestType = keyof IBrowserPageOpsWorkerRequestMap;
type TBrowserPageOpsWorkerRequest = v.InferOutput<typeof workerRequestSchema>;
type IBrowserPageOpsWorkerRequest<K extends TBrowserPageOpsWorkerRequestType = TBrowserPageOpsWorkerRequestType> = Extract<
    TBrowserPageOpsWorkerRequest,
    {type: K}
>;
type IPageMutationWorkerResult = v.InferOutput<typeof pageMutationResultSchema>;
type IBrowserPdfConformanceFacts = v.InferOutput<typeof conformanceFactsSchema>;
type TBrowserPageOpsWorkerResponse = v.InferOutput<typeof workerResponseSchema>;

export function getBrowserPageOpsWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPageOpsWorkerRequest(value: unknown): TBrowserPageOpsWorkerRequest | null {
    try {
        const result = v.safeParse(workerRequestSchema, value, {abortEarly: true});
        return result.success ? result.output : null;
    } catch {
        // Native mutation normalizers reject cross-field semantics at this wire boundary.
        return null;
    }
}

export {
    workerResultSchemas as BROWSER_PAGE_OPS_WORKER_RESULT_SCHEMAS,
};

export type {
    IBrowserPageOpsWorkerRequest,
    IBrowserPageOpsWorkerRequestMap,
    IBrowserPageOpsWorkerResultMap,
    IPageMutationWorkerResult,
    IBrowserPdfCatalogBookmark as IBrowserPdfCombineBookmarkEntry,
    IBrowserPdfCatalogPageLabelRange as IBrowserPdfCombinePageLabelRange,
    IBrowserPdfCatalog as IBrowserPdfCombineCatalog,
    IBrowserPdfConformanceFacts,
    TBrowserPageOpsWorkerRequest,
    TBrowserPageOpsWorkerRequestType,
    TBrowserPageOpsWorkerResponse,
    ICropMargins,
};
