import {
    spawn, spawnSync,
} from 'node:child_process';
import { once } from 'node:events';
import {
    mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    // pnpm run SCRIPT -- OPTIONS retains the separator. Vitest treats everything
    // after it as positional arguments, so remove it before forwarding the options.
    if (args[0] === '--') args.shift();

    const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
        'run',
        '--project',
        'browser-integration',
        ...args,
    ], { stdio: 'inherit' });

    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}

// One development server owns the compiled client/worker graph for this lane.
// Browser contexts and document state still belong to each spec.
/** @param {{provide: (key: string, value: string) => void}} project */
export async function setup(project) {
    const { tsImport } = await import('tsx/esm/api');
    const [
        {
            findFreePort, isProcessAlive, killProcessTree,
        },
        { buildNuxtDevServerEnv },
    ] = await Promise.all([
        tsImport('./electron-run/electronRunProcessTree.ts', import.meta.url),
        tsImport('./electron-run/electronRunLaunchConfig.ts', import.meta.url),
    ]);
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const sessionName = `browser-lifecycle-${process.pid}`;
    const outputPath = resolve('.devkit', `${sessionName}.log`);
    mkdirSync(resolve('.devkit'), { recursive: true });
    let serverOutput = '';
    const devServer = spawn(process.execPath, [
        resolve(process.cwd(), 'node_modules/nuxt/bin/nuxt.mjs'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        env: buildNuxtDevServerEnv({
            ...process.env,
            SENTRY_BROWSER_DSN: `http://consenttest@127.0.0.1:${String(port)}/1`,
        }, port, sessionName),
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    /** @param {Buffer} chunk */
    const captureOutput = (chunk) => {
        serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
        writeFileSync(outputPath, serverOutput);
    };
    devServer.stdout.on('data', captureOutput);
    devServer.stderr.on('data', captureOutput);
    const stopServer = async () => {
        try {
            if (!devServer.pid) return;
            await killProcessTree(devServer.pid);
            if (isProcessAlive(devServer.pid)) {
                throw new Error('The browser lifecycle Nuxt process did not exit');
            }
        } finally {
            rmSync(outputPath, { force: true });
        }
    };
    try {
        await once(devServer, 'spawn');
        const deadline = Date.now() + 90_000;
        while (true) {
            if (devServer.exitCode !== null || devServer.signalCode !== null) {
                throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
            }
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for Nuxt:\n${serverOutput.slice(-8_000)}`);
            }
            try {
                const response = await fetch(origin, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
                await response.body?.cancel();
                if (response.ok) break;
            } catch {
                // The development server is still compiling or binding.
            }
            await new Promise(resolveWait => setTimeout(resolveWait, 250));
        }
        project.provide('browserIntegrationOrigin', origin);
        project.provide('browserIntegrationServerOutputPath', outputPath);
        return stopServer;
    } catch (error) {
        await stopServer();
        throw error;
    }
}
