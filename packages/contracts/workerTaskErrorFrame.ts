import {isRecord} from '@contracts/runtimeGuards';
import {SERIALIZABLE_ERROR_ENVELOPE_SCHEMA} from '@contracts/serializableError';
import * as v from 'valibot';

const WORKER_TASK_ERROR_FRAME_OBJECT_SCHEMA = v.object({
    ...SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries,
    code: v.optional(SERIALIZABLE_ERROR_ENVELOPE_SCHEMA.entries.code),
    name: v.optional(v.string()),
    canceled: v.optional(v.boolean()),
    source: v.optional(v.string()),
    /**
     * Set when the worker stopped a native process tree without being able to
     * prove it died. A symbol-tagged error cannot survive the structured clone
     * between a worker and main, so the outcome travels as data on the frame and
     * is re-attached to the `WorkerTaskError` main throws.
     */
    terminationUnproven: v.optional(v.string()),
});

export const WORKER_TASK_ERROR_FRAME_SCHEMA = v.pipe(
    v.unknown(),
    v.check(isRecord, 'Expected worker task error frame object'),
    v.rawTransform(({dataset, addIssue, NEVER}) => {
        const result = v.safeParse(WORKER_TASK_ERROR_FRAME_OBJECT_SCHEMA, dataset.value, {abortEarly: true});
        if (!result.success) {
            for (const issue of result.issues) {
                addIssue({message: issue.message});
            }
            return NEVER;
        }
        return result.output;
    }),
);

export type IWorkerTaskErrorFrame = v.InferOutput<typeof WORKER_TASK_ERROR_FRAME_SCHEMA>;

export function parseWorkerTaskErrorFrame(value: unknown): IWorkerTaskErrorFrame | null {
    const result = v.safeParse(WORKER_TASK_ERROR_FRAME_SCHEMA, value, {abortEarly: true});
    return result.success ? result.output : null;
}
