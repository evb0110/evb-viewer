import {
    execFileSync,
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
const SHUTDOWN_SIGNALS = process.platform === 'win32'
    ? [
        'SIGINT',
        'SIGTERM',
        'SIGHUP',
    ]
    : [
        'SIGINT',
        'SIGTERM',
        'SIGHUP',
        'SIGQUIT',
    ];

/** @type {readonly NodeJS.Signals[]} */
const DIRECT_SHUTDOWN_SIGNALS = process.platform === 'win32'
    ? ['SIGHUP']
    : [
        'SIGHUP',
        'SIGQUIT',
    ];

/**
 * @typedef {{
 *   collectDescendantPidsUnix: (rootPid: number) => number[],
 *   findFreePort: () => Promise<number>,
 *   isProcessAlive: (rootPid: number) => boolean,
 *   killPids: (pids: number[], options?: { signal?: NodeJS.Signals | number }) => void,
 *   killProcessTree: (pid: number, graceMs?: number, options?: { force?: boolean }) => Promise<boolean>,
 * }} IProcessTreeHelper
 */

/** @param {number} pgid */
function isProcessGroupPresentUnix(pgid) {
    if (process.platform === 'win32' || !Number.isFinite(pgid) || pgid <= 0 || pgid === process.pid) return false;
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (error) {
        return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM';
    }
}

/**
 * @param {number} pgid
 * @returns {{ ok: boolean, pids: number[] }}
 */
function collectLiveProcessGroupPidsUnix(pgid) {
    if (process.platform === 'win32' || !Number.isFinite(pgid) || pgid <= 0) {
        return {
            ok: true,
            pids: [],
        };
    }
    try {
        const output = execFileSync('ps', [
            '-eo',
            'pid=,pgid=,stat=',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        /** @type {number[]} */
        const pids = [];
        for (const line of output.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/u);
            if (!match) continue;
            const pid = Number(match[1]);
            const group = Number(match[2]);
            const stat = match[3] ?? '';
            if (group !== pgid || !Number.isFinite(pid) || pid <= 0) continue;
            if (stat.startsWith('Z') || stat.startsWith('X')) continue;
            pids.push(pid);
        }
        return {
            ok: true,
            pids,
        };
    } catch {
        return {
            ok: false,
            pids: [],
        };
    }
}

/**
 * @param {number} pgid
 * @returns {{ alive: boolean, verified: boolean, pids: number[] }}
 */
function inspectProcessGroupUnix(pgid) {
    if (process.platform === 'win32' || !Number.isFinite(pgid) || pgid <= 0 || pgid === process.pid) {
        return {
            alive: false,
            verified: true,
            pids: [],
        };
    }
    if (!isProcessGroupPresentUnix(pgid)) {
        return {
            alive: false,
            verified: true,
            pids: [],
        };
    }
    const scan = collectLiveProcessGroupPidsUnix(pgid);
    if (!scan.ok) {
        return {
            alive: true,
            verified: false,
            pids: [],
        };
    }
    return {
        alive: scan.pids.length > 0,
        verified: true,
        pids: scan.pids,
    };
}

/**
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 */
function killProcessGroupUnix(pgid, signal) {
    if (process.platform === 'win32' || !Number.isFinite(pgid) || pgid <= 0 || pgid === process.pid) return;
    try {
        process.kill(-pgid, signal);
    } catch {}
}

/**
 * @typedef {{
 *   pid: number,
 *   isRootRunning: () => boolean,
 *   hasActiveGroup: () => boolean,
 *   markGroupCleared: () => void,
 * }} ITrackedProcess
 */

/**
 * Tracks a child process spawned in its own POSIX process group without
 * retaining stale bare descendant PIDs that could later be recycled by the OS.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {IProcessTreeHelper} processTree
 * @returns {ITrackedProcess | null}
 */
function createTrackedProcess(child, processTree) {
    const pid = child.pid;
    if (!pid || !Number.isFinite(pid) || pid <= 0) return null;
    let exited = child.exitCode !== null || child.signalCode !== null;
    let groupCleared = false;
    const syncGroupCleared = () => {
        if (!exited) return;
        if (process.platform === 'win32' || !isProcessGroupPresentUnix(pid)) {
            groupCleared = true;
        }
    };
    if (exited) {
        syncGroupCleared();
    } else {
        child.once('exit', () => {
            exited = true;
            syncGroupCleared();
        });
    }
    return {
        pid,
        isRootRunning: () => !exited && processTree.isProcessAlive(pid),
        hasActiveGroup: () => {
            if (process.platform === 'win32' || groupCleared) return false;
            if (exited && !isProcessGroupPresentUnix(pid)) {
                groupCleared = true;
                return false;
            }
            return true;
        },
        markGroupCleared: () => {
            if (exited) {
                groupCleared = true;
            }
        },
    };
}

/**
 * @param {Iterable<ITrackedProcess | null | undefined>} targets
 * @param {IProcessTreeHelper} processTree
 */
function forceKillTrackedProcessesSync(targets, processTree) {
    /** @type {Set<number>} */
    const liveRoots = new Set();
    /** @type {Set<number>} */
    const activeGroups = new Set();
    /** @type {ITrackedProcess[]} */
    const trackedList = [];
    for (const target of targets) {
        if (!target) continue;
        trackedList.push(target);
        if (target.isRootRunning()) {
            liveRoots.add(target.pid);
        }
        if (target.hasActiveGroup()) {
            activeGroups.add(target.pid);
        }
    }

    if (process.platform === 'win32') {
        for (const pid of liveRoots) {
            spawnSync('taskkill', [
                '/PID',
                String(pid),
                '/T',
                '/F',
            ], { stdio: 'ignore' });
        }
        return;
    }

    for (const pgid of activeGroups) {
        killProcessGroupUnix(pgid, 'SIGKILL');
    }
    if (liveRoots.size > 0) {
        /** @type {Set<number>} */
        const expanded = new Set(liveRoots);
        for (const pid of liveRoots) {
            for (const descendant of processTree.collectDescendantPidsUnix(pid)) {
                expanded.add(descendant);
            }
        }
        processTree.killPids([...expanded], { signal: 'SIGKILL' });
    }
    for (const target of trackedList) {
        if (!target.isRootRunning() && !isProcessGroupPresentUnix(target.pid)) {
            target.markGroupCleared();
        }
    }
}

/**
 * @param {ITrackedProcess | null} target
 * @param {string} label
 * @param {IProcessTreeHelper} processTree
 */
async function terminateTrackedProcessTree(target, label, processTree) {
    if (!target) return;
    const rootWasRunning = target.isRootRunning();
    const terminated = rootWasRunning ? await processTree.killProcessTree(target.pid) : true;
    const checkRemaining = () => {
        const rootAlive = target.isRootRunning();
        const group = target.hasActiveGroup()
            ? inspectProcessGroupUnix(target.pid)
            : {
                alive: false,
                verified: true,
                pids: [],
            };
        if (!rootAlive && !group.alive && group.verified) {
            target.markGroupCleared();
        }
        return {
            group,
            rootAlive,
            hasRemaining: rootAlive || group.alive || !group.verified,
        };
    };

    if (target.hasActiveGroup()) {
        const initialGroup = inspectProcessGroupUnix(target.pid);
        if (initialGroup.alive || !initialGroup.verified) {
            killProcessGroupUnix(target.pid, 'SIGTERM');
            const graceDeadline = Date.now() + 1_500;
            while (Date.now() < graceDeadline) {
                const groupState = target.hasActiveGroup()
                    ? inspectProcessGroupUnix(target.pid)
                    : {
                        alive: false,
                        verified: true,
                        pids: [],
                    };
                if (!groupState.alive && groupState.verified) break;
                await new Promise(resolveWait => setTimeout(resolveWait, 80));
            }
        }
    }

    const afterGrace = checkRemaining();
    if (afterGrace.hasRemaining) {
        forceKillTrackedProcessesSync([target], processTree);
        const forceDeadline = Date.now() + 2_000;
        while (Date.now() < forceDeadline && checkRemaining().hasRemaining) {
            await new Promise(resolveWait => setTimeout(resolveWait, 80));
        }
    }

    const finalState = checkRemaining();
    if ((rootWasRunning && !terminated) || finalState.hasRemaining) {
        throw new Error(`The ${label} process tree did not exit`);
    }
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
    const { findFreePort } = processTree;

    const port = await findFreePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const sessionName = `browser-lifecycle-${process.pid}`;
    const outputPath = resolve('.devkit', `${sessionName}.log`);
    mkdirSync(resolve('.devkit'), { recursive: true });

    /** @type {Promise<import('playwright').BrowserServer | null> | null} */
    let browserServerPromise = null;
    /** @type {ITrackedProcess | null} */
    let trackedBrowser = null;
    let serverOutput = '';
    // Give Nuxt its own POSIX process group so descendants remain targetable
    // even if the Nuxt leader exits before teardown and workers reparent.
    const devServer = spawn(process.execPath, [
        resolve(process.cwd(), 'node_modules/nuxt/bin/nuxt.mjs'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        detached: process.platform !== 'win32',
        env: buildNuxtDevServerEnv({
            ...process.env,
            // Match Vitest's globalSetup environment so Nuxt sets `import.meta.test = true`
            // (disabling the dev-error-overlay HMR client plugin on Playwright-routed pages).
            TEST: process.env.TEST ?? 'true',
            VITEST: process.env.VITEST ?? 'true',
            SENTRY_BROWSER_DSN: `http://consenttest@127.0.0.1:${String(port)}/1`,
        }, port, sessionName),
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    const trackedDevServer = createTrackedProcess(devServer, processTree);
    /** @param {Buffer} chunk */
    const captureOutput = (chunk) => {
        serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
        writeFileSync(outputPath, serverOutput);
    };
    devServer.stdout.on('data', captureOutput);
    devServer.stderr.on('data', captureOutput);

    // Synchronous fallback for abrupt process.exit() or rejected async teardown.
    // Targets only live unreaped roots and currently owned POSIX process groups
    // so reparented descendants are killed without ever signaling recycled PIDs.
    const forceKillOnExit = () => {
        forceKillTrackedProcessesSync([
            trackedBrowser,
            trackedDevServer,
        ], processTree);
        rmSync(outputPath, { force: true });
    };
    process.on('exit', forceKillOnExit);

    const stopBrowserServer = async () => {
        if (!browserServerPromise) return;
        const activeServer = await browserServerPromise.catch(() => null);
        browserServerPromise = null;
        if (!activeServer) return;
        const browserProc = activeServer.process();
        if (!trackedBrowser && browserProc) {
            trackedBrowser = createTrackedProcess(browserProc, processTree);
        }
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
        await terminateTrackedProcessTree(
            trackedBrowser,
            'browser integration Chromium server',
            processTree,
        );
        trackedBrowser = null;
    };

    const stopDevServer = async () => {
        try {
            await terminateTrackedProcessTree(
                trackedDevServer,
                'browser lifecycle Nuxt',
                processTree,
            );
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
            if (rejected) {
                forceKillOnExit();
                process.off('exit', forceKillOnExit);
                throw rejected.reason;
            }
            process.off('exit', forceKillOnExit);
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
                const browserProc = server.process();
                if (browserProc) {
                    trackedBrowser = createTrackedProcess(browserProc, processTree);
                }
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
            forceStop: forceKillOnExit,
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
    const processTree = await tsImport('./electron-run/electronRunProcessTree.ts', import.meta.url);

    const abortController = new AbortController();
    /** @type {Promise<Awaited<ReturnType<typeof startBrowserIntegrationHarness>>> | null} */
    let harnessPromise = null;
    /** @type {Awaited<ReturnType<typeof startBrowserIntegrationHarness>> | null} */
    let harness = null;
    /** @type {import('node:child_process').ChildProcess | null} */
    let vitestChild = null;
    /** @type {ITrackedProcess | null} */
    let trackedVitest = null;
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

    const stopVitestChild = async () => {
        await terminateTrackedProcessTree(
            trackedVitest,
            'Vitest browser integration',
            processTree,
        );
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
                stopVitestChild(),
                resolvedHarness ? resolvedHarness.stop() : Promise.resolve(),
            ]);
            const rejected = results.find(result => result.status === 'rejected');
            if (rejected) {
                forceKillTrackedProcessesSync([trackedVitest], processTree);
                resolvedHarness?.forceStop();
                if (!receivedSignal) {
                    throw rejected.reason;
                }
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
            detached: process.platform !== 'win32',
            stdio: [
                'ignore',
                'inherit',
                'inherit',
            ],
            env: {
                ...process.env,
                [BROWSER_ORIGIN_ENV]: harness.origin,
                [BROWSER_SERVER_OUTPUT_PATH_ENV]: harness.outputPath,
                [BROWSER_WS_ENDPOINT_ENV]: /** @type {string} */ (harness.wsEndpoint),
            },
        });
        trackedVitest = createTrackedProcess(vitestChild, processTree);
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
    // local `chromium.launch()`. Install SIGHUP/SIGQUIT handlers before startup
    // because Vitest only traps SIGINT/SIGTERM and default SIGHUP/SIGQUIT bypass
    // Node's `exit` hook while leaving the detached Nuxt process group alive.
    const abortController = new AbortController();
    /** @type {Promise<Awaited<ReturnType<typeof startBrowserIntegrationHarness>>> | null} */
    let harnessPromise = null;
    /** @type {Awaited<ReturnType<typeof startBrowserIntegrationHarness>> | null} */
    let harness = null;
    /** @type {NodeJS.Signals | null} */
    let receivedDirectSignal = null;
    let directSignalReraised = false;
    /** @type {Promise<void> | null} */
    let stopDirectPromise = null;

    const stopDirect = () => {
        if (stopDirectPromise) return stopDirectPromise;
        stopDirectPromise = (async () => {
            const resolvedHarness = harness ?? (harnessPromise ? await harnessPromise.catch(() => null) : null);
            if (resolvedHarness) {
                try {
                    await resolvedHarness.stop();
                } catch (error) {
                    resolvedHarness.forceStop();
                    throw error;
                }
            }
        })();
        return stopDirectPromise;
    };

    const removeDirectSignalHandlers = () => {
        for (const signal of DIRECT_SHUTDOWN_SIGNALS) {
            process.off(signal, handleDirectSignal);
        }
    };

    const finalizeDirectSignal = () => {
        if (!receivedDirectSignal || directSignalReraised) return false;
        directSignalReraised = true;
        removeDirectSignalHandlers();
        reraiseSignal(receivedDirectSignal);
        return true;
    };

    /** @param {NodeJS.Signals} signal */
    const handleDirectSignal = (signal) => {
        if (!receivedDirectSignal) {
            receivedDirectSignal = signal;
            abortController.abort();
        }
        void stopDirect().catch(() => {}).finally(() => {
            finalizeDirectSignal();
        });
    };
    for (const signal of DIRECT_SHUTDOWN_SIGNALS) {
        process.on(signal, handleDirectSignal);
    }

    try {
        harnessPromise = startBrowserIntegrationHarness({
            abortSignal: abortController.signal,
            launchChromiumServer: false,
        });
        harness = await harnessPromise;
        if (receivedDirectSignal) {
            await stopDirect().catch(() => {});
            finalizeDirectSignal();
            return () => {};
        }
        project.provide('browserIntegrationOrigin', harness.origin);
        project.provide('browserIntegrationServerOutputPath', harness.outputPath);
        return async () => {
            try {
                await stopDirect();
            } finally {
                if (!finalizeDirectSignal()) {
                    removeDirectSignalHandlers();
                }
            }
        };
    } catch (error) {
        if (receivedDirectSignal) {
            await stopDirect().catch(() => {});
            finalizeDirectSignal();
            return () => {};
        }
        removeDirectSignalHandlers();
        throw error;
    }
}
