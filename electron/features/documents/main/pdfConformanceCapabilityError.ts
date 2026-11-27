const _PDF_CONFORMANCE_CAPABILITY_ERROR_CODES = ['native-unavailable', 'native-failure', 'structural-output-too-large'] as const;

export type TPdfConformanceCapabilityErrorCode = (typeof _PDF_CONFORMANCE_CAPABILITY_ERROR_CODES)[number];

export interface IPdfConformanceCapabilityErrorOptions {
    cause?: unknown;
    operation?: string;
}

/**
 * Path-backed conformance could not be established without materializing the
 * document. Callers must keep the path flow fail-closed instead of retrying
 * with PDF.js or a whole-document byte read.
 */
export class PdfConformanceCapabilityError extends Error {
    public readonly operation: string | undefined;

    public constructor(
        public readonly code: TPdfConformanceCapabilityErrorCode,
        message: string,
        options: IPdfConformanceCapabilityErrorOptions = {},
    ) {
        super(message, options);
        this.name = 'PdfConformanceCapabilityError';
        this.operation = options.operation;
    }
}
