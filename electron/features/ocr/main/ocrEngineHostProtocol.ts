import * as v from 'valibot';
import {
    BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS,
    BROWSER_OCR_ENGINE_RESULT_SCHEMA,
} from '@contracts/browserOcrEngine';
import type {
    IOcrEngineRequest,
    IOcrEngineResult,
} from '@ocr-core/tesseractEngine';
import type {IOcrEngineWorkerData} from '@electron/features/ocr/main/ocrEngineWorker';

/** One page's passes, sent to an engine lane. */
export interface IOcrEngineLaneRequest {
    id: number;
    request: IOcrEngineRequest;
}

/** A lane's answer to one request, as its engine worker thread sends it. */
export interface IOcrEngineLaneReply {
    id: number;
    ok: boolean;
    result?: IOcrEngineResult;
    error?: string;
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

/** The OCR utility process to main: what a lane's worker thread did. */
export type TOcrEngineHostEvent =
    | {
        type: 'reply';
        lane: number;
        reply: IOcrEngineLaneReply;
    }
    | {
        type: 'error';
        lane: number;
        message: string;
    }
    | {
        type: 'exit';
        lane: number;
        code: number;
    };

const laneSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
// An engine failure carries Tesseract's stderr, which the engine bounds.
const messageTextSchema = v.pipe(v.string(), v.maxLength(BROWSER_OCR_ENGINE_MAX_STDERR_CHARACTERS + 4_096));

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
            request: v.custom<IOcrEngineRequest>(value => typeof value === 'object'
                && value !== null
                && (value as {image?: unknown}).image instanceof Uint8Array),
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
        reply: v.union([
            v.object({
                id: laneSchema,
                ok: v.literal(true),
                result: BROWSER_OCR_ENGINE_RESULT_SCHEMA,
            }),
            v.object({
                id: laneSchema,
                ok: v.literal(false),
                error: messageTextSchema,
            }),
        ]),
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

export function decodeOcrEngineHostRequest(value: unknown): TOcrEngineHostRequest | null {
    const parsed = v.safeParse(hostRequestSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}

export function decodeOcrEngineHostEvent(value: unknown): TOcrEngineHostEvent | null {
    const parsed = v.safeParse(hostEventSchema, value, {abortEarly: true});
    return parsed.success ? parsed.output : null;
}
