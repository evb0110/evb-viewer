import type {FileHandle} from 'node:fs/promises';
import {abortErrorFromSignal} from '@electron/utils/abort';

export function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export async function writeBufferAt(
    file: FileHandle,
    buffer: Buffer,
    position: number,
    signal?: AbortSignal,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        throwIfAborted(signal);
        const {bytesWritten} = await file.write(
            buffer,
            offset,
            buffer.byteLength - offset,
            position + offset,
        );
        if (bytesWritten <= 0) {
            throw new Error('Failed to write compact search index buffer');
        }
        offset += bytesWritten;
    }
}

export async function readBufferAt(
    file: FileHandle,
    buffer: Buffer,
    position: number,
    signal?: AbortSignal,
) {
    let offset = 0;
    while (offset < buffer.byteLength) {
        throwIfAborted(signal);
        const {bytesRead} = await file.read(
            buffer,
            offset,
            buffer.byteLength - offset,
            position + offset,
        );
        if (bytesRead <= 0) {
            return false;
        }
        offset += bytesRead;
    }
    return true;
}
