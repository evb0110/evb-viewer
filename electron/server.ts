import {
    spawn,
    type ChildProcess,
} from 'child_process';
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

async function isServerRunning() {
    try {
        const response = await fetch(config.server.url, {method: 'HEAD'});
        return response.ok;
    } catch {
        return false;
    }
}

export async function startServer() {
    if (nuxtProcess && nuxtProcess.exitCode !== null) {
        nuxtProcess = null;
    }

    // If we previously spawned the server, treat it as internal even though it answers on localhost.
    if (nuxtProcess && nuxtProcess.exitCode === null) {
        usingExternalServer = false;
        if (!serverReady) {
            serverReady = Promise.resolve();
        }
        return;
    }

    if (await isServerRunning()) {
        logger.info('Nuxt server already running, connecting...');
        usingExternalServer = true;
        serverReady = Promise.resolve();
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
        nuxtProcess = spawn('node', [config.server.entryPath], {
            env: {
                ...process.env,
                PORT: String(config.server.port),
            },
            stdio: [
                'inherit',
                'pipe',
                'inherit',
            ],
        });
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
            await new Promise((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
        }
    })();

    nuxtProcess.on('error', (err) => {
        logger.error(`Failed to start Nuxt server: ${err instanceof Error ? err.message : String(err)}`);
        rejectReady(err instanceof Error ? err : new Error(String(err)));
    });

    nuxtProcess.on('exit', (code, signal) => {
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

    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`Server failed to start within ${SERVER_READY_TIMEOUT_MS / 1000}s`));
        }, SERVER_READY_TIMEOUT_MS);
    });

    const verifyHealth = async () => {
        for (let attempt = 1; attempt <= SERVER_HEALTH_MAX_ATTEMPTS; attempt += 1) {
            try {
                const response = await fetch(config.server.url, { method: 'HEAD' });
                if (response.ok) {
                    logger.info('Server verified ready');
                    return;
                }
            } catch {
                // Retry
            }

            if (attempt < SERVER_HEALTH_MAX_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, SERVER_HEALTH_RETRY_MS));
            }
        }
        throw new Error('Server stdout detected but HTTP health check failed');
    };

    return (async () => {
        try {
            await Promise.race([
                serverReady,
                timeoutPromise,
            ]);
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            await verifyHealth();
        } catch (err) {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            if (nuxtProcess && !usingExternalServer) {
                nuxtProcess.kill();
                nuxtProcess = null;
            }

            throw err;
        }
    })();
}

export function stopServer() {
    if (usingExternalServer) {
        return;
    }
    if (nuxtProcess) {
        nuxtProcess.kill();
        nuxtProcess = null;
    }
}
