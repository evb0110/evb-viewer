import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import * as v from 'valibot';

const documentRefSchema = v.pipe(
    v.string(),
    v.check(value => parseDocumentRef(value) !== null, 'path must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const validationOptionsSchema = v.object({purpose: v.picklist([
    'opening',
    'save',
], 'validation options must be {purpose: \'opening\' | \'save\'}')}, 'validation options must be {purpose: \'opening\' | \'save\'}');
export type IPdfPathValidationOptions = v.InferOutput<typeof validationOptionsSchema>;

export const PDF_VALIDATION_PATH_ARGS_SCHEMA = v.pipe(
    v.strictTuple([
        documentRefSchema,
        v.optional(validationOptionsSchema),
    ]),
    v.transform(([
        path,
        options,
    ]): [TDocumentRef, options?: IPdfPathValidationOptions] => options === undefined ? [path] : [
        path,
        options,
    ]),
);

export const pdfValidationPathArgs = PDF_VALIDATION_PATH_ARGS_SCHEMA;
