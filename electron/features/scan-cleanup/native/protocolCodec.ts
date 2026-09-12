import {
    isNativeErrorEnvelope,
    type TNativeErrorCode,
} from '@contracts/nativeErrors';
import {NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA} from '@contracts/scan-cleanup/nativeProtocolV3';

export function decodeNativeScanCleanupEnvelope(line: string) {
    return NATIVE_SCAN_CLEANUP_ENVELOPE_SCHEMA.decode(JSON.parse(line));
}

export function parseNativeScanCleanupStderr(stderr: string): {
    code: TNativeErrorCode;
    message: string
} | null {
    const line = stderr.trim().split(/\r?\n/u).pop();
    if (!line) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(line);
        return isNativeErrorEnvelope(value) ? value : null;
    } catch {
        // Only the last line is trusted: the sidecar writes its envelope last, and
        // scanning earlier lines let document content that happens to be a valid
        // envelope choose the error code.
        return null;
    }
}
