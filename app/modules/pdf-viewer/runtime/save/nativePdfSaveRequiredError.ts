import type { IPdfViewerNativeRequiredFailure } from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

export class NativePdfSaveRequiredError extends Error {
    readonly code = 'native-save-required' as const;
    readonly failure: IPdfViewerNativeRequiredFailure;

    constructor(failure: IPdfViewerNativeRequiredFailure) {
        super(failure.detail ?? 'Native PDF persistence is required for this document');
        this.name = 'NativePdfSaveRequiredError';
        this.failure = failure;
    }
}
