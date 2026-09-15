import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {
    createServer,
    type Server,
} from 'node:net';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {isRecord} from '@contracts/runtimeGuards';
import {
    createNodeProcessSpawner,
    createOwnedProcessRegistry,
    createWindowsAppLauncher,
} from '@scripts/windows-test/guest/appLaunch';
import {
    guestLayoutForRoot,
    joinGuestPath,
    WINDOWS_GUEST_PATH_SEPARATOR,
} from '@scripts/windows-test/guest/guestPaths';
import {
    createNodeGuestCommandRunner,
    createNodeGuestFileSystem,
    nodeGuestClock,
} from '@scripts/windows-test/guest/guestRuntime';
import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    runGuestWorker,
    type IGuestWorkerAdapters,
} from '@scripts/windows-test/guest/guestWorker';
import { createUia3PowerShellAdapter } from '@scripts/windows-test/guest/native-ui/uia3PowerShellAdapter';
import { createWinappCliAdapter } from '@scripts/windows-test/guest/native-ui/winappCliAdapter';
import { createPuppeteerViewerFactory } from '@scripts/windows-test/guest/viewer/createPuppeteerViewerFactory';

const DEFAULT_GUEST_ROOT = 'C:\\EVBViewerTests';

const DEFAULT_WAIT_FOR_JOB_MS = 15 * 60 * 1_000;

export interface IGuestWorkerPipeLock {
    pipePath: string;
    release(): Promise<void>;
}

export class GuestWorkerLockBusyError extends Error {
    constructor(pipePath: string) {
        super(`Guest worker pipe ${pipePath} is already held by another process.`);
        this.name = 'GuestWorkerLockBusyError';
    }
}

export function guestWorkerPipePath(guestRoot: string) {
    const canonicalRoot = process.platform === 'win32'
        ? path.win32.resolve(guestRoot).toLowerCase()
        : path.resolve(guestRoot);
    const digest = createHash('sha256').update(canonicalRoot, 'utf8').digest('hex').slice(0, 32);
    return process.platform === 'win32'
        ? `\\\\.\\pipe\\evb-viewer-guest-worker-${digest}`
        : path.join('/tmp', `evb-viewer-guest-worker-${digest}.sock`);
}

function listenOnGuestWorkerPipe(pipePath: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        const server = createServer(socket => socket.destroy());
        const onError = (error: Error) => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.removeListener('error', onError);
            resolve(server);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        try {
            server.listen(pipePath);
        } catch (error) {
            server.removeListener('error', onError);
            server.removeListener('listening', onListening);
            reject(error);
        }
    });
}

function closeGuestWorkerPipe(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

export async function acquireGuestWorkerPipeLock(guestRoot: string): Promise<IGuestWorkerPipeLock> {
    const pipePath = guestWorkerPipePath(guestRoot);
    let server: Server;
    try {
        server = await listenOnGuestWorkerPipe(pipePath);
    } catch (error) {
        if (isRecord(error) && error.code === 'EADDRINUSE') {
            throw new GuestWorkerLockBusyError(pipePath);
        }
        throw new Error(`Cannot acquire guest worker pipe ${pipePath}: ${getErrorMessage(error)}`);
    }
    return {
        pipePath,
        release: () => closeGuestWorkerPipe(server),
    };
}

function parseWaitForJobMs(raw: string) {
    const parsed = Number(raw);
    if (raw.trim().length === 0 || !Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--wait-ms must be a non-negative integer of milliseconds, received "${raw}".`);
    }
    return parsed;
}

export function defaultWinappExecutableForRoot(root: string) {
    return `${root.replace(/[\\/]+$/u, '')}\\tools\\winapp\\winapp.exe`;
}

function nodeGuestWorkerAdapters(env: NodeJS.ProcessEnv, winappExecutable: string): IGuestWorkerAdapters {
    return {
        createNativeUiAdapter: ({
            exec,
            clock,
            powerShell,
        }) => (env.EVB_WINDOWS_TEST_NATIVE_UI === 'uia3'
            ? createUia3PowerShellAdapter({
                powerShell,
                clock,
            })
            : createWinappCliAdapter({
                exec,
                clock,
                executable: env.EVB_WINDOWS_TEST_WINAPP_EXECUTABLE ?? winappExecutable,
            })),
        createViewerFactory: ({
            clock,
            nativeUi,
            paths,
            executable,
        }) => createPuppeteerViewerFactory({
            launcher: createWindowsAppLauncher({
                clock,
                spawner: createNodeProcessSpawner(),
                registry: createOwnedProcessRegistry(),
                executable,
            }),
            profileDirectory: paths.profileDir,
            nativeUi,
            clock,
        }),
    };
}

export async function guestWorkerMain(argv: readonly string[], env: NodeJS.ProcessEnv) {
    const rootArgument = argv.find(argument => argument.startsWith('--root='));
    const root = rootArgument === undefined
        ? env.EVB_WINDOWS_TEST_GUEST_ROOT ?? DEFAULT_GUEST_ROOT
        : rootArgument.slice('--root='.length);
    const waitArgument = argv.find(argument => argument.startsWith('--wait-ms='));
    const layout = guestLayoutForRoot(root, WINDOWS_GUEST_PATH_SEPARATOR);
    const workerLock = await acquireGuestWorkerPipeLock(root);
    const fs = createNodeGuestFileSystem();
    try {
        // A cloned image may contain the golden image's last boot-id file. Replace
        // the boot identity and heartbeat at worker startup so the host can never
        // accept a copied heartbeat from before this VM boot.
        await fs.remove(layout.heartbeatFile);
        await fs.writeTextDurable(layout.bootIdFile, `boot-${randomUUID()}\n`);
        const summary = await runGuestWorker({
            fs,
            exec: createNodeGuestCommandRunner(),
            clock: nodeGuestClock,
            paths: layout,
            adapters: nodeGuestWorkerAdapters(env, defaultWinappExecutableForRoot(root)),
            env,
            powerShellScriptsDirectory: joinGuestPath(
                WINDOWS_GUEST_PATH_SEPARATOR,
                layout.root,
                'worker',
                'powershell',
            ),
            waitForJobMs: waitArgument === undefined
                ? DEFAULT_WAIT_FOR_JOB_MS
                : parseWaitForJobMs(waitArgument.slice('--wait-ms='.length)),
        });
        process.stdout.write(`${JSON.stringify({
            resultFile: summary.resultFile,
            outcome: summary.result?.outcome ?? null,
            reason: summary.reason,
        }, null, 4)}\n`);
        return summary;
    } finally {
        await workerLock.release();
    }
}

function canonicalPath(candidate: string) {
    try {
        return realpathSync(path.resolve(candidate));
    } catch {
        return null;
    }
}

const entryPath = process.argv[1] === undefined ? null : canonicalPath(process.argv[1]);
if (entryPath !== null && entryPath === canonicalPath(fileURLToPath(import.meta.url))) {
    void guestWorkerMain(process.argv.slice(2), process.env).then(
        (summary) => {
            process.exitCode = summary.result === null ? 1 : 0;
        },
        (error: unknown) => {
            process.stderr.write(`${error instanceof Error ? error.stack ?? getErrorMessage(error) : getErrorMessage(error)}\n`);
            process.exitCode = 1;
        },
    );
}
