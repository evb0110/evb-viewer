import * as v from 'valibot';

/**
 * Why the main process refused to open a document, in a form the renderer can
 * localize: the source file changed while its working copy was being made, or
 * a damaged PDF could not be rewritten into one an edit can extend.
 * `fileName` is the base name of the file the user chose, which the renderer
 * may not know yet when a picker open is refused.
 */
export const DOCUMENT_OPEN_ERROR_ENVELOPE_SCHEMA = v.object({
    code: v.picklist([
        'source-changed',
        'invalid-pdf',
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
