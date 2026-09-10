import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_SCHEMA_VERSION,
    isWindowsTestRunId,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { ownershipMatches } from '@scripts/windows-test/host/hostProcessIdentity';
import type {
    IHostLockDependencies,
    IHostLockOptions,
} from '@scripts/windows-test/host/hostLock';
import { withHostLock } from '@scripts/windows-test/host/hostLock';

export interface IWindowsTestLease {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    hostId: string;
    vmId: string | null;
    runId: string;
    ownerPid: number;
    ownerStartTime: string;
    createdAt: string;
}

export function isWindowsTestLease(value: unknown): value is IWindowsTestLease {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && typeof value.hostId === 'string'
        && (value.vmId === null || typeof value.vmId === 'string')
        && isWindowsTestRunId(value.runId)
        && typeof value.ownerPid === 'number'
        && Number.isInteger(value.ownerPid)
        && typeof value.ownerStartTime === 'string'
        && typeof value.createdAt === 'string';
}

/**
 * Only an absent lease file means "no lease". An unreadable or malformed file
 * is reported instead of being treated as free, because silently ignoring it
 * would let two runs share the single test VM.
 */
export async function readHostLease(leaseFile: string): Promise<IWindowsTestLease | null> {
    let raw: string;
    try {
        raw = await readFile(leaseFile, 'utf8');
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Cannot read the host lease ${leaseFile}: ${getErrorMessage(error)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`The host lease ${leaseFile} is not valid JSON (${getErrorMessage(error)}); inspect and remove it by hand.`);
    }
    if (!isWindowsTestLease(parsed)) {
        throw new Error(`The host lease ${leaseFile} does not match the lease schema; inspect and remove it by hand.`);
    }
    return parsed;
}

async function writeHostLease(leaseFile: string, lease: IWindowsTestLease) {
    await mkdir(path.dirname(leaseFile), {recursive: true});
    await writeFile(leaseFile, `${JSON.stringify(lease, null, 4)}\n`, 'utf8');
}

export const hostLeaseStates = [
    'held',
    'stale',
] as const;

export type THostLeaseState = typeof hostLeaseStates[number];

// A lease is only reclaimable once the recorded owner is provably gone: the PID
// is dead, or the PID exists with a different start time after reuse.
export async function evaluateHostLease(
    lease: IWindowsTestLease,
    probe: IHostProcessIdentityProbe,
): Promise<THostLeaseState> {
    const alive = probe.isAlive(lease.ownerPid);
    const observedStartTime = alive ? await probe.startTime(lease.ownerPid) : null;
    return ownershipMatches({
        alive,
        observedStartTime,
    }, lease.ownerStartTime)
        ? 'held'
        : 'stale';
}

export interface IHostLeaseAcquisition {
    acquired: boolean;
    lease: IWindowsTestLease | null;
    activeRunId: string | null;
    recoveredLease: IWindowsTestLease | null;
}

export interface IHostLeaseRequest {
    leaseFile: string;
    lockDirectory: string;
    runId: string;
    hostId: string;
    lock: IHostLockDependencies;
    probe: IHostProcessIdentityProbe;
    nowIso(): string;
    recoverStaleOwner?(lease: IWindowsTestLease): Promise<void>;
    lockOptions?: IHostLockOptions;
}

export async function acquireHostLease(request: IHostLeaseRequest): Promise<IHostLeaseAcquisition> {
    return withHostLock(request.lockDirectory, request.lock, async () => {
        const existing = await readHostLease(request.leaseFile);
        let recoveredLease: IWindowsTestLease | null = null;
        if (existing !== null) {
            if (await evaluateHostLease(existing, request.probe) === 'held') {
                return {
                    acquired: false,
                    lease: null,
                    activeRunId: existing.runId,
                    recoveredLease: null,
                };
            }
            await request.recoverStaleOwner?.(existing);
            recoveredLease = existing;
        }

        // Without our own start time a later reader could never tell this
        // lease from a stale one left by a recycled pid, so refuse to hold it.
        const ownerStartTime = await request.probe.startTime(request.lock.pid);
        if (ownerStartTime === null) {
            throw new Error(`Cannot record the lease owner: the start time of pid ${request.lock.pid} is unavailable.`);
        }
        const lease: IWindowsTestLease = {
            schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
            hostId: request.hostId,
            vmId: null,
            runId: request.runId,
            ownerPid: request.lock.pid,
            ownerStartTime,
            createdAt: request.nowIso(),
        };
        await writeHostLease(request.leaseFile, lease);
        return {
            acquired: true,
            lease,
            activeRunId: lease.runId,
            recoveredLease,
        };
    }, request.lockOptions);
}

export interface IHostLeaseMutationRequest {
    leaseFile: string;
    lockDirectory: string;
    runId: string;
    lock: IHostLockDependencies;
    lockOptions?: IHostLockOptions;
}

export async function bindLeaseToVm(
    request: IHostLeaseMutationRequest,
    vmId: string,
) {
    return withHostLock(request.lockDirectory, request.lock, async () => {
        const lease = await readHostLease(request.leaseFile);
        if (lease === null || lease.runId !== request.runId) {
            return null;
        }
        const updated: IWindowsTestLease = {
            ...lease,
            vmId,
        };
        await writeHostLease(request.leaseFile, updated);
        return updated;
    }, request.lockOptions);
}

export async function releaseHostLease(request: IHostLeaseMutationRequest) {
    return withHostLock(request.lockDirectory, request.lock, async () => {
        const lease = await readHostLease(request.leaseFile);
        if (lease !== null && lease.runId !== request.runId) {
            return false;
        }
        await rm(request.leaseFile, {force: true});
        return true;
    }, request.lockOptions);
}
