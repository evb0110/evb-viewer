import { delay } from 'es-toolkit/promise';
import {
    COMMAND_REQUEST_TIMEOUT_MS,
    SESSION_WAIT_TIMEOUT_MS,
} from '@scripts/electron-run/electronRunTimeouts';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from '@scripts/electron-run/electronRunProtocol';
import type { ISessionInfo } from '@scripts/electron-run/electronRunSessionTypes';

class ElectronRunCommandError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ElectronRunCommandError';
    }
}

export class ElectronRunCommandUncertainError extends Error {
    readonly sessionName: string;
    readonly command: TElectronRunCommand;
    readonly requestTimeoutMs: number;

    constructor(sessionName: string, command: TElectronRunCommand, requestTimeoutMs: number, cause: unknown) {
        super(
            `Command "${command}" for session '${sessionName}' timed out or was interrupted after `
            + `${Math.round(requestTimeoutMs / 1000)}s; execution may have occurred, so the request was not replayed`,
            {cause},
        );
        this.name = 'ElectronRunCommandUncertainError';
        this.sessionName = sessionName;
        this.command = command;
        this.requestTimeoutMs = requestTimeoutMs;
    }
}

interface ISendCommandOptions {
    signal?: AbortSignal;
    retryOnTransportFailure?: boolean;
}

export async function sendCommandToSession(
    info: ISessionInfo,
    command: TElectronRunCommand,
    args: unknown[],
    requestTimeoutMs: number,
    options: ISendCommandOptions = {},
) {
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    const requestSignal = options.signal
        ? AbortSignal.any([
            options.signal,
            timeoutSignal,
        ])
        : timeoutSignal;
    let responseBody: unknown;
    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command,
                args,
            }),
            signal: requestSignal,
        });
        responseBody = await res.json();
    } catch (error) {
        if (options.signal?.aborted) {
            throw options.signal.reason ?? error;
        }
        if (timeoutSignal.aborted || (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))) {
            if (options.retryOnTransportFailure) {
                throw error;
            }
            throw new ElectronRunCommandUncertainError(getCurrentSessionName(), command, requestTimeoutMs, error);
        }
        if (options.retryOnTransportFailure) {
            throw error;
        }
        throw new ElectronRunCommandUncertainError(getCurrentSessionName(), command, requestTimeoutMs, error);
    }
    const data = parseElectronRunCommandResponse(responseBody);
    if (!data) {
        throw new ElectronRunCommandError('Session returned malformed response payload');
    }
    if (!data.success) {
        throw new ElectronRunCommandError(data.error ?? 'Unknown error');
    }
    return data.result;
}

function createWaitLogger() {
    let didPrintWaitMessage = false;
    return {
        sessionStart(startedAt: number) {
            if (!didPrintWaitMessage && Date.now() - startedAt > 2000) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to start...`);
            }
        },
        sessionReady() {
            if (!didPrintWaitMessage) {
                didPrintWaitMessage = true;
                console.log(`[Session '${getCurrentSessionName()}'] Waiting for session to become ready...`);
            }
        },
    };
}

export async function sendCommand(
    command: TElectronRunCommand,
    args: unknown[] = [],
    requestTimeoutMs = COMMAND_REQUEST_TIMEOUT_MS,
    options: ISendCommandOptions = {},
) {
    const start = Date.now();
    const waitLogger = createWaitLogger();

    while (Date.now() - start < SESSION_WAIT_TIMEOUT_MS) {
        if (options.signal?.aborted) {
            throw options.signal.reason ?? new DOMException('Command request canceled', 'AbortError');
        }
        const info = getSessionInfo();

        if (!info) {
            waitLogger.sessionStart(start);
            await delay(250);
            continue;
        }

        try {
            return await sendCommandToSession(info, command, args, requestTimeoutMs, options);
        } catch (error) {
            if (error instanceof ElectronRunCommandError || error instanceof ElectronRunCommandUncertainError) {
                throw error;
            }
            if (options.signal?.aborted) {
                throw options.signal.reason ?? error;
            }
            if (!options.retryOnTransportFailure) {
                throw new ElectronRunCommandUncertainError(getCurrentSessionName(), command, requestTimeoutMs, error);
            }
            waitLogger.sessionReady();
            const remainingMs = SESSION_WAIT_TIMEOUT_MS - (Date.now() - start);
            if (remainingMs > 0) {
                await delay(Math.min(250, remainingMs));
            }
            continue;
        }
    }

    throw new Error(`Session '${getCurrentSessionName()}' not ready after ${Math.round(SESSION_WAIT_TIMEOUT_MS / 1000)}s. Start with: pnpm electron:run start --session=${getCurrentSessionName()}`);
}
