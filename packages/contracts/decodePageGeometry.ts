import {
    isFiniteNumber, isRecord,
} from '@contracts/runtimeGuards';
import * as v from 'valibot';

export const PDF_BOX_SCHEMA = v.object({
    x: v.pipe(v.number(), v.finite()),
    y: v.pipe(v.number(), v.finite()),
    width: v.pipe(v.number(), v.finite()),
    height: v.pipe(v.number(), v.finite()),
});

function isFiniteBox(value: unknown) {
    return isRecord(value)
        && isFiniteNumber(value.x)
        && isFiniteNumber(value.y)
        && isFiniteNumber(value.width)
        && isFiniteNumber(value.height);
}

export const PAGE_GEOMETRY_SCHEMA = v.pipe(
    v.unknown(),
    v.check(value => isRecord(value) && isFiniteNumber(value.rotation), 'page geometry must contain a finite rotation'),
    v.check(value => isRecord(value)
        && isFiniteBox(value.mediaBox)
        && (value.cropBox === null || isFiniteBox(value.cropBox)),
    'page geometry box must contain finite coordinates'),
    v.object({
        mediaBox: PDF_BOX_SCHEMA,
        cropBox: v.nullable(PDF_BOX_SCHEMA),
        rotation: v.pipe(v.number(), v.finite()),
    }),
);

export type IPdfBox = v.InferOutput<typeof PDF_BOX_SCHEMA>;
export type IPageGeometry = v.InferOutput<typeof PAGE_GEOMETRY_SCHEMA>;

export function decodePageGeometry(value: unknown): IPageGeometry | null {
    const result = v.safeParse(PAGE_GEOMETRY_SCHEMA, value, {abortEarly: true});
    return result.success ? result.output : null;
}
