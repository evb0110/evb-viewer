import type {IPageGeometry} from '@contracts/geometry';
import * as v from 'valibot';

const pdfBoxSchema = v.object({
    x: v.pipe(v.number(), v.finite()),
    y: v.pipe(v.number(), v.finite()),
    width: v.pipe(v.number(), v.finite()),
    height: v.pipe(v.number(), v.finite()),
});

export const PAGE_GEOMETRY_SCHEMA = v.object({
    mediaBox: pdfBoxSchema,
    cropBox: v.nullable(pdfBoxSchema),
    rotation: v.pipe(v.number(), v.finite()),
});

export function decodePageGeometry(value: unknown): IPageGeometry | null {
    const result = v.safeParse(PAGE_GEOMETRY_SCHEMA, value, {abortEarly: true});
    return result.success ? result.output : null;
}
