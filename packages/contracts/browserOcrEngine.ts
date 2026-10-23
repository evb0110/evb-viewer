import {
    OCR_LANGUAGE_MODEL_SHA256,
    type TOcrModelCode,
} from '@contracts/ocrLanguages';
import * as v from 'valibot';

/** Where a pass reads its page and models inside the engine's file system. */
export const BROWSER_OCR_ENGINE_IMAGE_PATH = '/work/page.ppm';
/** Bump with the pinned engine artifact so existing browser caches cannot mix runtimes. */
export const BROWSER_OCR_ENGINE_REVISION = '5.5.3-r2';
export const BROWSER_OCR_ENGINE_OUTPUT_BASE = '/work/out';
export const BROWSER_OCR_ENGINE_TESSDATA_PATH = '/tessdata';
/** Tesseract's stderr bound on desktop, kept for every pass. */
export const BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS = 262_144;
/** The largest raster a page may send: 45 megapixels of RGB plus its PPM header. */
export const BROWSER_OCR_MAX_RASTER_PIXELS = 45_000_000;
export const BROWSER_OCR_MAX_RASTER_DIMENSION_PX = 40_000;
export const BROWSER_OCR_ENGINE_MAX_IMAGE_BYTES = BROWSER_OCR_MAX_RASTER_PIXELS * 3 + 64;
export const BROWSER_OCR_RENDER_TILE_PX = 4096;

const requestIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const bytesSchema = v.custom<Uint8Array>(value => value instanceof Uint8Array);
const modelCodeSchema = v.custom<TOcrModelCode>(
    value => typeof value === 'string' && Object.hasOwn(OCR_LANGUAGE_MODEL_SHA256, value),
);
const enginePathSchema = v.pipe(v.string(), v.startsWith('/work/'), v.maxLength(256));
const rasterSchema = v.pipe(v.object({
    width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(BROWSER_OCR_MAX_RASTER_DIMENSION_PX)),
    height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(BROWSER_OCR_MAX_RASTER_DIMENSION_PX)),
    tiles: v.pipe(v.array(v.custom<ImageBitmap>(value => typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap)), v.maxLength(100)),
}), v.check(({
    width, height, tiles,
}) => {
    const columns = Math.ceil(width / BROWSER_OCR_RENDER_TILE_PX);
    return width * height <= BROWSER_OCR_MAX_RASTER_PIXELS
        && tiles.length === columns * Math.ceil(height / BROWSER_OCR_RENDER_TILE_PX)
        && tiles.every((tile, index) => tile.width === Math.min(BROWSER_OCR_RENDER_TILE_PX, width - index % columns * BROWSER_OCR_RENDER_TILE_PX)
            && tile.height === Math.min(BROWSER_OCR_RENDER_TILE_PX, height - Math.floor(index / columns) * BROWSER_OCR_RENDER_TILE_PX));
}));

const passSchema = v.object({
    args: v.pipe(v.array(v.pipe(v.string(), v.maxLength(4096))), v.minLength(2), v.maxLength(256)),
    /** Files the pass must write; their bytes come back in the same order. */
    outputs: v.pipe(v.array(enginePathSchema), v.minLength(1), v.maxLength(8)),
});

const recognizeRequestSchema = v.object({
    id: requestIdSchema,
    type: v.literal('recognize'),
    payload: v.object({
        image: v.union([
            v.pipe(bytesSchema, v.check(image => image.byteLength <= BROWSER_OCR_ENGINE_MAX_IMAGE_BYTES)),
            rasterSchema,
        ]),
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
