import { getErrorMessage } from '@contracts/getErrorMessage';
import { ensurePdfjsDevInstall } from '@scripts/ensure-pdfjs-dev-install.mjs';
import {
    execFileSync,
    spawn,
    type ChildProcess,
} from 'node:child_process';
import { rmSync } from 'node:fs';
import {
    basename,
    isAbsolute,
    join,
    parse,
    relative,
    resolve,
} from 'node:path';
import { delay } from 'es-toolkit/promise';
import {
    buildNuxtDevServerEnv,
    resolveNuxtDevServerArtifactDirs,
} from '@scripts/electron-run/electronRunLaunchConfig';
import { getActiveDevServerOutputTee } from '@scripts/electron-run/devServerOutputTee';
import { isReusableNuxtResponse } from '@scripts/electron-run/isReusableNuxtResponse';
import {
    DEFAULT_NUXT_PORT,
    getNuxtPort,
    setNuxtPort,
} from '@scripts/electron-run/electronRunPortConfig';
import {
    collectDescendantPidsUnix,
    findFreePort,
    isProcessAlive,
    killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import { createStartupLogger } from '@scripts/electron-run/createStartupLogger';
import {
    isVerifiedSessionProcess,
    killVerifiedSessionProcess,
    type ISessionProcessIdentityExpectation,
} from '@scripts/electron-run/electronRunProcessIdentity';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    classifySessionControllerOwnership,
    getSessionInfo,
    getSessionStartingInfo,
    listAllSessionNames,
    registerNuxtOwnerProbe,
    type IClassifySessionControllerOwnershipOptions,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import { getCurrentSessionName } from '@scripts/electron-run/electronRunSessionPaths';
import {
    shouldRequireNuxtWarmup,
    shouldUseStrictE2EIsolation,
} from '@scripts/electron-run/electronRunRunId';

export const ELECTRON_SERVER_PATH = '/electron';

const PNPM_COMMAND = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const NUXT_HTTP_READINESS_TIMEOUT_MS = 1000;
const NUXT_DEPENDENCY_WARMUP_TIMEOUT_MS = 30_000;
const NUXT_DEPENDENCY_WARMUP_REQUEST_TIMEOUT_MS = 2_000;
const NUXT_DEPENDENCY_WARMUP_STABLE_POLLS = 2;
const NUXT_DEPENDENCY_WARMUP_POLL_INTERVAL_MS = 500;
const DYNAMIC_IMPORT_FAILURE_MARKER = 'Failed to fetch dynamically imported module';

export interface INuxtListenerProbeResult {
    ok: boolean;
    pids: number[];
}

function hasChildProcessExitStatus(error: unknown, status: number) {
    return typeof error === 'object'
        && error !== null
        && 'status' in error
        && error.status === status;
}

/**
 * Port ownership is only useful for finding a server candidate. `lsof -ti
 * :port` also reports connected clients, so every port query in this module
 * must use the listener state filter.
 */
export function probeNuxtListenersOnPort(port: number): INuxtListenerProbeResult {
    if (!Number.isInteger(port) || port <= 0 || process.platform === 'win32') {
        return {
            ok: false,
            pids: [],
        };
    }

    try {
        const output = execFileSync('lsof', [
            '-nP',
            '-a',
            `-iTCP:${String(port)}`,
            '-sTCP:LISTEN',
            '-t',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        return {
            ok: true,
            pids: output
                .split('\n')
                .map(entry => Number(entry.trim()))
                .filter(pid => Number.isInteger(pid) && pid > 0),
        };
    } catch (error) {
        // lsof exits with status 1 when the valid query found no matching
        // listener. A missing tool or another probe error must fail closed.
        return {
            ok: hasChildProcessExitStatus(error, 1),
            pids: [],
        };
    }
}

function getNuxtListenerPidsOnPort(port: number) {
    return probeNuxtListenersOnPort(port).pids;
}

function getDescendantPids(rootPid: number) {
    if (!Number.isFinite(rootPid) || rootPid <= 0 || process.platform === 'win32') {
        return [] as number[];
    }

    return collectDescendantPidsUnix(rootPid);
}

export function getElectronAppUrl() {
    return `http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`;
}

export async function checkNuxtHttpReadiness(options: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
} = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? NUXT_HTTP_READINESS_TIMEOUT_MS;
    try {
        const res = await fetchImpl(getElectronAppUrl(), {
            method: 'GET',
            signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
    } catch {
        return false;
    }
}

async function isReusableNuxtServerReady() {
    return isReusableNuxtServer();
}

async function isReusableNuxtServer() {
    try {
        const res = await fetch(`http://127.0.0.1:${getNuxtPort()}${ELECTRON_SERVER_PATH}`, {
            method: 'GET',
            signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) {
            return false;
        }
        const poweredBy = res.headers.get('x-powered-by')?.toLowerCase() ?? '';
        const text = await res.text();
        return isReusableNuxtResponse({
            poweredBy,
            body: text,
        });
    } catch {
        return false;
    }
}

export async function waitForReusableNuxtServer(timeoutMs: number) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isReusableNuxtServer()) {
            return true;
        }
        await delay(250);
    }
    return false;
}

export async function killExistingNuxt() {
    try {
        return await cleanupOrphanedProjectNuxtRoots('stop-all final cleanup');
    } catch {
        console.warn(
            '[Nuxt] Refused final cleanup: owned-process inspection failed; no process was signaled.',
        );
        return false;
    }
}

export function resolveNuxtForceCleanCachePaths(
    rootDir = projectRoot,
    artifactDirs = resolveNuxtDevServerArtifactDirs(),
) {
    if (!artifactDirs) {
        return [
            join(rootDir, 'node_modules', '.vite'),
            join(rootDir, 'node_modules', '.cache', 'vite'),
            join(rootDir, '.nuxt'),
        ];
    }

    const resolvedRoot = resolve(rootDir);
    const artifactPaths: Array<readonly [string, string]> = [
        [
            artifactDirs.buildDir,
            'nuxt-build',
        ],
        [
            artifactDirs.outputDir,
            'nuxt-output',
        ],
        [
            artifactDirs.viteCacheDir,
            'vite-cache',
        ],
    ];
    return artifactPaths.map(([
        artifactDir,
        expectedBasename,
    ]) => {
        if (!isAbsolute(artifactDir)) {
            throw new Error(`Nuxt artifact cleanup path must be absolute: ${artifactDir}`);
        }
        const resolvedArtifactDir = resolve(artifactDir);
        const rootRelativeToArtifact = relative(resolvedArtifactDir, resolvedRoot);
        if (
            resolvedArtifactDir === parse(resolvedArtifactDir).root
            || resolvedArtifactDir === resolvedRoot
            || !rootRelativeToArtifact.startsWith('..')
            || basename(resolvedArtifactDir) !== expectedBasename
        ) {
            throw new Error(`Refusing unsafe Nuxt artifact cleanup path: ${artifactDir}`);
        }
        return resolvedArtifactDir;
    });
}

function clearViteCache() {
    for (const cachePath of resolveNuxtForceCleanCachePaths()) {
        try {
            rmSync(cachePath, {
                recursive: true,
                force: true,
            });
            console.log(`[Cache] Cleared ${cachePath.replace(projectRoot + '/', '')}`);
        } catch {}
    }
}

async function cleanupStaleNuxtPortOwners(reason: string) {
    const nuxtPort = getNuxtPort();
    const listenerProbe = probeNuxtListenersOnPort(nuxtPort);
    if (!listenerProbe.ok) {
        console.warn(
            `[Nuxt] Refused stale cleanup on port ${nuxtPort} (${reason}): listener inspection failed; no process was signaled.`,
        );
        return false;
    }
    const pidsOnPort = listenerProbe.pids;
    if (pidsOnPort.length === 0) {
        return false;
    }

    const sessionMetadata: INuxtPortOwnerSessionMetadata[] = [];
    for (const name of listAllSessionNames()) {
        const info = getSessionInfo(name);
        const starting = getSessionStartingInfo(name);
        const ownershipOptions: IClassifySessionControllerOwnershipOptions = {};
        if (info) {
            ownershipOptions.info = info;
        }
        if (starting) {
            ownershipOptions.starting = starting;
        }
        const ownership = classifySessionControllerOwnership(name, ownershipOptions);
        const sessionAlive = ownership.status !== 'abandoned';
        for (const owner of [
            info
                ? {
                    sessionPid: info.pid,
                    nuxtPid: info.nuxtPid ?? null,
                    nuxtPort: info.nuxtPort,
                }
                : null,
            starting
                ? {
                    sessionPid: starting.pid,
                    nuxtPid: starting.nuxtPid ?? null,
                    nuxtPort: starting.nuxtPort ?? 0,
                }
                : null,
        ]) {
            if (!owner) {
                continue;
            }
            const nuxtAlive = Boolean(owner.nuxtPid && isProcessAlive(owner.nuxtPid));
            sessionMetadata.push({
                name,
                sessionPid: owner.sessionPid,
                nuxtPid: owner.nuxtPid,
                nuxtPort: owner.nuxtPort,
                sessionAlive,
                nuxtAlive,
                descendantPids: nuxtAlive && owner.nuxtPid ? getDescendantPids(owner.nuxtPid) : [],
            });
        }
    }

    const staleNuxtPids = selectStaleNuxtPortOwnerCleanupTargets(
        pidsOnPort,
        sessionMetadata,
        nuxtPort,
    );
    if (staleNuxtPids.length === 0) {
        return false;
    }

    console.log(`[Nuxt] Cleaning stale session-owned Nuxt process(es) on port ${nuxtPort} (${reason}): ${staleNuxtPids.join(', ')}`);
    for (const staleNuxtPid of staleNuxtPids) {
        const owner = sessionMetadata.find(session => session.nuxtPid === staleNuxtPid);
        if (!owner) {
            continue;
        }
        const currentOwnership = classifySessionControllerOwnership(owner.name);
        if (currentOwnership.status !== 'abandoned') {
            continue;
        }
        const currentListenerProbe = probeNuxtListenersOnPort(nuxtPort);
        if (!currentListenerProbe.ok || !currentListenerProbe.pids.includes(staleNuxtPid)) {
            continue;
        }
        if (hasOtherAliveSessionUsingNuxt(
            readNuxtSessionShareMetadata(),
            owner.name,
            staleNuxtPid,
            nuxtPort,
        )) {
            continue;
        }
        await killVerifiedSessionProcess({
            pid: staleNuxtPid,
            expectation: {
                kind: 'nuxt',
                sessionName: owner.name,
                nuxtPort,
            },
            graceMs: 1200,
        });
    }
    await delay(500);
    return true;
}

interface IProcessListEntry {
    pid: number;
    ppid: number;
    command: string;
}

function listUnixProcesses(): IProcessListEntry[] {
    if (process.platform === 'win32') {
        return [];
    }

    try {
        const output = execFileSync('ps', [
            '-ax',
            '-o',
            'pid=,ppid=,command=',
        ], {encoding: 'utf8'});
        const processes: IProcessListEntry[] = [];
        for (const line of output.split('\n')) {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const pid = Number(match[1]);
            const ppid = Number(match[2]);
            const command = match[3] ?? '';
            if (Number.isFinite(pid) && Number.isFinite(ppid) && pid > 0 && ppid > 0) {
                processes.push({
                    pid,
                    ppid,
                    command,
                });
            }
        }
        return processes;
    } catch {
        return [];
    }
}

function getProcessCwd(pid: number) {
    if (process.platform === 'win32') {
        return null;
    }

    try {
        const output = execFileSync('lsof', [
            '-a',
            '-p',
            String(pid),
            '-d',
            'cwd',
            '-Fn',
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        });
        const cwdLine = output.split('\n').find(line => line.startsWith('n'));
        return cwdLine ? cwdLine.slice(1) : null;
    } catch {
        return null;
    }
}

function getProcessEnvValue(pid: number, name: string) {
    if (process.platform === 'win32') {
        return null;
    }

    try {
        const output = execFileSync('ps', [
            'eww',
            '-p',
            String(pid),
            '-o',
            'command=',
        ], {encoding: 'utf8'});
        const prefix = `${name}=`;
        const token = output.split(/\s+/).find(part => part.startsWith(prefix));
        return token ? token.slice(prefix.length) : null;
    } catch {
        return null;
    }
}

function getProcessEnvPort(pid: number) {
    const port = Number(getProcessEnvValue(pid, 'PORT'));
    return Number.isInteger(port) && port > 0 ? port : null;
}

function isProjectNuxtRootProcess(processEntry: IProcessListEntry) {
    if (!processEntry.command.includes('pnpm run dev:nuxt')) {
        return false;
    }
    return getProcessCwd(processEntry.pid) === projectRoot;
}

function getProjectNuxtRootProcesses(): IProjectNuxtRootProcessMetadata[] {
    return listUnixProcesses()
        .filter(isProjectNuxtRootProcess)
        .map(processEntry => ({
            pid: processEntry.pid,
            ppid: processEntry.ppid,
            devServerPort: getProcessEnvPort(processEntry.pid),
            descendantPids: getDescendantPids(processEntry.pid),
        }));
}

export async function cleanupOrphanedProjectNuxtRoots(
    reason: string,
    options: IOrphanedNuxtCleanupOptions = {},
) {
    const roots = options.roots ?? getProjectNuxtRootProcesses();
    const probeListeners = options.probeListeners ?? probeNuxtListenersOnPort;
    const verifyIdentity = options.verifyIdentity ?? isVerifiedSessionProcess;
    const terminateRoot = options.terminateRoot ?? killVerifiedSessionProcess;
    if (roots.length === 0) {
        return false;
    }

    const preservedPort = getNuxtPort();
    const preservedPortProbe = probeListeners(preservedPort);
    if (!preservedPortProbe.ok) {
        console.warn(
            `[Nuxt] Refused orphan cleanup (${reason}): listener inspection failed on port ${preservedPort}; no process was signaled.`,
        );
        return false;
    }

    const listenerPidsByPort = new Map<number, INuxtListenerProbeResult>([[
        preservedPort,
        preservedPortProbe,
    ]]);
    const getListenerProbe = (port: number) => {
        const existing = listenerPidsByPort.get(port);
        if (existing) {
            return existing;
        }
        const probe = probeListeners(port);
        listenerPidsByPort.set(port, probe);
        return probe;
    };
    const eligibleRoots = roots.filter((root) => {
        if (!root.devServerPort) {
            console.warn(
                `[Nuxt] Refused orphan candidate PID ${root.pid} (${reason}): its launch port was not identifiable.`,
            );
            return false;
        }

        const listenerProbe = getListenerProbe(root.devServerPort);
        if (!listenerProbe.ok) {
            console.warn(
                `[Nuxt] Refused orphan candidate PID ${root.pid} (${reason}): listener inspection failed on port ${root.devServerPort}.`,
            );
            return false;
        }

        const ownedPids = new Set([
            root.pid,
            ...root.descendantPids,
        ]);
        if (!listenerProbe.pids.some(pid => ownedPids.has(pid))) {
            return false;
        }
        return true;
    });
    const targets = selectOrphanedProjectNuxtRootCleanupTargets(
        eligibleRoots,
        preservedPortProbe.pids,
        preservedPort,
    );
    if (targets.length === 0) {
        return false;
    }

    console.log(`[Nuxt] Cleaning orphaned project dev server root(s) (${reason}): ${targets.join(', ')}`);
    let terminated = 0;
    for (const target of targets) {
        const root = eligibleRoots.find(candidate => candidate.pid === target);
        const nuxtPort = root?.devServerPort;
        if (!root || !nuxtPort) {
            continue;
        }

        const expectation = {
            kind: 'nuxt' as const,
            sessionName: 'orphaned-project-root',
            nuxtPort,
        };
        if (!verifyIdentity(target, expectation)) {
            if (isProcessAlive(target)) {
                console.warn(
                    `[Nuxt] Refused orphan candidate PID ${target} (${reason}): process identity did not match at the signal boundary; retained.`,
                );
            }
            continue;
        }

        const didTerminate = await terminateRoot({
            pid: target,
            expectation,
            graceMs: 1200,
        });
        if (didTerminate) {
            terminated += 1;
        } else if (isProcessAlive(target)) {
            console.warn(
                `[Nuxt] Refused orphan candidate PID ${target} (${reason}): identity changed or the process outlived termination; retained.`,
            );
        }
    }
    if (terminated > 0) {
        await delay(500);
    }
    return terminated > 0;
}

interface INuxtStartupAttempt {
    nuxt: ChildProcess;
    viteClientBuilt: boolean;
    viteServerBuilt: boolean;
    nitroBuilt: boolean;
    viteClientWarmed: boolean;
    sawPortCollision: boolean;
    exited: boolean;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
}

export interface INuxtPortOwnerSessionMetadata {
    name: string;
    sessionPid: number | null;
    nuxtPid: number | null;
    nuxtPort: number;
    sessionAlive: boolean;
    nuxtAlive: boolean;
    descendantPids: number[];
}

export interface IProjectNuxtRootProcessMetadata {
    pid: number;
    ppid: number;
    devServerPort: number | null;
    descendantPids: number[];
}

export interface IOrphanedNuxtCleanupOptions {
    roots?: readonly IProjectNuxtRootProcessMetadata[];
    probeListeners?: (port: number) => INuxtListenerProbeResult;
    verifyIdentity?: (
        pid: number,
        expectation: ISessionProcessIdentityExpectation,
    ) => boolean;
    terminateRoot?: (options: {
        pid: number;
        expectation: ISessionProcessIdentityExpectation;
        graceMs: number;
    }) => Promise<boolean>;
}

export interface INuxtSessionShareMetadata {
    name: string;
    sessionAlive: boolean;
    nuxtPid: number | null;
    nuxtPort: number;
}

export function hasOtherAliveSessionUsingNuxt(
    sessions: INuxtSessionShareMetadata[],
    currentName: string,
    nuxtPid: number,
    nuxtPort: number,
) {
    return sessions.some(session =>
        session.name !== currentName
        && session.sessionAlive
        && (
            session.nuxtPid === nuxtPid
            || session.nuxtPort === nuxtPort
        ),
    );
}

export function readNuxtSessionShareMetadata(): INuxtSessionShareMetadata[] {
    return listAllSessionNames().flatMap((name) => {
        const info = getSessionInfo(name);
        const starting = getSessionStartingInfo(name);
        const ownershipOptions: IClassifySessionControllerOwnershipOptions = {};
        if (info) {
            ownershipOptions.info = info;
        }
        if (starting) {
            ownershipOptions.starting = starting;
        }
        const ownership = classifySessionControllerOwnership(name, ownershipOptions);
        if (ownership.status === 'abandoned') {
            return [];
        }
        return [
            ...(info ? [{
                name,
                sessionAlive: true,
                nuxtPid: info.nuxtPid,
                nuxtPort: info.nuxtPort,
            }] : []),
            ...(starting ? [{
                name,
                sessionAlive: true,
                nuxtPid: starting.nuxtPid ?? null,
                nuxtPort: starting.nuxtPort ?? 0,
            }] : []),
        ];
    });
}

export function readNuxtOwnerCheck(
    sessionName: string,
    nuxtPid: number,
    nuxtPort: number | null,
): {
    known: boolean;
    shared: boolean;
    reason: string | null;
} {
    for (const otherName of listAllSessionNames()) {
        if (otherName === sessionName) {
            continue;
        }
        const ownership = classifySessionControllerOwnership(otherName);
        if (ownership.status === 'ambiguous') {
            return {
                known: false,
                shared: false,
                reason: `Nuxt ownership is ambiguous for session '${otherName}' (${ownership.reason ?? 'metadata is unresolved'}). The server was retained; recover that session before retrying cleanup.`,
            };
        }
    }
    const shared = hasOtherAliveSessionUsingNuxt(
        readNuxtSessionShareMetadata(),
        sessionName,
        nuxtPid,
        nuxtPort ?? 0,
    );
    return {
        known: true,
        shared,
        reason: shared
            ? `Nuxt PID ${nuxtPid} on port ${nuxtPort ?? 'unknown'} is still used by another live session.`
            : null,
    };
}

registerNuxtOwnerProbe(readNuxtOwnerCheck);

export function selectStaleNuxtPortOwnerCleanupTargets(
    pidsOnPort: number[],
    sessions: INuxtPortOwnerSessionMetadata[],
    nuxtPort: number,
) {
    const targets = new Set<number>();
    for (const session of sessions) {
        if (
            session.sessionAlive
            || session.nuxtPort !== nuxtPort
            || !session.nuxtPid
            || !session.nuxtAlive
        ) {
            continue;
        }


        const ownedPids = new Set([
            session.nuxtPid,
            ...session.descendantPids,
        ]);
        if (pidsOnPort.some(pid => ownedPids.has(pid))) {
            targets.add(session.nuxtPid);
        }
    }

    return Array.from(targets);
}

export function selectOrphanedProjectNuxtRootCleanupTargets(
    roots: IProjectNuxtRootProcessMetadata[],
    pidsOnPreservedPort: number[],
    devServerPort: number,
) {
    const preservedPids = new Set(pidsOnPreservedPort);
    const targets = new Set<number>();

    for (const root of roots) {
        if (root.ppid !== 1) {
            continue;
        }

        const ownedPids = new Set([
            root.pid,
            ...root.descendantPids,
        ]);
        const ownsPreservedDevServer = root.devServerPort === devServerPort
            && Array.from(preservedPids).some(pid => ownedPids.has(pid));
        if (ownsPreservedDevServer) {
            continue;
        }

        targets.add(root.pid);
    }

    return Array.from(targets);
}

function hasCompletedNuxtBuildMarkers(attempt: INuxtStartupAttempt) {
    return attempt.viteClientBuilt && attempt.viteServerBuilt && attempt.nitroBuilt;
}

function getMissingNuxtBuildLabels(attempt: INuxtStartupAttempt) {
    const missing = [];
    if (!attempt.viteClientBuilt) {
        missing.push('Vite client');
    }
    if (!attempt.viteServerBuilt) {
        missing.push('Vite server');
    }
    if (!attempt.nitroBuilt) {
        missing.push('Nitro');
    }
    if (!attempt.viteClientWarmed) {
        missing.push('Vite warmup');
    }
    return missing;
}

export function resolveNuxtPortStrategy(sessionName = getCurrentSessionName()) {
    return sessionName === 'default' ? 'fixed-default' : 'isolated-free';
}

export function shouldCleanupOrphanedProjectNuxtRoots(sessionName = getCurrentSessionName()) {
    return sessionName === 'default';
}

async function selectNuxtPort() {
    if (resolveNuxtPortStrategy() === 'fixed-default') {
        setNuxtPort(DEFAULT_NUXT_PORT);
        console.log(`[Nuxt] Using fixed dev port ${getNuxtPort()}`);
        return;
    }

    setNuxtPort(await findFreePort());
    console.log(`[Nuxt] Using isolated port ${getNuxtPort()} for session '${getCurrentSessionName()}'`);
}

async function prepareNuxtServerStart(
    forceClean: boolean,
    logTiming: (message: string) => void,
    options: {mustRestart?: boolean} = {},
) {
    await selectNuxtPort();
    console.log(`[Nuxt] Browser dev server: http://localhost:${getNuxtPort()}/`);
    if (shouldCleanupOrphanedProjectNuxtRoots()) {
        await cleanupOrphanedProjectNuxtRoots('before reuse check');
        logTiming('Nuxt orphan cleanup complete');
    } else {
        console.log(`[Nuxt] Skipping project-wide orphan cleanup for isolated session '${getCurrentSessionName()}'`);
        logTiming('Nuxt isolated-session cleanup boundary applied');
    }

    if (!forceClean && !options.mustRestart && await isReusableNuxtServerReady()) {
        console.log(`[Nuxt] Reusing existing dev server at http://127.0.0.1:${getNuxtPort()}`);
        logTiming('Nuxt existing dev server reused');
        return false;
    }

    await cleanupStaleNuxtPortOwners('before start');
    logTiming('Nuxt port cleanup complete');

    if (forceClean) {
        console.log('[Nuxt] Force clean start...');
        clearViteCache();
        logTiming('Nuxt cache cleanup complete');
    }

    return true;
}

function updateNuxtStartupMarkers(
    attempt: INuxtStartupAttempt,
    text: string,
    logTiming: (message: string) => void,
) {
    if (text.includes('Vite client built')) {
        console.log('[Nuxt] Vite client built');
        logTiming('Nuxt Vite client built');
        attempt.viteClientBuilt = true;
    }
    if (text.includes('Vite server built')) {
        console.log('[Nuxt] Vite server built');
        logTiming('Nuxt Vite server built');
        attempt.viteServerBuilt = true;
    }
    if (text.includes('Nitro server built') || text.includes('Nitro') && text.includes('built')) {
        console.log('[Nuxt] Nitro server built');
        logTiming('Nuxt Nitro server built');
        attempt.nitroBuilt = true;
    }
    if (text.includes('Vite client warmed up')) {
        console.log('[Nuxt] Vite client warmed up');
        logTiming('Nuxt Vite client warmed up');
        attempt.viteClientWarmed = true;
    }
    const lowerText = text.toLowerCase();
    if (lowerText.includes('address already in use') || lowerText.includes('eaddrinuse')) {
        attempt.sawPortCollision = true;
    }
}

function spawnNuxtStartupAttempt(attemptIndex: number, logTiming: (message: string) => void): INuxtStartupAttempt {
    console.log(`[Nuxt] Starting dev server on port ${getNuxtPort()} (attempt ${attemptIndex + 1}/2)...`);
    const attempt: INuxtStartupAttempt = {
        nuxt: spawn(PNPM_COMMAND, [
            'run',
            'dev:nuxt',
        ], {
            cwd: projectRoot,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            env: buildNuxtDevServerEnv(process.env, getNuxtPort()),
        }),
        viteClientBuilt: false,
        viteServerBuilt: false,
        nitroBuilt: false,
        viteClientWarmed: false,
        sawPortCollision: false,
        exited: false,
        exitCode: null,
        exitSignal: null,
    };

    attempt.nuxt.on('exit', (code, signal) => {
        attempt.exited = true;
        attempt.exitCode = code;
        attempt.exitSignal = signal;
    });

    const checkOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
        getActiveDevServerOutputTee()?.write('nuxt-dev-server', stream, data);
        updateNuxtStartupMarkers(attempt, data.toString(), logTiming);
    };
    attempt.nuxt.stdout?.on('data', (data: Buffer) => checkOutput('stdout', data));
    attempt.nuxt.stderr?.on('data', (data: Buffer) => checkOutput('stderr', data));
    return attempt;
}

async function sampleElectronAppDependencyWarmup(options: {
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
} = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const requestTimeoutMs = options.requestTimeoutMs ?? NUXT_DEPENDENCY_WARMUP_REQUEST_TIMEOUT_MS;
    try {
        const res = await fetchImpl(getElectronAppUrl(), {
            method: 'GET',
            signal: AbortSignal.timeout(requestTimeoutMs),
        });
        const body = await res.text();
        return {
            ok: res.status === 200
                && isReusableNuxtResponse({
                    poweredBy: res.headers.get('x-powered-by'),
                    body,
                })
                && !body.includes(DYNAMIC_IMPORT_FAILURE_MARKER),
            status: res.status,
            bodySnippet: body.trim().replace(/\s+/g, ' ').slice(0, 180),
        };
    } catch (error) {
        return {
            ok: false,
            status: null,
            bodySnippet: getErrorMessage(error),
        };
    }
}

export async function warmupElectronAppDependencies(
    logTiming: (message: string) => void = () => {},
    options: {
        fetchImpl?: typeof fetch;
        timeoutMs?: number;
        requestTimeoutMs?: number;
        stablePolls?: number;
        pollIntervalMs?: number;
    } = {},
) {
    console.log('[Nuxt] Warming up dependencies...');
    const timeoutMs = options.timeoutMs ?? NUXT_DEPENDENCY_WARMUP_TIMEOUT_MS;
    const stablePollsRequired = options.stablePolls ?? NUXT_DEPENDENCY_WARMUP_STABLE_POLLS;
    const pollIntervalMs = options.pollIntervalMs ?? NUXT_DEPENDENCY_WARMUP_POLL_INTERVAL_MS;
    const start = Date.now();
    let stablePolls = 0;
    let lastSample: Awaited<ReturnType<typeof sampleElectronAppDependencyWarmup>> | null = null;

    while (Date.now() - start < timeoutMs) {
        lastSample = await sampleElectronAppDependencyWarmup({
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
        });
        if (lastSample.ok) {
            stablePolls += 1;
            if (stablePolls >= stablePollsRequired) {
                logTiming('Nuxt dependency warmup complete');
                return {
                    ok: true as const,
                    stablePolls,
                };
            }
        } else {
            stablePolls = 0;
        }
        await delay(pollIntervalMs);
    }

    return {
        ok: false as const,
        reason: `Electron app dependencies did not warm within ${Math.round(timeoutMs / 1000)}s`,
        status: lastSample?.status ?? null,
        bodySnippet: lastSample?.bodySnippet ?? '',
    };
}

function logElectronAppDependencyWarmupMiss(result: Awaited<ReturnType<typeof warmupElectronAppDependencies>>) {
    if (result.ok) {
        return;
    }

    console.warn(
        `[Nuxt] Dependency warmup did not settle; continuing anyway. ${result.reason}`
        + ` (last status=${result.status ?? 'unknown'}, body="${result.bodySnippet}")`,
    );
}

function createElectronAppDependencyWarmupError(result: Awaited<ReturnType<typeof warmupElectronAppDependencies>>) {
    if (result.ok) {
        return null;
    }

    return new Error(
        `${result.reason}. Last status=${result.status ?? 'unknown'}, body="${result.bodySnippet}"`,
    );
}

export async function warmupElectronAppDependenciesBestEffort(
    logTiming: (message: string) => void = () => {},
    options: Parameters<typeof warmupElectronAppDependencies>[1] = {},
) {
    const result = await warmupElectronAppDependencies(logTiming, options);
    const error = createElectronAppDependencyWarmupError(result);
    if (error && shouldRequireNuxtWarmup()) {
        throw error;
    }
    logElectronAppDependencyWarmupMiss(result);
    return result;
}

function createNuxtStartupExitError(attempt: INuxtStartupAttempt) {
    const pids = getNuxtListenerPidsOnPort(getNuxtPort());
    const suffix = pids.length > 0 ? ` Port owners: ${pids.join(', ')}` : '';
    return new Error(
        `Nuxt process exited before startup completed (code=${attempt.exitCode ?? 'null'}, signal=${attempt.exitSignal ?? 'null'}).${suffix}`,
    );
}

async function maybeReuseUnrelatedNuxtServer(
    attempt: INuxtStartupAttempt,
    allowReuse = true,
) {
    if (!allowReuse) {
        return false;
    }
    const nuxtPid = attempt.nuxt.pid ?? null;
    if (!nuxtPid || nuxtPid <= 0) {
        return false;
    }

    const ownedPids = new Set<number>([
        nuxtPid,
        ...getDescendantPids(nuxtPid),
    ]);
    const pidsOnPort = getNuxtListenerPidsOnPort(getNuxtPort());
    const ownsRespondingServer = pidsOnPort.some(pid => ownedPids.has(pid));
    if (pidsOnPort.length === 0 || ownsRespondingServer) {
        return false;
    }

    if (!await isReusableNuxtServerReady()) {
        return false;
    }

    const message = `Port ${getNuxtPort()} is already served by unrelated reusable Nuxt process(es): ${pidsOnPort.join(', ')}`;
    if (shouldUseStrictE2EIsolation()) {
        throw new Error(`[Nuxt] ${message}. Strict E2E isolation refuses to reuse it.`);
    }

    console.log(`[Nuxt] ${message}. Reusing existing server.`);
    if (isProcessAlive(nuxtPid)) {
        await killProcessTree(nuxtPid, 800);
    }
    return true;
}

function shouldRetryNuxtStartup(cleaned: boolean, attempt: INuxtStartupAttempt, attemptIndex: number) {
    return (cleaned || attempt.sawPortCollision) && attemptIndex === 0;
}

type TNuxtStartupResult =
    | {
        kind: 'ready';
        nuxt: ChildProcess | null;
    }
    | {kind: 'retry'};

async function waitForNuxtStartupAttempt(
    attempt: INuxtStartupAttempt,
    attemptIndex: number,
    logTiming: (message: string) => void,
    options: {allowUnrelatedReuse?: boolean} = {},
): Promise<TNuxtStartupResult> {
    const timeout = 120_000;
    const WARMUP_GRACE_MS = 5_000;
    const start = Date.now();
    let lastLog = 0;

    while (Date.now() - start < timeout) {
        const serverUp = await checkNuxtHttpReadiness();
        const buildsComplete = hasCompletedNuxtBuildMarkers(attempt);
        const warmupComplete = attempt.viteClientWarmed || (Date.now() - start > WARMUP_GRACE_MS);
        const elapsedMs = Date.now() - start;

        if (buildsComplete && warmupComplete) {
            if (!serverUp) {
                if (Date.now() - lastLog > 2_000) {
                    console.log('[Nuxt] Build markers complete; waiting for HTTP readiness.');
                    lastLog = Date.now();
                }
                await delay(250);
                continue;
            }

            console.log('[Nuxt] Server ready at http://127.0.0.1:' + getNuxtPort());
            logTiming('Nuxt server ready');
            await warmupElectronAppDependenciesBestEffort(logTiming);
            return {
                kind: 'ready',
                nuxt: attempt.nuxt,
            };
        }

        if (options.allowUnrelatedReuse !== false && serverUp && elapsedMs > 15_000 && await isReusableNuxtServer()) {
            console.log('[Nuxt] Reusable server responded without full build markers; proceeding with existing readiness signal.');
            logTiming('Nuxt server ready from HTTP fallback');
            await warmupElectronAppDependenciesBestEffort(logTiming);
            return {
                kind: 'ready',
                nuxt: attempt.nuxt,
            };
        }

        if (attempt.exited) {
            const cleaned = await cleanupStaleNuxtPortOwners('spawn process exited');
            if (shouldRetryNuxtStartup(cleaned, attempt, attemptIndex)) {
                return {kind: 'retry'};
            }
            throw createNuxtStartupExitError(attempt);
        }

        const now = Date.now();
        if (serverUp && !buildsComplete && now - lastLog > 5000) {
            if (await maybeReuseUnrelatedNuxtServer(attempt, options.allowUnrelatedReuse ?? true)) {
                await warmupElectronAppDependenciesBestEffort(logTiming);
                return {
                    kind: 'ready',
                    nuxt: null,
                };
            }
            console.log(`[Nuxt] Waiting for builds: ${getMissingNuxtBuildLabels(attempt).join(', ')}`);
            lastLog = now;
        }

        await delay(500);
    }

    return {kind: 'retry'};
}

async function stopTimedOutNuxtAttempt(attempt: INuxtStartupAttempt) {
    if (attempt.nuxt.pid && isProcessAlive(attempt.nuxt.pid)) {
        await killProcessTree(attempt.nuxt.pid, 800);
    } else {
        attempt.nuxt.kill();
    }
}

export async function startNuxtServer(forceClean = false): Promise<ChildProcess | null> {
    const pdfjsInstall = ensurePdfjsDevInstall();
    const mustRestart = pdfjsInstall.repaired;
    forceClean = forceClean || mustRestart;
    const logTiming = createStartupLogger();
    if (!await prepareNuxtServerStart(forceClean, logTiming, {mustRestart})) {
        await warmupElectronAppDependenciesBestEffort(logTiming);
        return null;
    }

    for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
        const attempt = spawnNuxtStartupAttempt(attemptIndex, logTiming);
        const result = await waitForNuxtStartupAttempt(attempt, attemptIndex, logTiming, {allowUnrelatedReuse: !mustRestart});
        if (result.kind === 'ready') {
            return result.nuxt;
        }

        await stopTimedOutNuxtAttempt(attempt);
        if (attemptIndex === 0 && await cleanupStaleNuxtPortOwners('startup timeout')) {
            continue;
        }
    }

    throw new Error('Nuxt server failed to start');
}
