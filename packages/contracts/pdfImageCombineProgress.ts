import * as v from 'valibot';

/**
 * One `--json-progress` line of `evb-pdf-image-combine`, reduced to the
 * fields its callers report; a missing time estimate becomes null.
 */
export const PDF_IMAGE_COMBINE_PROGRESS_SCHEMA = v.pipe(v.object({
    type: v.literal('progress'),
    processed: v.pipe(v.number(), v.finite(), v.minValue(0)),
    total: v.pipe(v.number(), v.finite(), v.minValue(0)),
    percent: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(100)),
    elapsedMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
    estimatedRemainingMs: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
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
    estimatedRemainingMs: estimatedRemainingMs ?? null,
})));

export type TPdfImageCombineProgress = v.InferOutput<typeof PDF_IMAGE_COMBINE_PROGRESS_SCHEMA>;
