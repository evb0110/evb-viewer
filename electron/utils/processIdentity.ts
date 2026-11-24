import type {ChildProcess} from 'node:child_process';
import {
    access,
    readFile,
    readlink,
} from 'node:fs/promises';
import type {Socket} from 'node:net';
import {
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';
import {resolveNativeProcessSupervisorPath} from '@electron/native-tools/resolveNativeToolsBase';

// Who started a process: its pid and the creation time the OS keeps for it,
// read from the OS and compared exactly. The managed process reaper and the
// scratch and namespace owners prove a run with it; no clock is consulted.

export interface IProcessIdentity {
    executablePath: string;
    arguments: readonly string[];
    startTime: string;
    // What proves a child an older build recorded (see isExactStartTime): the
    // pid that created it, which Windows keeps, and the environment it was
    // started with, NUL-delimited on macOS.
    parentPid?: number;
    environment?: string;
}

const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

// starttime counts clock ticks since boot, so the boot id keeps a process
// from an earlier boot apart from one that got the same pid at the same tick.
function parseProcStartTime(stat: string, bootId: string) {
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) {
        return null;
    }
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    // The slice starts at field 3 (state), while starttime is field 22.
    return fields[19] === undefined ? null : `${bootId.trim()}:${fields[19]}`;
}

async function execFileForIdentity(
    file: string,
    argumentsList: readonly string[],
    options: {
        env?: NodeJS.ProcessEnv;
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

// starttime is set at fork and kept through exec until the parent reaps the
// process. cmdline is still empty while Node's spawn returns mid-exec, and
// cmdline and exe are gone once the child exits.
// procfs answers from memory; the built-in module keeps a feature test's fs mock out of it.
function readLinuxStartTime(pid: number) {
    const {readFileSync} = process.getBuiltinModule('node:fs');
    return parseProcStartTime(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'), readFileSync(LINUX_BOOT_ID_PATH, 'utf8'));
}

async function readLinuxProcessIdentity(pid: number): Promise<IProcessIdentity | null> {
    try {
        const startTime = readLinuxStartTime(pid);
        const [
            commandLine,
            executablePath,
        ] = await Promise.all([
            readFile(`/proc/${String(pid)}/cmdline`),
            readlink(`/proc/${String(pid)}/exe`),
        ]);
        const argumentsList = commandLine.toString('utf8').split('\0').filter(Boolean);
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

// Native process identity host (`evb-windows-job-launcher --process-start-time-host`):
// answers start-time (`<pid>`) and full identity (`identity <pid>`) queries
// over stdin/stdout using OS syscalls directly (Win32 GetProcessTimes +
// NtQueryInformationProcess on Windows; sysctl + proc_pidpath on macOS),
// replacing both PowerShell and osascript shell-outs. Its pipes keep this
// process alive only while a query is in flight.
interface INativeIdentityHost {
    child: ChildProcess;
    answers: Array<(answer: string | null) => void>;
    // Ends this reader: its open questions answer null, and the next read starts another.
    end: () => void;
}

let nativeIdentityHost: INativeIdentityHost | null = null;

function queryNativeIdentityHost(command: string) {
    return new Promise<string | null>(resolveAnswer => {
        if (nativeIdentityHost === null) {
            const {existsSync} = process.getBuiltinModule('node:fs');
            const supervisorPath = resolveNativeProcessSupervisorPath(import.meta.dirname, {exists: existsSync});
            if (!supervisorPath) {
                resolveAnswer(null);
                return;
            }
            const child = process.getBuiltinModule('node:child_process').spawn(supervisorPath, ['--process-start-time-host'], {
                stdio: [
                    'pipe',
                    'pipe',
                    'ignore',
                ],
                windowsHide: true,
            });
            const lines = createInterface({input: child.stdout});
            const started: INativeIdentityHost = {
                child,
                answers: [],
                end: () => {
                    if (nativeIdentityHost === started) nativeIdentityHost = null;
                    lines.close();
                    started.answers.splice(0).forEach(answer => answer(null));
                    child.kill();
                },
            };
            lines.on('line', line => {
                started.answers.shift()?.(line.trim());
                if (started.answers.length === 0) (child.stdout as Socket).unref();
            });
            child.once('error', started.end).once('close', started.end);
            child.stdin.once('error', started.end);
            child.unref();
            (child.stdin as Socket).unref();
            nativeIdentityHost = started;
        }
        const host = nativeIdentityHost;
        // The two-second bound of every identity read: a reader that has not answered by then is ended.
        const timeout = setTimeout(() => {
            if (host.answers.includes(settle)) {
                host.end();
            }
        }, 2_000);
        timeout.unref();
        const settle = (answer: string | null) => {
            clearTimeout(timeout);
            resolveAnswer(answer);
        };
        host.answers.push(settle);
        (host.child.stdout as Socket).ref();
        host.child.stdin!.write(`${command}\n`);
    });
}

function parseNativeProcessIdentity(line: string | null): IProcessIdentity | null {
    if (!line) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        const executablePath = record.executablePath;
        const rawArguments = record.arguments;
        const startTime = record.startTime;
        if (
            typeof executablePath !== 'string'
            || !isAbsolute(executablePath)
            || !Array.isArray(rawArguments)
            || !rawArguments.every((arg): arg is string => typeof arg === 'string')
            || typeof startTime !== 'string'
            || startTime.length === 0
        ) {
            return null;
        }
        const identity: IProcessIdentity = {
            executablePath: resolve(executablePath),
            arguments: rawArguments,
            startTime,
        };
        if (typeof record.parentPid === 'number' && Number.isSafeInteger(record.parentPid)) {
            identity.parentPid = record.parentPid;
        }
        if (typeof record.environment === 'string') {
            identity.environment = record.environment;
        }
        return identity;
    } catch {
        return null;
    }
}

export async function readProcessIdentity(pid: number, platform = process.platform) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    if (platform === 'linux') {
        return readLinuxProcessIdentity(pid);
    }
    if ((platform === 'darwin' || platform === 'win32') && platform === process.platform) {
        return parseNativeProcessIdentity(await queryNativeIdentityHost(`identity ${String(pid)}`));
    }
    return null;
}

/**
 * The creation time the OS keeps for a process, as one exact string: Linux
 * "boot id:ticks since boot", macOS "seconds.microseconds", Windows ISO 8601 to
 * 100 ns. "" when the process is gone, "denied" when this user may not read it
 * (Windows), null when it could not be asked.
 */
export async function readProcessStartTime(pid: number): Promise<string | null> {
    if (!Number.isInteger(pid) || pid <= 0) {
        return '';
    }
    if (process.platform === 'win32' || process.platform === 'darwin') {
        return queryNativeIdentityHost(String(pid));
    }
    if (process.platform !== 'linux') {
        return null;
    }
    try {
        return readLinuxStartTime(pid);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : null;
    }
}

let ownStartTime: Promise<string | null> | null = null;

/** This process's creation time, read from the OS once. Null when it cannot be read. */
export function getOwnStartTime() {
    ownStartTime ??= readProcessStartTime(process.pid).then(startTime => (startTime === '' || startTime === 'denied' ? null : startTime));
    return ownStartTime;
}

export function isProcessAlive(pid: number) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && (error as NodeJS.ErrnoException).code === 'ESRCH');
    }
}

// Exact, at the OS value's own precision. A Linux registry entry from before
// the boot id was recorded holds bare ticks; it can only name a process of this
// boot's that started at that tick, and the reaper also matches its executable.
// The shape of a start time this build reads, per platform. Older builds kept
// macOS ps seconds and a Windows clock estimate, which never equal it.
const EXACT_START_TIME_PATTERNS: Partial<Record<NodeJS.Platform, RegExp>> = {
    darwin: /^\d+\.\d{6}$/u,
    linux: /^[\da-f-]+:\d+$/u,
    win32: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/u,
};

export function isExactStartTime(startTime: string, platform = process.platform) {
    return EXACT_START_TIME_PATTERNS[platform]?.test(startTime) === true;
}

export function startTimesMatch(recorded: string, observed: string, platform = process.platform) {
    return recorded === observed || (platform === 'linux' && /^\d+$/u.test(recorded) && observed.endsWith(`:${recorded}`));
}

// Whether a profile's Chromium single-instance lock is held, asked without
// touching it: a live instance logs a connection to its socket, and a handle on
// its lock file could stand in a launch's way. Windows deletes "lockfile" when
// its holder closes it, so it exists exactly while held. On POSIX,
// SingletonSocket links to the holder's socket in a short temporary folder,
// which the kernel lists among the bound sockets only while a process has it
// open. A failure keeps it held.
async function isProfileHeld(userDataPath: string) {
    if (process.platform === 'win32') {
        return access(join(userDataPath, 'lockfile')).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
    }
    const socketPath = await readlink(join(userDataPath, 'SingletonSocket')).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : null);
    if (socketPath === '' || socketPath === null) {
        return socketPath === null;
    }
    try {
        const boundSockets = process.platform === 'linux'
            ? process.getBuiltinModule('node:fs').readFileSync('/proc/net/unix', 'utf8')
            : String((await execFileForIdentity('/usr/sbin/netstat', [
                '-f',
                'unix',
                '-an',
            ], {
                timeout: 2_000,
                maxBuffer: 8 * 1024 * 1024,
            })).stdout);
        return boundSockets.split('\n').some(line => line.trimEnd().endsWith(` ${socketPath}`));
    } catch {
        return true;
    }
}

/** The profile a record belongs to: the one this process holds, another profile's user-data folder, or unknown. */
export const OWN_PROFILE = 'own';

// Whether the run that recorded this pid and creation time still runs. A
// matching creation time proves it; another one, or a gone pid, proves it ended.
// Unproven (no time recorded by an older version, or one this user may not
// read) defers to the profile: this process holds its own profile, so only a
// run of this process's own could still be on; another profile's lock decides
// for it; an unknown one is kept.
export async function isRecordedProcessRunning(pid: number, startTime: string | null | undefined, profile?: string) {
    const observed = typeof startTime === 'string' ? await readProcessStartTime(pid) : (isProcessAlive(pid) ? null : '');
    if (observed === '') {
        return false;
    }
    if (observed !== null && observed !== 'denied') {
        return startTimesMatch(startTime!, observed);
    }
    if (profile === OWN_PROFILE) {
        // This user can read every process of its own; a null time is this version's own unread one.
        return startTime === null || (observed === null && startTime !== undefined);
    }
    return profile === undefined || isProfileHeld(profile);
}
