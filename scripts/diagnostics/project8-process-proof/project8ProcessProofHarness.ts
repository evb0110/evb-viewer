import {
    spawn, type ChildProcess,
} from 'node:child_process';
import {
    mkdtemp,
    readFile,
    readlink,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    basename, join,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';

export type TProject8ProcessProofRole = 'worker' | 'native-parent' | 'native-descendant';

export interface IProject8ProcessIdentity {
    command: string;
    executable: string;
    fixtureRoot: string;
    pgid: number;
    pid: number;
    ppid: number;
    role: TProject8ProcessProofRole;
    startTime: string;
    token: string;
}

interface IProject8NativeReadyMarker {
    descendant: {identity: IProject8ProcessIdentity;};
    identity: IProject8ProcessIdentity;
    schemaVersion: 1;
    token: string;
}

interface IProject8WorkerReadyMarker {
    native: IProject8NativeReadyMarker;
    schemaVersion: 1;
    token: string;
    worker: IProject8ProcessIdentity;
}

interface IProject8StartedMarker {
    identity: IProject8ProcessIdentity;
    schemaVersion: 1;
    token: string;
}

export interface IProject8ProcessProofEvidence {
    descendant: IProject8ProcessIdentity;
    descendantExitedAfterProof: boolean;
    descendantProcessGroupGoneAfterProof: boolean;
    descendantSurvivedNativeParentExit: boolean;
    descendantSurvivedWorkerExit: boolean;
    descendantWasReparented: boolean;
    identityMismatchRejected: boolean;
    nativeParent: IProject8ProcessIdentity;
    nativeParentExited: boolean;
    processGroupIdentityProven: boolean;
    rootName: string;
    terminationProven: boolean;
    token: string;
    worker: IProject8ProcessIdentity;
    workerExited: boolean;
}

const fixtureScriptPath = fileURLToPath(new URL(
    '../../../tests/fixtures/project8-process-proof/process-proof-fixture.mjs',
    import.meta.url,
));
const markerTimeoutMs = 5_000;
const processTimeoutMs = 5_000;
const processPollMs = 25;

function isErrno(error: unknown, code: string) {
    return error instanceof Error && 'code' in error && error.code === code;
}

function waitMs(milliseconds: number) {
    return new Promise<void>(resolve => {
        setTimeout(resolve, milliseconds);
    });
}

function assertCondition(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(`[project8-process-proof] ${message}`);
    }
}

function formatMarkerValue(value: unknown) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return 'undefined';
    }
    try {
        return JSON.stringify(value) ?? typeof value;
    } catch {
        return typeof value;
    }
}

async function readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
    try {
        return await readJson<T>(path);
    } catch (error) {
        if (isErrno(error, 'ENOENT')) {
            return null;
        }
        throw error;
    }
}

async function waitForJsonMarker<T>(root: string, name: string): Promise<T> {
    const path = join(root, name);
    const deadline = Date.now() + markerTimeoutMs;
    while (Date.now() < deadline) {
        const fixtureError = await readJsonIfPresent<{error?: unknown}>(join(root, 'fixture-error.json'));
        if (fixtureError) {
            throw new Error(`fixture reported an error: ${formatMarkerValue(fixtureError.error ?? 'unknown error')}`);
        }
        const fixtureTimeout = await readJsonIfPresent<{role?: unknown}>(join(root, 'fixture-timeout.json'));
        if (fixtureTimeout) {
            throw new Error(`fixture role timed out: ${formatMarkerValue(fixtureTimeout.role ?? 'unknown')}`);
        }
        const marker = await readJsonIfPresent<T>(path);
        if (marker !== null) {
            return marker;
        }
        await waitMs(processPollMs);
    }
    throw new Error(`timed out waiting for fixture marker ${name}`);
}

async function writeMarker(root: string, name: string) {
    await writeFile(join(root, name), '', 'utf8');
}

async function readLinuxProcessIdentity(
    pid: number,
    role: TProject8ProcessProofRole,
    root: string,
    token: string,
): Promise<IProject8ProcessIdentity> {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    assertCondition(commandEnd >= 0, `cannot parse /proc stat for PID ${String(pid)}`);
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const command = (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean)
        .join(' ');
    return {
        command,
        executable: await readlink(`/proc/${String(pid)}/exe`),
        fixtureRoot: root,
        pgid: Number(fields[2]),
        pid,
        ppid: Number(fields[1]),
        role,
        startTime: fields[19] ?? '',
        token,
    };
}

function isTaskOwnedIdentity(
    identity: IProject8ProcessIdentity,
    expected: Pick<IProject8ProcessIdentity, 'fixtureRoot' | 'role' | 'token'>,
) {
    const commandLine = [
        fixtureScriptPath,
        expected.role,
        expected.fixtureRoot,
        expected.token,
    ].join(' ');
    return identity.fixtureRoot === expected.fixtureRoot
        && identity.role === expected.role
        && identity.token === expected.token
        && identity.command.includes(commandLine);
}

export function matchesProject8ProcessIdentity(
    actual: IProject8ProcessIdentity,
    expected: IProject8ProcessIdentity,
) {
    return actual.pid === expected.pid
        && actual.role === expected.role
        && actual.token === expected.token
        && actual.fixtureRoot === expected.fixtureRoot
        && actual.startTime === expected.startTime
        && actual.pgid === expected.pgid
        && actual.command === expected.command
        && actual.executable === expected.executable;
}

function isProcessGroupAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number, timeoutMs = processTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await waitMs(processPollMs);
    }
    return !isProcessAlive(pid);
}

async function waitForProcessGroupGone(pid: number, timeoutMs = processTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessGroupAlive(pid)) {
            return true;
        }
        await waitMs(processPollMs);
    }
    return !isProcessGroupAlive(pid);
}

function spawnWorker(root: string, token: string) {
    const worker = spawn(process.execPath, [
        fixtureScriptPath,
        'worker',
        root,
        token,
    ], {
        cwd: root,
        env: {
            ...process.env,
            EVB_PROJECT8_PROOF_TOKEN: token,
        },
        stdio: 'ignore',
    });
    assertCondition(typeof worker.pid === 'number' && worker.pid > 0, 'worker did not receive a PID');
    return worker;
}

async function terminateOwnedNativeTree(
    nativeParent: IProject8ProcessIdentity,
    descendant: IProject8ProcessIdentity,
) {
    const parentAlive = isProcessAlive(nativeParent.pid);
    const currentParent = parentAlive
        ? await readLinuxProcessIdentity(nativeParent.pid, 'native-parent', nativeParent.fixtureRoot, nativeParent.token)
        : null;
    const currentDescendant = isProcessAlive(descendant.pid)
        ? await readLinuxProcessIdentity(descendant.pid, descendant.role, descendant.fixtureRoot, descendant.token)
        : null;
    const parentStillMatches = parentAlive
        && isTaskOwnedIdentity(nativeParent, nativeParent)
        && currentParent !== null
        && matchesProject8ProcessIdentity(currentParent, nativeParent)
        && currentParent.pgid === nativeParent.pid;
    const descendantStillMatches = !parentAlive
        && isTaskOwnedIdentity(descendant, descendant)
        && currentDescendant !== null
        && matchesProject8ProcessIdentity(currentDescendant, descendant)
        && currentDescendant.pgid === nativeParent.pid;
    if (!parentStillMatches && !descendantStillMatches) {
        return false;
    }
    if (!isProcessGroupAlive(nativeParent.pid)) {
        return !isProcessAlive(descendant.pid);
    }
    try {
        process.kill(-nativeParent.pid, 'SIGTERM');
    } catch {
        return !isProcessGroupAlive(nativeParent.pid) && !isProcessAlive(descendant.pid);
    }
    if (await waitForProcessGroupGone(nativeParent.pid, 500)) {
        return true;
    }
    try {
        process.kill(-nativeParent.pid, 'SIGKILL');
    } catch {
        return false;
    }
    return (await waitForProcessGroupGone(nativeParent.pid, 1_000))
        && !isProcessAlive(descendant.pid);
}

async function cleanupFixture(
    root: string,
    token: string,
    worker: ChildProcess,
    workerIdentity: IProject8ProcessIdentity | null,
    nativeParentIdentity: IProject8ProcessIdentity | null,
    descendantIdentity: IProject8ProcessIdentity | null,
) {
    await Promise.all([
        writeMarker(root, 'release-worker'),
        writeMarker(root, 'release-native-parent'),
    ]);

    if (nativeParentIdentity && descendantIdentity) {
        await terminateOwnedNativeTree(nativeParentIdentity, descendantIdentity);
    }

    if (workerIdentity && worker.pid && isProcessAlive(worker.pid)) {
        const currentWorker = await readLinuxProcessIdentity(worker.pid, 'worker', root, token);
        if (matchesProject8ProcessIdentity(currentWorker, workerIdentity)) {
            worker.kill('SIGKILL');
        }
    } else if (worker.pid && worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
    }

    if (descendantIdentity && isProcessAlive(descendantIdentity.pid)) {
        const currentDescendant = await readLinuxProcessIdentity(
            descendantIdentity.pid,
            descendantIdentity.role,
            root,
            token,
        );
        if (matchesProject8ProcessIdentity(currentDescendant, descendantIdentity)) {
            process.kill(descendantIdentity.pid, 'SIGKILL');
        }
    }

    if (worker.pid) {
        await waitForProcessExit(worker.pid, 1_000);
    }
    if (descendantIdentity) {
        await waitForProcessExit(descendantIdentity.pid, 1_000);
    }
    if (nativeParentIdentity) {
        await waitForProcessGroupGone(nativeParentIdentity.pid, 1_000);
    }

    const survivors = [
        worker.pid && isProcessAlive(worker.pid) ? `worker:${String(worker.pid)}` : null,
        descendantIdentity && isProcessAlive(descendantIdentity.pid)
            ? `descendant:${String(descendantIdentity.pid)}`
            : null,
        nativeParentIdentity && isProcessGroupAlive(nativeParentIdentity.pid)
            ? `group:${String(nativeParentIdentity.pid)}`
            : null,
    ].filter((value): value is string => value !== null);
    assertCondition(survivors.length === 0, `refusing to remove fixture root while processes remain: ${survivors.join(', ')}`);
    await rm(root, {
        force: true,
        recursive: true,
    });
}

export async function runProject8ProcessProof(): Promise<IProject8ProcessProofEvidence> {
    if (process.platform !== 'linux') {
        throw new Error('Project 8 process proof is a local Linux fixture');
    }

    const root = await mkdtemp(join(tmpdir(), 'evb-project8-process-proof-'));
    const token = `${basename(root)}-${randomUUID().replaceAll('-', '')}`;
    const worker = spawnWorker(root, token);
    let workerIdentity: IProject8ProcessIdentity | null = null;
    let nativeParentIdentity: IProject8ProcessIdentity | null = null;
    let descendantIdentity: IProject8ProcessIdentity | null = null;
    let evidence: IProject8ProcessProofEvidence | null = null;
    let primaryError: unknown;
    let primaryFailed = false;

    try {
        const ready = await waitForJsonMarker<IProject8WorkerReadyMarker>(root, 'worker-ready.json');
        assertCondition(ready.schemaVersion === 1 && ready.token === token, 'worker marker identity is invalid');
        workerIdentity = ready.worker;
        nativeParentIdentity = ready.native.identity;
        descendantIdentity = ready.native.descendant.identity;
        assertCondition(isTaskOwnedIdentity(workerIdentity, workerIdentity), 'worker command identity is not task-owned');
        assertCondition(isTaskOwnedIdentity(nativeParentIdentity, nativeParentIdentity), 'native parent command identity is not task-owned');
        assertCondition(isTaskOwnedIdentity(descendantIdentity, descendantIdentity), 'native descendant command identity is not task-owned');
        assertCondition(nativeParentIdentity.pgid === nativeParentIdentity.pid, 'native parent did not own a detached process group');
        assertCondition(descendantIdentity.pgid === nativeParentIdentity.pid, 'native descendant did not inherit the detached process group');
        const observedWorker = await readLinuxProcessIdentity(worker.pid!, 'worker', root, token);
        assertCondition(matchesProject8ProcessIdentity(observedWorker, workerIdentity), 'worker identity changed before handoff');
        const observedDescendant = await readLinuxProcessIdentity(
            descendantIdentity.pid,
            'native-descendant',
            root,
            token,
        );
        assertCondition(matchesProject8ProcessIdentity(observedDescendant, descendantIdentity), 'descendant identity changed before handoff');

        await writeMarker(root, 'release-worker');
        const workerExited = await waitForProcessExit(worker.pid!);
        assertCondition(workerExited, 'worker did not exit after its explicit release barrier');
        const descendantAfterWorkerExit = await readLinuxProcessIdentity(
            descendantIdentity.pid,
            'native-descendant',
            root,
            token,
        );
        const descendantSurvivedWorkerExit = isProcessAlive(descendantIdentity.pid)
            && matchesProject8ProcessIdentity(descendantAfterWorkerExit, descendantIdentity);
        assertCondition(descendantSurvivedWorkerExit, 'native descendant did not survive worker exit');

        await writeMarker(root, 'release-native-parent');
        const nativeParentExited = await waitForProcessExit(nativeParentIdentity.pid);
        assertCondition(nativeParentExited, 'native parent did not exit after its explicit release barrier');
        const descendantAfterParentExit = await readLinuxProcessIdentity(
            descendantIdentity.pid,
            'native-descendant',
            root,
            token,
        );
        const descendantSurvivedNativeParentExit = isProcessAlive(descendantIdentity.pid)
            && matchesProject8ProcessIdentity(descendantAfterParentExit, descendantIdentity);
        assertCondition(descendantSurvivedNativeParentExit, 'native descendant did not survive native parent exit');
        const descendantWasReparented = descendantAfterParentExit.ppid !== nativeParentIdentity.pid;
        assertCondition(descendantWasReparented, 'native descendant remained parented to the exited native parent');

        const staleIdentity = {
            ...descendantAfterParentExit,
            startTime: `stale-${descendantAfterParentExit.startTime}`,
        };
        const staleTerminationAttempt = await terminateOwnedNativeTree(nativeParentIdentity, staleIdentity);
        const identityMismatchRejected = !matchesProject8ProcessIdentity(descendantAfterParentExit, staleIdentity)
            && staleTerminationAttempt === false;
        assertCondition(identityMismatchRejected, 'stale descendant identity was accepted');
        assertCondition(isProcessAlive(descendantIdentity.pid), 'identity mismatch check disturbed the live descendant');

        const processGroupIdentityProven = descendantAfterParentExit.pgid === nativeParentIdentity.pid;
        assertCondition(processGroupIdentityProven, 'descendant process group no longer matched the registered parent identity');
        const terminationProven = await terminateOwnedNativeTree(nativeParentIdentity, descendantAfterParentExit);
        assertCondition(terminationProven, 'detached process-tree termination was not proven');
        const descendantExitedAfterProof = await waitForProcessExit(descendantIdentity.pid);
        const descendantProcessGroupGoneAfterProof = await waitForProcessGroupGone(nativeParentIdentity.pid);
        assertCondition(descendantExitedAfterProof, 'descendant remained alive after termination proof');
        assertCondition(descendantProcessGroupGoneAfterProof, 'native process group remained alive after termination proof');

        evidence = {
            descendant: descendantAfterParentExit,
            descendantExitedAfterProof,
            descendantProcessGroupGoneAfterProof,
            descendantSurvivedNativeParentExit,
            descendantSurvivedWorkerExit,
            descendantWasReparented,
            identityMismatchRejected,
            nativeParent: nativeParentIdentity,
            nativeParentExited,
            processGroupIdentityProven,
            rootName: basename(root),
            terminationProven,
            token,
            worker: workerIdentity,
            workerExited,
        };
    } catch (error) {
        primaryFailed = true;
        primaryError = error;
    }

    let cleanupError: unknown;
    let cleanupFailed = false;
    try {
        const started = await readJsonIfPresent<IProject8StartedMarker>(join(root, 'native-parent-started.json'));
        const descendantReady = await readJsonIfPresent<{identity: IProject8ProcessIdentity;}>(join(root, 'descendant-ready.json'));
        await cleanupFixture(
            root,
            token,
            worker,
            workerIdentity,
            nativeParentIdentity ?? started?.identity ?? null,
            descendantIdentity ?? descendantReady?.identity ?? null,
        );
    } catch (error) {
        cleanupFailed = true;
        cleanupError = error;
    }

    if (primaryFailed) {
        if (cleanupFailed) {
            process.stderr.write(`[project8-process-proof] cleanup warning after failure: ${formatMarkerValue(cleanupError)}\n`);
        }
        throw primaryError;
    }
    if (cleanupFailed) {
        throw cleanupError;
    }
    assertCondition(evidence !== null, 'process proof did not produce evidence');
    return evidence;
}
