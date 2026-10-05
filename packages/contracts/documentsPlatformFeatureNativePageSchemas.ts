import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import {
    parseDocumentRevisionToken, type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    parseEpochMs, type TEpochMs,
} from '@contracts/timestamps';
import * as v from 'valibot';
import {RECENT_READING_VIEW_SCHEMA} from '@contracts/recentReadingView';

const safeInteger = v.pipe(v.number(), v.safeInteger());
const nonNegativeSafeInteger = v.pipe(safeInteger, v.minValue(0));
const positiveSafeInteger = v.pipe(safeInteger, v.minValue(1));
const finiteNumber = v.pipe(v.number(), v.finite());
const positiveFiniteNumber = v.pipe(finiteNumber, v.gtValue(0));
const pdfRotationSchema = v.picklist([
    0,
    90,
    180,
    270,
]);
const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const documentRevisionTokenSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'must be a valid document revision token'),
    v.transform(value => parseDocumentRevisionToken(value) as TDocumentRevisionToken),
);
const epochMsSchema = v.pipe(
    nonNegativeSafeInteger,
    v.transform(value => parseEpochMs(value) as TEpochMs),
);
const pageNumberSchema = v.pipe(
    positiveSafeInteger,
    v.transform(value => requirePageNumber(value)),
);

const pdfOpeningGeometryDataSchema = v.pipe(
    v.object({
        pageNumber: pageNumberSchema,
        pageCount: positiveSafeInteger,
        width: positiveFiniteNumber,
        height: positiveFiniteNumber,
        rotation: pdfRotationSchema,
        widestPageWidth: positiveFiniteNumber,
        size: nonNegativeSafeInteger,
        modifiedAt: epochMsSchema,
        // Where the reader left these unchanged bytes, when Recent has it;
        // the shape is that place's page.
        readingView: v.optional(v.nullable(RECENT_READING_VIEW_SCHEMA)),
        // Every page's exact shape, in order, when the open starts at a
        // reader's place: the pages around it set where it sits.
        pages: v.optional(v.nullable(v.array(v.object({
            widthPoints: positiveFiniteNumber,
            heightPoints: positiveFiniteNumber,
            rotation: pdfRotationSchema,
            userUnit: positiveFiniteNumber,
        })))),
    }),
    v.check(value => !value.pages || value.pages.length === value.pageCount, 'invalid PDF opening geometry result'),
    v.check(value => value.widestPageWidth >= value.width, 'invalid PDF opening geometry result'),
    // The first page's shape, or that of the page the reader left these bytes at.
    v.check(value => (value.readingView
        ? value.readingView.pageCount === value.pageCount
            && (value.readingView.anchor?.page ?? value.readingView.currentPage) === value.pageNumber
        : value.pageNumber === 1), 'invalid PDF opening geometry result'),
);

// Preserve the uniform IPC failure message while Valibot validates the geometry fields.
export const PDF_OPENING_GEOMETRY_SCHEMA = v.pipe(
    v.unknown(),
    v.transform((value) => {
        const result = v.safeParse(pdfOpeningGeometryDataSchema, value, {abortEarly: true});
        if (!result.success) {
            throw new Error('invalid PDF opening geometry result');
        }
        return result.output;
    }),
);

export const PDF_NATIVE_PAGE_SIZES_EXACT_OPTIONS_SCHEMA = v.object({
    mode: v.literal('exact', 'native page sizes options.mode must be exact'),
    expectedDocumentRevisionToken: v.pipe(
        v.unknown(),
        v.check(
            value => typeof value === 'string' && parseDocumentRevisionToken(value) !== null,
            'exact native page sizes require expectedDocumentRevisionToken',
        ),
        v.transform(value => parseDocumentRevisionToken(value as string) as TDocumentRevisionToken),
    ),
});

export const PDF_NATIVE_PAGE_GEOMETRY_PAGE_SCHEMA = v.object({
    pageNumber: pageNumberSchema,
    xPoints: finiteNumber,
    yPoints: finiteNumber,
    widthPoints: positiveFiniteNumber,
    heightPoints: positiveFiniteNumber,
    rotation: pdfRotationSchema,
    userUnit: positiveFiniteNumber,
});

export const PDF_NATIVE_PAGE_GEOMETRY_SCHEMA = v.pipe(
    v.object({
        kind: v.literal('exact'),
        documentRef: documentRefSchema,
        documentRevisionToken: documentRevisionTokenSchema,
        pageCount: positiveSafeInteger,
        pages: v.array(PDF_NATIVE_PAGE_GEOMETRY_PAGE_SCHEMA),
    }),
    v.check(
        value => value.pages.length === value.pageCount,
        'exact native page geometry pages must cover the document',
    ),
    v.check(
        value => value.pages.every((page, index) => page.pageNumber === index + 1),
        'exact native page geometry page numbers must be in order',
    ),
);

export type IPdfOpeningGeometry = v.InferOutput<typeof PDF_OPENING_GEOMETRY_SCHEMA>;
export type IPdfNativePageSizesExactOptions = v.InferOutput<typeof PDF_NATIVE_PAGE_SIZES_EXACT_OPTIONS_SCHEMA>;
export type IPdfNativePageGeometryPage = v.InferOutput<typeof PDF_NATIVE_PAGE_GEOMETRY_PAGE_SCHEMA>;
export type IPdfNativePageGeometry = v.InferOutput<typeof PDF_NATIVE_PAGE_GEOMETRY_SCHEMA>;
