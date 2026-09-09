import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { delay } from 'es-toolkit/promise';
import { safeJsonParse } from '@contracts/safeJsonParse';
import { DEFAULT_NUXT_PORT } from '@scripts/electron-run/electronRunPortConfig';
import { SESSION_WAIT_TIMEOUT_MS } from '@scripts/electron-run/electronRunTimeouts';
import {
    parseElectronRunCommandResponse,
    type TElectronRunCommand,
} from '@scripts/electron-run/electronRunProtocol';
import { isJsonRecord } from '@scripts/electron-run/isJsonRecord';
import {
    getCurrentSessionName,
    sessionDir,
    electronUserDataPath,
    sessionFilePath,
    sessionLogFilePath,
    sessionStartingFilePath,
    sessionsBaseDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import { E2E_RUN_ID_ENV } from '@scripts/electron-run/electronRunRunId';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    findSessionOwnedElectronPids,
    inspectProcessIdentity,
    killVerifiedSessionProcess,
    matchesSessionProcessIdentity,
    type IProcessIdentitySnapshot,
    type ISessionProcessIdentityExpectation,
} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    cleanupSessionAppTempIfUnowned,
    hasWorkspaceRecoveryEvidence,
} from '@scripts/electron-run/electronRunSessionCleanup';
import type {
    ISessionInfo,
    ISessionStartingInfo,
} from '@scripts/electron-run/electronRunSessionTypes';

function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNullablePositiveInt(value: unknown): value is number | null {
    return value === null || isPositiveInt(value);
}

export type TSessionControllerOwnershipStatus = 'abandoned' | 'active' | 'ambiguous';

export interface ISessionControllerOwnership {
    kind: 'controller' | 'startup-controller';
    pid: number;
    status: TSessionControllerOwnershipStatus;
    reason: string | null;
}

export interface IClassifySessionControllerOwnershipOptions {
    info?: ISessionInfo | null;
    starting?: ISessionStartingInfo | null;
    isProcessAlive?: typeof isProcessAlive;
    inspectProcessIdentity?: typeof inspectProcessIdentity;
    matchesSessionProcessIdentity?: typeof matchesSessionProcessIdentity;
}

export interface IClassifiedSessionControllerOwnership {
    status: TSessionControllerOwnershipStatus;
    reason: string | null;
    controllers: ISessionControllerOwnership[];
}

export interface INuxtSessionOwnerCheck {
    known: boolean;
    shared: boolean;
    reason: string | null;
}

export interface ICleanupStaleSessionArtifactsOptions extends IClassifySessionControllerOwnershipOptions { nuxtOwnerProbe?: (
    sessionName: string,
    nuxtPid: number,
    nuxtPort: number | null,
) => INuxtSessionOwnerCheck | Promise<INuxtSessionOwnerCheck>; }

export type TStaleSessionArtifactsCleanupKind = 'clean' | 'preserved-recovery' | 'retained-unsafe';

export interface IStaleSessionArtifactsCleanupResult {
    retained: boolean;
    kind: TStaleSessionArtifactsCleanupKind;
    reason: string | null;
}

export function canProceedAfterStaleArtifactCleanup(result: IStaleSessionArtifactsCleanupResult) {
    return !result.retained || result.kind === 'preserved-recovery';
}

function parseJsonFile(path: string) {
    try {
        return safeJsonParse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

function isSessionInfo(value: unknown): value is ISessionInfo {
    if (!isJsonRecord(value)) {
        return false;
    }
    if (
        !isPositiveInt(value.port)
        || !isPositiveInt(value.pid)
        || !isPositiveInt(value.cdpPort)
        || !isNullablePositiveInt(value.electronPid)
        || !isNullablePositiveInt(value.nuxtPid)
    ) {
        return false;
    }
    // Backward compat: older session files may lack nuxtPort.
    if (value.nuxtPort !== undefined && !isPositiveInt(value.nuxtPort)) {
        return false;
    }
    return true;
}

function normalizeSessionInfo(raw: ISessionInfo): ISessionInfo {
    return {
        ...raw,
        nuxtPort: raw.nuxtPort || DEFAULT_NUXT_PORT,
        runId: typeof raw.runId === 'string' ? raw.runId : null,
    };
}

function isSessionStartingInfo(value: unknown): value is ISessionStartingInfo {
    if (!isJsonRecord(value)) {
        return false;
    }
    return isPositiveInt(value.pid) && isPositiveInt(value.startedAt);
}

function normalizeSessionStartingInfo(raw: ISessionStartingInfo): ISessionStartingInfo {
    const electronPids = Array.isArray(raw.electronPids)
        ? raw.electronPids.filter(isPositiveInt)
        : [];
    const cdpPorts = Array.isArray(raw.cdpPorts)
        ? raw.cdpPorts.filter(isPositiveInt)
        : [];
    return {
        pid: raw.pid,
        startedAt: raw.startedAt,
        electronPids,
        cdpPorts,
        electronUserDataDir: typeof raw.electronUserDataDir === 'string' && raw.electronUserDataDir.length > 0
            ? raw.electronUserDataDir
            : null,
        nuxtPid: isNullablePositiveInt(raw.nuxtPid) ? raw.nuxtPid : null,
        nuxtPort: isNullablePositiveInt(raw.nuxtPort) ? raw.nuxtPort : null,
        runId: typeof raw.runId === 'string' ? raw.runId : null,
    };
}

function classifyControllerProcess(
    sessionName: string,
    kind: 'controller' | 'startup-controller',
    pid: number,
    options: IClassifySessionControllerOwnershipOptions,
): ISessionControllerOwnership {
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    const inspect = options.inspectProcessIdentity ?? inspectProcessIdentity;
    const matches = options.matchesSessionProcessIdentity ?? matchesSessionProcessIdentity;
    const label = kind === 'startup-controller' ? 'startup-controller' : 'controller';
    const expectation = {
        kind: 'controller' as const,
        sessionName,
    } satisfies ISessionProcessIdentityExpectation;
    const ambiguousReason = `[Session '${sessionName}'] ${label} PID ${pid} is live but its ownership could not be verified. `
        + 'The identity probe failed or the PID may have been reused. Inspect the process and session artifacts, then retry cleanup.';

    let alive: boolean;
    try {
        alive = isAlive(pid);
    } catch {
        return {
            kind,
            pid,
            status: 'ambiguous',
            reason: ambiguousReason,
        };
    }
    if (!alive) {
        return {
            kind,
            pid,
            status: 'abandoned',
            reason: null,
        };
    }
    if (pid === process.pid || pid === process.ppid) {
        return {
            kind,
            pid,
            status: 'ambiguous',
            reason: `${ambiguousReason} The automatic cleanup process and its parent are never safe termination targets.`,
        };
    }

    let snapshot: IProcessIdentitySnapshot | null = null;
    try {
        snapshot = inspect(pid);
    } catch {
        snapshot = null;
    }
    if (snapshot) {
        try {
            if (matches(snapshot, expectation)) {
                return {
                    kind,
                    pid,
                    status: 'active',
                    reason: `[Session '${sessionName}'] verified live ${label} PID ${pid} owns this session.`,
                };
            }
        } catch {
            // A failed identity comparison is still ambiguous while the PID is
            // live. Automatic cleanup must not turn that uncertainty into a kill.
        }
    }

    try {
        if (!isAlive(pid)) {
            return {
                kind,
                pid,
                status: 'abandoned',
                reason: null,
            };
        }
    } catch {
        // Keep the conservative result below when the second liveness probe is
        // unavailable.
    }
    return {
        kind,
        pid,
        status: 'ambiguous',
        reason: ambiguousReason,
    };
}

export function classifySessionControllerOwnership(
    name: string,
    options: IClassifySessionControllerOwnershipOptions = {},
): IClassifiedSessionControllerOwnership {
    const info = options.info === undefined ? getSessionInfo(name) : options.info;
    const starting = options.starting === undefined ? getSessionStartingInfo(name) : options.starting;
    const controllers: ISessionControllerOwnership[] = [];

    if (info) {
        controllers.push(classifyControllerProcess(name, 'controller', info.pid, options));
    } else if (options.info === undefined && existsSync(sessionFilePath(name))) {
        controllers.push({
            kind: 'controller',
            pid: 0,
            status: 'ambiguous',
            reason: `[Session '${name}'] session.json exists but could not be read as valid controller metadata. Inspect the artifact before retrying cleanup.`,
        });
    }

    if (starting) {
        controllers.push(classifyControllerProcess(name, 'startup-controller', starting.pid, options));
    } else if (options.starting === undefined && existsSync(sessionStartingFilePath(name))) {
        controllers.push({
            kind: 'startup-controller',
            pid: 0,
            status: 'ambiguous',
            reason: `[Session '${name}'] session-starting.json exists but could not be read as valid startup metadata. Inspect the artifact before retrying cleanup.`,
        });
    }

    const active = controllers.find(controller => controller.status === 'active');
    if (active) {
        return {
            status: 'active',
            reason: active.reason,
            controllers,
        };
    }
    const ambiguous = controllers.find(controller => controller.status === 'ambiguous');
    if (ambiguous) {
        return {
            status: 'ambiguous',
            reason: ambiguous.reason,
            controllers,
        };
    }
    return {
        status: 'abandoned',
        reason: null,
        controllers,
    };
}

export function getSessionInfo(name = getCurrentSessionName()): ISessionInfo | null {
    const raw = parseJsonFile(sessionFilePath(name));
    if (!isSessionInfo(raw)) {
        return null;
    }
    return normalizeSessionInfo(raw);
}

export function getSessionStartingInfo(name = getCurrentSessionName()): ISessionStartingInfo | null {
    const raw = parseJsonFile(sessionStartingFilePath(name));
    if (!isSessionStartingInfo(raw)) {
        return null;
    }
    return normalizeSessionStartingInfo(raw);
}

export function readSessionLogTail(maxLines = 80) {
    try {
        const text = readFileSync(sessionLogFilePath(), 'utf8');
        const lines = text.split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
    } catch {
        return '';
    }
}

export function markSessionStarting(pid: number) {
    mkdirSync(sessionDir(), { recursive: true });
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        pid,
        startedAt: Date.now(),
        electronPids: [],
        cdpPorts: [],
        electronUserDataDir: electronUserDataPath(),
        nuxtPid: null,
        nuxtPort: null,
        runId: process.env[E2E_RUN_ID_ENV] ?? null,
    }));
}

export function recordSessionStartingAttempt(update: Partial<Pick<
    ISessionStartingInfo,
    'electronPids' | 'cdpPorts' | 'electronUserDataDir' | 'nuxtPid' | 'nuxtPort'
>>) {
    const current = getSessionStartingInfo();
    if (!current) {
        return;
    }
    const electronPids = [
        ...current.electronPids,
        ...(update.electronPids ?? []),
    ].filter(isPositiveInt);
    const cdpPorts = [
        ...current.cdpPorts,
        ...(update.cdpPorts ?? []),
    ].filter(isPositiveInt);
    writeFileSync(sessionStartingFilePath(), JSON.stringify({
        ...current,
        electronPids: [...new Set(electronPids)],
        cdpPorts: [...new Set(cdpPorts)],
        electronUserDataDir: update.electronUserDataDir ?? current.electronUserDataDir,
        nuxtPid: update.nuxtPid ?? current.nuxtPid,
        nuxtPort: update.nuxtPort ?? current.nuxtPort,
    }));
}

export function clearSessionStarting(name = getCurrentSessionName()) {
    try {
        unlinkSync(sessionStartingFilePath(name));
    } catch {}
}

interface IVerifiedTerminationCandidate {
    pid: number;
    expectation: ISessionProcessIdentityExpectation;
}

function collectSessionElectronCandidates(
    name: string,
    info: ISessionInfo | null,
    starting: ISessionStartingInfo | null,
) {
    const candidates: IVerifiedTerminationCandidate[] = [];
    const seen = new Set<string>();
    const add = (pid: number, expectation: ISessionProcessIdentityExpectation) => {
        const key = [
            String(pid),
            expectation.cdpPort === undefined ? '' : String(expectation.cdpPort),
            expectation.electronUserDataDir ?? '',
        ].join('|');
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push({
            pid,
            expectation,
        });
    };

    if (info?.electronPid) {
        add(info.electronPid, {
            kind: 'electron',
            sessionName: name,
            cdpPort: info.cdpPort,
            electronUserDataDir: electronUserDataPath(name),
        });
    }

    if (starting) {
        const electronUserDataDir = starting.electronUserDataDir ?? electronUserDataPath(name);
        const cdpPorts = starting.cdpPorts.length > 0 ? starting.cdpPorts : [null];
        for (const cdpPort of cdpPorts) {
            const expectation = {
                kind: 'electron' as const,
                sessionName: name,
                cdpPort,
                electronUserDataDir,
            } satisfies ISessionProcessIdentityExpectation;
            for (const electronPid of starting.electronPids) {
                add(electronPid, expectation);
            }
            for (const electronPid of findSessionOwnedElectronPids(expectation)) {
                add(electronPid, expectation);
            }
        }
    }

    const profileExpectation = {
        kind: 'electron' as const,
        sessionName: name,
        electronUserDataDir: electronUserDataPath(name),
    } satisfies ISessionProcessIdentityExpectation;
    for (const electronPid of findSessionOwnedElectronPids(profileExpectation)) {
        add(electronPid, profileExpectation);
    }
    return candidates;
}

async function terminateVerifiedCandidates(
    candidates: IVerifiedTerminationCandidate[],
    graceMs: number,
) {
    const remaining = new Set<number>();
    const stopped = new Set<number>();
    for (const candidate of candidates) {
        if (stopped.has(candidate.pid)) {
            continue;
        }
        let alive = false;
        try {
            alive = isProcessAlive(candidate.pid);
        } catch {
            remaining.add(candidate.pid);
            continue;
        }
        if (!alive) {
            stopped.add(candidate.pid);
            remaining.delete(candidate.pid);
            continue;
        }
        let didStop = false;
        try {
            didStop = await killVerifiedSessionProcess({
                pid: candidate.pid,
                expectation: candidate.expectation,
                graceMs,
            });
        } catch {
            didStop = false;
        }
        let stillAlive = false;
        try {
            stillAlive = isProcessAlive(candidate.pid);
        } catch {
            stillAlive = true;
        }
        if (didStop || !stillAlive) {
            stopped.add(candidate.pid);
            remaining.delete(candidate.pid);
        } else {
            remaining.add(candidate.pid);
        }
    }
    return [...remaining];
}

function collectSessionNuxtCandidates(
    info: ISessionInfo | null,
    starting: ISessionStartingInfo | null,
) {
    const candidates: Array<{
        pid: number;
        nuxtPort: number | null;
    }> = [];
    const seen = new Set<number>();
    for (const candidate of [
        info && info.nuxtPid
            ? {
                pid: info.nuxtPid,
                nuxtPort: info.nuxtPort,
            }
            : null,
        starting && starting.nuxtPid
            ? {
                pid: starting.nuxtPid,
                nuxtPort: starting.nuxtPort,
            }
            : null,
    ]) {
        if (!candidate || seen.has(candidate.pid)) {
            continue;
        }
        seen.add(candidate.pid);
        candidates.push(candidate);
    }
    return candidates;
}

type TNuxtOwnerProbe = (
    sessionName: string,
    nuxtPid: number,
    nuxtPort: number | null,
) => INuxtSessionOwnerCheck | Promise<INuxtSessionOwnerCheck>;

let nuxtOwnerProbe: TNuxtOwnerProbe = (sessionName, nuxtPid, nuxtPort) => {
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
        if (ownership.status !== 'active') {
            continue;
        }
        const info = getSessionInfo(otherName);
        const starting = getSessionStartingInfo(otherName);
        if ([
            info?.nuxtPid,
            starting?.nuxtPid,
        ].includes(nuxtPid)
            || [
                info?.nuxtPort,
                starting?.nuxtPort,
            ].includes(nuxtPort)) {
            return {
                known: true,
                shared: true,
                reason: `Nuxt PID ${nuxtPid} on port ${nuxtPort ?? 'unknown'} is still used by another live session.`,
            };
        }
    }
    return {
        known: true,
        shared: false,
        reason: null,
    };
};

export function registerNuxtOwnerProbe(probe: TNuxtOwnerProbe) {
    nuxtOwnerProbe = probe;
}

async function killRecordedStartingProcesses(
    name: string,
    starting: ISessionStartingInfo,
    options: { killNuxt?: boolean } = {},
): Promise<number[]> {
    const remaining = new Set(await terminateVerifiedCandidates(
        collectSessionElectronCandidates(name, null, starting),
        800,
    ));

    if (options.killNuxt !== false && starting.nuxtPid && isProcessAlive(starting.nuxtPid)) {
        let didStop = false;
        try {
            didStop = await killVerifiedSessionProcess({
                pid: starting.nuxtPid,
                expectation: {
                    kind: 'nuxt',
                    sessionName: name,
                    nuxtPort: starting.nuxtPort,
                },
                graceMs: 1200,
            });
        } catch {
            didStop = false;
        }
        if (!didStop && isProcessAlive(starting.nuxtPid)) {
            remaining.add(starting.nuxtPid);
        }
    }
    return [...remaining];
}

export interface ISessionStartingCleanupResult {
    completed: boolean;
    remainingPids: number[];
    reason: string | null;
}

export async function cleanupSessionStartingAttempt(
    name = getCurrentSessionName(),
    options: {
        killNuxt?: boolean;
        starting?: ISessionStartingInfo | null;
        nuxtOwnerProbe?: ICleanupStaleSessionArtifactsOptions['nuxtOwnerProbe'];
    } = {},
): Promise<ISessionStartingCleanupResult> {
    const starting = options.starting === undefined
        ? getSessionStartingInfo(name)
        : options.starting;
    if (!starting) {
        return {
            completed: true,
            remainingPids: [],
            reason: null,
        };
    }

    let killNuxt = options.killNuxt !== false;
    if (killNuxt && starting.nuxtPid && isProcessAlive(starting.nuxtPid)) {
        const ownerCheck = await (options.nuxtOwnerProbe ?? nuxtOwnerProbe)(
            name,
            starting.nuxtPid,
            starting.nuxtPort,
        );
        if (!ownerCheck.known) {
            return {
                completed: false,
                remainingPids: [starting.nuxtPid],
                reason: ownerCheck.reason,
            };
        }
        if (ownerCheck.shared) {
            killNuxt = false;
            console.log(`[Session '${name}'] Left Nuxt running because another live session owns the shared server.`);
        }
    }

    if (killNuxt && starting.nuxtPid && isProcessAlive(starting.nuxtPid)) {
        const boundaryOwnerCheck = await (options.nuxtOwnerProbe ?? nuxtOwnerProbe)(
            name,
            starting.nuxtPid,
            starting.nuxtPort,
        );
        if (!boundaryOwnerCheck.known || boundaryOwnerCheck.shared) {
            return {
                completed: false,
                remainingPids: [starting.nuxtPid],
                reason: boundaryOwnerCheck.reason
                    ?? `[Session '${name}'] shared Nuxt ownership changed before termination; the server was retained.`,
            };
        }
    }

    const remainingPids = await killRecordedStartingProcesses(name, starting, {killNuxt});
    if (remainingPids.length === 0) {
        clearSessionStarting(name);
        return {
            completed: true,
            remainingPids,
            reason: null,
        };
    }
    return {
        completed: false,
        remainingPids,
        reason: `[Session '${name}'] startup cleanup retained its artifacts because session-owned process(es) remain alive: ${remainingPids.join(', ')}.`,
    };
}

export function isSessionStarting(name = getCurrentSessionName()) {
    const info = getSessionStartingInfo(name);
    if (!info) {
        return false;
    }
    const ownership = classifySessionControllerOwnership(name, {
        info: null,
        starting: info,
    });
    if (ownership.status === 'active') {
        return true;
    }
    if (ownership.status === 'ambiguous') {
        console.warn(`${ownership.reason ?? 'Controller ownership is ambiguous.'} Startup metadata was retained because age cannot prove abandonment.`);
        return true;
    }
    if (ownership.status === 'abandoned') {
        clearSessionStarting(name);
        return false;
    }
    return false;
}

export async function cleanupStaleSessionArtifacts(
    name = getCurrentSessionName(),
    options: ICleanupStaleSessionArtifactsOptions = {},
): Promise<IStaleSessionArtifactsCleanupResult> {
    const info = options.info === undefined ? getSessionInfo(name) : options.info;
    const starting = options.starting === undefined ? getSessionStartingInfo(name) : options.starting;
    const classificationOptions: IClassifySessionControllerOwnershipOptions = {...options};
    // Leave a missing defaulted value undefined so the classifier can inspect
    // the file itself and distinguish a missing artifact from malformed data.
    // An explicit null remains an intentional test/caller override.
    if (options.info !== undefined || info) {
        classificationOptions.info = info;
    }
    if (options.starting !== undefined || starting) {
        classificationOptions.starting = starting;
    }
    const ownership = classifySessionControllerOwnership(name, classificationOptions);
    if (ownership.status !== 'abandoned') {
        const reason = ownership.reason ?? `[Session '${name}'] controller ownership was ambiguous.`;
        console.warn(`${reason} Automatic stale-artifact cleanup retained the session.`);
        return {
            retained: true,
            kind: 'retained-unsafe',
            reason,
        };
    }

    const remainingElectronPids = await terminateVerifiedCandidates(
        collectSessionElectronCandidates(name, info, starting),
        800,
    );
    if (remainingElectronPids.length > 0) {
        const reason = `[Session '${name}'] stale-artifact cleanup retained its metadata because Electron process(es) remain alive: ${remainingElectronPids.join(', ')}.`;
        console.warn(reason);
        return {
            retained: true,
            kind: 'retained-unsafe',
            reason,
        };
    }

    const remainingNuxtPids = new Set<number>();
    for (const candidate of collectSessionNuxtCandidates(info, starting)) {
        if (!isProcessAlive(candidate.pid)) {
            continue;
        }
        const ownerCheck = await (options.nuxtOwnerProbe ?? nuxtOwnerProbe)(
            name,
            candidate.pid,
            candidate.nuxtPort,
        );
        if (!ownerCheck.known) {
            const reason = ownerCheck.reason ?? `[Session '${name}'] Nuxt ownership could not be established.`;
            console.warn(reason);
            return {
                retained: true,
                kind: 'retained-unsafe',
                reason,
            };
        }
        if (ownerCheck.shared) {
            console.log(`[Session '${name}'] Left Nuxt PID ${candidate.pid} running because another live session owns the shared server.`);
            continue;
        }
        const boundaryOwnerCheck = await (options.nuxtOwnerProbe ?? nuxtOwnerProbe)(
            name,
            candidate.pid,
            candidate.nuxtPort,
        );
        if (!boundaryOwnerCheck.known || boundaryOwnerCheck.shared) {
            const reason = boundaryOwnerCheck.reason
                ?? `[Session '${name}'] shared Nuxt ownership changed before termination; the server was retained.`;
            console.warn(reason);
            return {
                retained: true,
                kind: 'retained-unsafe',
                reason,
            };
        }
        let didStop = false;
        try {
            didStop = await killVerifiedSessionProcess({
                pid: candidate.pid,
                expectation: {
                    kind: 'nuxt',
                    sessionName: name,
                    nuxtPort: candidate.nuxtPort,
                },
                graceMs: 1200,
            });
        } catch {
            didStop = false;
        }
        if (!didStop && isProcessAlive(candidate.pid)) {
            remainingNuxtPids.add(candidate.pid);
        }
    }
    if (remainingNuxtPids.size > 0) {
        const reason = `[Session '${name}'] stale-artifact cleanup retained its metadata because Nuxt process(es) remain alive: ${[...remainingNuxtPids].join(', ')}.`;
        console.warn(reason);
        return {
            retained: true,
            kind: 'retained-unsafe',
            reason,
        };
    }

    if (starting) {
        const startingCleanup = await cleanupSessionStartingAttempt(name, {
            killNuxt: false,
            starting,
            nuxtOwnerProbe: options.nuxtOwnerProbe,
        });
        if (!startingCleanup.completed) {
            const reason = startingCleanup.reason ?? `[Session '${name}'] startup cleanup was not completed.`;
            console.warn(reason);
            return {
                retained: true,
                kind: 'retained-unsafe',
                reason,
            };
        }
    }

    if (hasWorkspaceRecoveryEvidence(name)) {
        return {
            retained: true,
            kind: 'preserved-recovery',
            reason: 'workspace recovery evidence is present; retained for later recovery',
        };
    }

    try {
        if (!cleanupSessionAppTempIfUnowned(name)) {
            const reason = `[Session '${name}'] Retained app temp during stale-artifact cleanup because a session-owned Electron process is still alive.`;
            console.warn(reason);
            return {
                retained: true,
                kind: 'retained-unsafe',
                reason,
            };
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = `[Session '${name}'] App temp cleanup failed, so session artifacts were retained: ${message}`;
        console.warn(reason);
        return {
            retained: true,
            kind: 'retained-unsafe',
            reason,
        };
    }

    if (info) {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
    }
    return {
        retained: false,
        kind: 'clean',
        reason: null,
    };
}

export async function isSessionRunning(
    name = getCurrentSessionName(),
    signal?: AbortSignal,
) {
    const info = getSessionInfo(name);
    if (!info) {
        return false;
    }
    const ownership = classifySessionControllerOwnership(name, {
        info,
        starting: null,
    });
    if (ownership.status === 'ambiguous') {
        console.warn(`${ownership.reason ?? 'Controller ownership is ambiguous.'} Session metadata was retained.`);
        return false;
    }
    if (ownership.status === 'abandoned') {
        try {
            unlinkSync(sessionFilePath(name));
        } catch {}
        return false;
    }

    try {
        const res = await fetch(`http://localhost:${info.port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command: 'ping' satisfies TElectronRunCommand,
                args: [],
            }),
            ...(signal ? {signal} : {}),
        });
        if (!res.ok) {
            return false;
        }
        const responsePayload = parseElectronRunCommandResponse(await res.json());
        return Boolean(responsePayload?.success);
    } catch {
        if (!isProcessAlive(info.pid)) {
            try {
                unlinkSync(sessionFilePath(name));
            } catch {}
        }
        if (signal?.aborted && signal.reason?.name !== 'TimeoutError') {
            throw signal.reason ?? new DOMException('Session readiness probe canceled', 'AbortError');
        }
        return false;
    }
}

export async function waitForSessionReady(timeoutMs = SESSION_WAIT_TIMEOUT_MS, signal?: AbortSignal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        const timeoutSignal = AbortSignal.timeout(remainingMs);
        const probeSignal = signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal;
        try {
            if (await isSessionRunning(getCurrentSessionName(), probeSignal)) {
                return true;
            }
        } catch (error) {
            if (timeoutSignal.aborted && !signal?.aborted) {
                return false;
            }
            throw error;
        }
        const delayMs = Math.min(250, deadline - Date.now());
        if (delayMs > 0) {
            await delay(delayMs);
        }
    }
    return false;
}

export function listAllSessionNames() {
    try {
        return readdirSync(sessionsBaseDir).filter(name => {
            try {
                return existsSync(sessionFilePath(name)) || existsSync(sessionStartingFilePath(name));
            } catch {
                return false;
            }
        });
    } catch {
        return [];
    }
}

export function listRunningSessions(): string[] {
    const all = listAllSessionNames();
    const running: string[] = [];
    for (const name of all) {
        const info = getSessionInfo(name);
        if (info && classifySessionControllerOwnership(name, {
            info,
            starting: null,
        }).status !== 'abandoned') {
            running.push(name);
        }
    }
    return running;
}
