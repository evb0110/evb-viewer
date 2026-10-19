import {
    OCR_LANGUAGE_MODEL_SHA256,
    type TOcrModelCode,
} from '@contracts/ocrLanguages';
import * as v from 'valibot';

/** Where a pass reads its page and models inside the engine's file system. */
export const BROWSER_OCR_ENGINE_IMAGE_PATH = '/work/page.ppm';
export const BROWSER_OCR_ENGINE_OUTPUT_BASE = '/work/out';
export const BROWSER_OCR_ENGINE_TESSDATA_PATH = '/tessdata';
/** Tesseract's stderr bound on desktop, kept for every pass. */
export const BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS = 262_144;
/** The largest raster a page may send: 45 megapixels of RGB plus its PPM header. */
export const BROWSER_OCR_ENGINE_MAX_IMAGE_BYTES = 45_000_000 * 3 + 64;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const bytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const modelCodeSchema = v.custom<TOcrModelCode>(
    value => typeof value === 'string' && Object.hasOwn(OCR_LANGUAGE_MODEL_SHA256, value),
);
const enginePathSchema = v.pipe(v.string(), v.startsWith('/work/'), v.maxLength(256));

const passSchema = v.object({
    args: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.minLength(2), v.maxLength(256)),
    /** Files the pass must write; their bytes come back in the same order. */
    outputs: v.pipe(v.array(enginePathSchema), v.minLength(1), v.maxLength(8)),
});

const recognizeRequestSchema = v.object({
    id: requestIdSchema,
    type: v.literal('recognize'),
    payload: v.object({
        image: v.pipe(bytesSchema, v.check(image => image.byteLength <= BROWSER_OCR_ENGINE_MAX_IMAGE_BYTES)),
        models: v.pipe(v.array(modelCodeSchema), v.minLength(1), v.maxLength(16)),
        passes: v.pipe(v.array(passSchema), v.minLength(1), v.maxLength(8)),
    }),
});

const passResultSchema = v.object({
    stderr: v.pipe(v.string(), v.maxLength(BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS)),
    outputs: v.array(bytesSchema),
});

export const BROWSER_OCR_ENGINE_RESULT_SCHEMA = v.object({passes: v.array(passResultSchema)});

export type TBrowserOcrEngineRequest = v.InferOutput<typeof recognizeRequestSchema>;
export type IBrowserOcrEnginePass = v.InferOutput<typeof passSchema>;
export type IBrowserOcrEngineResult = v.InferOutput<typeof BROWSER_OCR_ENGINE_RESULT_SCHEMA>;

export function parseBrowserOcrEngineRequest(value: unknown) {
    const parsed = v.safeParse(recognizeRequestSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}
