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
 * @param {number} pid
 * @param {IProcessTreeHelper} processTree
 * @param {Set<number>} knownPids
 * @param {boolean} hasDedicatedGroup
 */
function recordProcessTreePids(pid, processTree, knownPids, hasDedicatedGroup) {
    knownPids.add(pid);
    if (process.platform === 'win32') return;
    for (const descendant of processTree.collectDescendantPidsUnix(pid)) {
        knownPids.add(descendant);
    }
    if (hasDedicatedGroup) {
        const scan = collectLiveProcessGroupPidsUnix(pid);
        for (const member of scan.pids) {
            knownPids.add(member);
        }
    }
}

/**
 * @param {Iterable<number>} pids
 * @param {Iterable<number>} processGroups
 * @param {IProcessTreeHelper} processTree
 */
function forceKillTargetsSync(pids, processGroups, processTree) {
    const groupSet = new Set([...processGroups].filter(pgid => Number.isFinite(pgid) && pgid > 0));
    const expanded = new Set([...pids].filter(pid => Number.isFinite(pid) && pid > 0));
    if (process.platform !== 'win32') {
        for (const pgid of groupSet) {
            const scan = collectLiveProcessGroupPidsUnix(pgid);
            for (const member of scan.pids) {
                expanded.add(member);
            }
            killProcessGroupUnix(pgid, 'SIGKILL');
        }
    }
    const alive = [...expanded].filter(pid => processTree.isProcessAlive(pid));
    if (alive.length === 0) return;
    if (process.platform === 'win32') {
        for (const pid of alive) {
            spawnSync('taskkill', [
                '/PID',
                String(pid),
                '/T',
                '/F',
            ], { stdio: 'ignore' });
        }
        return;
    }
    for (const pid of alive) {
        for (const descendant of processTree.collectDescendantPidsUnix(pid)) {
            expanded.add(descendant);
        }
    }
    processTree.killPids([...expanded], { signal: 'SIGKILL' });
}

/**
 * @param {number} pid
 * @param {string} label
 * @param {IProcessTreeHelper} processTree
 * @param {Set<number>} knownPids
 * @param {{ hasDedicatedGroup: boolean }} options
 */
async function terminateTrackedProcessTree(pid, label, processTree, knownPids, { hasDedicatedGroup }) {
    recordProcessTreePids(pid, processTree, knownPids, hasDedicatedGroup);
    const rootWasAlive = processTree.isProcessAlive(pid);
    const terminated = rootWasAlive ? await processTree.killProcessTree(pid) : true;
    const checkRemaining = () => {
        const current = new Set(knownPids);
        const group = hasDedicatedGroup && process.platform !== 'win32'
            ? inspectProcessGroupUnix(pid)
            : {
                alive: false,
                verified: true,
                pids: [],
            };
        for (const member of group.pids) {
            knownPids.add(member);
            current.add(member);
        }
        const survivors = [...current].filter(targetPid => processTree.isProcessAlive(targetPid));
        return {
            group,
            survivors,
            hasRemaining: survivors.length > 0 || group.alive || !group.verified,
        };
    };

    if (hasDedicatedGroup && process.platform !== 'win32' && isProcessGroupPresentUnix(pid)) {
        const initialGroup = inspectProcessGroupUnix(pid);
        if (initialGroup.alive || !initialGroup.verified) {
            killProcessGroupUnix(pid, 'SIGTERM');
            const graceDeadline = Date.now() + 1_500;
            while (Date.now() < graceDeadline) {
                const groupState = inspectProcessGroupUnix(pid);
                if (!groupState.alive && groupState.verified) break;
                await new Promise(resolveWait => setTimeout(resolveWait, 80));
            }
        }
    }

    const afterGrace = checkRemaining();
    if (afterGrace.hasRemaining) {
        forceKillTargetsSync(afterGrace.survivors, hasDedicatedGroup ? [pid] : [], processTree);
        const forceDeadline = Date.now() + 2_000;
        while (Date.now() < forceDeadline && checkRemaining().hasRemaining) {
            await new Promise(resolveWait => setTimeout(resolveWait, 80));
        }
    }

    const finalState = checkRemaining();
    if ((rootWasAlive && !terminated) || finalState.hasRemaining) {
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
    /** @type {number | null} */
    let browserPid = null;
    /** @type {Set<number>} */
    const browserKnownPids = new Set();
    /** @type {Set<number>} */
    const devServerKnownPids = new Set();
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

    // Synchronous fallback for abrupt process.exit() or rejected async teardown.
    // Targets both roots, recorded descendants, and dedicated POSIX process groups
    // so reparented descendants are still killed even if a leader exited early.
    const forceKillOnExit = () => {
        const allPids = new Set([
            ...browserKnownPids,
            ...devServerKnownPids,
        ]);
        /** @type {number[]} */
        const processGroups = [];
        if (browserPid) {
            processGroups.push(browserPid);
            recordProcessTreePids(browserPid, processTree, allPids, true);
        }
        if (devServer.pid) {
            processGroups.push(devServer.pid);
            recordProcessTreePids(devServer.pid, processTree, allPids, true);
        }
        forceKillTargetsSync(allPids, processGroups, processTree);
        rmSync(outputPath, { force: true });
    };
    process.on('exit', forceKillOnExit);

    const stopBrowserServer = async () => {
        if (!browserServerPromise) return;
        const activeServer = await browserServerPromise.catch(() => null);
        browserServerPromise = null;
        if (!activeServer) return;
        const pid = activeServer.process()?.pid ?? browserPid;
        if (pid) recordProcessTreePids(pid, processTree, browserKnownPids, true);
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
        if (pid) {
            await terminateTrackedProcessTree(
                pid,
                'browser integration Chromium server',
                processTree,
                browserKnownPids,
                { hasDedicatedGroup: true },
            );
        }
        browserPid = null;
    };

    const stopDevServer = async () => {
        try {
            if (!devServer.pid) return;
            await terminateTrackedProcessTree(
                devServer.pid,
                'browser lifecycle Nuxt',
                processTree,
                devServerKnownPids,
                { hasDedicatedGroup: true },
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
                browserPid = server.process()?.pid ?? null;
                if (browserPid) recordProcessTreePids(browserPid, processTree, browserKnownPids, true);
                return server;
            });
            // Prevent unhandled rejection if devServer startup fails before we await browserServerPromise.
            browserServerPromise.catch(() => {});
        }
        await once(devServer, 'spawn');
        if (devServer.pid) recordProcessTreePids(devServer.pid, processTree, devServerKnownPids, true);
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
    /** @type {Set<number>} */
    const vitestKnownPids = new Set();
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
        if (!vitestChild?.pid) return;
        await terminateTrackedProcessTree(
            vitestChild.pid,
            'Vitest browser integration',
            processTree,
            vitestKnownPids,
            { hasDedicatedGroup: true },
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
                if (vitestChild?.pid) recordProcessTreePids(vitestChild.pid, processTree, vitestKnownPids, true);
                forceKillTargetsSync(vitestKnownPids, vitestChild?.pid ? [vitestChild.pid] : [], processTree);
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
        if (vitestChild.pid) recordProcessTreePids(vitestChild.pid, processTree, vitestKnownPids, true);
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
