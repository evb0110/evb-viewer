import {
    spawn,
    type ChildProcess,
} from 'child_process';
import { config } from '@electron/config';

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
    if (await isServerRunning()) {
        console.log('[Electron] Nuxt server already running, connecting...');
        usingExternalServer = true;
        serverReady = Promise.resolve();
        return;
    }

    console.log('[Electron] Starting Nuxt server...');
    // Use definite assignment assertion - resolveReady is guaranteed to be assigned
    // by the Promise constructor before any code that uses it can execute
    let resolveReady!: () => void;
    serverReady = new Promise((resolve) => {
        resolveReady = resolve;
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

    nuxtProcess.on('error', (err) => {
        console.error('Failed to start Nuxt server:', err);
    });
}

export function waitForServer() {
    return serverReady;
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
