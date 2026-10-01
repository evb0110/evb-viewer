import {randomUUID} from 'node:crypto';
import {
    mkdir,
    readFile,
    readlink,
    readdir,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {
    isAbsolute,
    join, resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {removeManagedScratchTempDir} from '@electron/utils/managedScratchTemp';
import {
    isProcessTreeAlive,
    terminateProcessTree,
} from '@electron/utils/processTree';

// Keep the marker path stable so newer builds can reap children recorded by older builds.
export const MANAGED_PROCESS_REGISTRY_DIRECTORY = '.evb-scan-cleanup-sidecars';
export const MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX = 'sidecar-';
const MANAGED_PROCESS_REGISTRY_VERSION = 1;
const MANAGED_PROCESS_REAP_GRACE_MS = 1_500;
// Covers spawn latency and the gap between process creation and Node's
// uptime origin, which is far below the time a pid takes to be reused.
const WINDOWS_START_TIME_TOLERANCE_MS = 5_000;

export interface IManagedProcessIdentity {
    executablePath: string;
    arguments: readonly string[];
    startTime: string;
}

export interface IManagedProcessRegistryEntry {
    version: 1;
    pid: number;
    ownerPid: number;
    binaryPath: string;
    manifestPath?: string;
    scratchPath?: string;
    processStartTime?: string;
    ownerStartTime?: string;
}

export interface IManagedProcessRegistration {
    entryPath: string;
    unregister: () => Promise<void>;
}

export interface IManagedProcessRecoveryOptions {
    log?: (level: 'debug' | 'warn', message: string) => void;
    isProcessAlive?: (pid: number) => boolean;
    readProcessIdentity?: (pid: number) => Promise<IManagedProcessIdentity | null>;
    terminateProcessTree?: typeof terminateProcessTree;
    platform?: NodeJS.Platform;
}

function isNotFound(error: unknown) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseEntry(value: unknown): IManagedProcessRegistryEntry | null {
    if (!isRecord(value)
        || value.version !== MANAGED_PROCESS_REGISTRY_VERSION
        || typeof value.pid !== 'number'
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || typeof value.ownerPid !== 'number'
        || !Number.isSafeInteger(value.ownerPid)
        || value.ownerPid <= 0
        || typeof value.binaryPath !== 'string'
        || value.binaryPath.length === 0
        || (value.scratchPath !== undefined && (typeof value.scratchPath !== 'string'
            || value.scratchPath.length === 0
            || !isAbsolute(value.scratchPath)))
        || (value.manifestPath !== undefined && (typeof value.manifestPath !== 'string' || value.manifestPath.length === 0))
        || (value.manifestPath === undefined && typeof value.processStartTime !== 'string')
        || (value.processStartTime !== undefined && typeof value.processStartTime !== 'string')
        || (value.ownerStartTime !== undefined && typeof value.ownerStartTime !== 'string')) {
        return null;
    }
    return {
        version: 1,
        pid: value.pid,
        ownerPid: value.ownerPid,
        binaryPath: value.binaryPath,
        ...(value.scratchPath === undefined ? {} : {scratchPath: value.scratchPath}),
        ...(value.manifestPath === undefined ? {} : {manifestPath: value.manifestPath}),
        ...(value.processStartTime === undefined ? {} : {processStartTime: value.processStartTime}),
        ...(value.ownerStartTime === undefined ? {} : {ownerStartTime: value.ownerStartTime}),
    };
}

function parseProcStartTime(stat: string) {
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
        return null;
    }
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    // The slice starts at field 3 (state), while starttime is field 22.
    return fields[19] ?? null;
}

function normalizeProcessStartTime(value: string) {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    return normalized.length > 0 ? normalized : null;
}

function parseCommandLine(commandLine: string) {
    return (commandLine.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [])
        .map(argument => argument.length >= 2
            && ((argument.startsWith('"') && argument.endsWith('"'))
                || (argument.startsWith('\'') && argument.endsWith('\'')))
            ? argument.slice(1, -1)
            : argument);
}

async function execFileForIdentity(
    file: string,
    argumentsList: readonly string[],
    options: {
        timeout: number;
        maxBuffer: number;
        windowsHide?: boolean
    },
) {
    // Keep the child-process inspection lazy. The normal Linux path uses
    // /proc, and loading child_process during module evaluation would make
    // feature tests that replace spawn need to provide unrelated APIs.
    const {execFile} = await import('node:child_process');
    return promisify(execFile)(file, [...argumentsList], options);
}

async function readLinuxProcessIdentity(pid: number): Promise<IManagedProcessIdentity | null> {
    try {
        const [
            commandLine,
            executablePath,
            stat,
        ] = await Promise.all([
            readFile(`/proc/${String(pid)}/cmdline`),
            readlink(`/proc/${String(pid)}/exe`),
            readFile(`/proc/${String(pid)}/stat`, 'utf8'),
        ]);
        const argumentsList = commandLine.toString('utf8').split('\0').filter(Boolean);
        const startTime = parseProcStartTime(stat);
        if (argumentsList.length === 0 || startTime === null) {
            return null;
        }
        return {
            executablePath: resolve(executablePath),
            arguments: argumentsList,
            startTime,
        };
    } catch {
        return null;
    }
}

async function readMacProcessIdentity(pid: number): Promise<IManagedProcessIdentity | null> {
    try {
        const {stdout} = await execFileForIdentity('/bin/ps', [
            '-o',
            'lstart=',
            '-o',
            'command=',
            '-p',
            String(pid),
        ], {
            timeout: 1_000,
            maxBuffer: 16 * 1024,
        });
        const match = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/u.exec(String(stdout).trim());
        if (match === null) return null;
        const startTime = normalizeProcessStartTime(match[1]!);
        const argumentsList = parseCommandLine(match[2]!);
        const executablePath = argumentsList[0];
        if (startTime === null || executablePath === undefined || !isAbsolute(executablePath)) {
            return null;
        }
        return {
            executablePath: resolve(executablePath),
            arguments: argumentsList,
            startTime,
        };
    } catch {
        return null;
    }
}

async function readWindowsProcessIdentity(pid: number): Promise<IManagedProcessIdentity | null> {
    const command = [
        `$process = Get-Process -Id ${String(pid)} -ErrorAction Stop`,
        `$native = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" -ErrorAction Stop`,
        '@($process.StartTime.ToUniversalTime().ToString(\'o\'), $native.ExecutablePath, $native.CommandLine) -join "`n"',
    ].join('; ');
    for (const executable of [
        'pwsh.exe',
        'powershell.exe',
    ]) {
        try {
            const {stdout} = await execFileForIdentity(executable, [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                command,
            ], {
                timeout: 2_000,
                windowsHide: true,
                maxBuffer: 16 * 1024,
            });
            const lines = String(stdout).trim().split(/\r?\n/u);
            const startTime = normalizeProcessStartTime(lines.shift() ?? '');
            const executablePath = lines.shift()?.trim();
            const argumentsList = parseCommandLine(lines.join(' '));
            if (startTime === null || executablePath === undefined || !isAbsolute(executablePath)) {
                return null;
            }
            return {
                executablePath: resolve(executablePath),
                arguments: argumentsList,
                startTime,
            };
        } catch {
            // A machine may have only Windows PowerShell or only pwsh. Try
            // the other host before failing closed.
        }
    }
    return null;
}

async function readProcessIdentity(pid: number, platform: NodeJS.Platform) {
    if (platform === 'linux') {
        return readLinuxProcessIdentity(pid);
    }
    if (platform === 'darwin') {
        return readMacProcessIdentity(pid);
    }
    if (platform === 'win32') {
        return readWindowsProcessIdentity(pid);
    }
    return null;
}

// Windows has no in-process way to read a process's start time, and asking
// PowerShell costs about a second for every command while usually finding a
// short command already gone (#930). A child is created inside the spawn call
// that has just returned, and this process started uptime() ago, so the clock
// bounds both start times. The owner's is taken at module load, close to its
// creation, so a later sleep or clock correction cannot skew it. The reaper
// compares Windows start times within WINDOWS_START_TIME_TOLERANCE_MS; its one
// PowerShell read per live entry runs at startup, off any command's path.
const ownerStartedAtOnWindows = Date.now() - process.uptime() * 1_000;

async function readRegistrationStartTime(pid: number) {
    if (process.platform === 'win32') {
        return new Date(pid === process.pid ? ownerStartedAtOnWindows : Date.now()).toISOString();
    }
    return (await readProcessIdentity(pid, process.platform))?.startTime ?? null;
}

let ownerStartTimePromise: Promise<string | null> | null = null;

function getOwnerStartTime() {
    ownerStartTimePromise ??= readRegistrationStartTime(process.pid);
    return ownerStartTimePromise;
}

function defaultIsProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ESRCH');
    }
}

function normalizeIdentityPath(path: string, platform: NodeJS.Platform) {
    const normalized = resolve(path);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function startTimesMatch(recorded: string, observed: string, platform: NodeJS.Platform) {
    if (platform !== 'win32') {
        return recorded === observed;
    }
    const difference = Math.abs(Date.parse(recorded) - Date.parse(observed));
    return difference <= WINDOWS_START_TIME_TOLERANCE_MS;
}

function processIdentityMatches(
    entry: IManagedProcessRegistryEntry,
    identity: IManagedProcessIdentity,
    platform: NodeJS.Platform,
) {
    const manifestIndex = identity.arguments.indexOf('--manifest');
    return normalizeIdentityPath(identity.executablePath, platform) === normalizeIdentityPath(entry.binaryPath, platform)
        && (entry.processStartTime === undefined || startTimesMatch(entry.processStartTime, identity.startTime, platform))
        && (entry.manifestPath === undefined
            || (manifestIndex >= 0
                && identity.arguments[manifestIndex + 1] !== undefined
                && normalizeIdentityPath(identity.arguments[manifestIndex + 1]!, platform)
                    === normalizeIdentityPath(entry.manifestPath, platform)));
}

export function getManagedProcessRegistryDirectory(namespacePath: string) {
    return join(namespacePath, MANAGED_PROCESS_REGISTRY_DIRECTORY);
}

export async function registerManagedProcess(
    namespacePath: string,
    input: {
        pid: number;
        binaryPath: string;
        manifestPath?: string;
        scratchPath?: string;
    },
): Promise<IManagedProcessRegistration> {
    const processStartTime = await readRegistrationStartTime(input.pid);
    const ownerStartTime = await getOwnerStartTime();
    const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
    await mkdir(registryDirectory, {recursive: true});
    const entryPath = join(
        registryDirectory,
        `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}${randomUUID()}.json`,
    );
    if (processStartTime === null) {
        throw new Error(`Could not prove identity for managed process pid ${String(input.pid)}`);
    }
    const entry: IManagedProcessRegistryEntry = {
        version: 1,
        pid: input.pid,
        ownerPid: process.pid,
        binaryPath: resolve(input.binaryPath),
        ...(input.scratchPath === undefined ? {} : {scratchPath: resolve(input.scratchPath)}),
        ...(input.manifestPath === undefined ? {} : {manifestPath: resolve(input.manifestPath)}),
        processStartTime,
        ...(ownerStartTime === null ? {} : {ownerStartTime}),
    };
    await writeFile(entryPath, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    return {
        entryPath,
        unregister: async () => {
            await unlink(entryPath).catch(error => {
                if (!isNotFound(error)) {
                    throw error;
                }
            });
        },
    };
}

async function readRegistryEntries(registryDirectory: string) {
    let directoryEntries;
    try {
        directoryEntries = await readdir(registryDirectory, {withFileTypes: true});
    } catch (error) {
        if (isNotFound(error)) {
            return [] as Array<{
                entryPath: string;
                entry: IManagedProcessRegistryEntry
            }>;
        }
        throw error;
    }
    const entries: Array<{
        entryPath: string;
        entry: IManagedProcessRegistryEntry
    }> = [];
    for (const directoryEntry of directoryEntries) {
        if (!directoryEntry.isFile()
            || !directoryEntry.name.startsWith(MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX)
            || !directoryEntry.name.endsWith('.json')) {
            continue;
        }
        const entryPath = join(registryDirectory, directoryEntry.name);
        try {
            const entry = parseEntry(JSON.parse(await readFile(entryPath, 'utf8')) as unknown);
            if (entry === null) {
                await unlink(entryPath);
                continue;
            }
            entries.push({
                entryPath,
                entry,
            });
        } catch (error) {
            if (error instanceof SyntaxError) {
                // A torn marker must not make every later launch fail before
                // it can inspect the remaining sidecars. It carries no
                // trustworthy identity, so discard only this marker.
                await unlink(entryPath).catch(() => undefined);
                continue;
            }
            if (!isNotFound(error)) {
                throw error;
            }
        }
    }
    return entries;
}

export async function reapOrphanedManagedProcesses(
    namespacePath: string,
    options: IManagedProcessRecoveryOptions = {},
) {
    const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
    const log = options.log ?? (() => undefined);
    const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    const platform = options.platform ?? process.platform;
    const readIdentity = options.readProcessIdentity ?? ((pid: number) => readProcessIdentity(pid, platform));
    const terminate = options.terminateProcessTree ?? terminateProcessTree;
    const entries = await readRegistryEntries(registryDirectory);
    let reapedCount = 0;
    for (const {
        entryPath, entry,
    } of entries) {
        const ownerIsAlive = isProcessAlive(entry.ownerPid);
        const ownerIdentity = ownerIsAlive && entry.ownerStartTime !== undefined
            ? await readIdentity(entry.ownerPid)
            : null;
        if (ownerIsAlive && entry.ownerStartTime === undefined) {
            // A live worker still owns the child. Another app instance must
            // never terminate it merely because its marker is old. Missing
            // owner identity is also a fail-closed result for platforms where
            // the journal could not capture a start token.
            continue;
        }
        if (ownerIsAlive && ownerIdentity === null) {
            log('warn', `Skipped managed process pid ${String(entry.pid)} because its live owner identity could not be proven`);
            continue;
        }
        if (ownerIdentity !== null
            && entry.ownerStartTime !== undefined
            && startTimesMatch(entry.ownerStartTime, ownerIdentity.startTime, platform)) {
            continue;
        }
        if (!isProcessAlive(entry.pid)) {
            if (entry.scratchPath && isProcessTreeAlive(entry.pid, platform)) {
                log('warn', `Preserved scratch for managed process pid ${String(entry.pid)} while its process group is still alive`);
                continue;
            }
            if (entry.scratchPath && !await removeManagedScratchTempDir(entry.scratchPath, 'native-command-', namespacePath)) {
                log('warn', `Preserved managed process pid ${String(entry.pid)} because its scratch path is outside the namespace`);
                continue;
            }
            await unlink(entryPath).catch(() => undefined);
            continue;
        }
        const processIdentity = await readIdentity(entry.pid);
        if (processIdentity === null || !processIdentityMatches(entry, processIdentity, platform)) {
            log('warn', `Skipped managed process pid ${String(entry.pid)} because its identity could not be proven`);
            continue;
        }
        const terminated = await terminate(entry.pid, {
            graceMs: MANAGED_PROCESS_REAP_GRACE_MS,
            isTargetAlive: () => isProcessAlive(entry.pid),
            platform,
            preferProcessGroup: platform !== 'win32',
        }).catch(() => false);
        const processTreeGone = terminated || !isProcessTreeAlive(entry.pid, platform);
        if (processTreeGone) {
            if (entry.scratchPath && !await removeManagedScratchTempDir(entry.scratchPath, 'native-command-', namespacePath)) {
                log('warn', `Preserved managed process pid ${String(entry.pid)} because its scratch path is outside the namespace`);
                continue;
            }
            await unlink(entryPath).catch(() => undefined);
            reapedCount += 1;
            log('debug', `Reaped orphaned managed process pid ${String(entry.pid)}`);
        } else {
            log('warn', `Could not reap orphaned managed process pid ${String(entry.pid)}`);
        }
    }
    return reapedCount;
}
