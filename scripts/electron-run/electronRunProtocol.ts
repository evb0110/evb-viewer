import type { MergeExclusive } from 'type-fest';
import { isJsonRecord } from '@scripts/electron-run/isJsonRecord';

export const ELECTRON_RUN_COMMANDS = [
    'ping',
    'recording',
    'screenshot',
    'screenshots',
    'console',
    'devtools',
    'run',
    'eval',
    'click',
    'type',
    'content',
    'waitfor',
    'resize',
    'viewport',
    'openPdf',
    'health',
    'shutdown',
] as const;

export type TElectronRunCommand = typeof ELECTRON_RUN_COMMANDS[number];

const ELECTRON_RUN_COMMAND_SET: ReadonlySet<string> = new Set<TElectronRunCommand>(ELECTRON_RUN_COMMANDS);

export interface IElectronRunCommandRequest {
    command: TElectronRunCommand;
    args: unknown[];
}

interface IElectronRunCommandSuccessResponse {
    success: true;
    result: unknown;
    error?: never;
}

interface IElectronRunCommandFailureResponse {
    success: false;
    error: string;
    result?: never;
}

export type TElectronRunCommandResponse = MergeExclusive<
    IElectronRunCommandSuccessResponse,
    IElectronRunCommandFailureResponse
>;

export function isElectronRunCommand(value: unknown): value is TElectronRunCommand {
    return typeof value === 'string' && ELECTRON_RUN_COMMAND_SET.has(value);
}

export function parseElectronRunCommandRequest(value: unknown) {
    if (!isJsonRecord(value)) {
        return null;
    }
    if (!isElectronRunCommand(value.command)) {
        return null;
    }
    if (!Array.isArray(value.args)) {
        return null;
    }
    return {
        command: value.command,
        args: value.args,
    };
}

export function parseElectronRunCommandResponse(value: unknown) {
    if (!isJsonRecord(value) || typeof value.success !== 'boolean') {
        return null;
    }
    if (value.success) {
        return {
            success: true,
            result: value.result,
        };
    }
    if (typeof value.error !== 'string') {
        return null;
    }
    return {
        success: false,
        error: value.error,
    };
}
