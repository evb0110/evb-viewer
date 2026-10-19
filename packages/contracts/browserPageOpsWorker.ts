import {
    normalizePdfNativeMutationSet,
    normalizePdfNativeTextBoxAppearanceRequest,
    normalizePdfNativeTextBoxAppearanceMetadata,
    PDF_NATIVE_TEXT_BOX_APPEARANCE_LIMITS,
} from '@contracts/nativePdfMutations';
import {PDF_DECRYPT_PASSWORD_SCHEMA} from '@contracts/pdfDecryptSchemas';
import {isPdfDateString} from '@contracts/pdfDateString';
import {NATIVE_ERROR_ENVELOPE_SCHEMA} from '@contracts/nativeErrors';
import type {ICropMargins} from '@contracts/shared';
import {PAGE_GEOMETRY_SCHEMA} from '@contracts/decodePageGeometry';
import {
    BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS,
    decodeBrowserPdfCatalog,
} from '@contracts/browserPdfCatalog';
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
    top: finiteNonNegativeSchema,
    bottom: finiteNonNegativeSchema,
    left: finiteNonNegativeSchema,
    right: finiteNonNegativeSchema,
});

/**
 * What the Rust OCR writer appends for each recognized page: the target page,
 * the index of its Tesseract page PDF in `pagePdfs`, and the edits early-print
 * reading made to Tesseract's words.
 */
const OCR_TEXT_LAYER_INSTRUCTIONS_SCHEMA = v.object({pages: v.pipe(v.array(v.object({
    pageNumber: positiveIntegerSchema,
    source: nonNegativeIntegerSchema,
    normalizeGreekMicroSign: v.optional(v.boolean()),
    wordEdits: v.optional(v.array(v.object({
        word: nonNegativeIntegerSchema,
        from: v.string(),
        to: v.string(),
    }))),
})), v.minLength(1))});
export type IOcrTextLayerInstructions = v.InferOutput<typeof OCR_TEXT_LAYER_INSTRUCTIONS_SCHEMA>;

const workerRequestPayloadSchemas = {
    textBoxAppearance: v.pipe(v.unknown(), v.transform(value => normalizePdfNativeTextBoxAppearanceRequest(value))),
    deletePages: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
    }),
    extractPages: v.object({
        data: pdfBytesSchema,
        pages: v.array(positiveIntegerSchema),
    }),
    reorderPages: v.object({
        data: pdfBytesSchema,
        newOrder: v.array(positiveIntegerSchema),
    }),
    insertPages: v.object({
        data: pdfBytesSchema,
        insertionData: pdfBytesSchema,
        afterPage: nonNegativeIntegerSchema,
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
    parseAnnotations: v.object({data: pdfBytesSchema}),
    readCatalog: v.object({data: pdfBytesSchema}),
    conformance: v.object({data: pdfBytesSchema}),
    saveMutations: v.object({
        data: pdfBytesSchema,
        originalAppearanceSourceData: v.optional(pdfBytesSchema),
        mutations: v.pipe(v.unknown(), v.transform(value => normalizePdfNativeMutationSet(value, 'Browser PDF save mutations'))),
        modifiedAt: v.custom<string>(isPdfDateString),
    }),
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
    mergePages: v.object({documents: v.pipe(v.array(pdfBytesSchema), v.minLength(1), v.maxLength(500))}),
    ocrTextVisibility: v.object({
        data: pdfBytesSchema,
        pages: v.pipe(v.array(positiveIntegerSchema), v.minLength(1)),
        withEvbOcrText: v.boolean(),
    }),
    ocrTextLayer: v.object({
        data: pdfBytesSchema,
        instructions: OCR_TEXT_LAYER_INSTRUCTIONS_SCHEMA,
        pagePdfs: v.pipe(v.array(pdfBytesSchema), v.minLength(1)),
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
        type: v.literal('saveMutations'),
        payload: workerRequestPayloadSchemas.saveMutations,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('deletePages'),
        payload: workerRequestPayloadSchemas.deletePages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('extractPages'),
        payload: workerRequestPayloadSchemas.extractPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('reorderPages'),
        payload: workerRequestPayloadSchemas.reorderPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('insertPages'),
        payload: workerRequestPayloadSchemas.insertPages,
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
        type: v.literal('mergePages'),
        payload: workerRequestPayloadSchemas.mergePages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextVisibility'),
        payload: workerRequestPayloadSchemas.ocrTextVisibility,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextLayer'),
        payload: workerRequestPayloadSchemas.ocrTextLayer,
    }),
]);

const pageMutationResultSchema = v.object({
    data: pdfBytesSchema,
    pageCount: v.pipe(v.number(), v.check((value: number) => Number.isInteger(value)), v.minValue(1)),
});
const annotationParseResultSchema = v.object({data: pdfBytesSchema});
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
    v.transform(value => decodeBrowserPdfCatalog(value, {maxPageLabels: BROWSER_PDF_CATALOG_MAX_WORKER_PAGE_LABELS})),
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
export const BROWSER_PAGE_OPS_SAVE_MUTATIONS_RESULT_SCHEMA = v.object({
    ...pageMutationResultSchema.entries,
    identityBindings: v.array(v.object({
        annotationId: v.string(),
        pdfRef: v.string(),
    })),
    nativeMutationPostconditionsVerified: v.literal(true),
});

const workerResultSchemas = {
    textBoxAppearance: v.nullable(v.union([
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
    ])),
    saveMutations: v.nullable(v.union([
        BROWSER_PAGE_OPS_SAVE_MUTATIONS_RESULT_SCHEMA,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ])),
    decrypt: v.nullable(v.union([
        pageMutationResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ])),
    printLayout: v.nullable(v.union([
        pageMutationResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ])),
    deletePages: pageMutationResultSchema,
    extractPages: pageMutationResultSchema,
    reorderPages: pageMutationResultSchema,
    insertPages: pageMutationResultSchema,
    rotate: pageMutationResultSchema,
    crop: pageMutationResultSchema,
    removeCrop: pageMutationResultSchema,
    getPageGeometry: PAGE_GEOMETRY_SCHEMA,
    parseAnnotations: annotationParseResultSchema,
    readCatalog: catalogResultSchema,
    conformance: conformanceFactsSchema,
    mergePages: pageMutationResultSchema,
    ocrTextVisibility: v.nullable(v.union([
        PDF_OCR_TEXT_VISIBILITY_REPORT_SCHEMA,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ])),
    // `data` is the revision the writer appends to the request's document.
    ocrTextLayer: v.nullable(v.union([
        pageMutationResultSchema,
        BROWSER_PAGE_OPS_WASM_FAILURE_SCHEMA,
    ])),
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
        type: v.literal('saveMutations'),
        ok: v.literal(true),
        data: workerResultSchemas.saveMutations,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('deletePages'),
        ok: v.literal(true),
        data: workerResultSchemas.deletePages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('extractPages'),
        ok: v.literal(true),
        data: workerResultSchemas.extractPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('reorderPages'),
        ok: v.literal(true),
        data: workerResultSchemas.reorderPages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('insertPages'),
        ok: v.literal(true),
        data: workerResultSchemas.insertPages,
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
        type: v.literal('mergePages'),
        ok: v.literal(true),
        data: workerResultSchemas.mergePages,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextVisibility'),
        ok: v.literal(true),
        data: workerResultSchemas.ocrTextVisibility,
    }),
    v.object({
        id: workerRequestIdSchema,
        type: v.literal('ocrTextLayer'),
        ok: v.literal(true),
        data: workerResultSchemas.ocrTextLayer,
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
    workerResponseSchema as BROWSER_PAGE_OPS_WORKER_RESPONSE_SCHEMA,
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
