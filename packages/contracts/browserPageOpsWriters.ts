import * as v from 'valibot';

/*
 * Instructions and reports of the page-ops writers that desktop runs as
 * `split-pages`, `overlay-text`, `recompress-images` and `replace-page-images`.
 * The browser sends the same JSON the CLI reads from `--instructions-file`;
 * the Rust writer validates it as it validates the file, so instructions keep
 * every field for it to judge. A report is the JSON line the CLI prints on
 * success.
 */

const nonNegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const finiteSchema = v.pipe(v.number(), v.finite());
const rectSchema = v.strictObject({
    x: finiteSchema,
    y: finiteSchema,
    width: finiteSchema,
    height: finiteSchema,
});
const matrixSchema = v.tuple([
    finiteSchema,
    finiteSchema,
    finiteSchema,
    finiteSchema,
    finiteSchema,
    finiteSchema,
]);
const provenanceStampHexSchema = v.optional(v.pipe(v.string(), v.regex(/^(?:[0-9a-f]{2})+$/)));

export const SPLIT_PAGES_INSTRUCTIONS_SCHEMA = v.strictObject({
    pages: v.pipe(v.array(v.strictObject({
        sourcePageIndex: nonNegativeIntegerSchema,
        rotationQuarterTurns: v.pipe(v.number(), v.safeInteger()),
        outputs: v.array(v.strictObject({
            cropRect: rectSchema,
            contentTransform: v.optional(v.strictObject({
                scale: finiteSchema,
                translateX: finiteSchema,
                translateY: finiteSchema,
            })),
        })),
    })), v.minLength(1)),
    provenanceStampHex: provenanceStampHexSchema,
    /** `assembly` carries navigation, labels and page dependencies; omitted, the split keeps the source catalog. */
    catalog: v.optional(v.picklist([
        'source',
        'assembly',
    ])),
});
export type ISplitPagesInstructions = v.InferOutput<typeof SPLIT_PAGES_INSTRUCTIONS_SCHEMA>;

export const OVERLAY_TEXT_INSTRUCTIONS_SCHEMA = v.strictObject({
    pages: v.pipe(v.array(v.strictObject({
        sourcePageIndex: nonNegativeIntegerSchema,
        outputPageIndex: nonNegativeIntegerSchema,
        /** PDF `cm` operands mapping source-page user space into output-page user space. */
        matrix: matrixSchema,
        sourceRegion: v.optional(v.strictObject({
            rect: rectSchema,
            matrix: matrixSchema,
        })),
        filterToOutputPage: v.optional(v.boolean()),
        normalizeGreekMicroSign: v.optional(v.boolean()),
        linkOnly: v.optional(v.boolean()),
        unmappedGeometry: v.optional(v.boolean()),
    })), v.minLength(1)),
    provenanceStampHex: provenanceStampHexSchema,
});
export type IOverlayTextInstructions = v.InferOutput<typeof OVERLAY_TEXT_INSTRUCTIONS_SCHEMA>;

export const RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA = v.strictObject({
    targetDpi: finiteSchema,
    quality: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(100)),
    maxByteRatio: finiteSchema,
    skipPages: v.optional(v.array(positiveIntegerSchema)),
});
export type IRecompressImagesInstructions = v.InferOutput<typeof RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA>;

export const REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA = v.strictObject({
    pages: v.array(v.strictObject({
        pageNumber: positiveIntegerSchema,
        /** Index of the replacement PDF in the request's `replacementPdfs`. */
        replacement: nonNegativeIntegerSchema,
        replacementPageNumber: positiveIntegerSchema,
    })),
    maxByteRatio: finiteSchema,
});
export type IReplacePageImagesInstructions = v.InferOutput<typeof REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA>;

/** What `split-pages` and `overlay-text` print; scan cleanup reads the same line on desktop. */
/**
 * A document-wide loss result: a dropped tag tree, and the one-based source
 * pages whose text an overlay could not place on some output page.
 */
export const SCAN_CLEANUP_PAGE_OPS_REPORT_SCHEMA = v.object({
    accessibilityTagsRemoved: v.optional(v.boolean()),
    textOmittedSourcePages: v.optional(v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1))), []),
});

const byteCountSchema = nonNegativeIntegerSchema;

export const RECOMPRESS_IMAGES_REPORT_SCHEMA = v.object({
    format: v.literal('evb-pdf-recompress-images'),
    images: v.array(v.object({
        objectNumber: positiveIntegerSchema,
        outcome: v.picklist([
            'recompressed',
            'not-smaller',
            'unsupported',
        ]),
        sourceBytes: byteCountSchema,
        recompressedBytes: byteCountSchema,
    })),
    /** Pages whose images were recompressed. */
    pages: v.array(positiveIntegerSchema),
});

export const REPLACE_PAGE_IMAGES_REPORT_SCHEMA = v.object({
    format: v.literal('evb-pdf-replace-page-images'),
    pages: v.array(v.object({
        pageNumber: positiveIntegerSchema,
        outcome: v.picklist([
            'replaced',
            'not-smaller',
            'no-images',
            'visible-text',
            'visible-drawing',
            'form-xobject',
            'unsupported-text',
            'tagged-content',
            'optional-content',
        ]),
        sourceBytes: byteCountSchema,
        replacementBytes: byteCountSchema,
    })),
});
