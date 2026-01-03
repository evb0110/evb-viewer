import {
    spawn, type ChildProcess, 
} from 'child_process';
import { config } from './config';

let nuxtProcess: ChildProcess | null = null;
let serverReady: Promise<void> | null = null;

export function startServer() {
    let resolveReady: () => void;
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
    if (nuxtProcess) {
        nuxtProcess.kill();
        nuxtProcess = null;
    }
}
