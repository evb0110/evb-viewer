import {spawn} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {
    join,
    resolve,
} from 'node:path';
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
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
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

async function stopOwnedProcesses(pid: number | undefined, stopPromise: Promise<void> | undefined) {
    let treeStopError: Error | undefined;
    try {
        await stopPromise;
        if (pid && isProcessAlive(pid)) await killProcessTree(pid, 1_500);
    } catch (error) {
        treeStopError = error instanceof Error ? error : new Error(String(error));
        console.error('Process-tree shutdown failed; continuing owned-group cleanup.', error);
    }
    if (pid && process.platform !== 'win32') await stopOwnedProcessGroup(pid);
    if (treeStopError && process.platform === 'win32') throw treeStopError;
    if (pid && isProcessAlive(pid)) {
        throw new Error('Packaged automation remained alive after cleanup; preserving its bundle.');
    }
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
    if (positionals.some(arg => arg.startsWith('--user-data-dir'))) {
        throw new Error('The runner owns --user-data-dir under --work-directory.');
    }
    const workDirectory = resolve(values['work-directory']);
    const userDataPath = join(workDirectory, 'user-data');
    const launch = preparePackagedAutomationLaunch({
        executablePath: values.executable,
        workDirectory,
        env: {
            ...process.env,
            EVB_ALLOW_MULTI_AUTOMATION_SESSIONS: '1',
            EVB_AUTOMATION_SESSION_NAME: `packaged-automation-${process.pid}`,
            EVB_AUTOMATION_USER_DATA_DIR: userDataPath,
        },
    });
    const child = spawn(launch.executablePath, [
        ...positionals,
        `--user-data-dir=${userDataPath}`,
    ], {
        env: launch.env,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
    });
    console.info(`Packaged automation runner PID ${process.pid}; child PID ${String(child.pid)}`);
    let stopPromise: Promise<void> | undefined;
    const stop = () => {
        if (child.pid) {
            stopPromise ??= killProcessTree(child.pid, 1_500);
            void stopPromise.catch(error => console.error(error));
        }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        process.exitCode = await new Promise<number>((resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                console.info(`Packaged automation exited: code=${String(code)} signal=${String(signal)}`);
                resolveExit(code ?? (signal ? 1 : 0));
            });
        });
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        await stopOwnedProcesses(child.pid, stopPromise);
        if (launch.bundleDirectory) {
            await rm(launch.bundleDirectory, {
                recursive: true,
                force: true,
            });
        }
    }
}

run().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});
