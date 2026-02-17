import {
    spawn,
    type ChildProcess,
} from 'child_process';
import {
    existsSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { retry } from 'es-toolkit/function';
import {
    delay,
    withTimeout,
} from 'es-toolkit/promise';
import { config } from '@electron/config';
import {
    SERVER_HEALTH_MAX_ATTEMPTS,
    SERVER_HEALTH_RETRY_MS,
    SERVER_POLL_INTERVAL_MS,
    SERVER_READY_TIMEOUT_MS,
} from '@electron/config/constants';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('server');

let nuxtProcess: ChildProcess | null = null;
let serverReady: Promise<void> | null = null;
let usingExternalServer = false;
const SERVER_OWNERSHIP_FILE = 'nuxt-server-owner.json';

interface IServerOwnershipMarker {
    pid: number;
    entryPath: string;
    createdAt: number;
    version: 1;
}

function getOwnershipMarkerPath() {
    return join(app.getPath('userData'), SERVER_OWNERSHIP_FILE);
}

function readOwnershipMarker(): IServerOwnershipMarker | null {
    const markerPath = getOwnershipMarkerPath();
    if (!existsSync(markerPath)) {
        return null;
    }

    try {
        const content = readFileSync(markerPath, 'utf-8');
        const parsed = JSON.parse(content) as Partial<IServerOwnershipMarker>;
        if (
            typeof parsed?.pid !== 'number'
            || !Number.isInteger(parsed.pid)
            || parsed.pid <= 0
            || typeof parsed.entryPath !== 'string'
        ) {
            return null;
        }

        return {
            pid: parsed.pid,
            entryPath: parsed.entryPath,
            createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
            version: 1,
        };
    } catch {
        return null;
    }
}

function writeOwnershipMarker(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return;
    }

    const markerPath = getOwnershipMarkerPath();
    const marker: IServerOwnershipMarker = {
        pid,
        entryPath: config.server.entryPath,
        createdAt: Date.now(),
        version: 1,
    };
    try {
        writeFileSync(markerPath, JSON.stringify(marker), 'utf-8');
    } catch (err) {
        logger.warn(`Failed to write server ownership marker: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function clearOwnershipMarker() {
    const markerPath = getOwnershipMarkerPath();
    try {
        if (existsSync(markerPath)) {
            unlinkSync(markerPath);
        }
    } catch (err) {
        logger.warn(`Failed to clear server ownership marker: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function isPidAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function terminateProcess(pid: number, graceMs = 2_500) {
    if (!isPidAlive(pid) || pid === process.pid) {
        return;
    }

    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }

    const start = Date.now();
    while (Date.now() - start < graceMs) {
        if (!isPidAlive(pid)) {
            return;
        }
        await delay(100);
    }

    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // Ignore if process already exited.
    }
}

async function isServerRunning() {
    try {
        const response = await fetch(config.server.url, {method: 'HEAD'});
        return response.ok;
    } catch {
        return false;
    }
}

export async function startServer() {
    const startTime = Date.now();
    if (nuxtProcess && nuxtProcess.exitCode !== null) {
        nuxtProcess = null;
        clearOwnershipMarker();
    }

    // If we previously spawned the server, treat it as internal even though it answers on localhost.
    if (nuxtProcess && nuxtProcess.exitCode === null) {
        usingExternalServer = false;
        if (!serverReady) {
            serverReady = Promise.resolve();
        }
        logger.info(`Nuxt server already owned by this process (+${Date.now() - startTime}ms)`);
        return;
    }

    if (await isServerRunning()) {
        const marker = readOwnershipMarker();
        if (marker && marker.entryPath === config.server.entryPath) {
            if (isPidAlive(marker.pid)) {
                logger.warn(`Detected stale internally-owned Nuxt server (pid=${marker.pid}); terminating it`);
                await terminateProcess(marker.pid);
            }
            clearOwnershipMarker();
        }
    }

    if (await isServerRunning()) {
        logger.info('Nuxt server already running, connecting...');
        usingExternalServer = true;
        serverReady = Promise.resolve();
        logger.info(`Using existing Nuxt server (+${Date.now() - startTime}ms)`);
        return;
    }

    logger.info('Starting Nuxt server...');
    usingExternalServer = false;
    // Use definite assignment assertion - resolveReady is guaranteed to be assigned
    // by the Promise constructor before any code that uses it can execute
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    let readySettled = false;
    serverReady = new Promise<void>((resolve, reject) => {
        resolveReady = () => {
            if (readySettled) {
                return;
            }
            readySettled = true;
            resolve();
        };
        rejectReady = (err) => {
            if (readySettled) {
                return;
            }
            readySettled = true;
            reject(err);
        };
    });

    if (config.isDev) {
        nuxtProcess = spawn('pnpm', [
            'run',
            'dev:nuxt',
        ], {
            shell: true,
            stdio: [
                'inherit',
                'pipe',
                'inherit',
            ],
        });
    } else {
        nuxtProcess = spawn(process.execPath, [config.server.entryPath], {
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                EVB_VIEWER_NUXT_INTERNAL: '1',
                PORT: String(config.server.port),
            },
            stdio: [
                'inherit',
                'pipe',
                'inherit',
            ],
        });
    }

    if (nuxtProcess.pid) {
        writeOwnershipMarker(nuxtProcess.pid);
    }

    nuxtProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        process.stdout.write(output);

        if (output.includes('Local:') || output.includes('Listening')) {
            resolveReady();
        }
    });

    // Fallback: don't rely solely on log output for readiness (Nuxt output format may change).
    void (async () => {
        while (!readySettled && nuxtProcess && nuxtProcess.exitCode === null) {
            if (await isServerRunning()) {
                resolveReady();
                return;
            }
            await delay(SERVER_POLL_INTERVAL_MS);
        }
    })();

    nuxtProcess.on('error', (err) => {
        logger.error(`Failed to start Nuxt server: ${err instanceof Error ? err.message : String(err)}`);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
    });

    nuxtProcess.on('exit', (code, signal) => {
        clearOwnershipMarker();

        if (readySettled || usingExternalServer) {
            return;
        }

        rejectReady(new Error(`[Electron] Nuxt process exited before ready (code: ${code ?? 'null'}, signal: ${signal ?? 'null'})`));
    });
}

export function waitForServer() {
    if (!serverReady) {
        throw new Error('Server was not started');
    }
    const readyPromise = serverReady;

    const verifyHealth = async () => {
        let attempt = 0;
        try {
            await retry(async () => {
                attempt += 1;
                try {
                    const response = await fetch(config.server.url, { method: 'HEAD' });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                } catch (error) {
                    logger.debug(`Server health check attempt ${attempt}/${SERVER_HEALTH_MAX_ATTEMPTS} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`);
                    throw error;
                }
            }, {
                retries: SERVER_HEALTH_MAX_ATTEMPTS,
                delay: (retryAttempt) => (
                    retryAttempt + 1 < SERVER_HEALTH_MAX_ATTEMPTS
                        ? SERVER_HEALTH_RETRY_MS
                        : 0
                ),
            });
            logger.info('Server verified ready');
            return;
        } catch {
            // fall through
        }

        throw new Error('Server stdout detected but HTTP health check failed');
    };

    return (async () => {
        try {
            try {
                await withTimeout(async () => {
                    await readyPromise;
                }, SERVER_READY_TIMEOUT_MS);
            } catch (error) {
                if (error instanceof Error && error.name === 'TimeoutError') {
                    throw new Error(`Server failed to start within ${SERVER_READY_TIMEOUT_MS / 1000}s`);
                }
                throw error;
            }
            await verifyHealth();
        } catch (err) {
            if (nuxtProcess && !usingExternalServer) {
                nuxtProcess.kill();
                nuxtProcess = null;
            }
            if (!usingExternalServer) {
                clearOwnershipMarker();
            }

            throw err;
        }
    })();
}

export function stopServer() {
    if (nuxtProcess && nuxtProcess.exitCode === null) {
        logger.info('Stopping internally-managed Nuxt server');
        nuxtProcess.kill();
        nuxtProcess = null;
        clearOwnershipMarker();
        return;
    }

    if (!usingExternalServer) {
        clearOwnershipMarker();
    }
}
