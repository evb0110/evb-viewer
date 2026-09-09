import {
    createInterface,
    type Interface as TReadlineInterface,
} from 'node:readline';
import type {Readable} from 'node:stream';

const SCAN_CLEANUP_STDERR_LIMIT_BYTES = 64 * 1024;

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
    let stderr = '';
    let protocolError: Error | null = null;
    errorOutput?.setEncoding('utf8');
    errorOutput?.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-SCAN_CLEANUP_STDERR_LIMIT_BYTES);
    });
    const lines = createInterface({input: stdout});
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
    return {
        lines,
        get stderr() {
            return stderr;
        },
        failProtocol,
    };
}
