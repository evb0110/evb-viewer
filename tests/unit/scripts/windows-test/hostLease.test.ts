import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import { windowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    acquireHostLease,
    bindLeaseToVm,
    evaluateHostLease,
    readHostLease,
    releaseHostLease,
} from '@scripts/windows-test/host/hostLease';
import type { IWindowsTestLease } from '@scripts/windows-test/host/hostLease';
import {
    HostLockBusyError,
    acquireHostLock,
} from '@scripts/windows-test/host/hostLock';
import type { IHostLockDependencies } from '@scripts/windows-test/host/hostLock';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';

const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';
const RUN_ID = '20260904T120000Z-0123456789ab';
const OTHER_RUN_ID = '20260904T110000Z-ba9876543210';

function fakeProbe(processes: Map<number, string | null>): IHostProcessIdentityProbe {
    return {
        isAlive: pid => processes.has(pid),
        startTime: pid => Promise.resolve(processes.get(pid) ?? null),
    };
}

function lockDependencies(
    pid: number,
    probe: IHostProcessIdentityProbe,
    hostId = 'test-host',
): IHostLockDependencies {
    return {
        hostId,
        pid,
        probe,
        nowIso: () => '2026-09-04T12:00:00.000Z',
        sleep: () => Promise.resolve(),
    };
}

describe('windows test host lock and lease', () => {
    let dataRoot = '';
    let layout: IWindowsTestHostLayout;

    beforeEach(async () => {
        dataRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-lease-'));
        layout = windowsTestHostLayout(dataRoot);
    });

    afterEach(async () => {
        await rm(dataRoot, {
            force: true,
            recursive: true,
        });
    });

    it('refuses a second lock while the first owner is alive', async () => {
        const probe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        const handle = await acquireHostLock(layout.lockFile, lockDependencies(4_242, probe));

        await expect(acquireHostLock(layout.lockFile, lockDependencies(4_243, probe), {
            attempts: 1,
            retryDelayMs: 0,
        })).rejects.toBeInstanceOf(HostLockBusyError);

        await handle.release();
        await expect(stat(layout.lockFile)).rejects.toThrow();
    });

    it('breaks a lock whose owner process is gone', async () => {
        const aliveProbe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        await acquireHostLock(layout.lockFile, lockDependencies(4_242, aliveProbe));

        const survivorProbe = fakeProbe(new Map([[
            5_555,
            'Fri Sep  4 12:05:00 2026',
        ]]));
        const handle = await acquireHostLock(layout.lockFile, lockDependencies(5_555, survivorProbe), {
            attempts: 2,
            retryDelayMs: 0,
        });

        expect(handle.owner.pid).toBe(5_555);
        await handle.release();
    });

    it('reports a live lease as busy and names the active run', async () => {
        const probe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: OTHER_RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(4_242, probe),
            probe,
            nowIso: () => '2026-09-04T11:00:00.000Z',
        });

        const second = await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(4_242, probe),
            probe,
            nowIso: () => '2026-09-04T12:00:00.000Z',
        });

        expect(second.acquired).toBe(false);
        expect(second.activeRunId).toBe(OTHER_RUN_ID);
    });

    it('recovers a stale lease, runs the recovery hook and preserves the incomplete run', async () => {
        const deadOwnerProbe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: OTHER_RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(4_242, deadOwnerProbe),
            probe: deadOwnerProbe,
            nowIso: () => '2026-09-04T11:00:00.000Z',
        });
        await bindLeaseToVm({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: OTHER_RUN_ID,
            lock: lockDependencies(4_242, deadOwnerProbe),
        }, CLONE_VM_ID);

        const recovered: IWindowsTestLease[] = [];
        const newOwnerProbe = fakeProbe(new Map([[
            7_777,
            'Fri Sep  4 12:10:00 2026',
        ]]));
        const acquisition = await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(7_777, newOwnerProbe),
            probe: newOwnerProbe,
            nowIso: () => '2026-09-04T12:10:00.000Z',
            recoverStaleOwner: (lease) => {
                recovered.push(lease);
                return Promise.resolve();
            },
        });

        expect(acquisition.acquired).toBe(true);
        expect(acquisition.recoveredLease?.runId).toBe(OTHER_RUN_ID);
        expect(recovered[0]?.vmId).toBe(CLONE_VM_ID);
        expect(JSON.parse(await readFile(layout.leaseFile, 'utf8'))).toMatchObject({
            runId: RUN_ID,
            ownerPid: 7_777,
        });
    });

    it('treats a reused PID with a different start time as stale', async () => {
        const lease: IWindowsTestLease = {
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: null,
            runId: RUN_ID,
            ownerPid: 4_242,
            ownerStartTime: 'Fri Sep  4 12:00:00 2026',
            createdAt: '2026-09-04T12:00:00.000Z',
        };

        expect(await evaluateHostLease(lease, fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]])))).toBe('held');
        expect(await evaluateHostLease(lease, fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 18:30:00 2026',
        ]])))).toBe('stale');
        expect(await evaluateHostLease(lease, fakeProbe(new Map()))).toBe('stale');
    });

    it('only releases a lease that belongs to the caller', async () => {
        const probe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(4_242, probe),
            probe,
            nowIso: () => '2026-09-04T12:00:00.000Z',
        });

        expect(await releaseHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: OTHER_RUN_ID,
            lock: lockDependencies(4_242, probe),
        })).toBe(false);
        expect(await readHostLease(layout.leaseFile)).not.toBeNull();
        expect(await releaseHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            lock: lockDependencies(4_242, probe),
        })).toBe(true);
        expect(await readHostLease(layout.leaseFile)).toBeNull();
    });

    it('serializes lease mutations behind the host lock', async () => {
        const probe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            hostId: 'test-host',
            lock: lockDependencies(4_242, probe),
            probe,
            nowIso: () => '2026-09-04T12:00:00.000Z',
        });
        const lock = await acquireHostLock(layout.lockFile, lockDependencies(4_242, probe));
        const mutation = {
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId: RUN_ID,
            lock: lockDependencies(4_243, probe),
            lockOptions: {attempts: 1, retryDelayMs: 0},
        };

        await expect(bindLeaseToVm(mutation, CLONE_VM_ID)).rejects.toBeInstanceOf(HostLockBusyError);
        await expect(releaseHostLease(mutation)).rejects.toBeInstanceOf(HostLockBusyError);
        await lock.release();
    });

    it('reports a malformed lease file instead of treating the VM as free', async () => {
        await mkdir(path.dirname(layout.leaseFile), {recursive: true});
        await writeFile(layout.leaseFile, '{not json', 'utf8');

        await expect(readHostLease(layout.leaseFile)).rejects.toThrow('not valid JSON');

        await writeFile(layout.leaseFile, JSON.stringify({runId: RUN_ID}), 'utf8');
        await expect(readHostLease(layout.leaseFile)).rejects.toThrow('does not match the lease schema');
    });

    it('keeps a lock whose live owner has an unreadable start time', async () => {
        const ownerProbe = fakeProbe(new Map([[
            4_242,
            'Fri Sep  4 12:00:00 2026',
        ]]));
        const handle = await acquireHostLock(layout.lockFile, lockDependencies(4_242, ownerProbe));

        // The owner is alive but ps failed for it: unknown ownership stays busy.
        const blindProbe = fakeProbe(new Map<number, string | null>([
            [
                4_242,
                null,
            ],
            [
                5_555,
                'Fri Sep  4 12:05:00 2026',
            ],
        ]));
        await expect(acquireHostLock(layout.lockFile, lockDependencies(5_555, blindProbe), {
            attempts: 2,
            retryDelayMs: 0,
        })).rejects.toBeInstanceOf(HostLockBusyError);
        await handle.release();
    });

    it('reports a malformed lock owner file instead of breaking the lock', async () => {
        await mkdir(layout.lockFile, {recursive: true});
        await writeFile(path.join(layout.lockFile, 'owner.json'), '{not json', 'utf8');

        await expect(acquireHostLock(layout.lockFile, lockDependencies(5_555, fakeProbe(new Map()))))
            .rejects.toThrow('not valid JSON');
        await expect(stat(path.join(layout.lockFile, 'owner.json'))).resolves.toBeDefined();
    });

    it('refuses to hold the lock when its own start time is unknown and leaves no directory behind', async () => {
        const blindProbe = fakeProbe(new Map());

        await expect(acquireHostLock(layout.lockFile, lockDependencies(7_777, blindProbe)))
            .rejects.toThrow('start time of pid 7777 is unavailable');
        await expect(stat(layout.lockFile)).rejects.toThrow();
    });
});
