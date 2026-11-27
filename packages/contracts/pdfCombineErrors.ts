const _PDF_COMBINE_CAPABILITY_ERROR_CODES = ['native-unavailable', 'native-failure'] as const;

export type TPdfCombineCapabilityErrorCode = (typeof _PDF_COMBINE_CAPABILITY_ERROR_CODES)[number];

export interface IPdfCombineCapabilityErrorOptions {
    cause?: unknown;
    operation?: string;
}

/**
 * A native-only combine could not complete. Callers may present this as a
 * capability problem, but must not retry it through the whole-document JS
 * fallback for a large input set.
 */
export class PdfCombineCapabilityError extends Error {
    public readonly operation: string | undefined;

    public constructor(
        public readonly code: TPdfCombineCapabilityErrorCode,
        message: string,
        options: IPdfCombineCapabilityErrorOptions = {},
    ) {
        super(message, options);
        this.name = 'PdfCombineCapabilityError';
        this.operation = options.operation;
    }
}

export function isPdfCombineCapabilityError(error: unknown): error is PdfCombineCapabilityError {
    return error instanceof PdfCombineCapabilityError;
}
