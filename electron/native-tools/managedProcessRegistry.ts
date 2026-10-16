import {randomUUID} from 'node:crypto';
import {
    mkdir,
    readFile,
    readdir,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {
    isAbsolute,
    join, resolve,
} from 'node:path';
import {removeManagedScratchTempDir} from '@electron/utils/managedScratchTemp';
import {
    getOwnStartTime,
    isExactStartTime,
    isRecordedProcessRunning,
    isProcessAlive as isLiveProcess,
    readProcessIdentity,
    readProcessStartTime,
    startTimesMatch,
    type IProcessIdentity,
} from '@electron/utils/processIdentity';
import {
    isProcessTreeAlive,
    terminateProcessTree,
} from '@electron/utils/processTree';
import * as v from 'valibot';

// Keep the marker path stable so newer builds can reap children recorded by older builds.
export const MANAGED_PROCESS_REGISTRY_DIRECTORY = '.evb-scan-cleanup-sidecars';
export const MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX = 'sidecar-';
const MANAGED_PROCESS_REGISTRY_VERSION = 1;
const MANAGED_PROCESS_REAP_GRACE_MS = 1_500;

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
    readProcessIdentity?: (pid: number) => Promise<IProcessIdentity | null>;
    terminateProcessTree?: typeof terminateProcessTree;
    platform?: NodeJS.Platform;
}

function isNotFound(error: unknown) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

const positivePidSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));

// An entry proves its child by the child's start time, or by the manifest its command names.
const managedProcessRegistryEntrySchema = v.pipe(v.object({
    version: v.literal(MANAGED_PROCESS_REGISTRY_VERSION),
    pid: positivePidSchema,
    ownerPid: positivePidSchema,
    binaryPath: nonEmptyStringSchema,
    manifestPath: v.exactOptional(nonEmptyStringSchema),
    scratchPath: v.exactOptional(v.pipe(nonEmptyStringSchema, v.check(isAbsolute))),
    processStartTime: v.exactOptional(v.string()),
    ownerStartTime: v.exactOptional(v.string()),
}), v.check(entry => entry.manifestPath !== undefined || entry.processStartTime !== undefined));

function parseEntry(value: unknown): IManagedProcessRegistryEntry | null {
    const result = v.safeParse(managedProcessRegistryEntrySchema, value);
    return result.success ? result.output : null;
}

function normalizeIdentityPath(path: string, platform: NodeJS.Platform) {
    const normalized = resolve(path);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// An older build's child must also carry its recorded manifest, exact TMPDIR
// environment entry, or creator pid: its older start-time format is not proof.
function processIdentityMatches(
    entry: IManagedProcessRegistryEntry,
    identity: IProcessIdentity,
    platform: NodeJS.Platform,
) {
    const manifestIndex = identity.arguments.indexOf('--manifest');
    return normalizeIdentityPath(identity.executablePath, platform) === normalizeIdentityPath(entry.binaryPath, platform)
        && (entry.processStartTime === undefined
            || startTimesMatch(entry.processStartTime, identity.startTime, platform)
            || (!isExactStartTime(entry.processStartTime, platform) && (entry.manifestPath !== undefined
                || (identity.environment ?? '').split('\0').includes(`TMPDIR=${entry.scratchPath ?? '\0'}`)
                || identity.parentPid === entry.ownerPid)))
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
        // True once Node has reaped the child. Node reaps a child and records
        // its exit in one event-loop turn, so while this is false the pid still
        // names the child (running, exiting or a zombie) and no other process.
        hasExited: () => boolean;
        binaryPath: string;
        manifestPath?: string;
        scratchPath?: string;
    },
): Promise<IManagedProcessRegistration | null> {
    const processStartTime = await readProcessStartTime(input.pid);
    // Checked after the read: if the child had been reaped before it, the read
    // may name a process that reused the pid. A child that is gone needs no entry.
    if (input.hasExited()) return null;
    if (!processStartTime || processStartTime === 'denied') {
        throw new Error(`Could not prove identity for managed process pid ${String(input.pid)}`);
    }
    const ownerStartTime = await getOwnStartTime();
    const registryDirectory = getManagedProcessRegistryDirectory(namespacePath);
    await mkdir(registryDirectory, {recursive: true});
    const entryPath = join(
        registryDirectory,
        `${MANAGED_PROCESS_REGISTRY_ENTRY_PREFIX}${randomUUID()}.json`,
    );
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
    const isProcessAlive = options.isProcessAlive ?? isLiveProcess;
    const platform = options.platform ?? process.platform;
    const readIdentity = options.readProcessIdentity ?? ((pid: number) => readProcessIdentity(pid, platform));
    const terminate = options.terminateProcessTree ?? terminateProcessTree;
    const entries = await readRegistryEntries(registryDirectory);
    let reapedCount = 0;
    for (const {
        entryPath, entry,
    } of entries) {
        // A child whose process tree is gone gives back its scratch, then its entry.
        const release = async () => {
            if (entry.scratchPath && !await removeManagedScratchTempDir(entry.scratchPath, 'native-command-', namespacePath)) {
                log('warn', `Preserved managed process pid ${String(entry.pid)} because its scratch path is outside the namespace`);
                return false;
            }
            await unlink(entryPath).catch(() => undefined);
            return true;
        };
        // A live owner still holds its child, also when its start cannot be proven.
        if (await isRecordedProcessRunning(entry.ownerPid, entry.ownerStartTime)) {
            continue;
        }
        if (!isProcessAlive(entry.pid)) {
            if (entry.scratchPath && isProcessTreeAlive(entry.pid, platform)) {
                log('warn', `Preserved scratch for managed process pid ${String(entry.pid)} while its process group is still alive`);
                continue;
            }
            await release();
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
        if (!processTreeGone) {
            log('warn', `Could not reap orphaned managed process pid ${String(entry.pid)}`);
        } else if (await release()) {
            reapedCount += 1;
            log('debug', `Reaped orphaned managed process pid ${String(entry.pid)}`);
        }
    }
    return reapedCount;
}
