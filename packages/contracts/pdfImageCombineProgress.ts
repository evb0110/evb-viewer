import * as v from 'valibot';

/**
 * One `--json-progress` line of `evb-pdf-image-combine`, reduced to the
 * fields its callers report; a missing time estimate becomes null.
 */
export const PDF_IMAGE_COMBINE_PROGRESS_SCHEMA = v.pipe(v.object({
    type: v.literal('progress'),
    processed: v.number(),
    total: v.number(),
    percent: v.number(),
    elapsedMs: v.number(),
    estimatedRemainingMs: v.optional(v.unknown()),
}), v.transform(({
    processed,
    total,
    percent,
    elapsedMs,
    estimatedRemainingMs,
}) => ({
    processed,
    total,
    percent,
    elapsedMs,
    estimatedRemainingMs: typeof estimatedRemainingMs === 'number'
        ? estimatedRemainingMs
        : null,
})));

export type TPdfImageCombineProgress = v.InferOutput<typeof PDF_IMAGE_COMBINE_PROGRESS_SCHEMA>;
