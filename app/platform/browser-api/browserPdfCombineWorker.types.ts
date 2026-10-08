import {
    isRecord,
    isSafeWorkerRequestId,
} from '@contracts/runtimeGuards';
import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import * as v from 'valibot';

export const BROWSER_PDF_COMBINE_PAGE_SPEC_MAX_BYTES = 192 * 1024 * 1024;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const byteArraySchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const pdfBytesSchema = v.pipe(
    byteArraySchema,
    v.check(value => value.byteLength >= 8 && new TextDecoder().decode(value.subarray(0, 5)) === '%PDF-'),
);
const jpegQualitySchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100));
const ppiCapSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(1200));
const rgbChannelSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(255));
const positiveFiniteNumber = v.pipe(
    v.number(),
    v.finite(),
    v.check(value => value > 0),
);

const inputSchema = v.object({
    fileName: v.pipe(v.string(), v.check(value => value.trim().length > 0)),
    data: byteArraySchema,
});

const pageSizeSchema = v.object({
    widthPoints: positiveFiniteNumber,
    heightPoints: positiveFiniteNumber,
});

const pageSpecShared = {
    pageSize: pageSizeSchema,
    jpegQuality: v.optional(jpegQualitySchema),
    ppiCap: v.optional(ppiCapSchema),
    rotationDegrees: v.optional(v.picklist([
        0,
        90,
        180,
        270,
        360,
        450,
        540,
        630,
    ])),
    foregroundColor: v.optional(v.strictTuple([
        rgbChannelSchema,
        rgbChannelSchema,
        rgbChannelSchema,
    ])),
    image: v.optional(inputSchema),
    background: v.optional(inputSchema),
    mask: v.optional(inputSchema),
};

const pageSpecSchemas = [
    v.object({
        ...pageSpecShared,
        kind: v.literal('image'),
        image: inputSchema,
    }),
    v.object({
        ...pageSpecShared,
        kind: v.literal('mask'),
        mask: inputSchema,
    }),
    v.object({
        ...pageSpecShared,
        kind: v.literal('layered'),
        background: inputSchema,
        mask: inputSchema,
    }),
    v.object({
        ...pageSpecShared,
        kind: v.literal('layered-color'),
        background: inputSchema,
        mask: inputSchema,
        foregroundColor: v.strictTuple([
            rgbChannelSchema,
            rgbChannelSchema,
            rgbChannelSchema,
        ]),
    }),
] as const;

const pageSpecSchema = v.union(pageSpecSchemas);
const imagePreprocessingSchema = v.object({
    jpegQuality: v.optional(jpegQualitySchema),
    ppiCap: v.optional(ppiCapSchema),
    pageSizes: v.optional(v.pipe(v.array(pageSizeSchema), v.maxLength(500))),
    pageSpecs: v.optional(v.pipe(v.array(pageSpecSchema), v.minLength(1), v.maxLength(500))),
});
const combinePayloadSchema = v.pipe(v.object({
    inputs: v.pipe(v.array(inputSchema), v.maxLength(500)),
    wasmImagePreprocessing: v.optional(imagePreprocessingSchema),
}), v.check(value => value.inputs.length > 0 || (value.wasmImagePreprocessing?.pageSpecs?.length ?? 0) > 0));

const requestSchema = v.object({
    id: requestIdSchema,
    type: v.literal('combinePdfs'),
    payload: combinePayloadSchema,
});

const resultSchemas = {combinePdfs: v.object({data: pdfBytesSchema})};

const workerResponseSchema = v.union([
    v.object({
        id: requestIdSchema,
        type: v.literal('combinePdfs'),
        ok: v.literal(true),
        data: pdfBytesSchema,
    }),
    v.object({
        id: requestIdSchema,
        ok: v.literal(false),
        error: v.string(),
        errorEnvelope: v.optional(v.custom<INativeErrorEnvelope>(isNativeErrorEnvelope)),
    }),
]);

interface IBrowserPdfCombineWorkerRequestMap {combinePdfs: v.InferOutput<typeof combinePayloadSchema>;}
type IBrowserPdfCombineWorkerResultMap = {
    [K in keyof typeof resultSchemas]: v.InferOutput<(typeof resultSchemas)[K]>;
};
type TBrowserPdfCombineWorkerRequestType = keyof IBrowserPdfCombineWorkerRequestMap;
type TBrowserPdfCombineWorkerRequest = v.InferOutput<typeof requestSchema>;
type IBrowserPdfCombineWorkerRequest<K extends TBrowserPdfCombineWorkerRequestType = TBrowserPdfCombineWorkerRequestType> = Extract<
    TBrowserPdfCombineWorkerRequest,
    {type: K}
>;
type TBrowserPdfCombineWorkerResponse = v.InferOutput<typeof workerResponseSchema>;
type IBrowserPdfCombineInput = v.InferOutput<typeof inputSchema>;
type IBrowserPdfCombinePageSize = v.InferOutput<typeof pageSizeSchema>;
type IBrowserPdfCombineWasmPageSpec = v.InferOutput<typeof pageSpecSchema>;
type IBrowserPdfCombineWasmImagePreprocessing = v.InferOutput<typeof imagePreprocessingSchema>;
type IBrowserPdfCombinePayload = v.InferOutput<typeof combinePayloadSchema>;
type TBrowserPdfCombineWasmPageKind = IBrowserPdfCombineWasmPageSpec['kind'];
type TBrowserPdfCombineRgb = NonNullable<IBrowserPdfCombineWasmPageSpec['foregroundColor']>;

export function getBrowserPdfCombineWorkerRequestId(value: unknown) {
    return isRecord(value) && isSafeWorkerRequestId(value.id)
        ? value.id
        : null;
}

export function parseBrowserPdfCombineWorkerRequest(value: unknown): TBrowserPdfCombineWorkerRequest | null {
    const result = v.safeParse(requestSchema, value, {abortEarly: true});
    return result.success ? result.output : null;
}

export {
    resultSchemas as BROWSER_PDF_COMBINE_WORKER_RESULT_SCHEMAS,
    workerResponseSchema as BROWSER_PDF_COMBINE_WORKER_RESPONSE_SCHEMA,
};

export type {
    IBrowserPdfCombineInput,
    IBrowserPdfCombinePageSize,
    IBrowserPdfCombinePayload,
    IBrowserPdfCombineWasmImagePreprocessing,
    IBrowserPdfCombineWasmPageSpec,
    IBrowserPdfCombineWorkerRequestMap,
    IBrowserPdfCombineWorkerResultMap,
    IBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineRgb,
    TBrowserPdfCombineWasmPageKind,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerRequestType,
    TBrowserPdfCombineWorkerResponse,
};
