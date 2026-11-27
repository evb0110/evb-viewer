const _PDF_PAGE_OPS_CAPABILITY_ERROR_CODES = ['native-unavailable', 'native-failure', 'too-large'] as const;

export type TPdfPageOpsCapabilityErrorCode = (typeof _PDF_PAGE_OPS_CAPABILITY_ERROR_CODES)[number];

export interface IPdfPageOpsCapabilityErrorOptions {
    cause?: unknown;
    operation?: string;
}

/**
 * A path-backed page operation could not complete without the whole-document
 * JavaScript compatibility path. Callers must keep large inputs fail-closed.
 */
export class PdfPageOpsCapabilityError extends Error {
    public readonly operation: string | undefined;

    public constructor(
        public readonly code: TPdfPageOpsCapabilityErrorCode,
        message: string,
        options: IPdfPageOpsCapabilityErrorOptions = {},
    ) {
        super(message);
        this.name = 'PdfPageOpsCapabilityError';
        this.operation = options.operation;
        if (options.cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                enumerable: false,
                value: options.cause,
                writable: false,
            });
        }
    }
}

export function isPdfPageOpsCapabilityError(error: unknown): error is PdfPageOpsCapabilityError {
    return error instanceof PdfPageOpsCapabilityError;
}
