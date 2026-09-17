import {randomUUID} from 'node:crypto';
import {
    mkdir,
    readFile,
    readlink,
    readdir,
    rmdir,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {
    isAbsolute,
    join, resolve,
} from 'node:path';
import {promisify} from 'node:util';
import {terminateProcessTree} from '@electron/utils/processTree';

export const SCAN_CLEANUP_SIDECAR_REGISTRY_DIRECTORY = '.evb-scan-cleanup-sidecars';
export const SCAN_CLEANUP_SIDECAR_REGISTRY_ENTRY_PREFIX = 'sidecar-';
const SCAN_CLEANUP_SIDECAR_REGISTRY_VERSION = 1;
const SCAN_CLEANUP_SIDECAR_REAP_GRACE_MS = 1_500;

export interface IScanCleanupProcessIdentity {
    executablePath: string;
    arguments: readonly string[];
    startTime: string;
}

export interface IScanCleanupSidecarRegistryEntry {
    version: 1;
    pid: number;
    ownerPid: number;
    binaryPath: string;
    manifestPath: string;
    processStartTime?: string;
    ownerStartTime?: string;
}

export interface IScanCleanupSidecarRegistration {
    entryPath: string;
    unregister: () => Promise<void>;
}

export interface IScanCleanupSidecarRecoveryOptions {
    log?: (level: 'debug' | 'warn', message: string) => void;
    isProcessAlive?: (pid: number) => boolean;
    readProcessIdentity?: (pid: number) => Promise<IScanCleanupProcessIdentity | null>;
    terminateProcessTree?: typeof terminateProcessTree;
    platform?: NodeJS.Platform;
}

function isNotFound(error: unknown) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseEntry(value: unknown): IScanCleanupSidecarRegistryEntry | null {
    if (!isRecord(value)
        || value.version !== SCAN_CLEANUP_SIDECAR_REGISTRY_VERSION
        || typeof value.pid !== 'number'
        || !Number.isSafeInteger(value.pid)
        || value.pid <= 0
        || typeof value.ownerPid !== 'number'
        || !Number.isSafeInteger(value.ownerPid)
        || value.ownerPid <= 0
        || typeof value.binaryPath !== 'string'
        || value.binaryPath.length === 0
        || typeof value.manifestPath !== 'string'
        || value.manifestPath.length === 0
        || (value.processStartTime !== undefined && typeof value.processStartTime !== 'string')
        || (value.ownerStartTime !== undefined && typeof value.ownerStartTime !== 'string')) {
        return null;
    }
    return {
        version: 1,
        pid: value.pid,
        ownerPid: value.ownerPid,
        binaryPath: value.binaryPath,
        manifestPath: value.manifestPath,
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

async function readLinuxProcessIdentity(pid: number): Promise<IScanCleanupProcessIdentity | null> {
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

async function readMacProcessIdentity(pid: number): Promise<IScanCleanupProcessIdentity | null> {
    try {
        const [
            {stdout: startTimeOutput},
            {stdout: commandLineOutput},
        ] = await Promise.all([
            execFileForIdentity('/bin/ps', [
                '-o',
                'lstart=',
                '-p',
                String(pid),
            ], {
                timeout: 1_000,
                maxBuffer: 16 * 1024,
            }),
            execFileForIdentity('/bin/ps', [
                '-o',
                'command=',
                '-p',
                String(pid),
            ], {
                timeout: 1_000,
                maxBuffer: 16 * 1024,
            }),
        ]);
        const startTime = normalizeProcessStartTime(String(startTimeOutput));
        const argumentsList = parseCommandLine(String(commandLineOutput));
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

async function readWindowsProcessIdentity(pid: number): Promise<IScanCleanupProcessIdentity | null> {
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

let ownerIdentityPromise: Promise<IScanCleanupProcessIdentity | null> | null = null;

function getOwnerIdentity() {
    ownerIdentityPromise ??= readProcessIdentity(process.pid, process.platform);
    return ownerIdentityPromise;
}

function defaultIsProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function normalizeIdentityPath(path: string, platform: NodeJS.Platform) {
    const normalized = resolve(path);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function processIdentityMatches(
    entry: IScanCleanupSidecarRegistryEntry,
    identity: IScanCleanupProcessIdentity,
    platform: NodeJS.Platform,
) {
    const manifestIndex = identity.arguments.indexOf('--manifest');
    return normalizeIdentityPath(identity.executablePath, platform) === normalizeIdentityPath(entry.binaryPath, platform)
        && manifestIndex >= 0
        && identity.arguments[manifestIndex + 1] !== undefined
        && normalizeIdentityPath(identity.arguments[manifestIndex + 1]!, platform)
            === normalizeIdentityPath(entry.manifestPath, platform)
        && (entry.processStartTime === undefined || entry.processStartTime === identity.startTime);
}

export function getScanCleanupSidecarRegistryDirectory(namespacePath: string) {
    return join(namespacePath, SCAN_CLEANUP_SIDECAR_REGISTRY_DIRECTORY);
}

export async function registerScanCleanupSidecar(
    namespacePath: string,
    input: {
        pid: number;
        binaryPath: string;
        manifestPath: string;
    },
): Promise<IScanCleanupSidecarRegistration> {
    const registryDirectory = getScanCleanupSidecarRegistryDirectory(namespacePath);
    await mkdir(registryDirectory, {recursive: true});
    const entryPath = join(
        registryDirectory,
        `${SCAN_CLEANUP_SIDECAR_REGISTRY_ENTRY_PREFIX}${randomUUID()}.json`,
    );
    const processIdentity = await readProcessIdentity(input.pid, process.platform);
    const ownerIdentity = await getOwnerIdentity();
    const entry: IScanCleanupSidecarRegistryEntry = {
        version: 1,
        pid: input.pid,
        ownerPid: process.pid,
        binaryPath: resolve(input.binaryPath),
        manifestPath: resolve(input.manifestPath),
        ...(processIdentity === null ? {} : {processStartTime: processIdentity.startTime}),
        ...(ownerIdentity === null ? {} : {ownerStartTime: ownerIdentity.startTime}),
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
            await removeEmptyRegistryDirectory(registryDirectory);
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
                entry: IScanCleanupSidecarRegistryEntry
            }>;
        }
        throw error;
    }
    const entries: Array<{
        entryPath: string;
        entry: IScanCleanupSidecarRegistryEntry
    }> = [];
    for (const directoryEntry of directoryEntries) {
        if (!directoryEntry.isFile()
            || !directoryEntry.name.startsWith(SCAN_CLEANUP_SIDECAR_REGISTRY_ENTRY_PREFIX)
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

async function removeEmptyRegistryDirectory(registryDirectory: string) {
    await rmdir(registryDirectory).catch(() => undefined);
}

export async function reapOrphanedScanCleanupSidecars(
    namespacePath: string,
    options: IScanCleanupSidecarRecoveryOptions = {},
) {
    const registryDirectory = getScanCleanupSidecarRegistryDirectory(namespacePath);
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
            log('warn', `Skipped scan-cleanup sidecar pid ${String(entry.pid)} because its live owner identity could not be proven`);
            continue;
        }
        if (ownerIsAlive && ownerIdentity?.startTime === entry.ownerStartTime) {
            continue;
        }
        if (!isProcessAlive(entry.pid)) {
            await unlink(entryPath).catch(() => undefined);
            continue;
        }
        const processIdentity = await readIdentity(entry.pid);
        if (processIdentity === null || !processIdentityMatches(entry, processIdentity, platform)) {
            log('warn', `Skipped scan-cleanup sidecar pid ${String(entry.pid)} because its identity could not be proven`);
            continue;
        }
        const terminated = await terminate(entry.pid, {
            graceMs: SCAN_CLEANUP_SIDECAR_REAP_GRACE_MS,
            isTargetAlive: () => isProcessAlive(entry.pid),
            platform,
            preferProcessGroup: platform !== 'win32',
        }).catch(() => false);
        if (terminated || !isProcessAlive(entry.pid)) {
            await unlink(entryPath).catch(() => undefined);
            reapedCount += 1;
            log('debug', `Reaped orphaned scan-cleanup sidecar pid ${String(entry.pid)}`);
        } else {
            log('warn', `Could not reap orphaned scan-cleanup sidecar pid ${String(entry.pid)}`);
        }
    }
    await removeEmptyRegistryDirectory(registryDirectory);
    return reapedCount;
}
