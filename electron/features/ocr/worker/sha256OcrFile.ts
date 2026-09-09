import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {abortErrorFromSignal} from '@electron/utils/abort';

function throwIfAborted(signal: AbortSignal) {
    if (signal.aborted) {
        throw abortErrorFromSignal(signal);
    }
}

export async function sha256OcrFile(path: string, signal: AbortSignal) {
    throwIfAborted(signal);
    const hash = createHash('sha256');
    for await (const rawChunk of createReadStream(path)) {
        throwIfAborted(signal);
        const chunk: unknown = rawChunk;
        if (!(chunk instanceof Uint8Array)) {
            throw new Error('OCR result stream returned a non-binary chunk');
        }
        hash.update(chunk);
    }
    throwIfAborted(signal);
    return hash.digest('hex');
}
