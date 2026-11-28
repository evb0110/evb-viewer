import * as v from 'valibot';
import {BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS, BROWSER_OCR_ENGINE_RESULT_SCHEMA} from '@contracts/browserOcrEngine';
import type {IOcrEngineRequest} from '@ocr-core/tesseractEngine';
import type {IOcrEngineWorkerData} from '@electron/features/ocr/main/ocrEngineWorker';

/** A file-backed PNM raster passed by path across the utility-process IPC boundary. */
export interface IOcrEngineImageFile {
    kind: 'file';
    path: string;
    width: number;
    height: number;
}

export type TOcrEngineImageInput = Uint8Array | IOcrEngineImageFile;
export type TDesktopOcrEngineRequest = IOcrEngineRequest<TOcrEngineImageInput>;

export function isOcrEngineImageFile(value: unknown): value is IOcrEngineImageFile {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value as Partial<IOcrEngineImageFile>;
    return (
        candidate.kind === 'file' &&
        typeof candidate.path === 'string' &&
        candidate.path.length > 0 &&
        typeof candidate.width === 'number' &&
        Number.isSafeInteger(candidate.width) &&
        candidate.width > 0 &&
        typeof candidate.height === 'number' &&
        Number.isSafeInteger(candidate.height) &&
        candidate.height > 0
    );
}

/** One page's passes, sent to an engine lane. */
export interface IOcrEngineLaneRequest {
    id: number;
    request: TDesktopOcrEngineRequest;
}

/**
 * Main to the OCR utility process: start a lane's worker thread, run a page on
 * it, end it, or end every lane and exit.
 */
export type TOcrEngineHostRequest =
    | {
          type: 'start';
          lane: number;
          workerPath: string;
          workerData: IOcrEngineWorkerData;
      }
    | {
          type: 'run';
          lane: number;
          message: IOcrEngineLaneRequest;
      }
    | {
          type: 'end';
          lane: number;
      }
    | {type: 'shutdown'};

const laneSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const nonNegativeBytesSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
// An engine failure carries Tesseract's stderr, which the engine bounds.
const messageTextSchema = v.pipe(v.string(), v.maxLength(BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS + 4_096));

const laneReplySchema = v.union([
    v.object({
        id: laneSchema,
        ok: v.literal(true),
        result: BROWSER_OCR_ENGINE_RESULT_SCHEMA,
        wasmMemoryBytes: v.optional(nonNegativeBytesSchema),
    }),
    v.object({
        id: laneSchema,
        ok: v.literal(false),
        error: messageTextSchema,
        wasmMemoryBytes: v.optional(nonNegativeBytesSchema),
    }),
]);

const hostRequestSchema = v.variant('type', [
    v.object({
        type: v.literal('start'),
        lane: laneSchema,
        workerPath: v.pipe(v.string(), v.minLength(1)),
        workerData: v.object({
            engineDir: v.string(),
            tessdataDir: v.string(),
        }),
    }),
    v.object({
        type: v.literal('run'),
        lane: laneSchema,
        message: v.object({
            id: laneSchema,
            request: v.custom<TDesktopOcrEngineRequest>((value) => {
                if (typeof value !== 'object' || value === null) {
                    return false;
                }
                const image = (value as {image?: unknown}).image;
                return image instanceof Uint8Array || isOcrEngineImageFile(image);
            }),
        }),
    }),
    v.object({
        type: v.literal('end'),
        lane: laneSchema,
    }),
    v.object({type: v.literal('shutdown')}),
]);

const hostEventSchema = v.variant('type', [
    v.object({
        type: v.literal('reply'),
        lane: laneSchema,
        reply: laneReplySchema,
    }),
    v.object({
        type: v.literal('error'),
        lane: laneSchema,
        message: messageTextSchema,
    }),
    v.object({
        type: v.literal('exit'),
        lane: laneSchema,
        code: v.pipe(v.number(), v.integer()),
    }),
]);

/** A lane's answer to one request, as its engine worker thread sends it. */
export type IOcrEngineLaneReply = v.InferOutput<typeof laneReplySchema>;

/** The OCR utility process to main: what a lane's worker thread did. */
export type TOcrEngineHostEvent = v.InferOutput<typeof hostEventSchema>;

export function decodeOcrEngineHostRequest(value: unknown): TOcrEngineHostRequest | null {
    const parsed = v.safeParse(hostRequestSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}

export function decodeOcrEngineHostEvent(value: unknown): TOcrEngineHostEvent | null {
    const parsed = v.safeParse(hostEventSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}
