import * as v from 'valibot';
import type {
    TPdfViewRotation, TPdfViewMode, TZoomMode,
} from '@contracts/shared';

export const ZOOM_MODE_SCHEMA = v.picklist([
    'custom',
    'fit-height',
    'fit-width',
] satisfies TZoomMode[]);
export const VIEW_MODE_SCHEMA = v.picklist([
    'single',
    'facing',
    'facing-first-single',
] satisfies TPdfViewMode[]);
export const VIEW_ROTATION_SCHEMA = v.picklist([
    0,
    90,
    180,
    270,
] satisfies TPdfViewRotation[]);

const pageSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const fractionSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));

/** A place in a document that survives relayout: a point on a page and where it sits in the viewport. */
export const PDF_SEMANTIC_ANCHOR_SCHEMA = v.object({
    page: pageSchema,
    pageXFraction: fractionSchema,
    pageYFraction: fractionSchema,
    viewportXFraction: fractionSchema,
    viewportYFraction: fractionSchema,
    affinity: v.picklist([
        'start',
        'center',
        'end',
    ]),
});
export type IPdfSemanticAnchor = v.InferOutput<typeof PDF_SEMANTIC_ANCHOR_SCHEMA>;

/**
 * Where a reader left a document: the subset of a view that a later normal
 * open of the same, unchanged bytes starts from. Fit modes are recomputed
 * against the new window, so only the custom zoom value is kept.
 */
export const RECENT_READING_VIEW_SCHEMA = v.object({
    currentPage: pageSchema,
    pageCount: pageSchema,
    zoom: v.pipe(v.number(), v.finite(), v.minValue(Number.MIN_VALUE)),
    zoomMode: ZOOM_MODE_SCHEMA,
    viewMode: VIEW_MODE_SCHEMA,
    continuousScroll: v.boolean(),
    viewRotation: VIEW_ROTATION_SCHEMA,
    anchor: v.optional(PDF_SEMANTIC_ANCHOR_SCHEMA),
});
export type IRecentReadingView = v.InferOutput<typeof RECENT_READING_VIEW_SCHEMA>;
