import * as v from 'valibot';

/**
 * Why an open was refused, for the renderer to localize. `fileName` is the
 * chosen file's base name, unknown to a refused picker open.
 */
export const DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA = v.object({
    code: v.picklist([
        'source-changed',
        'invalid-pdf',
        'empty-pdf',
        'not-found',
        'invalid-djvu',
        'djvu-raster-limit',
    ]),
    message: v.string(),
    fileName: v.optional(v.string()),
});

export type TDocumentOpenErrorCode = v.InferOutput<typeof DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA>['code'];

/** A main-process open refusal whose code crosses IPC for the renderer to localize. */
export class DocumentOpenRefusalError extends Error {
    readonly fileName: string | undefined;

    constructor(
        readonly code: TDocumentOpenErrorCode,
        message: string,
        options: {
            cause?: unknown;
            fileName?: string;
        } = {},
    ) {
        const {
            fileName,
            ...errorOptions
        } = options;
        super(message, errorOptions);
        this.name = 'DocumentOpenRefusalError';
        this.fileName = fileName;
    }
}
