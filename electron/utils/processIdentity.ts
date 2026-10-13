import type {ChildProcess} from 'node:child_process';
import {
    open,
    readFile,
    readlink,
} from 'node:fs/promises';
import {
    connect,
    type Socket,
} from 'node:net';
import {
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {createInterface} from 'node:readline';
import {promisify} from 'node:util';

// Who started a process: its pid and the creation time the OS keeps for it,
// read from the OS and compared exactly. The managed process reaper and the
// scratch and namespace owners prove a run with it; no clock is consulted.

export interface IProcessIdentity {
    executablePath: string;
    arguments: readonly string[];
    startTime: string;
    // What proves a child an older build recorded (see isExactStartTime): the
    // pid that created it, which Windows keeps, and the environment it was
    // started with, which macOS shows its own user.
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

// The kernel keeps a process's start as seconds and microseconds (p_starttime
// at the head of its kinfo_proc); ps prints it to the second only, so two runs
// in one second looked alike. JavaScript for Automation reads it through sysctl.
const MAC_START_TIME_SCRIPT = `ObjC.import('Foundation');
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long']]);
function run(argv) {
    const info = $.NSMutableData.dataWithLength(648);
    const size = $.NSData.alloc.initWithBase64EncodedStringOptions('iAIAAAAAAAA=', 0).mutableCopy;
    const mib = $.NSData.alloc.initWithBase64EncodedStringOptions(argv[0], 0);
    if ($.sysctl(mib.bytes, 4, info.mutableBytes, size.mutableBytes, null, 0) !== 0) return '';
    return size.base64EncodedStringWithOptions(0).js + ' ' + info.subdataWithRange($.NSMakeRange(0, 12)).base64EncodedStringWithOptions(0).js;
}`;

async function readMacStartTime(pid: number) {
    const mib = Buffer.alloc(16);
    [
        1,
        14,
        1,
        pid,
    ].forEach((value, index) => mib.writeInt32LE(value, index * 4)); // CTL_KERN, KERN_PROC, KERN_PROC_PID
    try {
        const {stdout} = await execFileForIdentity('/usr/bin/osascript', [
            '-l',
            'JavaScript',
            '-e',
            MAC_START_TIME_SCRIPT,
            mib.toString('base64'),
        ], {
            timeout: 2_000,
            maxBuffer: 1024,
        });
        const [
            size,
            head,
        ] = String(stdout).trim().split(' ').map(part => Buffer.from(part, 'base64'));
        // A pid with no process answers with an empty kinfo_proc.
        if (size?.length !== 8 || size.readBigUInt64LE() !== 648n || head?.length !== 12) return null;
        return `${String(head.readBigInt64LE(0))}.${String(head.readInt32LE(8)).padStart(6, '0')}`;
    } catch {
        return null;
    }
}

async function readMacProcessIdentity(pid: number): Promise<IProcessIdentity | null> {
    try {
        const readCommand = (environment: string[]) => execFileForIdentity('/bin/ps', [
            ...environment,
            '-ww',
            '-o',
            'command=',
            '-p',
            String(pid),
        ], {
            timeout: 1_000,
            maxBuffer: 256 * 1024,
        }).then(({stdout}) => String(stdout).trim());
        const [
            command,
            commandWithEnvironment,
            startTime,
        ] = await Promise.all([
            readCommand([]),
            readCommand(['-E']),
            readMacStartTime(pid),
        ]);
        const argumentsList = parseCommandLine(command);
        const executablePath = argumentsList[0];
        if (startTime === null || executablePath === undefined || !isAbsolute(executablePath)) {
            return null;
        }
        return {
            executablePath: resolve(executablePath),
            arguments: argumentsList,
            startTime,
            // ps -E appends the environment the process started with, for this user's processes.
            environment: commandWithEnvironment.slice(command.length).trim(),
        };
    } catch {
        return null;
    }
}

async function readWindowsProcessIdentity(pid: number): Promise<IProcessIdentity | null> {
    const command = [
        `$process = Get-Process -Id ${String(pid)} -ErrorAction Stop`,
        `$native = Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" -ErrorAction Stop`,
        '@($process.StartTime.ToUniversalTime().ToString(\'o\'), $native.ParentProcessId, $native.ExecutablePath, $native.CommandLine) -join "`n"',
    ].join('; ');
    try {
        const {stdout} = await execFileForIdentity('powershell.exe', [
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
        const parentPid = Number(lines.shift());
        const executablePath = lines.shift()?.trim();
        const argumentsList = parseCommandLine(lines.join(' '));
        if (startTime === null || executablePath === undefined || !isAbsolute(executablePath)) {
            return null;
        }
        return {
            executablePath: resolve(executablePath),
            arguments: argumentsList,
            startTime,
            parentPid,
        };
    } catch {
        return null;
    }
}

export async function readProcessIdentity(pid: number, platform = process.platform) {
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

// Windows keeps a process's creation time to 100 ns, which Get-Process prints
// in full. One PowerShell per process answers in order, one line per pid: one
// launched per question cost every native command about a second (#930). It
// prints nothing for a pid that is gone and "denied" for a process it may not
// inspect. Its pipes keep this process alive only while a question is open.
const WINDOWS_START_TIME_HOST_SCRIPT = `while ($null -ne ($line = [Console]::In.ReadLine())) {
    $answer = ''
    try { $answer = (Get-Process -Id ([int]$line) -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') }
    catch [Microsoft.PowerShell.Commands.ProcessCommandException] {}
    catch { $answer = 'denied' }
    if ($null -eq $answer) { $answer = 'denied' }
    [Console]::Out.WriteLine($answer)
    [Console]::Out.Flush()
}`;

let windowsStartTimeHost: {
    child: ChildProcess;
    answers: Array<(answer: string | null) => void>;
} | null = null;

function readWindowsStartTime(pid: number) {
    return new Promise<string | null>(resolveAnswer => {
        if (windowsStartTimeHost === null) {
            const child = process.getBuiltinModule('node:child_process').spawn('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                WINDOWS_START_TIME_HOST_SCRIPT,
            ], {
                stdio: [
                    'pipe',
                    'pipe',
                    'ignore',
                ],
                windowsHide: true,
            });
            const host = {
                child,
                answers: [] as Array<(answer: string | null) => void>,
            };
            const close = () => {
                if (windowsStartTimeHost === host) windowsStartTimeHost = null;
                host.answers.splice(0).forEach(answer => answer(null));
            };
            createInterface({input: child.stdout}).on('line', line => {
                host.answers.shift()?.(line.trim());
                if (host.answers.length === 0) (child.stdout as Socket).unref();
            });
            child.once('error', close).once('close', close);
            child.stdin.once('error', close);
            child.unref();
            (child.stdin as Socket).unref();
            windowsStartTimeHost = host;
        }
        windowsStartTimeHost.answers.push(resolveAnswer);
        (windowsStartTimeHost.child.stdout as Socket).ref();
        windowsStartTimeHost.child.stdin!.write(`${String(pid)}\n`);
    });
}

/**
 * The creation time the OS keeps for a process, as one exact string: Linux
 * "boot id:ticks since boot", macOS "seconds.microseconds", Windows ISO 8601 to
 * 100 ns. "" when the process is gone, "denied" when this user may not read it
 * (Windows), null when it could not be asked.
 */
export async function readProcessStartTime(pid: number): Promise<string | null> {
    if (process.platform === 'win32') {
        return readWindowsStartTime(pid);
    }
    if (process.platform === 'darwin') {
        return isProcessAlive(pid) ? readMacStartTime(pid) : '';
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

// Whether a profile's Chromium single-instance lock is held. The OS lets go of
// it when its holder exits (Windows deletes "lockfile" on close; a socket stops
// listening), so it answers without a pid or a clock. A failure keeps it held.
async function isProfileHeld(userDataPath: string) {
    if (process.platform === 'win32') {
        return open(join(userDataPath, 'lockfile'), 'r+').then(handle => handle.close().then(() => false), (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
    }
    // SingletonSocket links to the listening socket in a short temporary folder,
    // since a socket path in a deep profile would not fit sun_path.
    const socketPath = await readlink(join(userDataPath, 'SingletonSocket')).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : null);
    if (socketPath === '' || socketPath === null) {
        return socketPath === null;
    }
    return new Promise<boolean>(resolveHeld => {
        const socket = connect(socketPath);
        socket.once('connect', () => {
            socket.destroy();
            resolveHeld(true);
        });
        socket.once('error', (error: NodeJS.ErrnoException) => resolveHeld(error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED'));
    });
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
    if (pid === process.pid) {
        return startTime === await getOwnStartTime();
    }
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
