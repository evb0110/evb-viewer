import {
    createInterface,
    type Interface as TReadlineInterface,
} from 'node:readline';
import {
    Transform, type Readable,
} from 'node:stream';

const SCAN_CLEANUP_STDERR_LIMIT_BYTES = 64 * 1024;
const SCAN_CLEANUP_PROTOCOL_MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface IScanCleanupSidecarProtocolHandlerOptions {
    stdout: Readable;
    stderr: Readable | null | undefined;
    onProtocolError: (error: Error) => void;
    log: (level: 'warn', message: string) => void;
}

export interface IScanCleanupSidecarProtocolHandler {
    readonly lines: TReadlineInterface;
    readonly stderr: string;
    failProtocol: (error: unknown, line: string) => void;
}

export function createScanCleanupSidecarProtocolHandler({
    stdout,
    stderr: errorOutput,
    onProtocolError,
    log,
}: IScanCleanupSidecarProtocolHandlerOptions): IScanCleanupSidecarProtocolHandler {
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let protocolError: Error | null = null;
    errorOutput?.on('data', (chunk: Buffer) => {
        if (chunk.length === 0) {
            return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        while (stderrBytes > SCAN_CLEANUP_STDERR_LIMIT_BYTES) {
            const first = stderrChunks[0];
            if (first === undefined) break;
            const excess = stderrBytes - SCAN_CLEANUP_STDERR_LIMIT_BYTES;
            if (first.length <= excess) {
                stderrChunks.shift();
                stderrBytes -= first.length;
            } else {
                stderrChunks[0] = first.subarray(excess);
                stderrBytes -= excess;
            }
        }
    });
    let pendingLineBytes = 0;
    const boundedStdout = new Transform({transform(chunk: Buffer, _encoding, callback) {
        let lineStart = 0;
        for (let index = 0; index < chunk.length; index += 1) {
            if (chunk[index] !== 0x0a) continue;
            pendingLineBytes += index - lineStart + 1;
            if (pendingLineBytes > SCAN_CLEANUP_PROTOCOL_MAX_LINE_BYTES) {
                callback(new Error(
                    `Scan cleanup NDJSON line exceeds ${String(SCAN_CLEANUP_PROTOCOL_MAX_LINE_BYTES)} bytes`,
                ));
                return;
            }
            pendingLineBytes = 0;
            lineStart = index + 1;
        }
        pendingLineBytes += chunk.length - lineStart;
        if (pendingLineBytes > SCAN_CLEANUP_PROTOCOL_MAX_LINE_BYTES) {
            callback(new Error(
                `Scan cleanup NDJSON line exceeds ${String(SCAN_CLEANUP_PROTOCOL_MAX_LINE_BYTES)} bytes`,
            ));
            return;
        }
        callback(null, chunk);
    }});
    const failProtocol = (error: unknown, line: string) => {
        if (protocolError !== null) {
            return;
        }
        protocolError = error instanceof Error ? error : new Error(String(error));
        try {
            lines.close();
        } catch {
            // Termination and the original protocol failure still take precedence.
        }
        onProtocolError(protocolError);
        log('warn', `Rejected malformed evb-scan-cleanup NDJSON: ${line.slice(0, 200)}`);
    };
    const lines = createInterface({input: boundedStdout});
    boundedStdout.on('error', error => failProtocol(error, '[line exceeds protocol limit]'));
    stdout.pipe(boundedStdout);
    return {
        lines,
        get stderr() {
            return Buffer.concat(stderrChunks).toString('utf8');
        },
        failProtocol,
    };
}
