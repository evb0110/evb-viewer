import type {TScanCleanupErrorCode} from '@contracts/scan-cleanup/electronApiScanCleanup';
import {SCAN_CLEANUP_ERROR_CODES} from '@contracts/scan-cleanup/ipc';

/** The typed code a failed browser Scan Cleanup job reports, as desktop classifies its errors. */
export function classifyBrowserScanCleanupError(error: unknown): TScanCleanupErrorCode {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return typeof code === 'string' && (SCAN_CLEANUP_ERROR_CODES as readonly string[]).includes(code)
        ? code as TScanCleanupErrorCode
        : 'internal';
}
