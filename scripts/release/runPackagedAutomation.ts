import {
    spawn,
    type ChildProcess,
    type StdioOptions,
} from 'node:child_process';
import {
    access,
    lstat,
    mkdir,
    open,
    realpath,
    readdir,
    rm,
} from 'node:fs/promises';
import {once} from 'node:events';
import path, {
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {preparePackagedAutomationLaunch} from '@scripts/release/preparePackagedAutomationLaunch';
import {
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';

function isProcessGroupAlive(pid: number) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        // macOS reports EPERM for a group whose remaining members are unreaped zombies.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH' || code === 'EPERM') {
            return false;
        }
        throw error;
    }
}

async function stopOwnedProcessGroup(pid: number) {
    // A separate group retains ownership after the main process exits. Polling
    // ancestry alone can miss helpers spawned just before their parent exits.
    for (const signal of [
        'SIGTERM',
        'SIGKILL',
    ] as const) {
        if (!isProcessGroupAlive(pid)) {
            return;
        }
        try {
            process.kill(-pid, signal);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline && isProcessGroupAlive(pid)) await delay(50);
    }
    if (isProcessGroupAlive(pid)) {
        throw new Error(`Owned packaged automation process group ${pid} remained alive; preserving its bundle.`);
    }
}

/**
 * How completely a stop could account for helpers. A Unix process group keeps
 * ownership after the main process exits. Windows has only the live root's
 * tree: once the root has exited, reparented helpers cannot be found by an
 * exact owner, so the stop says so instead of reporting a clean exit.
 */
export type TOwnedHelperCleanup = 'process-group' | 'live-root-tree' | 'root-exited-helpers-unverified';

async function stopOwnedProcesses(pid: number | undefined, force: boolean): Promise<TOwnedHelperCleanup> {
    const rootAliveAtStop = pid !== undefined && isProcessAlive(pid);
    let treeStopError: Error | undefined;
    try {
        if (pid && rootAliveAtStop) await killProcessTree(pid, 1_500, {force});
    } catch (error) {
        treeStopError = error instanceof Error ? error : new Error(String(error));
        console.error('Process-tree shutdown failed; continuing owned-group cleanup.', error);
    }
    if (pid && process.platform !== 'win32') await stopOwnedProcessGroup(pid);
    if (treeStopError && process.platform === 'win32') throw treeStopError;
    if (pid && isProcessAlive(pid)) {
        throw new Error('Packaged automation remained alive after cleanup; preserving its bundle.');
    }
    if (process.platform !== 'win32') return 'process-group';
    return rootAliveAtStop ? 'live-root-tree' : 'root-exited-helpers-unverified';
}

async function resolveOwnedLogDirectory(workDirectory: string) {
    const logDirectory = join(workDirectory, 'electron-logs');
    await mkdir(logDirectory, {recursive: true});
    return realpath(logDirectory);
}

/**
 * The directory the installed payload owns: the `.app` bundle on macOS, the
 * executable's install directory elsewhere (`/opt/EVB Viewer`, the NSIS
 * install folder). Climbing three levels on Linux or Windows would treat a
 * whole `/opt` or drive hierarchy as the source.
 */
export function resolvePackagedSourceRoot(executablePath: string, platform: NodeJS.Platform = process.platform) {
    const executable = resolve(executablePath);
    return platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable);
}

/**
 * Whether `candidate` lies outside `root`. A different Windows drive makes
 * `relative` return an absolute path, which is outside, not a descendant.
 */
export function isOutsideRoot(root: string, candidate: string, pathApi: path.PlatformPath = path) {
    const fromRoot = pathApi.relative(root, candidate);
    return fromRoot === '..' || fromRoot.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(fromRoot);
}

async function claimWorkDirectory(workDirectory: string, executablePath: string) {
    const sourceRealPath = await realpath(resolvePackagedSourceRoot(executablePath));
    let existingAncestor = workDirectory;
    while (true) {
        try {
            await access(existingAncestor);
            break;
        } catch {
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor) throw new Error(`Cannot resolve packaged automation work directory: ${workDirectory}`);
            existingAncestor = parent;
        }
    }
    const existingAncestorRealPath = await realpath(existingAncestor);
    if (!isOutsideRoot(sourceRealPath, existingAncestorRealPath)) {
        throw new Error('Packaged automation workDirectory must be outside the source app bundle.');
    }

    await mkdir(dirname(workDirectory), {recursive: true});
    try {
        if ((await lstat(workDirectory)).isSymbolicLink()) {
            throw new Error(`Packaged automation work directory must not be a symlink: ${workDirectory}`);
        }
        const entries = await readdir(workDirectory);
        if (entries.length > 0) {
            throw new Error(`Packaged automation work directory must be empty and unused: ${workDirectory}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(workDirectory);
    }
    const ownerPath = join(workDirectory, '.packaged-automation-owner');
    try {
        const owner = await open(ownerPath, 'wx');
        await owner.writeFile(`${process.pid}\n`);
        await owner.close();
    } catch (error) {
        throw new Error(`Packaged automation work directory is already claimed: ${workDirectory}`, {cause: error});
    }
}

export interface IOwnedPackagedProcess {
    child: ChildProcess;
    userDataPath: string;
    logDirectory: string;
    /** Path the payload was launched from; on macOS a per-run LSUIElement copy. */
    launchExecutablePath: string;
    exited: Promise<number>;
    /** Idempotent. Stops every owned process, then removes the launch copy. */
    stop(options?: {force?: boolean}): Promise<TOwnedHelperCleanup>;
}

/**
 * The one owner of a packaged automation run: claims an unused task root
 * outside the installed payload, owns its profile and logs, launches hidden,
 * and stops exactly the processes it started.
 */
export async function startOwnedPackagedProcess(options: {
    executablePath: string;
    workDirectory: string;
    args: string[];
    sessionName?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: StdioOptions;
}): Promise<IOwnedPackagedProcess> {
    if (options.args.some(arg => arg.startsWith('--user-data-dir'))) {
        throw new Error('The runner owns --user-data-dir under --work-directory.');
    }
    const workDirectory = resolve(options.workDirectory);
    await claimWorkDirectory(workDirectory, options.executablePath);
    const userDataPath = join(workDirectory, 'user-data');
    const logDirectory = await resolveOwnedLogDirectory(workDirectory);
    const launch = preparePackagedAutomationLaunch({
        executablePath: options.executablePath,
        workDirectory,
        env: {
            ...options.env ?? process.env,
            EVB_AUTOMATION_SESSION_NAME: options.sessionName ?? `packaged-automation-${process.pid}`,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
            EVB_FILE_LOG_DIR: logDirectory,
        },
    });
    console.info(`Packaged automation paths: userData=${userDataPath}; logs=${logDirectory}`);
    const child = spawn(launch.executablePath, [
        ...options.args,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: launch.env,
        stdio: options.stdio ?? 'inherit',
        detached: process.platform !== 'win32',
    });
    // A payload that cannot start (EACCES, ENOEXEC, ENOENT) fails the start
    // itself, after its launch copy is removed, rather than rejecting an
    // exit promise nobody is awaiting yet.
    try {
        await once(child, 'spawn');
    } catch (error) {
        if (launch.bundleDirectory) {
            await rm(launch.bundleDirectory, {
                recursive: true,
                force: true,
            });
        }
        throw error;
    }
    console.info(`Packaged automation runner PID ${process.pid}; child PID ${String(child.pid)}`);
    const exited = new Promise<number>((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            console.info(`Packaged automation exited: code=${String(code)} signal=${String(signal)}`);
            resolveExit(code ?? (signal ? 1 : 0));
        });
    });
    let finalStop: Promise<TOwnedHelperCleanup> | undefined;
    return {
        child,
        userDataPath,
        logDirectory,
        launchExecutablePath: launch.executablePath,
        exited,
        stop(stopOptions = {}) {
            finalStop ??= (async () => {
                const cleanup = await stopOwnedProcesses(child.pid, stopOptions.force === true);
                if (launch.bundleDirectory) {
                    await rm(launch.bundleDirectory, {
                        recursive: true,
                        force: true,
                    });
                }
                return cleanup;
            })();
            return finalStop;
        },
    };
}

async function run() {
    const {
        values,
        positionals,
    } = parseArgs({
        options: {
            executable: {type: 'string'},
            'work-directory': {type: 'string'},
        },
        allowPositionals: true,
    });
    if (!values.executable || !values['work-directory']) {
        throw new Error('Usage: runPackagedAutomation.ts --executable <path> --work-directory <task directory> -- <Electron arguments>');
    }
    const owned = await startOwnedPackagedProcess({
        executablePath: values.executable,
        workDirectory: values['work-directory'],
        args: positionals,
    });
    let stopRequested = false;
    const stop = () => {
        stopRequested = true;
        void owned.stop().catch(error => console.error(error));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        process.exitCode = await owned.exited;
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        const cleanup = await owned.stop();
        if (cleanup === 'root-exited-helpers-unverified') {
            console.warn('The packaged main process exited before cleanup; on Windows its reparented helpers cannot be verified.');
        }
        if (stopRequested) process.exitCode = 0;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
