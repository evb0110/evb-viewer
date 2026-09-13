import type {
    IGuestCommandResult,
    IGuestCommandRunner,
} from '@scripts/windows-test/guest/guestRuntime';
import { joinGuestPath } from '@scripts/windows-test/guest/guestPaths';

export const POWERSHELL_EXECUTABLE = 'powershell.exe';

export const POWERSHELL_BASE_ARGUMENTS = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
] as const;

export const guestPowerShellScriptNames = [
    'probe-identity.ps1',
    'get-file-hash.ps1',
    'get-print-jobs.ps1',
    'hold-file-handle.ps1',
    'uia-query.ps1',
    'uia-action.ps1',
    'install-nsis-per-user.ps1',
    'register-worker-logon-task.ps1',
    'ensure-standard-test-user.ps1',
    'disable-test-audio.ps1',
    'configure-test-printer.ps1',
    'start-worker-logon.ps1',
    'mute-test-audio.ps1',
    'test-lab-helpers.ps1',
] as const;

export type TGuestPowerShellScriptName = typeof guestPowerShellScriptNames[number];

export class GuestPowerShellScriptError extends Error {
    constructor(public readonly scriptName: string, public readonly result: IGuestCommandResult) {
        super(`PowerShell script ${scriptName} exited with ${result.exitCode}: ${result.stderr.trim()}`);
        this.name = 'GuestPowerShellScriptError';
    }
}

export function guestPowerShellArguments(scriptPath: string, args: readonly string[]) {
    return [
        ...POWERSHELL_BASE_ARGUMENTS,
        scriptPath,
        ...args,
    ];
}

export interface IGuestPowerShellRunner {
    scriptPath(scriptName: TGuestPowerShellScriptName): string;
    run(scriptName: TGuestPowerShellScriptName, args?: readonly string[]): Promise<IGuestCommandResult>;
    runJson(scriptName: TGuestPowerShellScriptName, args?: readonly string[]): Promise<unknown>;
}

export interface ICreateGuestPowerShellRunnerOptions {
    exec: IGuestCommandRunner;
    scriptsDirectory: string;
    separator: string;
    timeoutMs?: number;
}

export function createGuestPowerShellRunner({
    exec,
    scriptsDirectory,
    separator,
    timeoutMs = 120_000,
}: ICreateGuestPowerShellRunnerOptions): IGuestPowerShellRunner {
    const scriptPath = (scriptName: TGuestPowerShellScriptName) => joinGuestPath(separator, scriptsDirectory, scriptName);

    const run = async (scriptName: TGuestPowerShellScriptName, args: readonly string[] = []) => {
        if (!guestPowerShellScriptNames.includes(scriptName)) {
            throw new Error(`Unknown guest PowerShell script: ${scriptName}`);
        }
        return exec.run(
            POWERSHELL_EXECUTABLE,
            guestPowerShellArguments(scriptPath(scriptName), args),
            { timeoutMs },
        );
    };

    return {
        scriptPath,
        run,
        runJson: async (scriptName, args = []) => {
            const result = await run(scriptName, args);
            if (result.exitCode !== 0) {
                throw new GuestPowerShellScriptError(scriptName, result);
            }
            const parsed: unknown = JSON.parse(result.stdout);
            return parsed;
        },
    };
}
