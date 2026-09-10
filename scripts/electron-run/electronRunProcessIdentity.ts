import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
    collectDescendantPidsUnix,
    findPidsByCommandSubstring,
    getPidsOnPort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';

export type TSessionProcessKind = 'controller' | 'electron' | 'nuxt';

export interface IProcessIdentitySnapshot {
    pid: number;
    platform: NodeJS.Platform;
    command: string;
    cwd: string | null;
    environment: string;
    descendantPids: number[];
    pidsOnExpectedPort: number[];
}

export interface ISessionProcessIdentityExpectation {
    kind: TSessionProcessKind;
    sessionName: string;
    cdpPort?: number | null | undefined;
    nuxtPort?: number | null | undefined;
    electronUserDataDir?: string | null | undefined;
}

function readProcessOutput(command: string, args: string[]) {
    try {
        return execFileSync(command, args, {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
    } catch {
        return '';
    }
}

function readWindowsProcessIdentity(
    pid: number,
    expectedPort?: number | null,
): IProcessIdentitySnapshot | null {
    try {
        const output = execFileSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            '$all = @(Get-CimInstance Win32_Process); '
            + `$p = $all | Where-Object { $_.ProcessId -eq ${pid} } | Select-Object -First 1; `
            + 'if ($p) { '
            + `$frontier = @(${pid}); $descendants = @(); `
            + 'while ($frontier.Count -gt 0) { '
            + '$children = @($all | Where-Object { $frontier -contains $_.ParentProcessId }); '
            + 'if ($children.Count -eq 0) { break }; '
            + '$childIds = @($children | ForEach-Object { [int]$_.ProcessId }); '
            + '$descendants += $childIds; $frontier = $childIds }; '
            + (expectedPort
                ? `$portPids = @(); try { $portPids = @(Get-NetTCPConnection -State Listen -LocalPort ${expectedPort} `
                    + '| ForEach-Object { [int]$_.OwningProcess }) } catch {}; '
                : '$portPids = @(); ')
            + '@{ command = $p.CommandLine; descendants = @($descendants); portPids = @($portPids) } '
            + '| ConvertTo-Json -Compress }',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
        if (!output) {
            return null;
        }
        const parsed = JSON.parse(output) as {
            command?: unknown;
            descendants?: unknown;
            portPids?: unknown;
        };
        if (typeof parsed.command !== 'string' || !parsed.command) {
            return null;
        }
        return {
            pid,
            platform: 'win32',
            command: parsed.command,
            cwd: null,
            environment: '',
            descendantPids: Array.isArray(parsed.descendants)
                ? parsed.descendants.filter((value): value is number => (
                    typeof value === 'number' && Number.isInteger(value) && value > 0
                ))
                : [],
            pidsOnExpectedPort: Array.isArray(parsed.portPids)
                ? parsed.portPids.filter((value): value is number => (
                    typeof value === 'number' && Number.isInteger(value) && value > 0
                ))
                : [],
        };
    } catch {
        return null;
    }
}

function readProcessCwd(pid: number) {
    const output = readProcessOutput('lsof', [
        '-a',
        '-p',
        String(pid),
        '-d',
        'cwd',
        '-Fn',
    ]);
    const cwdLine = output.split('\n').find(line => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : null;
}

export function inspectProcessIdentity(
    pid: number,
    expectedPort?: number | null,
): IProcessIdentitySnapshot | null {
    if (!isProcessAlive(pid)) {
        return null;
    }
    if (process.platform === 'win32') {
        return readWindowsProcessIdentity(pid, expectedPort);
    }
    const command = readProcessOutput('ps', [
        '-p',
        String(pid),
        '-o',
        'command=',
    ]);
    if (!command) {
        return null;
    }
    return {
        pid,
        platform: process.platform,
        command,
        cwd: readProcessCwd(pid),
        environment: readProcessOutput('ps', [
            'eww',
            '-p',
            String(pid),
            '-o',
            'command=',
        ]),
        descendantPids: collectDescendantPidsUnix(pid),
        pidsOnExpectedPort: expectedPort ? getPidsOnPort(expectedPort) : [],
    };
}

function hasExactArgument(command: string, argument: string) {
    const escaped = argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)(?:${escaped}|'${escaped}'|"${escaped}")(?:\\s|$)`).test(command);
}

function hasEnvironmentValue(environment: string, name: string, value: string | number) {
    const token = `${name}=${value}`;
    return environment.split(/\s+/).includes(token);
}

export function matchesSessionProcessIdentity(
    snapshot: IProcessIdentitySnapshot,
    expectation: ISessionProcessIdentityExpectation,
) {
    if (expectation.kind === 'controller') {
        const controllerEntry = join(projectRoot, 'scripts', 'electronRun.ts');
        const ephemeralControllerEntry = join(
            projectRoot,
            'scripts',
            'electron-run',
            'ephemeralSessionEntry.ts',
        );
        const hasControllerEntry = hasExactArgument(snapshot.command, controllerEntry)
            || (snapshot.cwd === projectRoot && hasExactArgument(snapshot.command, join('scripts', 'electronRun.ts')));
        const hasAbsoluteEphemeralControllerEntry = hasExactArgument(snapshot.command, ephemeralControllerEntry);
        const hasEphemeralControllerEntry = hasAbsoluteEphemeralControllerEntry
            || (snapshot.cwd === projectRoot
                && hasExactArgument(snapshot.command, join('scripts', 'electron-run', 'ephemeralSessionEntry.ts')));
        const hasProjectIdentity = snapshot.cwd === projectRoot
            || hasExactArgument(snapshot.command, projectRoot)
            || hasAbsoluteEphemeralControllerEntry
            || (snapshot.platform === 'win32' && (hasControllerEntry || hasEphemeralControllerEntry));
        const hasExplicitSessionArgument = /(?:^|\s)(?:--session=(?:[^\s"']+|'[^']*'|"[^"]*")|["']--session=[^\s"']+["'])(?:\s|$)/u
            .test(snapshot.command);
        const hasExpectedSession = expectation.sessionName === 'default'
            ? !hasExplicitSessionArgument || hasExactArgument(snapshot.command, '--session=default')
            : hasExactArgument(snapshot.command, `--session=${expectation.sessionName}`);
        const isLegacyController = (snapshot.command.includes('electron:run') || hasControllerEntry)
            && hasExpectedSession
            && /(?:^|\s)start(?:\s|$)/.test(snapshot.command);
        const isEphemeralController = hasEphemeralControllerEntry
            && hasExactArgument(snapshot.command, expectation.sessionName);
        return hasProjectIdentity && (isLegacyController || isEphemeralController);
    }

    if (expectation.kind === 'electron') {
        const cdpPort = expectation.cdpPort;
        const userDataDir = expectation.electronUserDataDir ?? electronUserDataPath(expectation.sessionName);
        const automationAppEntry = join(
            sessionDir(expectation.sessionName),
            'automation-electron-app-entry',
            'automation-app',
        );
        return hasExactArgument(snapshot.command, automationAppEntry)
            && hasExactArgument(snapshot.command, `--user-data-dir=${userDataDir}`)
            && (cdpPort
                ? hasExactArgument(snapshot.command, `--remote-debugging-port=${cdpPort}`)
                : /(?:^|\s)["']?--remote-debugging-port=\d+["']?(?:\s|$)/.test(snapshot.command));
    }

    const nuxtPort = expectation.nuxtPort;
    if (!nuxtPort) {
        return false;
    }
    const ownedPids = new Set([
        snapshot.pid,
        ...snapshot.descendantPids,
    ]);
    const hasExactProjectAndPortArguments = hasExactArgument(snapshot.command, projectRoot)
        && (hasExactArgument(snapshot.command, `--port=${nuxtPort}`)
            || hasExactArgument(snapshot.command, `--port ${nuxtPort}`));
    const ownsExpectedPort = snapshot.pidsOnExpectedPort.some(pid => ownedPids.has(pid))
        || (snapshot.pidsOnExpectedPort.length === 0 && hasExactProjectAndPortArguments);
    const hasWindowsPortIdentity = snapshot.platform === 'win32' && ownsExpectedPort;
    return (snapshot.cwd === projectRoot
        || hasExactArgument(snapshot.command, projectRoot)
        || hasWindowsPortIdentity)
        && /\brun\s+dev:nuxt\b/.test(snapshot.command)
        && (hasEnvironmentValue(snapshot.environment, 'PORT', nuxtPort)
            || hasExactProjectAndPortArguments
            || hasWindowsPortIdentity)
        && ownsExpectedPort;
}

export function findSessionOwnedElectronPids(expectation: ISessionProcessIdentityExpectation) {
    if (expectation.kind !== 'electron') {
        return [];
    }
    const userDataDir = expectation.electronUserDataDir ?? electronUserDataPath(expectation.sessionName);
    const candidates = new Set([
        ...(expectation.cdpPort
            ? findPidsByCommandSubstring(`--remote-debugging-port=${expectation.cdpPort}`)
            : []),
        ...findPidsByCommandSubstring(`--user-data-dir=${userDataDir}`),
    ]);
    return [...candidates].filter(pid => {
        const snapshot = inspectProcessIdentity(pid);
        return snapshot ? matchesSessionProcessIdentity(snapshot, expectation) : false;
    });
}

export function isVerifiedSessionProcess(
    pid: number,
    expectation: ISessionProcessIdentityExpectation,
) {
    const expectedPort = expectation.kind === 'nuxt' ? expectation.nuxtPort : null;
    const snapshot = inspectProcessIdentity(pid, expectedPort);
    return snapshot ? matchesSessionProcessIdentity(snapshot, expectation) : false;
}

export async function killVerifiedSessionProcess(options: {
    pid: number;
    expectation: ISessionProcessIdentityExpectation;
    graceMs?: number;
    force?: boolean;
}) {
    if (!isProcessAlive(options.pid)) {
        return true;
    }
    if (!isVerifiedSessionProcess(options.pid, options.expectation)) {
        // Identity is read from `ps`, so a process that exits between the
        // liveness check above and the probe reports as unverifiable. Such a
        // process is already terminated; only a live one is a real refusal.
        if (!isProcessAlive(options.pid)) {
            return true;
        }
        console.warn(
            `[Session '${options.expectation.sessionName}'] Refused to terminate PID ${options.pid}: `
            + `${options.expectation.kind} process identity did not match session ownership.`,
        );
        return false;
    }
    await killProcessTree(
        options.pid,
        options.graceMs,
        options.force === undefined ? {} : {force: options.force},
    );
    return !isProcessAlive(options.pid);
}
