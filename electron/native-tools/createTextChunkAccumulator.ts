/**
 * Collects a child process's output under a byte ceiling. Chunks are kept as
 * buffers and joined once, because measuring a growing string on every chunk
 * costs a full re-encode of everything received so far, which is quadratic in
 * the total output and runs on the main thread.
 *
 * Past the ceiling the tail is what is kept: this output is read by humans and
 * by error reporting, where the end of a failing run says more than its start.
 */
interface ITextChunkAccumulator {
    readonly truncated: boolean;
    append(chunk: Buffer): void;
    text(): string;
}

export function createTextChunkAccumulator(maxBytes: number): ITextChunkAccumulator {
    let chunks: Buffer[] = [];
    let byteLength = 0;
    let truncated = false;

    const retainTail = (chunk: Buffer) => {
        const targetTailBytes = Math.max(1, Math.floor(maxBytes * 0.9));
        const nextChunks: Buffer[] = [];
        let nextByteLength = 0;
        for (const source of [
            ...chunks,
            chunk,
        ].reverse()) {
            if (nextByteLength >= targetTailBytes) {
                break;
            }
            const tail = source.subarray(
                Math.max(0, source.byteLength - (targetTailBytes - nextByteLength)),
            );
            nextChunks.unshift(tail);
            nextByteLength += tail.byteLength;
        }
        chunks = nextChunks;
        byteLength = nextByteLength;
    };

    return {
        get truncated() {
            return truncated;
        },
        append(chunk) {
            if (maxBytes <= 0) {
                truncated = true;
                chunks = [];
                byteLength = 0;
                return;
            }
            if (byteLength + chunk.byteLength <= maxBytes) {
                chunks.push(chunk);
                byteLength += chunk.byteLength;
                return;
            }
            truncated = true;
            retainTail(chunk);
        },
        text() {
            return Buffer.concat(chunks, byteLength).toString('utf8');
        },
    };
}
