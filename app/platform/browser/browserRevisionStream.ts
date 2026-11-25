import type { TRevisionWriter } from '@document-store/documentDirectory';
import { BROWSER_DOCUMENT_CHUNK_SIZE } from '@app/platform/browser/browserDocumentConstants';

export const canceledWrite = () => new DOMException('The write was canceled', 'AbortError');

/**
 * Writes `stream` into a new revision file as it arrives, in batches of at most `BROWSER_DOCUMENT_CHUNK_SIZE`: no
 * more of it is held at once, and nothing copies it whole. A stream reads once, so a second write, such as the
 * memory store's retry after the browser's store filled up, is refused rather than given what was left of it.
 */
export function streamWriter(stream: ReadableStream<Uint8Array>): TRevisionWriter {
    let read = false;
    return async file => {
        if (read) throw new Error('A streamed document can be stored only once');
        read = true;
        const reader = stream.getReader();
        const batch = new Uint8Array(BROWSER_DOCUMENT_CHUNK_SIZE);
        let filled = 0;
        let offset = 0;
        // A store file's write finishes with the bytes before it resolves, so the batch is reused at once.
        const write = async () => {
            await file.writeAt(offset, batch.subarray(0, filled));
            offset += filled;
            filled = 0;
        };
        try {
            for (let next = await reader.read(); !next.done; next = await reader.read()) {
                for (let at = 0; at < next.value.byteLength;) {
                    const count = Math.min(next.value.byteLength - at, batch.byteLength - filled);
                    batch.set(next.value.subarray(at, at + count), filled);
                    filled += count;
                    at += count;
                    if (filled === batch.byteLength) await write();
                }
            }
            if (filled > 0) await write();
        } catch (error) {
            await reader.cancel(error).catch(() => undefined);
            throw error;
        }
    };
}

/**
 * Bytes pushed as they come into the revision `commit` writes from them. A write resolves once the store is done
 * with its bytes, which are not copied: the store reads a chunk only after it has written the one before, so the
 * empty chunk after the caller's is read when the caller's are written. Until `close` is called an abort wins, and
 * later writes and `close` fail with its reason, as with a failed commit's error; after it the commit settles on
 * its own, and an abort waits for it.
 */
export function pushRevisionStream(commit: (source: TRevisionWriter) => Promise<unknown>) {
    const {readable, writable} = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const written = commit(streamWriter(readable));
    let end: {reason: unknown} | 'close' | null = null;
    const ended = () => {
        if (end !== null && end !== 'close') throw end.reason;
    };
    const abort = async (reason: unknown = canceledWrite()) => {
        if (end === null) {
            end = {reason};
            await writer.abort(reason).catch(() => undefined);
        }
        await written.catch(() => undefined);
    };
    void written.catch(abort);
    return {
        written,
        write: async (bytes: Uint8Array) => {
            ended();
            await writer.write(bytes);
            await writer.write(new Uint8Array());
        },
        close: async () => {
            ended();
            end = 'close';
            // A writer the commit's failure stopped refuses to close; the commit tells why.
            await writer.close().catch(() => undefined);
            await written;
        },
        abort,
    };
}
