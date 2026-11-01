import {compact} from 'es-toolkit';
import type {IPdfValidationResult} from '@contracts/pdfConformance';

/**
 * The qpdf command lines EVB Viewer runs and how it reads their results. Desktop
 * runs them with its bundled qpdf, the browser with the same qpdf built to
 * WebAssembly (`scripts/build-qpdf-wasm.sh`), so both shells take one decision.
 */

/** qpdf finished without warnings. */
export const QPDF_EXIT_CODE_OK = 0;
/** qpdf finished with warnings, for example after rebuilding a damaged cross-reference table. */
export const QPDF_EXIT_CODE_WARNINGS = 3;
/** Exits the commands below accept; 2 (errors) and anything else refuse. */
export const QPDF_SUCCESS_EXIT_CODES: readonly number[] = [
    QPDF_EXIT_CODE_OK,
    QPDF_EXIT_CODE_WARNINGS,
];

export function isQpdfSuccessExitCode(exitCode: number) {
    return QPDF_SUCCESS_EXIT_CODES.includes(exitCode);
}

/** Rewrites a PDF; qpdf rebuilds a damaged cross-reference table on the way. */
export function getQpdfRewriteArgs(inputPath: string, outputPath: string) {
    return [
        inputPath,
        outputPath,
    ];
}

/** The full structural check behind PDF validation. */
export function getQpdfCheckArgs(inputPath: string) {
    return [
        '--check',
        inputPath,
    ];
}

/** Reads the page tree: the page count, and a quick structural check. */
export function getQpdfPageCountArgs(inputPath: string) {
    return [
        '--show-npages',
        inputPath,
    ];
}

/** Save As optimization: linearized, object streams generated, stream data untouched. */
export function getQpdfLosslessRewriteArgs(inputPath: string, outputPath: string) {
    return [
        '--linearize',
        '--stream-data=preserve',
        '--object-streams=generate',
        inputPath,
        outputPath,
    ];
}

/** The diagnostic lines of a qpdf run, without its progress lines. */
export function extractQpdfWarnings(text: string) {
    return compact(text
        .split(/\r?\n/u)
        .map(line => line.trim()))
        .filter(line => !/^checking /iu.test(line));
}

/** The page count `--show-npages` printed, or null when it printed anything else. */
export function parseQpdfPageCount(stdout: string) {
    const text = stdout.trim();
    const pageCount = Number(text);
    return /^[1-9]\d*$/u.test(text) && Number.isSafeInteger(pageCount) ? pageCount : null;
}

const QPDF_VALIDATE_BASE_TIMEOUT_MS = 30_000;
export const QPDF_VALIDATE_MAX_TIMEOUT_MS = 10 * 60_000;
const QPDF_VALIDATE_TIMEOUT_SCALE_START_BYTES = 64 * 1024 * 1024;
const QPDF_VALIDATE_TIMEOUT_BYTES_PER_STEP = 16 * 1024 * 1024;
const QPDF_VALIDATE_TIMEOUT_STEP_MS = 1_000;
export const QPDF_STRUCTURAL_VALIDATE_TIMEOUT_MS = 10_000;
export const QPDF_LOSSLESS_REWRITE_TIMEOUT_MS = 600_000;

export function resolveQpdfValidationTimeoutMs(fileSize: number | bigint | undefined) {
    const normalizedFileSize = typeof fileSize === 'bigint'
        ? Number(fileSize > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : fileSize)
        : fileSize;
    if (typeof normalizedFileSize !== 'number' || !Number.isFinite(normalizedFileSize)) {
        return QPDF_VALIDATE_BASE_TIMEOUT_MS;
    }
    const extraBytes = Math.max(0, normalizedFileSize - QPDF_VALIDATE_TIMEOUT_SCALE_START_BYTES);
    const extraSteps = Math.ceil(extraBytes / QPDF_VALIDATE_TIMEOUT_BYTES_PER_STEP);
    return Math.min(
        QPDF_VALIDATE_MAX_TIMEOUT_MS,
        QPDF_VALIDATE_BASE_TIMEOUT_MS + extraSteps * QPDF_VALIDATE_TIMEOUT_STEP_MS,
    );
}

/**
 * Both shells keep an optimized PDF only when it is a nonempty, valid and
 * strictly smaller copy; otherwise they publish the original unchanged.
 */
export function shouldKeepPdfOptimizationCandidate(
    originalBytes: number,
    candidateBytes: number,
    validation: IPdfValidationResult,
) {
    return candidateBytes > 0 && candidateBytes < originalBytes && validation.isValid;
}
