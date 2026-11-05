import type {FileHandle} from 'node:fs/promises';
import {abortErrorFromSignal} from '@electron/utils/abort';

/**
 * Writes all of `bytes`, at `position` or, when it is null, at the handle's
 * current position. `FileHandle.write` may write fewer bytes than asked
 * without failing, so a caller that writes once can leave a short file.
 * A canceled `signal` stops it before its next write.
 */
export async function writeFileHandleFully(
    handle: FileHandle,
    bytes: Uint8Array,
    position: number | null = null,
    signal?: AbortSignal,
) {
    let written = 0;
    while (written < bytes.byteLength) {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        const remaining = bytes.byteLength - written;
        const {bytesWritten} = await handle.write(bytes, written, remaining, position === null ? null : position + written);
        if (!Number.isInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) {
            throw new Error(`File write made no progress (wrote ${String(bytesWritten)} of ${String(remaining)} bytes)`);
        }
        written += bytesWritten;
    }
}
