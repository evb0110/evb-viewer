import {
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { delay } from 'es-toolkit/promise';
import {
    cleanupOrphanedProjectNuxtRoots,
    hasOtherAliveSessionUsingNuxt,
    killExistingNuxt,
    readNuxtOwnerCheck,
    readNuxtSessionShareMetadata,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    waitForProcessExit,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    findSessionOwnedElectronPids,
    isVerifiedSessionProcess,
    killVerifiedSessionProcess,
    type ISessionProcessIdentityExpectation,
} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    cleanupSessionStartingAttempt,
    clearSessionStarting,
    getSessionInfo,
    getSessionStartingInfo,
    listAllSessionNames,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    getCurrentSessionName,
    sessionDir,
    sessionFilePath,
    sessionKeepNuxtMarkerPath,
    sessionPreserveWorkspaceCheckpointMarkerPath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {cleanupSessionAppTempIfUnowned} from '@scripts/electron-run/electronRunSessionCleanup';
import type { ISessionInfo } from '@scripts/electron-run/electronRunSessionTypes';
import { sendCommandToSession } from '@scripts/electron-run/sendCommand';
import { clearAutomationWorkspaceCrashCheckpoint } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';

const SESSION_CONTROLLER_SHUTDOWN_TIMEOUT_MS = 12_000;
const SESSION_SHUTDOWN_COMMAND_TIMEOUT_MS = 2_000;

interface IVerifiedTerminationResult {
    terminated: number;
    refused: number;
}

async function killVerifiedSessionProcesses(
    pids: Iterable<number>,
    expectation: ISessionProcessIdentityExpectation,
    graceMs: number,
): Promise<IVerifiedTerminationResult> {
    let terminated = 0;
    let refused = 0;
    for (const pid of new Set(pids)) {
        if (!isProcessAlive(pid)) {
            continue;
        }
        const didTerminate = await killVerifiedSessionProcess({
            pid,
            expectation,
            graceMs,
        });
        if (didTerminate) {
            terminated += 1;
        } else if (isProcessAlive(pid)) {
            refused += 1;
        }
    }
    return {
        terminated,
        refused,
    };
}

export function shouldRemoveSessionStopArtifacts(outcomes: readonly boolean[]) {
    return outcomes.every(Boolean);
}

async function stopSessionController(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (keepNuxt && info.nuxtPid && isProcessAlive(info.nuxtPid)) {
        mkdirSync(sessionDir(name), {recursive: true});
        writeFileSync(sessionKeepNuxtMarkerPath(name), String(Date.now()));
    }
    if (!isProcessAlive(info.pid)) {
        return true;
    }
    if (!isVerifiedSessionProcess(info.pid, {
        kind: 'controller',
        sessionName: name,
    })) {
        // A controller that exited during the identity probe is stopped, not
        // unverifiable, and must not retain the session artifacts.
        if (!isProcessAlive(info.pid)) {
            return true;
        }
        console.warn(
            `[Session '${name}'] Refused to stop controller PID ${info.pid}: `
            + 'process identity did not match session ownership.',
        );
        return false;
    }

    try {
        await sendCommandToSession(info, 'shutdown', [], SESSION_SHUTDOWN_COMMAND_TIMEOUT_MS);
    } catch {
        const terminated = await killVerifiedSessionProcess({
            pid: info.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1500,
        });
        if (!terminated) {
            return false;
        }
    }
    if (await waitForProcessExit(info.pid, SESSION_CONTROLLER_SHUTDOWN_TIMEOUT_MS)) {
        return true;
    }
    if (isProcessAlive(info.pid)) {
        console.warn(`[Session '${name}'] Graceful controller shutdown timed out; using process-tree fallback`);
        return killVerifiedSessionProcess({
            pid: info.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1500,
        });
    }
    return true;
}

async function stopSessionElectron(info: ISessionInfo, name: string, force = false) {
    const expectation = {
        kind: 'electron',
        sessionName: name,
        cdpPort: info.cdpPort,
    } satisfies ISessionProcessIdentityExpectation;
    const candidates = new Set(findSessionOwnedElectronPids(expectation));
    if (info.electronPid) {
        candidates.add(info.electronPid);
    }
    let terminated = 0;
    let refused = 0;
    for (const pid of candidates) {
        if (!isProcessAlive(pid)) {
            continue;
        }
        const didTerminate = await killVerifiedSessionProcess({
            pid,
            expectation,
            graceMs: 800,
            force,
        });
        if (didTerminate) {
            terminated += 1;
        } else if (isProcessAlive(pid)) {
            refused += 1;
        }
    }
    const result = {
        terminated,
        refused,
    };
    return result.refused === 0;
}

async function stopNuxtForSessionInfo(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (!info.nuxtPid || !isProcessAlive(info.nuxtPid)) {
        return true;
    }
    if (keepNuxt) {
        console.log('[Nuxt] Left running for fast restart');
        return true;
    }
    const ownerCheck = readNuxtOwnerCheck(name, info.nuxtPid, info.nuxtPort);
    if (!ownerCheck.known) {
        console.warn(ownerCheck.reason ?? `[Nuxt] Refused to terminate PID ${info.nuxtPid}: ownership is unresolved.`);
        return false;
    }
    if (ownerCheck.shared || hasOtherAliveSessionUsingNuxt(readNuxtSessionShareMetadata(), name, info.nuxtPid, info.nuxtPort)) {
        console.log('[Nuxt] Left running (shared with other session)');
        return true;
    }
    return killVerifiedSessionProcess({
        pid: info.nuxtPid,
        expectation: {
            kind: 'nuxt',
            sessionName: name,
            nuxtPort: info.nuxtPort,
        },
        graceMs: 1200,
    });
}

function removeSessionStopFiles(name: string, preserveWorkspaceCheckpoint: boolean) {
    try { unlinkSync(sessionFilePath(name)); } catch {}
    try { unlinkSync(sessionKeepNuxtMarkerPath(name)); } catch {}
    if (!preserveWorkspaceCheckpoint) {
        try { unlinkSync(sessionPreserveWorkspaceCheckpointMarkerPath(name)); } catch {}
    }
}

function sessionElectronExpectation(name: string) {
    return {
        kind: 'electron',
        sessionName: name,
        electronUserDataDir: electronUserDataPath(name),
    } satisfies ISessionProcessIdentityExpectation;
}

async function killOrphanedSessionElectron(name: string) {
    const expectation = sessionElectronExpectation(name);
    const pids = findSessionOwnedElectronPids(expectation);
    return killVerifiedSessionProcesses(pids, expectation, 800);
}

function retainSessionStopArtifacts(name: string, info: ISessionInfo) {
    mkdirSync(sessionDir(name), {recursive: true});
    writeFileSync(sessionFilePath(name), JSON.stringify(info));
}

export async function stopSingleSession(
    name: string,
    options: {
        keepNuxt?: boolean;
        preserveWorkspaceCheckpoint?: boolean;
        crashElectronBeforeStop?: boolean;
    } = {},
) {
    const preserveWorkspaceCheckpoint = options.preserveWorkspaceCheckpoint === true;
    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);
    if (!info && !starting) {
        const orphanResult = await killOrphanedSessionElectron(name);
        if (orphanResult.refused > 0) {
            throw new Error(
                `Session '${name}' could not terminate ${orphanResult.refused} Electron process(es): identity did not match session ownership, or the process outlived termination.`,
            );
        }
        if (orphanResult.terminated > 0) {
            await delay(250);
            console.log(`Cleaned ${orphanResult.terminated} orphaned Electron process(es) for session '${name}'.`);
        } else {
            console.log(`No session '${name}' running.`);
        }
        if (!preserveWorkspaceCheckpoint) {
            if (!cleanupSessionAppTempIfUnowned(name)) {
                throw new Error(
                    `Session '${name}' app temp cleanup was refused because a session-owned Electron process is still alive.`,
                );
            }
            clearAutomationWorkspaceCrashCheckpoint(name);
        }
        removeSessionStopFiles(name, preserveWorkspaceCheckpoint);
        return;
    }
    if (info) {
        if (preserveWorkspaceCheckpoint) {
            mkdirSync(sessionDir(name), {recursive: true});
            writeFileSync(sessionPreserveWorkspaceCheckpointMarkerPath(name), String(Date.now()));
        }
        const electronStoppedByCrash = options.crashElectronBeforeStop === true
            ? await stopSessionElectron(info, name, true)
            : null;
        const stageOutcomes = {
            'electron crash': electronStoppedByCrash ?? true,
            controller: await stopSessionController(info, name, options.keepNuxt),
            electron: electronStoppedByCrash === null
                ? await stopSessionElectron(info, name)
                : true,
            nuxt: await stopNuxtForSessionInfo(info, name, options.keepNuxt),
        };
        const outcomes = Object.values(stageOutcomes);
        if (!shouldRemoveSessionStopArtifacts(outcomes)) {
            retainSessionStopArtifacts(name, info);
            const refusedStages = Object.entries(stageOutcomes)
                .filter(([
                    , stopped,
                ]) => !stopped)
                .map(([stage]) => stage)
                .join(', ');
            throw new Error(
                `Session '${name}' stop was refused at ${refusedStages}: a process identity did not match session ownership, or the process outlived termination; session artifacts were retained.`,
            );
        }
        // The Electron stage only matches the recorded CDP port. An Electron
        // that outlived a restart on another port still owns the session's
        // user-data directory and would be reported as a clean stop.
        const survivors = findSessionOwnedElectronPids(sessionElectronExpectation(name));
        if (survivors.length > 0) {
            retainSessionStopArtifacts(name, info);
            throw new Error(
                `Session '${name}' stop left ${String(survivors.length)} session-owned Electron process(es) alive (pid ${survivors.join(', ')}); session artifacts were retained, run stop again.`,
            );
        }
    }
    if (starting?.pid && isProcessAlive(starting.pid)) {
        const didTerminateStartingController = await killVerifiedSessionProcess({
            pid: starting.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1000,
        });
        if (!didTerminateStartingController) {
            if (info) {
                retainSessionStopArtifacts(name, info);
            }
            throw new Error(
                `Session '${name}' startup-controller stop was refused; session artifacts were retained.`,
            );
        }
    }
    const startingCleanup = await cleanupSessionStartingAttempt(name, {
        killNuxt: options.keepNuxt !== true,
        starting,
    });
    if (!startingCleanup.completed) {
        if (info) {
            retainSessionStopArtifacts(name, info);
        }
        throw new Error(startingCleanup.reason ?? `Session '${name}' startup cleanup was retained.`);
    }
    clearSessionStarting(name);
    if (!preserveWorkspaceCheckpoint) {
        if (!cleanupSessionAppTempIfUnowned(name)) {
            if (info) {
                retainSessionStopArtifacts(name, info);
            }
            throw new Error(
                `Session '${name}' app temp cleanup was refused because a session-owned Electron process is still alive.`,
            );
        }
        clearAutomationWorkspaceCrashCheckpoint(name);
    }
    removeSessionStopFiles(name, preserveWorkspaceCheckpoint);
    console.log(`Session '${name}' stopped.`);
}

export async function stopAllSessions() {
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');
    const names = listAllSessionNames();
    if (names.length === 0) {
        await killExistingNuxt();
        await cleanupOrphanedProjectNuxtRoots('stop all sessions');
        console.log('No sessions found.');
        return;
    }
    for (const name of names) await stopSingleSession(name);
    await killExistingNuxt();
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');
    console.log('All sessions stopped.');
}

export async function stopSession(options: {
    stopAll?: boolean;
    keepNuxt?: boolean
} = {}) {
    if (options.stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(getCurrentSessionName(), options.keepNuxt === undefined
            ? {}
            : {keepNuxt: options.keepNuxt});
    }
}
