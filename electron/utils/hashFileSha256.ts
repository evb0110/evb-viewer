import { createHash } from 'node:crypto';
import { createReadStream } from 'fs';
import { abortErrorFromSignal } from '@electron/utils/abort';

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

/**
 * The SHA-256 of a file, streamed so memory stays one chunk and the main
 * process is never held for the whole hash. An aborted signal rejects with its
 * abort error before, during and after the read, and stops the stream.
 */
export async function hashFileSha256(
    path: string,
    signal?: AbortSignal,
) {
    throwIfAborted(signal);
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const onAbort = () => {
        if (signal) {
            stream.destroy(abortErrorFromSignal(signal));
        }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        for await (const rawChunk of stream) {
            throwIfAborted(signal);
            const chunk: unknown = rawChunk;
            if (!(chunk instanceof Uint8Array)) {
                throw new Error(`File stream returned a non-binary chunk: ${path}`);
            }
            hash.update(chunk);
        }
        throwIfAborted(signal);
        return hash.digest('hex');
    } finally {
        signal?.removeEventListener('abort', onAbort);
    }
}
