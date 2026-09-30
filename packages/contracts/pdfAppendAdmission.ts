import * as v from 'valibot';

/**
 * `evb-pdf-page-ops append-admission` stdout. `repairable` damage keeps the
 * append loaders from finding or following the cross-reference chain and a
 * full rewrite removes it; `limited` is a resource ceiling a rewrite would not
 * change; `unverified` is a base too large for its loader ceilings to be
 * checked at open, which only a save settles.
 */
export const PDF_APPEND_ADMISSION_SCHEMA = v.variant('verdict', [
    v.object({
        verdict: v.literal('appendable'),
        reason: v.null(),
    }),
    v.object({
        verdict: v.picklist([
            'repairable',
            'limited',
            'unverified',
        ]),
        reason: v.string(),
    }),
]);

export type TPdfAppendAdmission = v.InferOutput<typeof PDF_APPEND_ADMISSION_SCHEMA>;
