import {createReadStream} from 'node:fs';
import {
    open,
    stat,
} from 'node:fs/promises';

export interface IPdfSidecarLine {
    offset: number;
    byteLength: number;
}

export interface IScannedPdfSidecar {
    dataStartOffset: number;
    dataBytes: number;
    pageCount: number;
    entryCount: number;
    lines: IPdfSidecarLine[];
}

export interface IScanPdfSidecarOptions<TData> {
    maxLineBytes: number;
    label: string;
    decodeHeader: (value: unknown) => number;
    decodeDataLine: (value: unknown) => TData[];
    signal?: AbortSignal;
}

const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export function addSafePdfSidecarOffset(left: number, right: number, fieldName: string) {
    const result = left + right;
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new RangeError(`${fieldName} exceeds the safe integer range`);
    }
    return result;
}

export function assertSafePdfSidecarOffset(value: number, fieldName: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${fieldName} must be a non-negative safe integer`);
    }
    return value;
}

export function parsePdfSidecarJsonLine(bytes: Buffer, label: string) {
    const withoutNewline = bytes[bytes.length - 1] === 0x0a
        ? bytes.subarray(0, bytes.length - 1)
        : bytes;
    const jsonBytes = withoutNewline[withoutNewline.length - 1] === 0x0d
        ? withoutNewline.subarray(0, withoutNewline.length - 1)
        : withoutNewline;
    if (jsonBytes.length === 0) {
        throw new Error(`PDF sidecar contains an empty ${label} line`);
    }
    try {
        return JSON.parse(jsonBytes.toString('utf8')) as unknown;
    } catch (error) {
        throw new Error(`PDF sidecar contains invalid JSON in its ${label} line`, {cause: error});
    }
}

/**
 * Scan a bounded JSONL sidecar once and retain only line offsets. The native
 * hosts use different decoders, but all three sidecars share this byte-level
 * framing. Keeping the scanner here prevents a new format from acquiring a
 * subtly different offset or oversized-line policy.
 */
export function scanPdfSidecarLines<TData>(
    sidecarPath: string,
    options: IScanPdfSidecarOptions<TData>,
): Promise<IScannedPdfSidecar> {
    return new Promise((resolveScan, rejectScan) => {
        const lines: IPdfSidecarLine[] = [];
        let stream: ReturnType<typeof createReadStream> | null = null;
        let pending = Buffer.alloc(0) as Buffer;
        let pendingStartOffset = 0;
        let dataStartOffset = 0;
        let totalBytes = 0;
        let headerPageCount: number | null = null;
        let entryCount = 0;
        let headerSeen = false;
        let settled = false;
        let removeAbortListener: () => void = () => undefined;

        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            removeAbortListener();
            stream?.destroy();
            rejectScan(error);
        };
        const processLine = (line: Buffer, offset: number) => {
            if (line.length === 0 || line.length > options.maxLineBytes) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
            const lineValue = parsePdfSidecarJsonLine(line, headerSeen ? 'data' : 'header');
            if (!headerSeen) {
                headerPageCount = options.decodeHeader(lineValue);
                dataStartOffset = addSafePdfSidecarOffset(
                    offset,
                    line.length,
                    `${options.label} offset`,
                );
                headerSeen = true;
                return;
            }
            const entries = options.decodeDataLine(lineValue);
            entryCount = addSafePdfSidecarOffset(
                entryCount,
                entries.length,
                `${options.label} entry count`,
            );
            lines.push({
                offset: addSafePdfSidecarOffset(
                    offset,
                    -dataStartOffset,
                    `${options.label} offset`,
                ),
                byteLength: line.length,
            });
        };
        const consume = (chunk: Buffer) => {
            totalBytes = addSafePdfSidecarOffset(totalBytes, chunk.length, `${options.label} sidecar size`);
            pending = pending.length === 0 ? chunk : Buffer.concat([
                pending,
                chunk,
            ]);
            if (pending.length > options.maxLineBytes && pending.indexOf(0x0a) < 0) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
            let newlineIndex = pending.indexOf(0x0a);
            while (newlineIndex >= 0) {
                const lineLength = newlineIndex + 1;
                processLine(pending.subarray(0, lineLength), pendingStartOffset);
                pendingStartOffset = addSafePdfSidecarOffset(
                    pendingStartOffset,
                    lineLength,
                    `${options.label} offset`,
                );
                pending = pending.subarray(lineLength);
                newlineIndex = pending.indexOf(0x0a);
            }
            if (pending.length > options.maxLineBytes) {
                throw new Error(`${options.label} sidecar line exceeds ${options.maxLineBytes} bytes`);
            }
        };

        if (options.signal?.aborted) {
            rejectOnce(options.signal.reason ?? new Error(`${options.label} sidecar scan was aborted`));
            return;
        }
        const handleAbort = () => rejectOnce(
            options.signal?.reason ?? new Error(`${options.label} sidecar scan was aborted`),
        );
        options.signal?.addEventListener('abort', handleAbort, {once: true});
        removeAbortListener = () => options.signal?.removeEventListener('abort', handleAbort);
        stream = createReadStream(sidecarPath, {
            highWaterMark: 64 * 1_024,
            signal: options.signal,
        });
        stream.on('data', (chunk: Buffer | string) => {
            try {
                consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            } catch (error) {
                rejectOnce(error);
            }
        });
        stream.once('error', rejectOnce);
        stream.once('end', () => {
            if (settled) {
                return;
            }
            try {
                if (pending.length > 0) {
                    processLine(pending, pendingStartOffset);
                    pendingStartOffset = addSafePdfSidecarOffset(
                        pendingStartOffset,
                        pending.length,
                        `${options.label} offset`,
                    );
                }
                if (headerPageCount === null) {
                    throw new Error(`${options.label} sidecar is empty`);
                }
                if (pendingStartOffset !== totalBytes) {
                    throw new Error(`${options.label} sidecar offset accounting failed`);
                }
                settled = true;
                removeAbortListener();
                resolveScan({
                    dataStartOffset,
                    dataBytes: addSafePdfSidecarOffset(
                        totalBytes,
                        -dataStartOffset,
                        `${options.label} bytes`,
                    ),
                    pageCount: headerPageCount,
                    entryCount,
                    lines,
                });
            } catch (error) {
                rejectOnce(error);
            }
        });
    });
}

export function findPdfSidecarLineIndex(lines: readonly IPdfSidecarLine[], offset: number) {
    let low = 0;
    let high = lines.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const line = lines[middle]!;
        if (line.offset === offset) {
            return middle;
        }
        if (line.offset < offset) low = middle + 1;
        else high = middle - 1;
    }
    return -1;
}

export async function readPdfSidecarLine(
    sidecarPath: string,
    dataStartOffset: number,
    line: IPdfSidecarLine,
    label: string,
) {
    const absoluteOffset = addSafePdfSidecarOffset(dataStartOffset, line.offset, `${label} offset`);
    const lineBytes = Buffer.allocUnsafe(line.byteLength);
    const sidecarHandle = await open(sidecarPath, 'r');
    try {
        let bytesRead = 0;
        while (bytesRead < line.byteLength) {
            const readResult = await sidecarHandle.read(
                lineBytes,
                bytesRead,
                line.byteLength - bytesRead,
                absoluteOffset + bytesRead,
            );
            if (readResult.bytesRead === 0) {
                throw new Error(`${label} sidecar ended before the requested chunk`);
            }
            bytesRead += readResult.bytesRead;
        }
    } finally {
        await sidecarHandle.close();
    }
    return lineBytes;
}

export async function assertPdfSidecarFitsSafeOffsetRange(sidecarPath: string, label: string) {
    const sidecarStat = await stat(sidecarPath, {bigint: true});
    if (sidecarStat.size > MAX_SAFE_INTEGER_BIGINT) {
        throw new Error(`${label} sidecar exceeds the safe offset range`);
    }
    return Number(sidecarStat.size);
}
