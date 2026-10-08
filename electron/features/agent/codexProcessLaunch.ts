import {existsSync} from 'node:fs';
import path from 'node:path';

export const codexProcessLaunchRuntime = {existsSync};

export function shouldUseCodexCommandShell(
    codexPath: string,
    platform: NodeJS.Platform = process.platform,
) {
    return platform === 'win32' && /\.(?:bat|cmd)$/iu.test(codexPath);
}

function resolveWindowsScriptLaunch(codexPath: string, args: string[]) {
    const powershellShim = codexPath.replace(/\.(?:bat|cmd)$/iu, '.ps1');
    if (!codexProcessLaunchRuntime.existsSync(powershellShim)) {
        throw new Error(
            `Codex Windows command shim requires a sibling PowerShell shim: ${powershellShim}`,
        );
    }

    const configuredWindowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
    const windowsRoot = configuredWindowsRoot && configuredWindowsRoot.trim().length > 0
        ? configuredWindowsRoot
        : 'C:\\Windows';
    return {
        args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            powershellShim,
            ...args,
        ],
        command: path.win32.join(
            windowsRoot,
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
        ),
        shell: false,
        sourcePath: powershellShim,
    };
}

export function resolveCodexProcessLaunch(
    codexPath: string,
    args: string[],
    platform: NodeJS.Platform = process.platform,
) {
    if (shouldUseCodexCommandShell(codexPath, platform)) {
        return resolveWindowsScriptLaunch(codexPath, args);
    }

    return {
        args,
        command: codexPath,
        shell: false,
        sourcePath: codexPath,
    };
}
