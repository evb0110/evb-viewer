import {
    execFile,
    spawn,
} from 'node:child_process';
import { basename } from 'node:path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

// Poppler decodes font and content streams without a size limit, so a small
// crafted PDF can make it allocate many gigabytes (#1255). Each Poppler process
// is held to 4 GiB, several times the largest page any caller renders. Linux
// enforces this at spawn: the shell sets a soft data-segment limit and execs
// Poppler, so its process id and binary stay Poppler's. macOS does not apply
// RLIMIT_DATA to mapped memory and Windows has no spawn-time limit, so there a
// watchdog reads each Poppler process's memory once a second and stops it
// above the limit (#1265). It reads the macOS physical footprint and the
// Windows private bytes because, unlike resident size or the working set,
// they keep counting memory the system has compressed or paged out.
const POPPLER_TOOL_NAMES = new Set([
    'pdfimages',
    'pdfinfo',
    'pdftoppm',
    'pdftotext',
]);
export const POPPLER_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3;
const SAMPLE_INTERVAL_MS = 1_000;
const READ_TIMEOUT_MS = 10_000;
// Keeps the Windows reader across consecutive pages instead of starting
// PowerShell for each one.
const READER_IDLE_CLOSE_MS = 30_000;
// footprint exits with EX_NOINPUT when none of the processes exist any more.
const FOOTPRINT_NO_PROCESSES_EXIT_CODE = 66;
const POWERSHELL_MEMORY_QUERY = [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {'
    + ' foreach ($process in Get-Process -Id ($line -split \',\')) {'
    + ' [Console]::Out.WriteLine((\'{0} {1}\' -f $process.Id, $process.PrivateMemorySize64)) };'
    + ' [Console]::Out.WriteLine(\'.\'); [Console]::Out.Flush() }',
].join('; ');

const log = createLogger('poppler-memory');

interface IProcessMemoryReader {
    read: (pids: number[]) => Promise<Map<number, number>>;
    close: () => void;
}

function isPopplerTool(command: string) {
    return POPPLER_TOOL_NAMES.has(basename(command).replace(/\.exe$/iu, ''));
}

export function withPopplerMemoryLimit(command: string, args: string[]) {
    if (process.platform !== 'linux' || !isPopplerTool(command)) {
        return {
            command,
            args,
        };
    }
    return {
        command: '/bin/sh',
        args: [
            '-c',
            'ulimit -S -d "$0" 2>/dev/null; exec "$@"',
            String(POPPLER_MEMORY_LIMIT_BYTES / 1024),
            command,
            ...args,
        ],
    };
}

function createFootprintReader(): IProcessMemoryReader {
    return {
        read: pids => new Promise((resolve, reject) => {
            execFile('/usr/bin/footprint', [
                '--noCategories',
                '-f',
                'bytes',
                ...pids.flatMap(pid => [
                    '-p',
                    String(pid),
                ]),
            ], {
                timeout: READ_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
            }, (error, stdout) => {
                if (error && error.code !== FOOTPRINT_NO_PROCESSES_EXIT_CODE) {
                    reject(error);
                    return;
                }
                resolve(new Map(Array.from(
                    stdout.matchAll(/\[(\d+)\]: .*\bFootprint: (\d+) B/gu),
                    ([
                        , pid,
                        bytes,
                    ]) => [
                        Number(pid),
                        Number(bytes),
                    ],
                )));
            });
        }),
        close: () => undefined,
    };
}

function createPowerShellReader(): IProcessMemoryReader {
    const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_MEMORY_QUERY,
    ], {
        windowsHide: true,
        stdio: [
            'pipe',
            'pipe',
            'ignore',
        ],
    });
    let pending: {
        resolve: (usage: Map<number, number>) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    } | null = null;
    let failure: Error | null = null;
    let usage = new Map<number, number>();
    let partialLine = '';
    const fail = (error: Error) => {
        failure ??= error;
        if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(failure);
            pending = null;
        }
    };
    child.on('error', fail);
    child.on('exit', () => fail(new Error('PowerShell memory reader exited')));
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        const lines = (partialLine + chunk).split(/\r?\n/u);
        partialLine = lines.pop() ?? '';
        for (const line of lines) {
            if (line !== '.') {
                const [
                    pid,
                    bytes,
                ] = line.split(' ').map(Number);
                if (Number.isSafeInteger(pid) && Number.isSafeInteger(bytes)) {
                    usage.set(pid!, bytes!);
                }
                continue;
            }
            if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(usage);
                pending = null;
            }
            usage = new Map();
        }
    });
    return {
        read: pids => (failure
            ? Promise.reject(failure)
            : new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    fail(new Error(`PowerShell memory reader did not answer within ${READ_TIMEOUT_MS}ms`));
                    child.kill();
                }, READ_TIMEOUT_MS);
                timeout.unref();
                pending = {
                    resolve,
                    reject,
                    timeout,
                };
                child.stdin.write(`${pids.join(',')}\n`);
            })),
        // The reader holds no state worth flushing, and a replaced reader may
        // be hung, so closing always ends the process.
        close: () => {
            child.kill();
        },
    };
}

function createProcessMemoryReader(): IProcessMemoryReader {
    return process.platform === 'win32' ? createPowerShellReader() : createFootprintReader();
}

// Tests replace the reader so they never depend on the host's tools.
export const popplerMemoryRuntime = {createReader: createProcessMemoryReader};

const watchedProcesses = new Map<number, (bytes: number) => void>();
let reader: IProcessMemoryReader | null = null;
let readFailureReported = false;
let sampleScheduled = false;
let idleCloseTimer: NodeJS.Timeout | null = null;

function scheduleReaderClose() {
    if (idleCloseTimer || !reader) {
        return;
    }
    idleCloseTimer = setTimeout(() => {
        idleCloseTimer = null;
        if (watchedProcesses.size === 0 && !sampleScheduled) {
            reader?.close();
            reader = null;
        }
    }, READER_IDLE_CLOSE_MS);
    idleCloseTimer.unref();
}

async function sampleWatchedProcesses() {
    if (watchedProcesses.size === 0) {
        return;
    }
    let usage: Map<number, number>;
    try {
        reader ??= popplerMemoryRuntime.createReader();
        usage = await reader.read(Array.from(watchedProcesses.keys()));
    } catch (error) {
        // A failed read leaves Poppler running rather than stopping every PDF
        // text and render job. The next sample starts a new reader, so a read
        // that timed out while the system was short of memory still gets the
        // process that caused it.
        reader?.close();
        reader = null;
        if (!readFailureReported) {
            readFailureReported = true;
            log.warn('Poppler memory watchdog could not read process memory; retrying every second', {error: getErrorMessage(error)});
        }
        return;
    }
    readFailureReported = false;
    for (const [
        pid,
        bytes,
    ] of usage) {
        const onExceeded = watchedProcesses.get(pid);
        if (onExceeded && bytes > POPPLER_MEMORY_LIMIT_BYTES) {
            watchedProcesses.delete(pid);
            onExceeded(bytes);
        }
    }
}

function scheduleSample() {
    if (sampleScheduled) {
        return;
    }
    sampleScheduled = true;
    setTimeout(() => {
        void sampleWatchedProcesses().finally(() => {
            sampleScheduled = false;
            if (watchedProcesses.size > 0) {
                scheduleSample();
            } else {
                scheduleReaderClose();
            }
        });
    }, SAMPLE_INTERVAL_MS).unref();
}

/** Calls `onExceeded` once if the Poppler process passes the limit; returns the unwatch function. */
export function watchPopplerMemory(command: string, pid: number, onExceeded: (bytes: number) => void) {
    if ((process.platform !== 'darwin' && process.platform !== 'win32') || !isPopplerTool(command)) {
        return () => undefined;
    }
    watchedProcesses.set(pid, onExceeded);
    if (idleCloseTimer) {
        clearTimeout(idleCloseTimer);
        idleCloseTimer = null;
    }
    scheduleSample();
    return () => {
        if (watchedProcesses.get(pid) === onExceeded) {
            watchedProcesses.delete(pid);
        }
    };
}
