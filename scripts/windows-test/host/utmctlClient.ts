import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    createWriteStream,
    existsSync,
} from 'node:fs';
import {
    readFile,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import {
    isVmUuid,
    windowsTestDefaultDeadlines,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    resolveWindowsTestDataRoot,
    windowsTestGuestLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';

export const DEFAULT_UTMCTL_PATH = '/Applications/UTM.app/Contents/MacOS/utmctl';

export const STANDALONE_UTMCTL_RELATIVE_PATH = path.join(
    'caches',
    'tools',
    'utmctl-probe',
    'utmctl',
);

export interface IDefaultUtmctlPathOptions {
    dataRoot?: string;
    env?: NodeJS.ProcessEnv;
    fileExists?: (filePath: string) => boolean;
}

/**
 * Prefer the prepared copy because the executable inside UTM.app registers as
 * a foreground application and creates a second Dock icon for each poll.
 * A missing prepared copy is an operator error. Running the executable inside
 * UTM.app registers a foreground app and creates a second Dock icon for each
 * poll, so there is no safe fallback here.
 */
export function resolveDefaultUtmctlPath(options: IDefaultUtmctlPathOptions = {}) {
    const dataRoot = options.dataRoot ?? resolveWindowsTestDataRoot(options.env);
    const preparedPath = path.join(dataRoot, STANDALONE_UTMCTL_RELATIVE_PATH);
    const fileExists = options.fileExists ?? existsSync;
    if (!fileExists(preparedPath)) {
        throw new Error('The verified standalone utmctl copy is unavailable. Run pnpm windows:test:prepare before running the Windows test lane.');
    }
    return preparedPath;
}

// Captured from `utmctl help <subcommand>` of the installed UTM 4.7.5 build 118.
// Keeping them in one injectable record lets a different UTM build be qualified
// without editing call sites.
export const defaultUtmctlCommandSpelling = {
    version: ['version'],
    list: ['list'],
    status: ['status'],
    start: ['start'],
    stopRequest: [
        'stop',
        '--request',
    ],
    stopForce: [
        'stop',
        '--force',
    ],
    clone: ['clone'],
    cloneNameFlag: '--name',
    delete: ['delete'],
    ipAddress: ['ip-address'],
    exec: ['exec'],
    execCommandFlag: '--cmd',
    execInputFlag: '--input',
    filePush: [
        'file',
        'push',
    ],
    filePull: [
        'file',
        'pull',
    ],
} as const;

export type TUtmctlCommandSpelling = typeof defaultUtmctlCommandSpelling;

export interface ICommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
}

export interface ICommandRunOptions {
    timeoutMs: number;
    input?: string | Uint8Array;
    // Streams stdout straight to a file so binary `utmctl file pull` payloads
    // survive without a lossy utf8 decode.
    stdoutFilePath?: string;
}

/** File-pull stdout is a byte stream, not a UTM diagnostic channel. */
export interface ITransportFailureClassificationOptions {inspectStdoutEvents?: boolean;}

export interface ICommandRunner {run(command: string, args: string[], options: ICommandRunOptions): Promise<ICommandResult>;}

export function createProcessCommandRunner(): ICommandRunner {
    return {run: async (command, args, options) => new Promise<ICommandResult>((resolve, reject) => {
        const child = spawn(command, args, {stdio: [
            options.input === undefined ? 'ignore' : 'pipe',
            'pipe',
            'pipe',
        ]});
        const stdoutChunks: Buffer[] = [];
        // `utmctl file pull` streams the payload to stdout, but UTM can also
        // encode an Error event in that same stream while returning exit 0.
        // Keep only a bounded diagnostic prefix so binary pulls remain streamed.
        const stdoutDiagnosticChunks: Buffer[] = [];
        let stdoutDiagnosticBytes = 0;
        const stderrChunks: Buffer[] = [];
        let timedOut = false;
        let settled = false;

        const stdoutFile = options.stdoutFilePath === undefined
            ? null
            : createWriteStream(options.stdoutFilePath);
        child.stdout?.on('data', (chunk: Buffer) => {
            if (stdoutFile === null) {
                stdoutChunks.push(chunk);
                return;
            }
            const diagnosticLimit = 64 * 1024;
            if (stdoutDiagnosticBytes < diagnosticLimit) {
                const remaining = diagnosticLimit - stdoutDiagnosticBytes;
                stdoutDiagnosticChunks.push(chunk.subarray(0, remaining));
                stdoutDiagnosticBytes += Math.min(chunk.byteLength, remaining);
            }
        });
        if (stdoutFile !== null) {
            child.stdout?.pipe(stdoutFile);
        }
        child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, options.timeoutMs);

        const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode,
                stdout: Buffer.concat(stdoutFile === null ? stdoutChunks : stdoutDiagnosticChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
                timedOut,
                signal,
            });
        };

        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
            stdoutFile?.destroy();
            const cleanup = options.stdoutFilePath === undefined
                ? Promise.resolve()
                : rm(options.stdoutFilePath, {force: true}).catch(() => undefined);
            void cleanup.then(() => reject(error));
        };

        child.on('error', fail);
        // A capture file that cannot be written must not leave the pull
        // looking successful; a stdin write to a child that already exited is
        // reported by the exit code instead.
        stdoutFile?.on('error', fail);
        child.stdin?.on('error', (error) => {
            if (isErrnoException(error) && error.code === 'EPIPE') {
                return;
            }
            fail(error);
        });
        child.on('close', (code, signal) => {
            if (stdoutFile === null) {
                finish(code, signal);
                return;
            }
            stdoutFile.end(() => finish(code, signal));
        });

        if (options.input !== undefined && child.stdin !== null) {
            child.stdin.end(options.input);
        }
    })};
}

export interface IUtmVmListEntry {
    uuid: string;
    status: string;
    name: string;
}

export function parseUtmctlListOutput(stdout: string): IUtmVmListEntry[] {
    const entries: IUtmVmListEntry[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const columns = trimmed.split(/\s+/u);
        const uuid = columns[0];
        const status = columns[1];
        if (uuid === undefined || status === undefined || !isVmUuid(uuid)) {
            continue;
        }
        entries.push({
            uuid: uuid.toLowerCase(),
            status: status.toLowerCase(),
            // A UTM display name may contain spaces, so everything after the
            // status column belongs to the name.
            name: columns.slice(2).join(' '),
        });
    }
    return entries;
}

export const utmctlFailureKinds = [
    'automation-consent-missing',
    'timeout',
    'transport-failed',
] as const;

export type TUtmctlFailureKind = typeof utmctlFailureKinds[number];

const AUTOMATION_CONSENT_OSSTATUS = -1743;

export function detectsAutomationConsentFailure(text: string) {
    return text.includes(String(AUTOMATION_CONSENT_OSSTATUS))
        || /not authorized to send apple events/iu.test(text)
        || /errAEEventNotPermitted/u.test(text);
}

export function detectsUtmctlEventFailure(text: string) {
    if (/(?:^|\r?\n)\s*error\b/imu.test(text)
        || /failed to (?:open|read|write) file/iu.test(text)
        || /process cannot access the file/iu.test(text)
        || (text.includes('-2700') && /guest agent is not running|not installed on the guest/iu.test(text))) {
        return true;
    }
    for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (typeof parsed !== 'object' || parsed === null) {
                continue;
            }
            const record = parsed as Record<string, unknown>;
            const eventKeys = [
                'event',
                'type',
            ];
            if (eventKeys.some(key => {
                const value = record[key];
                return typeof value === 'string' && value.toLowerCase() === 'error';
            })) {
                return true;
            }
        } catch {
            // A binary pull or a non-JSON diagnostic is handled by the other
            // transport checks and must not be treated as an event by shape.
        }
    }
    return false;
}

// The transport can only report whether utmctl itself reached UTM. A zero exit
// says nothing about guest work (invariant I3), so callers must still validate
// a guest completion record.
export function classifyUtmctlTransportFailure(
    result: ICommandResult,
    options: ITransportFailureClassificationOptions = {},
): TUtmctlFailureKind | null {
    const inspectStdoutEvents = options.inspectStdoutEvents ?? true;
    const diagnostic = inspectStdoutEvents
        ? `${result.stdout}\n${result.stderr}`
        : result.stderr;
    if (detectsAutomationConsentFailure(diagnostic)) {
        return 'automation-consent-missing';
    }
    if (result.timedOut) {
        return 'timeout';
    }
    if (result.exitCode !== 0 || detectsUtmctlEventFailure(diagnostic)) {
        return 'transport-failed';
    }
    return null;
}

export class UtmctlTransportError extends Error {
    readonly kind: TUtmctlFailureKind;

    readonly args: string[];

    readonly result: ICommandResult;

    constructor(kind: TUtmctlFailureKind, args: string[], result: ICommandResult) {
        super(UtmctlTransportError.describe(kind, args, result));
        this.name = 'UtmctlTransportError';
        this.kind = kind;
        this.args = args;
        this.result = result;
    }

    private static describe(kind: TUtmctlFailureKind, args: string[], result: ICommandResult) {
        const command = `utmctl ${args.join(' ')}`;
        if (kind === 'automation-consent-missing') {
            return [
                `${command} failed with OSStatus ${AUTOMATION_CONSENT_OSSTATUS}:`,
                'the launcher running this coordinator has no macOS Automation consent for UTM.',
                'Grant it in System Settings > Privacy & Security > Automation for the qualified launcher.',
                'The CLI\'s own message blames SSH and does not identify this cause.',
            ].join(' ');
        }
        if (kind === 'timeout') {
            return `${command} exceeded its supervised timeout and was killed.`;
        }
        const detail = result.stderr.trim() || result.stdout.trim();
        return `${command} failed with exit code ${String(result.exitCode)}: ${detail}`;
    }
}

export interface IUtmctlExecOutcome {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    signal: NodeJS.Signals | null;
    transportFailure: TUtmctlFailureKind | null;
}

export interface IUtmctlClientOptions {
    runner: ICommandRunner;
    utmctlPath?: string;
    dataRoot?: string;
    env?: NodeJS.ProcessEnv;
    fileExists?: (filePath: string) => boolean;
    spelling?: TUtmctlCommandSpelling;
    defaultTimeoutMs?: number;
    temporaryFilePath?: (label: string) => string;
    guestExecPollIntervalMs?: number;
    guestExecStateDirectory?: string;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    randomId?: () => string;
}

export interface IUtmctlClient {
    version(): Promise<string>;
    list(): Promise<IUtmVmListEntry[]>;
    status(vmId: string): Promise<string>;
    start(vmId: string): Promise<void>;
    stop(vmId: string, mode: 'request' | 'force'): Promise<void>;
    clone(sourceVmId: string, name: string): Promise<void>;
    deleteVm(vmId: string): Promise<void>;
    ipAddress(vmId: string): Promise<string[]>;
    exec(vmId: string, command: readonly string[], options?: {
        timeoutMs?: number;
        input?: string;
    }): Promise<IUtmctlExecOutcome>;
    pushFile(vmId: string, guestPath: string, contents: Uint8Array | string, options?: {timeoutMs?: number;}): Promise<void>;
    pullFile(vmId: string, guestPath: string, hostPath: string, options?: {timeoutMs?: number;}): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = windowsTestDefaultDeadlines.guestTransportSeconds * 1_000;
const DEFAULT_GUEST_EXEC_POLL_INTERVAL_MS = 2_000;
const GUEST_EXEC_DEADLINE_HEADROOM_MS = 2_000;
const WINDOWS_POWERSHELL_EXECUTABLE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const GUEST_EXEC_PROTOCOL = 'evb-utmctl-exec-v1';

interface IUtmctlGuestExecCompletion {
    protocol: typeof GUEST_EXEC_PROTOCOL;
    id: string;
    state: 'complete' | 'error' | 'timeout';
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

function powershellSingleQuoted(value: string) {
    const quote = String.fromCharCode(39);
    return `${quote}${value.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

function encodePowerShellCommand(command: string) {
    return Buffer.from(command, 'utf16le').toString('base64');
}

function guestExecBootstrap(
    requestPath: string,
    completionPath: string,
    temporaryCompletionPath: string,
    timeoutMs: number,
) {
    return [
        `$requestPath = ${powershellSingleQuoted(requestPath)}`,
        `$completionPath = ${powershellSingleQuoted(completionPath)}`,
        `$temporaryCompletionPath = ${powershellSingleQuoted(temporaryCompletionPath)}`,
        `$timeoutMs = ${String(Math.max(1, Math.floor(timeoutMs)))}`,
        '$record = $null',
        'try {',
        '    $ErrorActionPreference = [System.Management.Automation.ActionPreference]::Stop',
        '    $path = [IO.Path]::GetDirectoryName($requestPath)',
        '    if (-not [string]::IsNullOrWhiteSpace($path)) { [IO.Directory]::CreateDirectory($path) | Out-Null }',
        '    $request = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json',
        '    $command = [string]$request.command',
        '    if ([string]::IsNullOrWhiteSpace($command)) { throw "The guest command is empty." }',
        '    $commandName = [IO.Path]::GetFileNameWithoutExtension($command)',
        '    $isPowerShell = $commandName -ieq "powershell" -or $commandName -ieq "pwsh"',
        '    if ($commandName -ieq "powershell") {',
        `        $command = ${powershellSingleQuoted(WINDOWS_POWERSHELL_EXECUTABLE)}`,
        '    }',
        '    $psi = New-Object System.Diagnostics.ProcessStartInfo',
        '    $psi.FileName = $command',
        '    $psi.UseShellExecute = $false',
        '    $psi.CreateNoWindow = $true',
        '    $psi.RedirectStandardInput = $true',
        '    $psi.RedirectStandardOutput = $true',
        '    $psi.RedirectStandardError = $true',
        '    if ($null -ne $psi.PSObject.Properties["StandardInputEncoding"]) { $psi.StandardInputEncoding = [Text.Encoding]::UTF8 }',
        '    if ($null -ne $psi.PSObject.Properties["StandardOutputEncoding"]) { $psi.StandardOutputEncoding = [Text.Encoding]::UTF8 }',
        '    if ($null -ne $psi.PSObject.Properties["StandardErrorEncoding"]) { $psi.StandardErrorEncoding = [Text.Encoding]::UTF8 }',
        '    function ConvertTo-WindowsArgument([string]$value) {',
        '        if ($value.Length -gt 0 -and $value.IndexOf([char]34) -lt 0 -and $value -notmatch \'\\s\') { return $value }',
        '        $builder = New-Object System.Text.StringBuilder',
        '        [void]$builder.Append([char]34)',
        '        $backslashes = 0',
        '        foreach ($character in $value.ToCharArray()) {',
        '            if ($character -eq [char]92) { $backslashes++; continue }',
        '            if ($character -eq [char]34) {',
        '                for ($index = 0; $index -lt ($backslashes * 2 + 1); $index++) { [void]$builder.Append([char]92) }',
        '                [void]$builder.Append([char]34)',
        '                $backslashes = 0',
        '                continue',
        '            }',
        '            for ($index = 0; $index -lt $backslashes; $index++) { [void]$builder.Append([char]92) }',
        '            $backslashes = 0',
        '            [void]$builder.Append($character)',
        '        }',
        '        for ($index = 0; $index -lt ($backslashes * 2); $index++) { [void]$builder.Append([char]92) }',
        '        [void]$builder.Append([char]34)',
        '        return $builder.ToString()',
        '    }',
        '    function ConvertTo-PowerShellLiteral([string]$value) {',
        '        $quote = [char]39',
        '        return $quote + $value.Replace($quote.ToString(), $quote.ToString() + $quote.ToString()) + $quote',
        '    }',
        '    function ConvertTo-PowerShellArgument([string]$value) {',
        '        if ($value -match "^--?[A-Za-z_][A-Za-z0-9_-]*$" -or $value -eq "--" -or $value -eq "--%") { return $value }',
        '        return ConvertTo-PowerShellLiteral $value',
        '    }',
        '    $arguments = @($request.arguments | ForEach-Object { [string]$_ })',
        '    $powerShellPrefix = ([char]36).ToString() + "ProgressPreference = [System.Management.Automation.ActionPreference]::SilentlyContinue; "',
        '    $normalizedArguments = @()',
        '    for ($argumentIndex = 0; $argumentIndex -lt $arguments.Count; $argumentIndex++) {',
        '        $argument = [string]$arguments[$argumentIndex]',
        '        if ($isPowerShell -and ($argument -ieq "-EncodedCommand" -or $argument -ieq "-e") -and ($argumentIndex + 1) -lt $arguments.Count) {',
        '            $decodedCommand = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([string]$arguments[$argumentIndex + 1]))',
        '            $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($powerShellPrefix + "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; " + $decodedCommand))',
        '            $normalizedArguments += "-EncodedCommand"',
        '            $normalizedArguments += $encodedCommand',
        '            $argumentIndex++',
        '            continue',
        '        }',
        '        if ($isPowerShell -and ($argument -ieq "-Command" -or $argument -ieq "-c") -and ($argumentIndex + 1) -lt $arguments.Count) {',
        '            $commandParts = @()',
        '            for ($commandArgumentIndex = $argumentIndex + 1; $commandArgumentIndex -lt $arguments.Count; $commandArgumentIndex++) {',
        '                $commandParts += [string]$arguments[$commandArgumentIndex]',
        '            }',
        '            $commandPrefix = $powerShellPrefix + "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; "',
        '            $commandText = $commandPrefix + ($commandParts -join " ")',
        '            $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($commandText))',
        '            $normalizedArguments += "-EncodedCommand"',
        '            $normalizedArguments += $encodedCommand',
        '            break',
        '        }',
        '        if ($isPowerShell -and ($argument -ieq "-File" -or $argument -ieq "-f") -and ($argumentIndex + 1) -lt $arguments.Count) {',
        '            $scriptPrefix = $powerShellPrefix + "[Console]::InputEncoding = [Text.Encoding]::UTF8; [Console]::OutputEncoding = [Text.Encoding]::UTF8; "',
        '            $scriptText = $scriptPrefix + "& " + (ConvertTo-PowerShellLiteral ([string]$arguments[$argumentIndex + 1]))',
        '            for ($scriptArgumentIndex = $argumentIndex + 2; $scriptArgumentIndex -lt $arguments.Count; $scriptArgumentIndex++) {',
        '                $scriptText += " " + (ConvertTo-PowerShellArgument ([string]$arguments[$scriptArgumentIndex]))',
        '            }',
        '            $scriptText += "; exit " + ([char]36).ToString() + "LASTEXITCODE"',
        '            $normalizedArguments += "-EncodedCommand"',
        '            $normalizedArguments += [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($scriptText))',
        '            break',
        '        }',
        '        $normalizedArguments += $argument',
        '    }',
        '    $arguments = @($normalizedArguments)',
        '    $psi.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join " "',
        '    $process = New-Object System.Diagnostics.Process',
        '    $process.StartInfo = $psi',
        '    if (-not $process.Start()) { throw "The guest process did not start." }',
        '    $stdoutTask = $process.StandardOutput.ReadToEndAsync()',
        '    $stderrTask = $process.StandardError.ReadToEndAsync()',
        '    if ($null -ne $request.input) {',
        '        $inputBytes = [Text.Encoding]::UTF8.GetBytes([string]$request.input)',
        '        $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)',
        '        $process.StandardInput.BaseStream.Flush()',
        '    }',
        '    $process.StandardInput.Close()',
        '    $completed = $process.WaitForExit($timeoutMs)',
        '    if (-not $completed) {',
        '        try {',
        '            if (-not $process.HasExited) { $process.Kill() }',
        '        } catch { }',
        '        [void]$process.WaitForExit(1000)',
        '    }',
        '    $stdout = ""',
        '    $stderr = ""',
        '    if ($completed) {',
        '        $stdout = [string]$stdoutTask.Result',
        '        $stderr = [string]$stderrTask.Result',
        '    } else {',
        '        if ($stdoutTask.Wait(1000)) { $stdout = [string]$stdoutTask.Result }',
        '        if ($stderrTask.Wait(1000)) { $stderr = [string]$stderrTask.Result }',
        '        if ([string]::IsNullOrEmpty($stderr)) { $stderr = "The guest command timed out." }',
        '    }',
        '    $record = [ordered]@{',
        `        protocol = ${powershellSingleQuoted(GUEST_EXEC_PROTOCOL)}`,
        '        id = [string]$request.id',
        '        state = if ($completed) { "complete" } else { "timeout" }',
        '        exitCode = if ($completed) { [int]$process.ExitCode } else { $null }',
        '        stdout = $stdout',
        '        stderr = $stderr',
        '    }',
        '} catch {',
        '    $record = [ordered]@{',
        `        protocol = ${powershellSingleQuoted(GUEST_EXEC_PROTOCOL)}`,
        '        id = if ($null -eq $request) { "" } else { [string]$request.id }',
        '        state = "error"',
        '        exitCode = $null',
        '        stdout = ""',
        '        stderr = [string]$_',
        '    }',
        '}',
        '$utf8 = New-Object System.Text.UTF8Encoding($false)',
        '[IO.File]::WriteAllText($temporaryCompletionPath, ($record | ConvertTo-Json -Compress -Depth 4), $utf8)',
        'Move-Item -LiteralPath $temporaryCompletionPath -Destination $completionPath -Force | Out-Null',
    ].join('\n');
}

function guestExecCleanup(requestPath: string, completionPath: string, temporaryCompletionPath: string) {
    return [
        `$paths = @(${powershellSingleQuoted(requestPath)}, ${powershellSingleQuoted(completionPath)}, ${powershellSingleQuoted(temporaryCompletionPath)})`,
        'foreach ($path in $paths) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }',
    ].join('\n');
}

function parseGuestExecCompletion(text: string, expectedId: string): IUtmctlGuestExecCompletion | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const record = parsed as Partial<IUtmctlGuestExecCompletion>;
    return record.protocol === GUEST_EXEC_PROTOCOL
        && record.id === expectedId
        && (record.state === 'complete' || record.state === 'error' || record.state === 'timeout')
        && (record.state === 'complete'
            ? typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
            : record.exitCode === null)
        && typeof record.stdout === 'string'
        && typeof record.stderr === 'string'
        ? record as IUtmctlGuestExecCompletion
        : null;
}

function isMissingGuestFile(text: string) {
    return /(?:file|path|item).*(?:not found|does not exist|cannot find|could not find)/iu.test(text)
        || /(?:not found|does not exist|cannot find|could not find).*(?:file|path|item)/iu.test(text);
}

export function createUtmctlClient(options: IUtmctlClientOptions): IUtmctlClient {
    const utmctlPath = options.utmctlPath ?? resolveDefaultUtmctlPath({
        ...(options.dataRoot === undefined ? {} : {dataRoot: options.dataRoot}),
        ...(options.env === undefined ? {} : {env: options.env}),
        ...(options.fileExists === undefined ? {} : {fileExists: options.fileExists}),
    });
    const spelling = options.spelling ?? defaultUtmctlCommandSpelling;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const temporaryFilePath = options.temporaryFilePath
        ?? ((label: string) => path.join(tmpdir(), `evb-windows-test-${label}-${randomUUID()}.json`));
    const guestExecPollIntervalMs = options.guestExecPollIntervalMs ?? DEFAULT_GUEST_EXEC_POLL_INTERVAL_MS;
    const guestExecStateDirectory = options.guestExecStateDirectory ?? windowsTestGuestLayout.stateDir;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? delay;
    const randomId = options.randomId ?? randomUUID;

    const runChecked = async (args: string[], runOptions: ICommandRunOptions) => {
        const result = await options.runner.run(utmctlPath, args, runOptions);
        const failure = classifyUtmctlTransportFailure(result, {inspectStdoutEvents: runOptions.stdoutFilePath === undefined});
        if (failure !== null) {
            throw new UtmctlTransportError(failure, args, result);
        }
        return result;
    };

    return {
        version: async () => (await runChecked([...spelling.version], {timeoutMs: defaultTimeoutMs})).stdout.trim(),
        list: async () => parseUtmctlListOutput(
            (await runChecked([...spelling.list], {timeoutMs: defaultTimeoutMs})).stdout,
        ),
        status: async (vmId) => (await runChecked([
            ...spelling.status,
            vmId.toUpperCase(),
        ], {timeoutMs: defaultTimeoutMs})).stdout.trim().toLowerCase(),
        start: async (vmId) => {
            await runChecked([
                ...spelling.start,
                vmId.toUpperCase(),
            ], {timeoutMs: defaultTimeoutMs});
        },
        stop: async (vmId, mode) => {
            await runChecked([
                ...(mode === 'force' ? spelling.stopForce : spelling.stopRequest),
                vmId.toUpperCase(),
            ], {timeoutMs: defaultTimeoutMs});
        },
        clone: async (sourceVmId, name) => {
            await runChecked([
                ...spelling.clone,
                sourceVmId.toUpperCase(),
                spelling.cloneNameFlag,
                name,
            ], {timeoutMs: defaultTimeoutMs});
        },
        deleteVm: async (vmId) => {
            await runChecked([
                ...spelling.delete,
                vmId.toUpperCase(),
            ], {timeoutMs: defaultTimeoutMs});
        },
        ipAddress: async (vmId) => (await runChecked([
            ...spelling.ipAddress,
            vmId.toUpperCase(),
        ], {timeoutMs: defaultTimeoutMs})).stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0),
        exec: async (vmId, command, execOptions) => {
            const timeoutMs = execOptions?.timeoutMs ?? defaultTimeoutMs;
            const vmUuid = vmId.toUpperCase();
            const id = randomId();
            const requestPath = `${guestExecStateDirectory}\\utmctl-exec-${id}.request.json`;
            const completionPath = `${guestExecStateDirectory}\\utmctl-exec-${id}.completion.json`;
            const temporaryCompletionPath = `${guestExecStateDirectory}\\utmctl-exec-${id}.completion.tmp`;
            const hostCompletionPath = temporaryFilePath(`utmctl-exec-${id}`);
            const deadline = now() + timeoutMs;
            let cleanupRequired = true;

            const outcomeForTransport = (result: ICommandResult, failure: TUtmctlFailureKind): IUtmctlExecOutcome => ({
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: result.timedOut || failure === 'timeout',
                signal: result.signal,
                transportFailure: failure,
            });

            const runWithinDeadline = async (
                args: string[],
                runOptions: Omit<ICommandRunOptions, 'timeoutMs'> = {},
                timeoutBudgetMs = timeoutMs,
            ) => {
                const remainingMs = Math.max(1, deadline - now());
                return options.runner.run(utmctlPath, args, {
                    ...runOptions,
                    timeoutMs: Math.min(timeoutBudgetMs, remainingMs),
                });
            };

            const cleanup = async () => {
                if (!cleanupRequired) {
                    return;
                }
                cleanupRequired = false;
                const cleanupCommand = encodePowerShellCommand(
                    guestExecCleanup(requestPath, completionPath, temporaryCompletionPath),
                );
                await options.runner.run(utmctlPath, [
                    ...spelling.exec,
                    vmUuid,
                    spelling.execCommandFlag,
                    WINDOWS_POWERSHELL_EXECUTABLE,
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-EncodedCommand',
                    cleanupCommand,
                ], {timeoutMs: Math.min(defaultTimeoutMs, 5_000)}).catch(() => undefined);
            };

            try {
                await rm(hostCompletionPath, {force: true});
                const request = `${JSON.stringify({
                    protocol: GUEST_EXEC_PROTOCOL,
                    id,
                    command: command[0] ?? '',
                    arguments: [...command].slice(1),
                    input: execOptions?.input ?? null,
                })}\n`;
                const pushResult = await runWithinDeadline([
                    ...spelling.filePush,
                    vmUuid,
                    requestPath,
                ], {input: request});
                const pushFailure = classifyUtmctlTransportFailure(pushResult);
                if (pushFailure !== null) {
                    return outcomeForTransport(pushResult, pushFailure);
                }

                if (now() >= deadline) {
                    return {
                        exitCode: null,
                        stdout: '',
                        stderr: '',
                        timedOut: true,
                        signal: null,
                        transportFailure: 'timeout' as const,
                    };
                }

                const bootstrapCommand = encodePowerShellCommand(
                    guestExecBootstrap(
                        requestPath,
                        completionPath,
                        temporaryCompletionPath,
                        Math.max(
                            1,
                            deadline - now() - Math.min(
                                GUEST_EXEC_DEADLINE_HEADROOM_MS,
                                Math.max(1, Math.floor(timeoutMs / 4)),
                            ),
                        ),
                    ),
                );
                const launchResult = await runWithinDeadline([
                    ...spelling.exec,
                    vmUuid,
                    spelling.execCommandFlag,
                    WINDOWS_POWERSHELL_EXECUTABLE,
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-EncodedCommand',
                    bootstrapCommand,
                ], {}, Math.max(
                    1,
                    deadline - now() - Math.min(
                        GUEST_EXEC_DEADLINE_HEADROOM_MS,
                        Math.max(1, Math.floor(timeoutMs / 4)),
                    ),
                ));
                const launchFailure = classifyUtmctlTransportFailure(launchResult);
                if (launchFailure !== null) {
                    return outcomeForTransport(launchResult, launchFailure);
                }

                while (now() < deadline) {
                    await rm(hostCompletionPath, {force: true});
                    const pullResult = await runWithinDeadline([
                        ...spelling.filePull,
                        vmUuid,
                        completionPath,
                    ], {stdoutFilePath: hostCompletionPath});
                    const pullFailure = classifyUtmctlTransportFailure(pullResult, {inspectStdoutEvents: false});
                    if (pullFailure === null) {
                        const completion = parseGuestExecCompletion(
                            await readFile(hostCompletionPath, 'utf8').catch(() => ''),
                            id,
                        );
                        if (completion !== null) {
                            if (completion.state === 'timeout') {
                                return {
                                    exitCode: null,
                                    stdout: completion.stdout,
                                    stderr: completion.stderr,
                                    timedOut: true,
                                    signal: null,
                                    transportFailure: 'timeout' as const,
                                };
                            }
                            if (completion.state === 'error') {
                                return {
                                    exitCode: null,
                                    stdout: completion.stdout,
                                    stderr: completion.stderr,
                                    timedOut: false,
                                    signal: null,
                                    transportFailure: 'transport-failed' as const,
                                };
                            }
                            return {
                                exitCode: completion.exitCode,
                                stdout: completion.stdout,
                                stderr: completion.stderr,
                                timedOut: false,
                                signal: null,
                                transportFailure: null,
                            };
                        }
                    } else if (!isMissingGuestFile(`${pullResult.stdout}\n${pullResult.stderr}`)) {
                        return outcomeForTransport(pullResult, pullFailure);
                    }

                    const remainingMs = deadline - now();
                    if (remainingMs <= 0) {
                        break;
                    }
                    await sleep(Math.min(guestExecPollIntervalMs, remainingMs));
                }

                return {
                    exitCode: null,
                    stdout: '',
                    stderr: 'The guest command did not publish a completion record before the timeout.',
                    timedOut: true,
                    signal: null,
                    transportFailure: 'timeout' as const,
                };
            } finally {
                await rm(hostCompletionPath, {force: true});
                await cleanup();
            }
        },
        pushFile: async (vmId, guestPath, contents, pushOptions) => {
            await runChecked([
                ...spelling.filePush,
                vmId.toUpperCase(),
                guestPath,
            ], {
                timeoutMs: pushOptions?.timeoutMs ?? defaultTimeoutMs,
                input: contents,
            });
        },
        pullFile: async (vmId, guestPath, hostPath, pullOptions) => {
            try {
                await runChecked([
                    ...spelling.filePull,
                    vmId.toUpperCase(),
                    guestPath,
                ], {
                    timeoutMs: pullOptions?.timeoutMs ?? defaultTimeoutMs,
                    stdoutFilePath: hostPath,
                });
            } catch (error) {
                // A non-zero exit or a timeout leaves a partial capture that a
                // later reader would mistake for the real file.
                await rm(hostPath, {force: true});
                throw error;
            }
        },
    };
}
