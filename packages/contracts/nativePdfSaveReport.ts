import * as v from 'valibot';
import {isRecord} from '@contracts/runtimeGuards';
import {normalizePdfNativeAnnotationIdentityBindings} from '@contracts/nativePdfIdentityBindings';
import {PDF_ANNOTATION_PARSE_PAGE_INDICES_SCHEMA} from '@contracts/pdfAnnotationParseSchemas';

export const PDF_NATIVE_ANNOTATION_DELETE_EFFECTS_SCHEMA = v.object({
    affectedPageIndices: PDF_ANNOTATION_PARSE_PAGE_INDICES_SCHEMA,
    deletedReplyRefs: v.pipe(v.array(v.pipe(v.string(), v.maxLength(40), v.regex(/^[1-9]\d* \d+ R$/u), v.check(ref => ref.split(' ').slice(0, 2).every(part => Number.isSafeInteger(Number(part)))))), v.maxLength(4_096)),
});
export type TNativeAnnotationDeleteEffects = v.InferOutput<typeof PDF_NATIVE_ANNOTATION_DELETE_EFFECTS_SCHEMA>;

/** Older/whole saves emit only bindings. Deletion scope requires explicit proof. */
export function parseNativePdfSaveReport(value: unknown) {
    const report = isRecord(value) ? value : {identityBindings: value};
    return {
        identityBindings: normalizePdfNativeAnnotationIdentityBindings(report.identityBindings, 'native save bindings', {
            errorKind: 'error',
            scope: 'chunk',
        }),
        ...(report.annotationDeleteEffects === undefined ? {} : {annotationDeleteEffects: v.parse(PDF_NATIVE_ANNOTATION_DELETE_EFFECTS_SCHEMA, report.annotationDeleteEffects)}),
    };
}

export function mergeNativeAnnotationDeleteEffects(effects: readonly TNativeAnnotationDeleteEffects[]) {
    if (!effects.length) return undefined;
    const affectedPageIndices = [...new Set(effects.flatMap(effect => effect.affectedPageIndices))].sort((a, b) => a - b);
    const deletedReplyRefs = [...new Set(effects.flatMap(effect => effect.deletedReplyRefs))];
    return v.safeParse(PDF_NATIVE_ANNOTATION_DELETE_EFFECTS_SCHEMA, {
        affectedPageIndices,
        deletedReplyRefs,
    }).success
        ? {
            affectedPageIndices,
            deletedReplyRefs,
        } : undefined;
}
