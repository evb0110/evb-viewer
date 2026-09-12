import { describeProcessExitCode } from '@electron/utils/describeProcessExitCode';
export { createAbortError } from '@electron/utils/abort';

export interface IProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

export type TNativeProcessFailureKind = 'exit-code' | 'signal';

export class NativeProcessError extends Error {
    constructor(
        readonly kind: TNativeProcessFailureKind,
        readonly exitCode: number | null,
        readonly closeSignal: NodeJS.Signals | null,
        message: string,
    ) {
        super(message);
        this.name = 'NativeProcessError';
    }
}

export type TProcessLog = (level: 'debug' | 'warn' | 'error', message: string) => void;

function truncateForError(text: string, maxLen = 1200) {
    const normalized = text.trim();
    if (normalized.length <= maxLen) {
        return normalized;
    }
    return `${normalized.slice(0, maxLen - 3)}...`;
}

export function formatArgForLog(arg: string) {
    if (/[^\w./:-]/u.test(arg)) {
        return `"${arg.replaceAll('"', '\\"')}"`;
    }
    return arg;
}

export function formatCommandFailureMessage(
    displayName: string,
    command: string,
    args: string[],
    exitCode: number | null,
    stdout: string,
    stderr: string,
    signal?: NodeJS.Signals | null,
) {
    const details = truncateForError(stderr || stdout || 'No process output was captured.');
    let termination: string;
    if (exitCode === null) {
        termination = `failed after signal ${signal ?? 'unknown'}`;
    } else {
        const describedExitCode = describeProcessExitCode(exitCode);
        termination = `failed with exit code ${describedExitCode}${signal ? `, signal=${signal}` : ''}`;
    }
    const displayCommand = `${command} ${args.map(formatArgForLog).join(' ')}`.trim();

    return {
        message: `${displayName} ${termination}. ${
            details || 'No process output was captured.'
        }`,
        displayCommand,
    };
}
