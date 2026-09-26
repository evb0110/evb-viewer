import {
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {PDF_ANNOTATION_PARSE_MAX_ENTRIES} from '@contracts/pdfAnnotationParseTypes';
import type {TPageIndex} from '@contracts/pageNumbers';
import {
    documentArgs,
    documentResult,
} from '@contracts/documentsPlatformFeatureSchemas';
import {
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    parseDocumentRef,
    requireDocumentRef,
} from '@contracts/documentRef';
import {isPdfNativeNormalizedRectInsidePageBounds} from '@contracts/nativePdfPageBounds';
import {isRecord} from '@contracts/runtimeGuards';
import * as v from 'valibot';

const SHA256_PATTERN = /^[0-9a-f]{64}$/iu;

function finiteNumber(fieldName: string, min?: number, max?: number) {
    const bounds = `${min === undefined ? '' : ` >= ${min}`}${max === undefined ? '' : ` <= ${max}`}`;
    return v.pipe(
        v.number(`${fieldName} must be a finite number${bounds}`),
        v.finite(`${fieldName} must be a finite number${bounds}`),
        v.check(value => (min === undefined || value >= min) && (max === undefined || value <= max),
            `${fieldName} must be a finite number${bounds}`),
    );
}

function nonNegativeInteger(fieldName: string) {
    return v.pipe(
        v.number(`${fieldName} must be a non-negative safe integer`),
        v.safeInteger(`${fieldName} must be a non-negative safe integer`),
        v.minValue(0, `${fieldName} must be a non-negative safe integer`),
    );
}

function nonEmptyString(fieldName: string, allowEmpty = false) {
    return v.pipe(
        v.string(`${fieldName} must be ${allowEmpty ? '' : 'a non-empty '}string`),
        v.check(value => allowEmpty || value.length > 0,
            `${fieldName} must be ${allowEmpty ? '' : 'a non-empty '}string`),
    );
}

function nullableString(fieldName: string, allowEmpty = true) {
    return v.optional(v.nullable(nonEmptyString(fieldName, allowEmpty)), null);
}

function nullableTimestamp(fieldName: string) {
    return v.optional(v.nullable(v.pipe(
        v.number(`${fieldName} must be a safe integer timestamp or null`),
        v.safeInteger(`${fieldName} must be a safe integer timestamp or null`),
        v.minValue(0, `${fieldName} must be a safe integer timestamp or null`),
    )), null);
}

const pageIndexSchema = v.pipe(nonNegativeInteger('pageIndex'), v.transform(value => value as TPageIndex));
const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value)!),
);
const revisionTokenSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'must be a valid document revision token'),
    v.transform(value => parseDocumentRevisionToken(value)!),
);
const parseIdentity = {
    pageIndex: pageIndexSchema,
    objectNumber: nonNegativeInteger('objectNumber'),
    generationNumber: nonNegativeInteger('generationNumber'),
    name: nonEmptyString('name'),
    author: nullableString('author'),
    createdAt: nullableTimestamp('createdAt'),
    modifiedAt: nullableTimestamp('modifiedAt'),
};
const baseRectSchema = v.strictObject({
    left: finiteNumber('rect.left'),
    top: finiteNumber('rect.top'),
    width: finiteNumber('rect.width', 0),
    height: finiteNumber('rect.height', 0),
}, 'contains unsupported field');
const markerRectSchema = v.pipe(
    baseRectSchema,
    v.check(isPdfNativeNormalizedRectInsidePageBounds, 'must be inside the normalized page bounds'),
);
const positiveRectSchema = v.pipe(
    baseRectSchema,
    v.check(rect => rect.width > 0 && rect.height > 0, 'must have positive dimensions'),
);
const rgbColorSchema = (fieldName: string) => v.pipe(
    nonEmptyString(fieldName),
    v.check(value => /^#[0-9a-f]{6}$/iu.test(value), `${fieldName} must be an 8-bit RGB color`),
    v.transform(value => value.toLowerCase()),
);
const sha256Schema = v.pipe(
    nonEmptyString('annotation parse stamp.image.sha256'),
    v.check(value => SHA256_PATTERN.test(value), 'annotation parse stamp.image.sha256 must be a 64-character hexadecimal SHA-256 digest'),
    v.transform(value => value.toLowerCase()),
);
const TEXT_BOX_ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;
const rotationSchema = v.picklist(TEXT_BOX_ROTATIONS,
    'annotation parse text-box.rotation must be 0, 90, 180, or 270');
const pointSchema = v.strictObject({
    x: finiteNumber('point.x'),
    y: finiteNumber('point.y'),
}, 'contains unsupported field');
type TPoint = v.InferOutput<typeof pointSchema>;
const boundedPointsSchema = v.pipe(
    v.unknown(),
    v.check(value => Array.isArray(value) && value.length <= 40_000, 'annotation parse points is too large'),
    v.array(pointSchema),
);
const pointsSchema = v.optional(v.nullable(boundedPointsSchema), null);
const strokeSchema = v.pipe(
    v.optional(v.nullable(v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 40_000,
            'annotation parse shape.strokes is too large'),
        v.array(pointSchema),
    )), null),
    v.transform((value): TPoint[] => value ?? []),
);

const textBoxSchema = v.pipe(
    v.strictObject({
        kind: v.literal('text-box'),
        ...parseIdentity,
        text: nonEmptyString('annotation parse text-box.text', true),
        rect: baseRectSchema,
        rotation: rotationSchema,
        fontSize: finiteNumber('annotation parse text-box.fontSize', Number.MIN_VALUE, 512),
        color: rgbColorSchema('annotation parse text-box.color'),
    }, 'contains unsupported field'),
    v.check(({
        rect, rotation,
    }) => {
        if (rotation % 180 === 0) return isPdfNativeNormalizedRectInsidePageBounds(rect);
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const availableArea = 4 * Math.min(centerX, 1 - centerX) * Math.min(centerY, 1 - centerY);
        return centerX >= 0 && centerX <= 1 && centerY >= 0 && centerY <= 1
            && rect.width * rect.height <= availableArea + 1e-7;
    }, 'annotation parse text-box.rect cannot fit inside the normalized page bounds after rotation'),
);
const noteReplySchema = v.strictObject({
    objectNumber: nonNegativeInteger('annotation parse note.replies.objectNumber'),
    generationNumber: nonNegativeInteger('annotation parse note.replies.generationNumber'),
    contents: nonEmptyString('annotation parse note.replies.contents', true),
    author: nullableString('annotation parse note.replies.author'),
    createdAt: nullableTimestamp('annotation parse note.replies.createdAt'),
    modifiedAt: nullableTimestamp('annotation parse note.replies.modifiedAt'),
}, 'contains unsupported field');
const noteSchema = v.strictObject({
    kind: v.literal('note'),
    ...parseIdentity,
    recoveryData: v.optional(v.pipe(
        v.string(),
        v.check(value => value.length <= 2 * 1024 * 1024 && value.length % 2 === 0 && /^[0-9a-f]+$/u.test(value),
            'annotation parse note.recoveryData must be a bounded native recovery graph'),
    )),
    position: markerRectSchema,
    contents: nonEmptyString('annotation parse note.contents', true),
    color: v.optional(v.nullable(rgbColorSchema('annotation parse note.color')), null),
    open: v.boolean('annotation parse note.open must be a boolean'),
    replies: v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 4_096,
            'annotation parse note.replies must contain at most 4096 replies'),
        v.array(noteReplySchema),
    ),
}, 'contains unsupported field');
const highlightSchema = v.strictObject({
    kind: v.literal('highlight'),
    ...parseIdentity,
    subtype: v.picklist(PDF_ANNOTATION_MARKUP_SUBTYPES, 'annotation parse highlight.subtype is unsupported'),
    quadPoints: v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 512,
            'annotation parse highlight.quadPoints must contain at most 512 rectangles'),
        v.array(markerRectSchema),
    ),
    color: rgbColorSchema('annotation parse highlight.color'),
    opacity: finiteNumber('annotation parse highlight.opacity', 0, 1),
    contents: nonEmptyString('annotation parse highlight.contents', true),
}, 'contains unsupported field');
const stampImageSchema = v.strictObject({
    objectNumber: nonNegativeInteger('annotation parse stamp.image.objectNumber'),
    generationNumber: nonNegativeInteger('annotation parse stamp.image.generationNumber'),
    byteLength: nonNegativeInteger('annotation parse stamp.image.byteLength'),
    sha256: sha256Schema,
}, 'contains unsupported field');
const stampSchema = v.strictObject({
    kind: v.literal('stamp'),
    ...parseIdentity,
    rect: positiveRectSchema,
    rotation: finiteNumber('annotation parse stamp.rotation'),
    image: stampImageSchema,
}, 'contains unsupported field');
const optionalShapeEnum = <T extends readonly string[]>(values: T, fieldName: string) => v.pipe(
    v.optional(v.nullable(v.picklist(values, `annotation parse shape.${fieldName} is unsupported`)), null),
);
const shapeSchema = v.strictObject({
    kind: v.literal('shape'),
    ...parseIdentity,
    stableKey: nullableString('annotation parse shape.stableKey'),
    pdfSubtype: v.picklist(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES, 'annotation parse shape.pdfSubtype is unsupported'),
    type: v.picklist(PDF_ANNOTATION_SHAPE_TYPES, 'annotation parse shape.type is unsupported'),
    x: finiteNumber('annotation parse shape.x'),
    y: finiteNumber('annotation parse shape.y'),
    width: finiteNumber('annotation parse shape.width', 0),
    height: finiteNumber('annotation parse shape.height', 0),
    x2: v.optional(v.nullable(finiteNumber('annotation parse shape.x2')), null),
    y2: v.optional(v.nullable(finiteNumber('annotation parse shape.y2')), null),
    color: rgbColorSchema('annotation parse shape.color'),
    fillColor: v.optional(v.nullable(rgbColorSchema('annotation parse shape.fillColor')), null),
    opacity: finiteNumber('annotation parse shape.opacity', 0, 1),
    strokeWidth: finiteNumber('annotation parse shape.strokeWidth', 0),
    points: pointsSchema,
    strokes: v.optional(v.nullable(v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 4_096,
            'annotation parse shape.strokes is too large'),
        v.array(strokeSchema),
    )), null),
    lineStartStyle: optionalShapeEnum(PDF_ANNOTATION_LINE_END_STYLES, 'lineStartStyle'),
    lineEndStyle: optionalShapeEnum(PDF_ANNOTATION_LINE_END_STYLES, 'lineEndStyle'),
}, 'contains unsupported field');
const foreignSchema = v.strictObject({
    kind: v.literal('foreign'),
    pageIndex: pageIndexSchema,
    objectNumber: nonNegativeInteger('annotation parse foreign.objectNumber'),
    generationNumber: nonNegativeInteger('annotation parse foreign.generationNumber'),
    name: nonEmptyString('annotation parse foreign.name'),
    subtype: nonEmptyString('annotation parse foreign.subtype'),
    reason: nonEmptyString('annotation parse foreign.reason'),
}, 'contains unsupported field');

export const PDF_ANNOTATION_PARSE_ENTRY_SCHEMA = v.variant('kind', [
    textBoxSchema,
    noteSchema,
    highlightSchema,
    stampSchema,
    shapeSchema,
    foreignSchema,
]);
export const PDF_ANNOTATION_PARSE_ENTITY_SCHEMA = v.variant('kind', [
    textBoxSchema,
    noteSchema,
    highlightSchema,
    stampSchema,
    shapeSchema,
]);
export const PDF_ANNOTATION_PARSE_FOREIGN_SCHEMA = foreignSchema;
export const PDF_ANNOTATION_PARSE_OPTIONS_SCHEMA = v.pipe(
    v.unknown(),
    v.check(value => isRecord(value) && typeof value.expectedDocumentRevisionToken === 'string',
        'invalid document revision options'),
    v.object({
        expectedDocumentRevisionToken: revisionTokenSchema,
        changedObjectRefs: v.optional(v.pipe(
            v.unknown(),
            v.check(value => Array.isArray(value) && value.length <= 128,
                'invalid changed PDF object references'),
            v.array(v.pipe(
                v.string(),
                v.regex(/^\d+\s+\d+\s+R$/u, 'invalid changed PDF object references'),
            )),
        )),
        workingCopyOnly: v.optional(v.literal(true)),
    }),
    v.transform(({expectedDocumentRevisionToken}) => ({expectedDocumentRevisionToken})),
);

const parseResultShapeSchema = v.strictObject({
    documentRevisionToken: revisionTokenSchema,
    pageCount: nonNegativeInteger('annotation parse result pageCount'),
    entities: v.pipe(v.array(PDF_ANNOTATION_PARSE_ENTITY_SCHEMA), v.maxLength(PDF_ANNOTATION_PARSE_MAX_ENTRIES)),
    foreign: v.pipe(v.array(foreignSchema), v.maxLength(PDF_ANNOTATION_PARSE_MAX_ENTRIES)),
}, 'contains unsupported field');
export const PDF_ANNOTATION_PARSE_RESULT_SCHEMA = v.pipe(
    v.unknown(),
    v.check(value => isRecord(value)
        && Array.isArray(value.entities)
        && Array.isArray(value.foreign)
        && value.entities.length + value.foreign.length <= PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    `annotation parse result contains more than ${PDF_ANNOTATION_PARSE_MAX_ENTRIES} entries`),
    parseResultShapeSchema,
);

export type IPdfAnnotationParseEntry = v.InferOutput<typeof PDF_ANNOTATION_PARSE_ENTRY_SCHEMA>;
export type TPdfAnnotationParseEntity = v.InferOutput<typeof PDF_ANNOTATION_PARSE_ENTITY_SCHEMA>;
export type IPdfAnnotationForeignEntry = v.InferOutput<typeof PDF_ANNOTATION_PARSE_FOREIGN_SCHEMA>;
export type IPdfAnnotationParseResult = v.InferOutput<typeof PDF_ANNOTATION_PARSE_RESULT_SCHEMA>;
export type IPdfAnnotationParseOptionsWire = v.InferOutput<typeof PDF_ANNOTATION_PARSE_OPTIONS_SCHEMA>;
export type IPdfAnnotationTextBoxEntry = v.InferOutput<typeof textBoxSchema>;
export type IPdfAnnotationNoteReply = v.InferOutput<typeof noteReplySchema>;
export type IPdfAnnotationNoteEntry = v.InferOutput<typeof noteSchema>;
export type IPdfAnnotationHighlightEntry = v.InferOutput<typeof highlightSchema>;
export type IPdfAnnotationStampImageReference = v.InferOutput<typeof stampImageSchema>;
export type IPdfAnnotationStampEntry = v.InferOutput<typeof stampSchema>;
export type IPdfAnnotationParsePoint = v.InferOutput<typeof pointSchema>;
export type IPdfAnnotationShapeEntry = v.InferOutput<typeof shapeSchema>;

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:annotation-parse-fixture');
const pdfAnnotationParseResult = documentResult<'parsePdfAnnotations'>(
    value => v.parse(PDF_ANNOTATION_PARSE_RESULT_SCHEMA, value, {abortEarly: true}),
    () => ({
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entities: [],
        foreign: [],
    }),
);
const parsePdfAnnotationsArgs = documentArgs<'parsePdfAnnotations'>(
    value => v.parse(v.strictTuple([
        documentRefSchema,
        PDF_ANNOTATION_PARSE_OPTIONS_SCHEMA,
    ]), value, {abortEarly: true}),
    () => [
        requireDocumentRef('/tmp/document.pdf'),
        {expectedDocumentRevisionToken: fixtureRevisionToken},
    ],
);

export {
    pdfAnnotationParseResult,
    parsePdfAnnotationsArgs,
};
