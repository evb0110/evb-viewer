import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
} from '@contracts/electronApiDocuments';
import {
    documentArgs,
    documentResult,
    type TDocumentMethodArgs,
} from '@contracts/documentsPlatformFeatureSchemas';
import {
    parseDocumentRevisionToken, requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    parseDocumentRef, requireDocumentRef,
} from '@contracts/documentRef';
import {requirePageIndex} from '@contracts/pageNumbers';
import {isRecord} from '@contracts/runtimeGuards';
import {parseSessionId} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
import * as v from 'valibot';

function safeInteger(fieldName: string, min = 0) {
    return v.pipe(
        v.number(`${fieldName} must be a safe integer >= ${min}`),
        v.safeInteger(`${fieldName} must be a safe integer >= ${min}`),
        v.minValue(min, `${fieldName} must be a safe integer >= ${min}`),
    );
}

function finiteNumber(fieldName: string, min?: number) {
    const bound = min === undefined ? '' : ` >= ${min}`;
    return v.pipe(
        v.number(`${fieldName} must be a finite number${bound}`),
        v.finite(`${fieldName} must be a finite number${bound}`),
        v.check(value => min === undefined || value >= min, `${fieldName} must be a finite number${bound}`),
    );
}

const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'path must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value)!),
);
const sessionIdSchema = v.pipe(
    v.string(),
    v.check(value => parseSessionId(value) !== null, 'sessionId must be a non-empty session ID'),
    v.transform(value => parseSessionId(value)!),
);
const revisionTokenSchema = v.pipe(
    v.string('invalid document revision options'),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'invalid document revision options'),
    v.transform(value => parseDocumentRevisionToken(value)!),
);
const revisionOptionsSchema = v.pipe(
    v.unknown(),
    v.check(value => isRecord(value), 'invalid document revision options'),
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
const embeddedShapeIndexOptionsSchema = revisionOptionsSchema;
const chunkOptionsSchema = v.pipe(
    v.nullish(v.object({chunkBytes: v.optional(safeInteger('options.chunkBytes', 1))})),
    v.transform(value => value ?? undefined),
    v.check(value => value?.chunkBytes === undefined || value.chunkBytes <= PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
        `options.chunkBytes must be at most ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES}`),
    v.transform(value => value === undefined ? undefined : value.chunkBytes === undefined ? {} : value),
);

const pointSchema = v.object({
    x: finiteNumber('embedded shape index point.x'),
    y: finiteNumber('embedded shape index point.y'),
});
const boundedPointsSchema = v.pipe(
    v.unknown(),
    v.check(value => Array.isArray(value) && value.length <= 40_000,
        'embedded shape index entry points must contain at most 40000 points'),
    v.array(pointSchema),
);
const boundedStrokePointsSchema = v.pipe(
    v.unknown(),
    v.check(value => Array.isArray(value) && value.length <= 40_000,
        'annotation index entry strokes must contain at most 40000 points'),
    v.array(pointSchema),
);
const pointsSchema = v.pipe(
    v.nullish(boundedPointsSchema),
    v.transform(value => value ?? null),
);
const strokePointsSchema = v.pipe(
    v.nullish(boundedStrokePointsSchema),
    v.transform(value => value ?? []),
);
const strokesSchema = v.pipe(
    v.nullish(v.pipe(
        v.unknown(),
        v.check(value => Array.isArray(value) && value.length <= 4_096,
            'annotation index entry strokes must contain at most 4096 strokes'),
        v.array(strokePointsSchema),
    )),
    v.transform(value => value ?? null),
);
const nullableStringSchema = (fieldName: string) => v.pipe(
    v.nullish(v.pipe(
        v.string(`${fieldName} must be a non-empty string`),
        v.check(value => value.length > 0, `${fieldName} must be a non-empty string`),
    )),
    v.transform(value => value ?? null),
);
const nullableTimestampSchema = (fieldName: string) => v.pipe(
    v.nullish(v.pipe(
        v.number(`${fieldName} must be a safe integer timestamp or null`),
        v.safeInteger(`${fieldName} must be a safe integer timestamp or null`),
        v.minValue(0, `${fieldName} must be a safe integer timestamp or null`),
        v.transform(value => parseEpochMs(value)!),
    )),
    v.transform(value => value ?? null),
);
const nullableStyleSchema = v.pipe(
    v.nullish(v.picklist(PDF_ANNOTATION_LINE_END_STYLES)),
    v.transform(value => value ?? null),
);

export const PDF_EMBEDDED_SHAPE_INDEX_POINT_SCHEMA = pointSchema;
export const PDF_EMBEDDED_SHAPE_INDEX_ENTRY_SCHEMA = v.object({
    pageIndex: v.pipe(safeInteger('embedded shape index entry pageIndex'), v.transform(value => requirePageIndex(value))),
    objectNumber: safeInteger('embedded shape index entry objectNumber', 1),
    generationNumber: safeInteger('embedded shape index entry generationNumber'),
    stableKey: nullableStringSchema('embedded shape index entry stableKey'),
    pdfSubtype: v.picklist(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES, 'embedded shape index entry pdfSubtype is unsupported'),
    type: v.picklist(PDF_ANNOTATION_SHAPE_TYPES, 'embedded shape index entry type is unsupported'),
    x: finiteNumber('embedded shape index entry x'),
    y: finiteNumber('embedded shape index entry y'),
    width: finiteNumber('embedded shape index entry width', 0),
    height: finiteNumber('embedded shape index entry height', 0),
    x2: v.pipe(v.nullish(finiteNumber('embedded shape index entry x2')), v.transform(value => value ?? null)),
    y2: v.pipe(v.nullish(finiteNumber('embedded shape index entry y2')), v.transform(value => value ?? null)),
    color: v.pipe(v.string(), v.check(value => value.length > 0, 'embedded shape index entry color must be a non-empty string')),
    fillColor: nullableStringSchema('embedded shape index entry fillColor'),
    opacity: finiteNumber('embedded shape index entry opacity', 0),
    strokeWidth: finiteNumber('embedded shape index entry strokeWidth', 0),
    points: pointsSchema,
    strokes: strokesSchema,
    lineStartStyle: nullableStyleSchema,
    lineEndStyle: nullableStyleSchema,
    createdAt: nullableTimestampSchema('embedded shape index entry createdAt'),
    modifiedAt: nullableTimestampSchema('embedded shape index entry modifiedAt'),
});
export const PDF_EMBEDDED_SHAPE_INDEX_SESSION_SCHEMA = v.object({
    sessionId: sessionIdSchema,
    documentRef: documentRefSchema,
    documentRevisionToken: revisionTokenSchema,
    pageCount: safeInteger('embedded shape index pageCount'),
    entryCount: safeInteger('embedded shape index entryCount'),
    totalBytes: safeInteger('embedded shape index totalBytes'),
});
export const PDF_EMBEDDED_SHAPE_INDEX_CHUNK_SCHEMA = v.pipe(
    v.object({
        offset: safeInteger('embedded shape index chunk offset'),
        nextOffset: v.nullish(safeInteger('embedded shape index chunk nextOffset')),
        byteLength: v.pipe(
            safeInteger('embedded shape index chunk byteLength'),
            v.maxValue(PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
                `embedded shape index chunk exceeds ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES} bytes`),
        ),
        done: v.boolean(),
        entries: v.array(PDF_EMBEDDED_SHAPE_INDEX_ENTRY_SCHEMA),
    }),
    v.transform(chunk => ({
        ...chunk,
        nextOffset: chunk.nextOffset ?? null,
    })),
);

export type IPdfEmbeddedShapeIndexPoint = v.InferOutput<typeof PDF_EMBEDDED_SHAPE_INDEX_POINT_SCHEMA>;
export type IPdfEmbeddedShapeIndexEntry = v.InferOutput<typeof PDF_EMBEDDED_SHAPE_INDEX_ENTRY_SCHEMA>;
export type IPdfEmbeddedShapeIndexOptions = v.InferOutput<typeof embeddedShapeIndexOptionsSchema>;
export type IPdfEmbeddedShapeIndexChunkOptions = NonNullable<v.InferOutput<typeof chunkOptionsSchema>>;
export type IPdfEmbeddedShapeIndexSession = v.InferOutput<typeof PDF_EMBEDDED_SHAPE_INDEX_SESSION_SCHEMA>;
export type IPdfEmbeddedShapeIndexChunk = v.InferOutput<typeof PDF_EMBEDDED_SHAPE_INDEX_CHUNK_SCHEMA>;

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:embedded-shape-index-fixture');
const fixtureSessionId = parseSessionId('embedded-shape-index-1')!;
const beginPdfEmbeddedShapeIndexArgs = documentArgs<'beginPdfEmbeddedShapeIndex'>(
    value => v.parse(v.strictTuple([
        documentRefSchema,
        embeddedShapeIndexOptionsSchema,
    ]), value, {abortEarly: true}),
    () => [
        requireDocumentRef('/tmp/document.pdf'),
        {expectedDocumentRevisionToken: fixtureRevisionToken},
    ],
);
const readPdfEmbeddedShapeIndexChunkArgs = documentArgs<'readPdfEmbeddedShapeIndexChunk'>(
    value => v.parse(v.pipe(
        v.strictTuple([
            sessionIdSchema,
            safeInteger('offset'),
            v.optional(chunkOptionsSchema),
        ]),
        v.transform(([
            sessionId,
            offset,
            options,
        ]) => options === undefined ? [
            sessionId,
            offset,
        ] : [
            sessionId,
            offset,
            options,
        ]),
    ), value, {abortEarly: true}) as TDocumentMethodArgs<'readPdfEmbeddedShapeIndexChunk'>,
    () => [
        fixtureSessionId,
        0,
    ],
);
const releasePdfEmbeddedShapeIndexArgs = documentArgs<'releasePdfEmbeddedShapeIndex'>(
    value => v.parse(v.strictTuple([sessionIdSchema]), value, {abortEarly: true}),
    () => [fixtureSessionId],
);
const pdfEmbeddedShapeIndexSessionResult = documentResult<'beginPdfEmbeddedShapeIndex'>(
    value => v.parse(PDF_EMBEDDED_SHAPE_INDEX_SESSION_SCHEMA, value, {abortEarly: true}),
    () => ({
        sessionId: fixtureSessionId,
        documentRef: requireDocumentRef('/tmp/document.pdf'),
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entryCount: 0,
        totalBytes: 1,
    }),
);
const pdfEmbeddedShapeIndexChunkResult = documentResult<'readPdfEmbeddedShapeIndexChunk'>(
    value => v.parse(PDF_EMBEDDED_SHAPE_INDEX_CHUNK_SCHEMA, value, {abortEarly: true}),
    () => ({
        offset: 0,
        nextOffset: null,
        byteLength: 0,
        done: true,
        entries: [],
    }),
);

export {
    beginPdfEmbeddedShapeIndexArgs,
    pdfEmbeddedShapeIndexChunkResult,
    pdfEmbeddedShapeIndexSessionResult,
    readPdfEmbeddedShapeIndexChunkArgs,
    releasePdfEmbeddedShapeIndexArgs,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
};
