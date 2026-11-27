import {
    spawn,
    spawnSync,
} from 'node:child_process';
import { once } from 'node:events';
import {
    mkdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// One development server owns the compiled client/worker graph for this lane,
// and the supervised CLI starts one shared Chromium server for ordinary specs.
// Persistent-context specs still launch their own browser processes, and direct
// Vitest runs (such as Nightly Firefox/WebKit) do not require Chromium.
const BROWSER_WS_ENDPOINT_ENV = 'EVB_BROWSER_INTEGRATION_WS_ENDPOINT';
const BROWSER_ORIGIN_ENV = 'EVB_BROWSER_INTEGRATION_ORIGIN';
const BROWSER_SERVER_OUTPUT_PATH_ENV = 'EVB_BROWSER_INTEGRATION_SERVER_OUTPUT_PATH';

/** @type {readonly NodeJS.Signals[]} */
const SHUTDOWN_SIGNALS = [
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
];

/**
 * @param {number} pid
 * @param {{
 *   collectDescendantPidsUnix: (rootPid: number) => number[],
 *   isProcessAlive: (rootPid: number) => boolean,
 *   killPids: (pids: number[], options?: { signal?: NodeJS.Signals | number }) => void,
 * }} processTree
 */
function forceKillProcessTreeSync(pid, processTree) {
    if (!processTree.isProcessAlive(pid)) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', [
            '/PID',
            String(pid),
            '/T',
            '/F',
        ], { stdio: 'ignore' });
        return;
    }
    processTree.killPids([
        ...processTree.collectDescendantPidsUnix(pid),
        pid,
    ], { signal: 'SIGKILL' });
}

/** @param {NodeJS.Signals} signal */
function reraiseSignal(signal) {
    if (process.platform === 'win32') {
        process.exit(1);
    }
    process.kill(process.pid, signal);
}

/**
 * @param {{
 *   abortSignal?: AbortSignal,
 *   launchChromiumServer: boolean,
 * }} options
 */
async function startBrowserIntegrationHarness({
    abortSignal,
    launchChromiumServer,
}) {
    const { tsImport } = await import('tsx/esm/api');
    const [
        processTree,
        { buildNuxtDevServerEnv },
        playwrightModule,
    ] = await Promise.all([
        tsImport('./electron-run/electronRunProcessTree.ts', import.meta.url),
        tsImport('./electron-run/electronRunLaunchConfig.ts', import.meta.url),
        launchChromiumServer ? import('playwright') : Promise.resolve(null),
    ]);
    const {
        findFreePort,
        isProcessAlive,
        killProcessTree,
    } = processTree;

    const port = await findFreePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const sessionName = `browser-lifecycle-${process.pid}`;
    const outputPath = resolve('.devkit', `${sessionName}.log`);
    mkdirSync(resolve('.devkit'), { recursive: true });

    /** @type {Promise<import('playwright').BrowserServer | null> | null} */
    let browserServerPromise = null;
    /** @type {number | null} */
    let browserPid = null;
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

    // Synchronous fallback for abrupt process.exit() (such as Vitest's own
    // signal exit when invoked directly without the CLI supervisor).
    const forceKillOnExit = () => {
        if (browserPid) forceKillProcessTreeSync(browserPid, processTree);
        if (devServer.pid) forceKillProcessTreeSync(devServer.pid, processTree);
        rmSync(outputPath, { force: true });
    };
    process.on('exit', forceKillOnExit);

    const stopBrowserServer = async () => {
        if (!browserServerPromise) return;
        const activeServer = await browserServerPromise.catch(() => null);
        browserServerPromise = null;
        if (!activeServer) return;
        const pid = activeServer.process()?.pid ?? browserPid;
        try {
            await Promise.race([
                activeServer.close(),
                new Promise((_, reject) => {
                    const timer = setTimeout(() => reject(new Error('Timed out closing browser integration Chromium server')), 10_000);
                    timer.unref();
                }),
            ]);
        } catch {
            await activeServer.kill().catch(() => {});
        }
        if (pid && isProcessAlive(pid)) {
            await killProcessTree(pid);
            if (isProcessAlive(pid)) {
                throw new Error('The browser integration Chromium server process did not exit');
            }
        }
        browserPid = null;
    };

    const stopDevServer = async () => {
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

    /** @type {Promise<void> | null} */
    let stopPromise = null;
    const stop = () => {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
            const results = await Promise.allSettled([
                stopBrowserServer(),
                stopDevServer(),
            ]);
            const rejected = results.find(result => result.status === 'rejected');
            if (!rejected) {
                process.off('exit', forceKillOnExit);
            } else {
                throw rejected.reason;
            }
        })();
        return stopPromise;
    };

    try {
        if (playwrightModule) {
            browserServerPromise = playwrightModule.chromium.launchServer({
                headless: true,
                host: '127.0.0.1',
                handleSIGINT: false,
                handleSIGTERM: false,
                handleSIGHUP: false,
            }).then((server) => {
                browserPid = server.process()?.pid ?? null;
                return server;
            });
            // Prevent unhandled rejection if devServer startup fails before we await browserServerPromise.
            browserServerPromise.catch(() => {});
        }
        await once(devServer, 'spawn');
        const deadline = Date.now() + 90_000;
        while (true) {
            if (abortSignal?.aborted) {
                throw new Error('Aborted while waiting for browser integration harness');
            }
            if (devServer.exitCode !== null || devServer.signalCode !== null) {
                throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
            }
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting for Nuxt:\n${serverOutput.slice(-8_000)}`);
            }
            try {
                const requestSignal = abortSignal
                    ? AbortSignal.any([
                        abortSignal,
                        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
                    ])
                    : AbortSignal.timeout(Math.max(1, deadline - Date.now()));
                const response = await fetch(origin, { signal: requestSignal });
                await response.body?.cancel();
                if (response.ok) break;
            } catch {
                // The development server is still compiling or binding.
            }
            await new Promise((resolveWait) => {
                const timer = setTimeout(resolveWait, 250);
                if (!abortSignal) return;
                const onAbort = () => {
                    clearTimeout(timer);
                    resolveWait(undefined);
                };
                if (abortSignal.aborted) {
                    onAbort();
                    return;
                }
                abortSignal.addEventListener('abort', onAbort, { once: true });
            });
        }
        let wsEndpoint = null;
        if (browserServerPromise) {
            const activeBrowserServer = await browserServerPromise;
            if (!activeBrowserServer) {
                throw new Error('Failed to launch shared Chromium server for browser integration tests');
            }
            wsEndpoint = activeBrowserServer.wsEndpoint();
        }
        return {
            origin,
            outputPath,
            wsEndpoint,
            stop,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}

async function runSupervisedCli() {
    const args = process.argv.slice(2);
    // pnpm run SCRIPT -- OPTIONS retains the separator. Vitest treats everything
    // after it as positional arguments, so remove it before forwarding the options.
    if (args[0] === '--') args.shift();

    const { tsImport } = await import('tsx/esm/api');
    const { killSpawnedProcessTree } = await tsImport('./electron-run/electronRunProcessTree.ts', import.meta.url);

    const abortController = new AbortController();
    /** @type {Promise<Awaited<ReturnType<typeof startBrowserIntegrationHarness>>> | null} */
    let harnessPromise = null;
    /** @type {Awaited<ReturnType<typeof startBrowserIntegrationHarness>> | null} */
    let harness = null;
    /** @type {import('node:child_process').ChildProcess | null} */
    let vitestChild = null;
    /** @type {NodeJS.Signals | null} */
    let receivedSignal = null;
    /** @type {Promise<void> | null} */
    let teardownPromise = null;
    let signalReraised = false;

    const removeSignalHandlers = () => {
        for (const candidate of SHUTDOWN_SIGNALS) {
            process.off(candidate, handleSignal);
        }
    };

    const finalizePendingSignal = () => {
        if (!receivedSignal || signalReraised) return false;
        signalReraised = true;
        removeSignalHandlers();
        reraiseSignal(receivedSignal);
        return true;
    };

    /** @param {NodeJS.Signals | null} signal */
    const teardown = (signal) => {
        if (signal && !receivedSignal) {
            receivedSignal = signal;
            abortController.abort();
        }
        if (teardownPromise) return teardownPromise;
        teardownPromise = (async () => {
            // Keep signal handlers installed while teardown runs so a second
            // signal (or a signal arriving during ordinary teardown) cannot
            // terminate the supervisor before child processes are reaped.
            const resolvedHarness = harness ?? (harnessPromise ? await harnessPromise.catch(() => null) : null);
            const results = await Promise.allSettled([
                vitestChild ? killSpawnedProcessTree(vitestChild, 1_500) : Promise.resolve(),
                resolvedHarness ? resolvedHarness.stop() : Promise.resolve(),
            ]);
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected && !receivedSignal) {
                throw rejected.reason;
            }
        })();
        return teardownPromise;
    };

    /** @param {NodeJS.Signals} signal */
    const handleSignal = (signal) => {
        void teardown(signal).catch(() => {}).finally(() => {
            finalizePendingSignal();
        });
    };
    for (const signal of SHUTDOWN_SIGNALS) {
        process.on(signal, handleSignal);
    }

    try {
        harnessPromise = startBrowserIntegrationHarness({
            abortSignal: abortController.signal,
            launchChromiumServer: true,
        });
        harness = await harnessPromise;
        if (receivedSignal) {
            await teardown(receivedSignal).catch(() => {});
            finalizePendingSignal();
            return;
        }
        vitestChild = spawn(process.execPath, [
            fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
            'run',
            '--project',
            'browser-integration',
            ...args,
        ], {
            stdio: 'inherit',
            env: {
                ...process.env,
                [BROWSER_ORIGIN_ENV]: harness.origin,
                [BROWSER_SERVER_OUTPUT_PATH_ENV]: harness.outputPath,
                [BROWSER_WS_ENDPOINT_ENV]: /** @type {string} */ (harness.wsEndpoint),
            },
        });
        const [
            exitCode,
            exitSignal,
        ] = await once(vitestChild, 'close');
        await teardown(null);
        if (finalizePendingSignal()) return;
        removeSignalHandlers();
        process.exitCode = exitCode ?? (exitSignal ? 1 : 1);
    } catch (error) {
        if (receivedSignal) {
            await teardown(receivedSignal).catch(() => {});
            finalizePendingSignal();
            return;
        }
        await teardown(null);
        if (finalizePendingSignal()) return;
        removeSignalHandlers();
        throw error;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await runSupervisedCli();
}

/** @param {{provide: (key: string, value: string) => void}} project */
export async function setup(project) {
    const supervisedOrigin = process.env[BROWSER_ORIGIN_ENV]?.trim();
    const supervisedOutputPath = process.env[BROWSER_SERVER_OUTPUT_PATH_ENV]?.trim();
    const supervisedWsEndpoint = process.env[BROWSER_WS_ENDPOINT_ENV]?.trim();
    if (supervisedOrigin && supervisedOutputPath && supervisedWsEndpoint) {
        project.provide('browserIntegrationOrigin', supervisedOrigin);
        project.provide('browserIntegrationServerOutputPath', supervisedOutputPath);
        return () => {};
    }

    // Direct Vitest invocations (e.g. Nightly Firefox/WebKit or single-spec runs)
    // do not launch a shared Chromium server; ordinary Chromium specs fall back to
    // local `chromium.launch()`. Install a SIGHUP handler before startup because
    // Vitest only traps SIGINT/SIGTERM and default SIGHUP bypasses Node's `exit` hook.
    const abortController = new AbortController();
    /** @type {Promise<Awaited<ReturnType<typeof startBrowserIntegrationHarness>>> | null} */
    let harnessPromise = null;
    /** @type {Awaited<ReturnType<typeof startBrowserIntegrationHarness>> | null} */
    let harness = null;
    let sighupReceived = false;
    let sighupReraised = false;
    /** @type {Promise<void> | null} */
    let stopDirectPromise = null;

    const stopDirect = () => {
        if (stopDirectPromise) return stopDirectPromise;
        stopDirectPromise = (async () => {
            const resolvedHarness = harness ?? (harnessPromise ? await harnessPromise.catch(() => null) : null);
            if (resolvedHarness) {
                await resolvedHarness.stop();
            }
        })();
        return stopDirectPromise;
    };

    const finalizeSighup = () => {
        if (!sighupReceived || sighupReraised) return false;
        sighupReraised = true;
        process.off('SIGHUP', handleSighup);
        reraiseSignal('SIGHUP');
        return true;
    };

    const handleSighup = () => {
        sighupReceived = true;
        abortController.abort();
        void stopDirect().catch(() => {}).finally(() => {
            finalizeSighup();
        });
    };
    process.on('SIGHUP', handleSighup);

    try {
        harnessPromise = startBrowserIntegrationHarness({
            abortSignal: abortController.signal,
            launchChromiumServer: false,
        });
        harness = await harnessPromise;
        if (sighupReceived) {
            await stopDirect().catch(() => {});
            finalizeSighup();
            return () => {};
        }
        project.provide('browserIntegrationOrigin', harness.origin);
        project.provide('browserIntegrationServerOutputPath', harness.outputPath);
        return async () => {
            try {
                await stopDirect();
            } finally {
                if (!finalizeSighup()) {
                    process.off('SIGHUP', handleSighup);
                }
            }
        };
    } catch (error) {
        if (sighupReceived) {
            await stopDirect().catch(() => {});
            finalizeSighup();
            return () => {};
        }
        process.off('SIGHUP', handleSighup);
        throw error;
    }
}
