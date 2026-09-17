export const SCAN_CLEANUP_OUTPUT_MISSING_ERROR_CODE = 'SCAN_CLEANUP_OUTPUT_MISSING' as const;
export const SCAN_CLEANUP_PDF_VALIDATION_ERROR_CODE = 'SCAN_CLEANUP_PDF_VALIDATION_FAILED' as const;
export const SCAN_CLEANUP_CONTRACT_ERROR_CODE = 'SCAN_CLEANUP_CONTRACT_VIOLATION' as const;
export const SCAN_CLEANUP_STREAMING_EVIDENCE_ERROR_CODE = 'SCAN_CLEANUP_STREAMING_EVIDENCE_INVALID' as const;
export class ScanCleanupMissingOutputError extends Error {
    readonly code = SCAN_CLEANUP_OUTPUT_MISSING_ERROR_CODE;
    readonly sourcePageNumber: number;
    readonly outputPath: string | undefined;
    readonly role: string;

    constructor(
        sourcePageNumber: number,
        outputPath: string | undefined,
        role: string,
        detail?: string,
    ) {
        super(
            `Scan cleanup produced output for source page ${String(sourcePageNumber)} is missing: ${role}`
            + (outputPath === undefined ? '' : ` at ${outputPath}`)
            + (detail === undefined ? '' : ` (${detail})`),
        );
        this.name = 'ScanCleanupMissingOutputError';
        this.sourcePageNumber = sourcePageNumber;
        this.outputPath = outputPath;
        this.role = role;
    }
}

export class ScanCleanupPdfValidationError extends Error {
    readonly code = SCAN_CLEANUP_PDF_VALIDATION_ERROR_CODE;
    readonly stagedPdfPath: string;

    constructor(stagedPdfPath: string, detail?: string) {
        super(
            `Scan cleanup staged PDF failed structural validation: ${stagedPdfPath}`
            + (detail === undefined ? '' : ` (${detail})`),
        );
        this.name = 'ScanCleanupPdfValidationError';
        this.stagedPdfPath = stagedPdfPath;
    }
}

export class ScanCleanupContractError extends Error {
    readonly code = SCAN_CLEANUP_CONTRACT_ERROR_CODE;

    constructor(detail: string) {
        super(`Scan cleanup contract violation: ${detail}`);
        this.name = 'ScanCleanupContractError';
    }
}

export class ScanCleanupTooLargeError extends Error {
    readonly code = 'too-large' as const;

    constructor() {
        super('Scan cleanup ink placement exceeds the supported 20,000-page document capacity');
        this.name = 'ScanCleanupTooLargeError';
    }
}

export class ScanCleanupStreamingEvidenceError extends Error {
    readonly code = SCAN_CLEANUP_STREAMING_EVIDENCE_ERROR_CODE;
    readonly sidecarPath: string;

    constructor(sidecarPath: string, detail: string) {
        super(`Scan cleanup streaming evidence is invalid: ${sidecarPath} (${detail})`);
        this.name = 'ScanCleanupStreamingEvidenceError';
        this.sidecarPath = sidecarPath;
    }
}

export class ScanCleanupNativeToolUnavailableError extends Error {
    readonly code = 'tools-unavailable' as const;
    readonly toolName: string;

    constructor(toolName: string) {
        super(`Scan cleanup native tool is unavailable: ${toolName}`);
        this.name = 'ScanCleanupNativeToolUnavailableError';
        this.toolName = toolName;
    }
}

/**
 * Detection could not stage even one page raster inside the scratch budget.
 *
 * This is the only remaining storage refusal: a document is never rejected for
 * its length, because it is analysed through a bounded window that is replayed.
 * The two figures travel with the error so the renderer can state how much
 * space is free and how much is needed without parsing an English sentence.
 */
export class ScanCleanupInsufficientScratchError extends Error {
    readonly code = 'insufficient-scratch' as const;
    readonly availableBytes: number | null;
    readonly requiredBytes: number | null;
    readonly scratchShortfall: {
        availableBytes: number | null;
        requiredBytes: number | null;
    };

    constructor(availableBytes: number | null, requiredBytes: number | null) {
        const figures = [
            availableBytes === null ? null : `${String(availableBytes)} bytes free`,
            requiredBytes === null ? null : `${String(requiredBytes)} bytes required`,
        ].filter(figure => figure !== null);
        super(
            'Scan cleanup detection cannot stage one page raster within the available scratch space'
            + (figures.length === 0 ? '' : ` (${figures.join(', ')})`),
        );
        this.name = 'ScanCleanupInsufficientScratchError';
        this.availableBytes = availableBytes;
        this.requiredBytes = requiredBytes;
        this.scratchShortfall = {
            availableBytes,
            requiredBytes,
        };
    }
}
