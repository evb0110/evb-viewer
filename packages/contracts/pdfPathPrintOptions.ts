import {requirePageNumber} from '@contracts/pageNumbers';
import {
    parseRequestId, type TRequestId,
} from '@contracts/shared';
import * as v from 'valibot';

const requestIdSchema = v.pipe(
    v.string('options.requestId must be a non-empty bounded string'),
    v.minLength(1, 'options.requestId must be a non-empty bounded string'),
    v.maxLength(128, 'options.requestId must be a non-empty bounded string'),
    v.check(value => parseRequestId(value) !== null, 'options.requestId must be a non-empty bounded string'),
    v.transform(value => parseRequestId(value) as TRequestId),
);
const pageNumberSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.transform(value => requirePageNumber(value)),
);

export const PDF_PATH_PRINT_OPTIONS_SCHEMA = v.object({
    pageNumbers: v.exactOptional(v.array(pageNumberSchema)),
    requestId: v.exactOptional(requestIdSchema),
    viewMode: v.picklist([
        'single',
        'facing',
        'facing-first-single',
    ], 'options.viewMode is invalid'),
    orientation: v.picklist([
        'auto',
        'portrait',
        'landscape',
    ], 'options.orientation is invalid'),
}, 'options must be an object');

export const PDF_DATA_PRINT_OPTIONS_SCHEMA = v.object({requestId: v.exactOptional(requestIdSchema)}, 'options must be an object');

export const PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA = v.object({requestId: v.pipe(
    v.string('native print dialog event requestId must be a non-empty bounded string'),
    v.minLength(1, 'native print dialog event requestId must be a non-empty bounded string'),
    v.maxLength(128, 'native print dialog event requestId must be a non-empty bounded string'),
    v.check(
        value => parseRequestId(value) !== null,
        'native print dialog event requestId must be a non-empty bounded string',
    ),
    v.transform(value => parseRequestId(value) as TRequestId),
)}, 'native print dialog event must be an object');

export type IPdfPathPrintOptions = v.InferOutput<typeof PDF_PATH_PRINT_OPTIONS_SCHEMA>;
export type IPdfDataPrintOptions = v.InferOutput<typeof PDF_DATA_PRINT_OPTIONS_SCHEMA>;
export type IPdfNativePrintDialogOpenedEvent = v.InferOutput<typeof PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA>;
