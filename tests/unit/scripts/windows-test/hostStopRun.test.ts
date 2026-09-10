import {
    mkdir,
    mkdtemp,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    windowsTestHostLayout,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { requestWindowsTestStop } from '@scripts/windows-test/host/stopRun';
import type {
    IUtmVmListEntry,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';

const GOLDEN_VM_ID = '11111111-2222-4333-8444-555555555555';
const TEST_VM_ID = '22222222-3333-4444-8555-666666666666';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const RUN_ID = '20260904T120000Z-0123456789ab';
const LIVE_PID = 4_242;
const DEAD_PID = 5_555;
const LIVE_START_TIME = 'Fri Sep  4 12:00:00 2026';
const CLONE_NAME = `evb-win-test-${RUN_ID}`;

function createFakeUtmctl(options: {
    statusAfterStop?: string;
    statusSequence?: string[];
    registered?: IUtmVmListEntry[];
} = {}) {
    const calls: string[] = [];
    const statusSequence = [...(options.statusSequence ?? [])];
    const client: IUtmctlClient & {calls: string[]} = {
        calls,
        version: () => Promise.resolve('utmctl version 4.7.5 (118)'),
        list: () => Promise.resolve(options.registered ?? [{
            uuid: CLONE_VM_ID,
            status: 'stopped',
            name: CLONE_NAME,
        }]),
        status: (vmId) => {
            calls.push(`status ${vmId}`);
            return Promise.resolve(statusSequence.shift() ?? options.statusAfterStop ?? 'stopped');
        },
        start: (vmId) => {
            calls.push(`start ${vmId}`);
            return Promise.resolve();
        },
        stop: (vmId, mode) => {
            calls.push(`stop ${mode} ${vmId}`);
            return Promise.resolve();
        },
        clone: (vmId) => {
            calls.push(`clone ${vmId}`);
            return Promise.resolve();
        },
        deleteVm: (vmId) => {
            calls.push(`delete ${vmId}`);
            return Promise.resolve();
        },
        ipAddress: () => Promise.resolve([]),
        exec: () => Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
            transportFailure: null,
        }),
        pushFile: () => Promise.resolve(),
        pullFile: () => Promise.resolve(),
    };
    return client;
}

const probe: IHostProcessIdentityProbe = {
    isAlive: pid => pid === LIVE_PID,
    startTime: pid => Promise.resolve(pid === LIVE_PID ? LIVE_START_TIME : null),
};

interface IHarnessOptions {
    lease?: Record<string, unknown> | null;
    createRunDir?: boolean;
    utmctl?: ReturnType<typeof createFakeUtmctl>;
}

async function createStopHarness(options: IHarnessOptions = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-stop-'));
    const layout = windowsTestHostLayout(root);
    await mkdir(layout.imagesDir, {recursive: true});
    const runLayout = windowsTestRunLayout(layout.runsDir, RUN_ID);
    if (options.createRunDir !== false) {
        await mkdir(runLayout.runDir, {recursive: true});
        await writeFile(runLayout.transitionsFile, '{"state":"testing","elapsedMs":1,"reason":"in flight"}\n', 'utf8');
    }
    if (options.lease != null) {
        await mkdir(layout.root, {recursive: true});
        await writeFile(layout.leaseFile, JSON.stringify(options.lease), 'utf8');
    }

    const config: IWindowsTestHostConfig = {
        schemaVersion: 1,
        testImageRoot: layout.imagesDir,
        allowedTestVmIds: [TEST_VM_ID],
        goldenImageId: 'win11-arm64-2026-09',
        goldenVmId: GOLDEN_VM_ID,
        personalVmIdsDenied: [PERSONAL_VM_ID],
        candidate: null,
        environment: 'win11-arm64',
        qualifiedLaunchers: ['/bin/zsh'],
        retention: {
            passDays: 3,
            failureDays: 14,
            maxFailedClones: 2,
            minFreeBytes: 1_024,
        },
    };

    const utmctl = options.utmctl ?? createFakeUtmctl();
    return {
        layout,
        runLayout,
        utmctl,
        stop: (runId: string = RUN_ID) => requestWindowsTestStop({
            runId,
            reason: 'operator asked for a stop',
        }, {
            layout,
            config,
            utmctl,
            probe,
            lock: {
                hostId: 'test-host',
                pid: LIVE_PID,
                probe,
                nowIso: () => '2026-09-04T12:30:00.000Z',
                sleep: () => Promise.resolve(),
            },
            nowIso: () => '2026-09-04T12:30:00.000Z',
            identityGuard: {
                resolvePath: target => Promise.resolve(target),
                readVmId: () => Promise.resolve(CLONE_VM_ID),
                readVmName: () => Promise.resolve(CLONE_NAME),
            },
        }),
    };
}

function lease(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        hostId: 'test-host',
        vmId: CLONE_VM_ID,
        runId: RUN_ID,
        ownerPid: DEAD_PID,
        ownerStartTime: 'Thu Sep  3 09:00:00 2026',
        createdAt: '2026-09-04T12:00:00.000Z',
        ...overrides,
    };
}

async function exists(target: string) {
    return (await stat(target).catch(() => null)) !== null;
}

describe('windows test stop request', () => {
    it('rejects a malformed run ID before touching the filesystem', async () => {
        const harness = await createStopHarness();

        const result = await harness.stop('yesterday');

        expect(result.exitCode).toBe(1);
        expect(result.messages.join('')).toContain('is not a Windows test run ID');
        expect(await exists(harness.runLayout.cancelRequestFile)).toBe(false);
    });

    it('rejects a run that has no directory', async () => {
        const harness = await createStopHarness({createRunDir: false});

        const result = await harness.stop();

        expect(result.exitCode).toBe(1);
        expect(result.messages.join('')).toContain('has no directory');
    });

    it('writes a cancel request when no lease exists at all', async () => {
        const harness = await createStopHarness();

        const result = await harness.stop();

        expect(result.exitCode).toBe(0);
        expect(result.recovered).toBe(false);
        expect(JSON.parse(await readFile(harness.runLayout.cancelRequestFile, 'utf8'))).toMatchObject({
            runId: RUN_ID,
            reason: 'operator asked for a stop',
        });
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('leaves teardown to a live owner and touches no VM', async () => {
        const harness = await createStopHarness({lease: lease({
            ownerPid: LIVE_PID,
            ownerStartTime: LIVE_START_TIME,
        })});

        const result = await harness.stop();

        expect(result.exitCode).toBe(0);
        expect(result.recovered).toBe(false);
        expect(result.messages.join(' ')).toContain(`still owned by pid ${LIVE_PID}`);
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('leaves a lease that belongs to another run untouched', async () => {
        const harness = await createStopHarness({lease: lease({
            runId: '20260903T090000Z-abcdefabcdef',
            ownerPid: LIVE_PID,
            ownerStartTime: LIVE_START_TIME,
        })});

        const result = await harness.stop();

        expect(result.exitCode).toBe(0);
        expect(await exists(harness.layout.leaseFile)).toBe(true);
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('recovers a stale owner, stops its clone and preserves the incomplete run', async () => {
        const harness = await createStopHarness({lease: lease()});

        const result = await harness.stop();

        expect(result.exitCode).toBe(0);
        expect(result.recovered).toBe(true);
        expect(harness.utmctl.calls).toEqual([
            `stop request ${CLONE_VM_ID}`,
            `status ${CLONE_VM_ID}`,
        ]);
        expect(harness.utmctl.calls).not.toContain(`delete ${CLONE_VM_ID}`);
        expect(await exists(harness.layout.leaseFile)).toBe(false);
        expect(await exists(harness.runLayout.transitionsFile)).toBe(true);
    });

    it('retains a failed forced stop for an explicit retry', async () => {
        const harness = await createStopHarness({
            lease: lease(),
            utmctl: createFakeUtmctl({statusSequence: ['started', 'started', 'stopped']}),
        });

        const firstResult = await harness.stop();

        expect(firstResult.exitCode).toBe(3);
        expect(firstResult.recovered).toBe(false);
        expect(harness.utmctl.calls).toEqual([
            `stop request ${CLONE_VM_ID}`,
            `status ${CLONE_VM_ID}`,
            `stop force ${CLONE_VM_ID}`,
            `status ${CLONE_VM_ID}`,
        ]);
        expect(await exists(harness.layout.leaseFile)).toBe(true);

        const retryResult = await harness.stop();

        expect(retryResult.exitCode).toBe(0);
        expect(retryResult.recovered).toBe(true);
        expect(await exists(harness.layout.leaseFile)).toBe(false);
    });

    it('retains an unbound stale lease instead of releasing the host exclusion', async () => {
        const harness = await createStopHarness({lease: lease({vmId: null})});

        const result = await harness.stop();

        expect(result.exitCode).toBe(3);
        expect(result.recovered).toBe(false);
        expect(result.messages.join(' ')).toContain('has no bound clone identity');
        expect(await exists(harness.layout.leaseFile)).toBe(true);
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('refuses stale recovery when the registered UUID has another name', async () => {
        const harness = await createStopHarness({
            lease: lease(),
            utmctl: createFakeUtmctl({registered: [{
                uuid: CLONE_VM_ID,
                status: 'stopped',
                name: 'unrelated-vm',
            }]}),
        });

        const result = await harness.stop();

        expect(result.exitCode).toBe(3);
        expect(result.messages.join(' ')).toContain('registered UUID has an unexpected name');
        expect(harness.utmctl.calls).toEqual([]);
        expect(await exists(harness.layout.leaseFile)).toBe(true);
    });

    it('refuses stale recovery when the expected run name belongs to another UUID', async () => {
        const harness = await createStopHarness({
            lease: lease(),
            utmctl: createFakeUtmctl({registered: [{
                uuid: TEST_VM_ID,
                status: 'stopped',
                name: CLONE_NAME,
            }]}),
        });

        const result = await harness.stop();

        expect(result.exitCode).toBe(3);
        expect(result.messages.join(' ')).toContain('lease UUID is not registered');
        expect(harness.utmctl.calls).toEqual([]);
        expect(await exists(harness.layout.leaseFile)).toBe(true);
    });

    it('refuses to stop a personal VM named by a stale lease', async () => {
        const harness = await createStopHarness({lease: lease({vmId: PERSONAL_VM_ID})});

        const result = await harness.stop();

        expect(result.exitCode).toBe(3);
        expect(result.messages.join(' ')).toContain('Refusing');
        expect(harness.utmctl.calls).toEqual([]);
        expect(await exists(harness.layout.leaseFile)).toBe(true);
    });
});
