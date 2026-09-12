import { createHash } from 'node:crypto';
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
import { WINDOWS_TEST_RUNNER_VERSION } from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestRunSummary,
    IWindowsTestWorkerHeartbeat,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    windowsTestGuestLayout,
    windowsTestGuestRunPaths,
    windowsTestHostLayout,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestSuiteSelection } from '@scripts/windows-test/host/capabilityRegistry';
import { createManualClock } from '@scripts/windows-test/host/hostClock';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import { executeWindowsTestRun } from '@scripts/windows-test/host/runCoordinator';
import type { IWindowsTestRunDependencies } from '@scripts/windows-test/host/runCoordinator';
import type {
    IUtmVmListEntry,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';

const GOLDEN_VM_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_TEST_VM_ID = '22222222-3333-4444-8555-666666666666';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';
const OLD_CLONE_VM_ID = '66666666-7777-4888-8999-000000000000';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const RUN_SUFFIX = '0123456789ab';
const RUN_ID = `20260904T120000Z-${RUN_SUFFIX}`;
const OWNER_PID = 4_242;
const OWNER_START_TIME = 'Fri Sep  4 12:00:00 2026';
const BOOT_ID = 'boot-2026-09-04-01';
const MARKER = 'evb-windows-test-marker-2026-09';
const IMAGE_ID = 'win11-arm64-2026-09';
const ARTIFACT_BYTES = 'installer-bytes';
const EVIDENCE_BYTES = 'screenshot-bytes';
const EVIDENCE_PATH = 'screenshots/save.png';

const guestPaths = windowsTestGuestRunPaths(RUN_ID);

function sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
}

function heartbeat(overrides: Partial<IWindowsTestWorkerHeartbeat> = {}): IWindowsTestWorkerHeartbeat {
    return {
        schemaVersion: 1,
        bootId: BOOT_ID,
        guestTestMarker: MARKER,
        updatedAt: '2026-09-04T12:00:10.000Z',
        locked: false,
        worker: {
            userSid: 'S-1-5-21-1-2-3-1001',
            sessionId: 1,
            integrityLevel: 'Medium',
            inputDesktop: 'Default',
            interactive: true,
            workerPid: 7_331,
            workerStartTime: '2026-09-04T12:00:05.000Z',
        },
        ...overrides,
    };
}

const evidenceManifestText = `${JSON.stringify({
    schemaVersion: 1,
    runId: RUN_ID,
    entries: [{
        relativePath: EVIDENCE_PATH,
        sha256: sha256(EVIDENCE_BYTES),
        bytes: EVIDENCE_BYTES.length,
    }],
}, null, 4)}\n`;

function guestResultText(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
        schemaVersion: 1,
        runId: RUN_ID,
        vmId: CLONE_VM_ID,
        imageId: IMAGE_ID,
        bootId: BOOT_ID,
        guestTestMarker: MARKER,
        artifactSha256: sha256(ARTIFACT_BYTES),
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        terminalState: 'complete',
        outcome: 'passed',
        startedAt: '2026-09-04T12:00:20.000Z',
        endedAt: '2026-09-04T12:01:20.000Z',
        expectedTests: ['WIN-SAVE-01'],
        executedTests: ['WIN-SAVE-01'],
        assertionCount: 2,
        failedAssertionCount: 0,
        cases: [{
            testId: 'WIN-SAVE-01',
            driver: 'APP',
            actionKind: 'app',
            outcome: 'passed',
            startedAt: '2026-09-04T12:00:20.000Z',
            endedAt: '2026-09-04T12:01:00.000Z',
            assertions: [{
                id: 'saved-file-exists',
                passed: true,
                detail: 'The saved document exists on disk.',
            }],
            evidenceFiles: [EVIDENCE_PATH],
            failureReason: null,
        }],
        worker: heartbeat().worker,
        platform: {
            osVersion: '10.0.26100.1',
            osArch: 'arm64',
            appVersion: '3.4.5',
            appArch: 'arm64',
            installedExecutableSha256: 'f'.repeat(64),
            hostname: 'EVB-WIN-TEST',
        },
        evidenceManifestSha256: sha256(evidenceManifestText),
        logTruncated: false,
        humanReviewRequired: false,
        failureReason: null,
        ...overrides,
    });
}

interface IFakeUtmctl extends IUtmctlClient {
    calls: string[];
    registered: IUtmVmListEntry[];
}

function createFakeUtmctl(options: {
    goldenStatus?: string;
    cloneVmId?: string;
    cloneStatusSequence?: readonly string[];
    statusOverride?: string;
    existingClone?: {
        runId: string;
        vmId: string
    };
    extraClones?: readonly string[];
    onDelete?: () => void;
} = {}) {
    const cloneVmId = options.cloneVmId ?? CLONE_VM_ID;
    const cloneStatusSequence = [...(options.cloneStatusSequence ?? [])];
    const registered: IUtmVmListEntry[] = [
        {
            uuid: GOLDEN_VM_ID,
            status: options.goldenStatus ?? 'stopped',
            name: 'windows-golden',
        },
        {
            uuid: OTHER_TEST_VM_ID,
            status: 'stopped',
            name: 'unrelated',
        },
        ...(options.existingClone === undefined ? [] : [{
            uuid: options.existingClone.vmId,
            status: 'started',
            name: `evb-win-test-${options.existingClone.runId}`,
        }]),
        ...(options.extraClones ?? []).map((uuid, index) => ({
            uuid,
            status: 'stopped',
            name: `evb-win-test-2026090${index + 1}T000000Z-aaaaaaaaaaaa`,
        })),
    ];
    const calls: string[] = [];
    const statuses = new Map<string, string>(registered.map(entry => [
        entry.uuid,
        entry.status,
    ]));

    const client: IFakeUtmctl = {
        calls,
        registered,
        version: () => Promise.resolve('utmctl version 4.7.5 (118)'),
        list: () => {
            calls.push('list');
            return Promise.resolve(registered.map(entry => ({...entry})));
        },
        status: (vmId) => {
            calls.push(`status ${vmId}`);
            if (options.statusOverride !== undefined
                && (vmId.toLowerCase() === cloneVmId.toLowerCase()
                    || vmId.toLowerCase() === options.existingClone?.vmId.toLowerCase())) {
                return Promise.resolve(options.statusOverride);
            }
            if ((vmId.toLowerCase() === cloneVmId.toLowerCase()
                || vmId.toLowerCase() === options.existingClone?.vmId.toLowerCase())
                && cloneStatusSequence.length > 0) {
                return Promise.resolve(cloneStatusSequence.shift() ?? 'unknown');
            }
            return Promise.resolve(statuses.get(vmId) ?? 'stopped');
        },
        start: (vmId) => {
            calls.push(`start ${vmId}`);
            statuses.set(vmId, 'started');
            return Promise.resolve();
        },
        stop: (vmId, mode) => {
            calls.push(`stop ${mode} ${vmId}`);
            statuses.set(vmId, 'stopped');
            return Promise.resolve();
        },
        clone: (sourceVmId, name) => {
            calls.push(`clone ${sourceVmId} ${name}`);
            registered.push({
                uuid: cloneVmId,
                status: 'stopped',
                name,
            });
            statuses.set(cloneVmId, 'stopped');
            return Promise.resolve();
        },
        deleteVm: (vmId) => {
            calls.push(`delete ${vmId}`);
            options.onDelete?.();
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

interface IGuestScript {
    resultText: string | null;
    resultTextAfterReads?: number;
    heartbeat: IWindowsTestWorkerHeartbeat | null;
    bootId: string | null;
    evidenceManifestText: string | null;
    evidenceFiles: Record<string, string>;
    stagedHashOk: boolean;
    onPublishReadyMarker?: () => Promise<void>;
}

function defaultGuestScript(): IGuestScript {
    return {
        resultText: guestResultText(),
        heartbeat: heartbeat(),
        bootId: BOOT_ID,
        evidenceManifestText,
        evidenceFiles: {[EVIDENCE_PATH]: EVIDENCE_BYTES},
        stagedHashOk: true,
    };
}

function createFakeGuest(script: IGuestScript) {
    const calls: string[] = [];
    let resultReads = 0;
    const channel: IWindowsTestGuestChannel = {
        ping: () => {
            calls.push('ping');
            return Promise.resolve(true);
        },
        ensureDirectory: (_vmId, guestPath) => {
            calls.push(`mkdir ${guestPath}`);
            return Promise.resolve();
        },
        readHeartbeat: () => Promise.resolve(script.heartbeat),
        stageFile: (_vmId, hostPath, guestPath) => {
            calls.push(`stage ${path.basename(hostPath)} -> ${guestPath}`);
            return Promise.resolve();
        },
        stageText: () => Promise.resolve(),
        verifyStagedFileHash: () => Promise.resolve(script.stagedHashOk),
        writeJob: (_vmId, job) => {
            calls.push(`job ${job.runId} ${job.tests.join(',')}`);
            return Promise.resolve();
        },
        publishReadyMarker: async (_vmId, runId) => {
            calls.push(`ready ${runId}`);
            await script.onPublishReadyMarker?.();
        },
        requestGuestCancel: (_vmId, runId) => {
            calls.push(`cancel ${runId}`);
            return Promise.resolve();
        },
        readGuestText: (_vmId, guestPath) => {
            if (guestPath === windowsTestGuestLayout.bootIdFile) {
                return Promise.resolve(script.bootId);
            }
            if (guestPath === guestPaths.resultFile) {
                resultReads += 1;
                if (script.resultTextAfterReads !== undefined && resultReads <= script.resultTextAfterReads) {
                    return Promise.resolve(null);
                }
                return Promise.resolve(script.resultText);
            }
            return Promise.resolve(null);
        },
        pullGuestFile: async (_vmId, guestPath, hostPath) => {
            if (guestPath === guestPaths.evidenceManifestFile) {
                if (script.evidenceManifestText === null) {
                    return false;
                }
                await writeFile(hostPath, script.evidenceManifestText, 'utf8');
                return true;
            }
            const prefix = `${guestPaths.evidenceDir}\\`;
            if (!guestPath.startsWith(prefix)) {
                return false;
            }
            const relativePath = guestPath.slice(prefix.length).replace(/\\/gu, '/');
            const contents = script.evidenceFiles[relativePath];
            if (contents === undefined) {
                return false;
            }
            await writeFile(hostPath, contents, 'utf8');
            return true;
        },
    };
    return {
        channel,
        calls,
    };
}

const imageManifest: IWindowsTestImageManifest = {
    schemaVersion: 1,
    imageId: IMAGE_ID,
    vmId: GOLDEN_VM_ID,
    bundlePath: '/tmp/images/windows-golden.utm',
    createdAt: '2026-08-01T00:00:00.000Z',
    windowsBuild: '10.0.26100.1',
    osArch: 'arm64',
    utmVersion: '4.7.5',
    qemuVersion: '9.1.0',
    driverVersions: {virtio: '0.1.262'},
    disks: [{
        diskId: 'system',
        purpose: 'Windows system disk',
        resetPolicy: 'restore-from-baseline',
    }],
    guestTestMarker: MARKER,
    qualifiedAt: '2026-08-02T00:00:00.000Z',
    qualification: {
        qualifiedBy: 'evb',
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        coldResetCycles: 3,
        notes: 'Three identical cold cycles.',
    },
};

function fakeProbe(): IHostProcessIdentityProbe {
    return {
        isAlive: pid => pid === OWNER_PID,
        startTime: pid => Promise.resolve(pid === OWNER_PID ? OWNER_START_TIME : null),
    };
}

interface IHarnessOptions {
    script?: Partial<IGuestScript>;
    utmctl?: IFakeUtmctl;
    selection?: Partial<IWindowsTestSuiteSelection>;
    maxFailedClones?: number;
    tests?: string[] | null;
    environment?: string;
    evaluateHostOracles?: IWindowsTestRunDependencies['evaluateHostOracles'];
}

async function createHarness(options: IHarnessOptions = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-run-'));
    const layout = windowsTestHostLayout(root);
    await mkdir(layout.imagesDir, {recursive: true});
    const artifactPath = path.join(root, 'caches', 'artifacts', 'EVBViewer-Setup.exe');
    await mkdir(path.dirname(artifactPath), {recursive: true});
    await writeFile(artifactPath, ARTIFACT_BYTES, 'utf8');
    const fixtureManifestPath = path.join(layout.fixturesCacheDir, 'manifest.json');
    await mkdir(path.dirname(fixtureManifestPath), {recursive: true});
    await writeFile(fixtureManifestPath, 'prepared-fixture-manifest', 'utf8');

    const config: IWindowsTestHostConfig = {
        schemaVersion: 1,
        testImageRoot: layout.imagesDir,
        allowedTestVmIds: [OTHER_TEST_VM_ID],
        goldenImageId: IMAGE_ID,
        goldenVmId: GOLDEN_VM_ID,
        personalVmIdsDenied: [PERSONAL_VM_ID],
        candidate: {
            artifactPath,
            sha256: sha256(ARTIFACT_BYTES),
            fileName: 'EVBViewer-Setup.exe',
            version: '3.4.5',
            sourceSha: 'b'.repeat(40),
            appArch: 'arm64',
        },
        environment: 'utm-win11-arm64-app-arm64',
        qualifiedLaunchers: ['installed-exe'],
        retention: {
            passDays: 3,
            failureDays: 14,
            maxFailedClones: options.maxFailedClones ?? 0,
            minFreeBytes: 1_024,
        },
    };

    const script: IGuestScript = {
        ...defaultGuestScript(),
        ...options.script,
    };
    const guest = createFakeGuest(script);
    const utmctl = options.utmctl ?? createFakeUtmctl();
    const clock = createManualClock();
    const probe = fakeProbe();
    const selection: IWindowsTestSuiteSelection = {
        tests: ['WIN-SAVE-01'],
        uncoveredObligations: ['WIN-PRINT-09'],
        humanReviewObligations: [],
        ...options.selection,
    };

    const dependencies: IWindowsTestRunDependencies = {
        config,
        layout,
        utmctl,
        guest: guest.channel,
        clock,
        suiteResolver: {resolveSuite: () => Promise.resolve(selection)},
        fixtureManifest: {sha256: () => Promise.resolve('d'.repeat(64))},
        imageManifest,
        stagedInputs: [{
            hostPath: fixtureManifestPath,
            guestRelativePath: 'fixtures/manifest.json',
            sha256: 'd'.repeat(64),
        }],
        lock: {
            hostId: 'test-host',
            pid: OWNER_PID,
            probe,
            nowIso: () => clock.nowIso(),
            sleep: milliseconds => clock.sleep(milliseconds),
        },
        probe,
        hostId: 'test-host',
        randomRunSuffix: () => RUN_SUFFIX,
        ...(options.evaluateHostOracles === undefined ? {} : {evaluateHostOracles: options.evaluateHostOracles}),
        identityGuard: {
            resolvePath: target => Promise.resolve(target),
            readVmId: bundlePath => Promise.resolve(bundlePath.includes(RUN_ID) ? CLONE_VM_ID : OLD_CLONE_VM_ID),
            readVmName: bundlePath => Promise.resolve(
                `evb-win-test-${bundlePath.includes(RUN_ID) ? RUN_ID : '20260903T090000Z-abcdefabcdef'}`,
            ),
        },
        deadlines: {
            bootToGuestReadyMs: 1_000,
            guestReadyToDesktopReadyMs: 1_000,
            jobMs: 2_000,
            pollIntervalMs: 100,
            cancelGraceMs: 300,
            heartbeatStaleAfterMs: 1_000,
            commandTimeoutMs: 200,
            stageFileMs: 200,
        },
    };

    return {
        root,
        layout,
        config,
        dependencies,
        guest,
        utmctl,
        script,
        run: () => executeWindowsTestRun({
            suite: 'smoke',
            environment: options.environment ?? 'utm-win11-arm64-app-arm64',
            tests: options.tests ?? null,
        }, dependencies),
    };
}

async function exists(target: string) {
    return (await stat(target).catch(() => null)) !== null;
}

describe('windows test run coordinator', () => {
    it('drives a clean run from lease to summary and deletes the owned clone', async () => {
        const harness = await createHarness();

        const report = await harness.run();

        expect(report.exitCode).toBe(0);
        expect(report.outcome).toBe('passed');
        expect(report.runId).toBe(RUN_ID);
        expect(report.summary?.passedTests).toEqual(['WIN-SAVE-01']);
        expect(report.summary?.executedTests).toEqual(['WIN-SAVE-01']);
        expect(report.summary?.uncoveredObligations).toEqual(['WIN-PRINT-09']);
        expect(report.summary?.vmId).toBe(CLONE_VM_ID);
        expect(report.summary?.retainedClone).toBe(false);
        expect(harness.utmctl.calls).toContain(`clone ${GOLDEN_VM_ID} evb-win-test-${RUN_ID}`);
        expect(harness.utmctl.calls).toContain(`delete ${CLONE_VM_ID}`);
        expect(harness.guest.calls).toContain(`job ${RUN_ID} WIN-SAVE-01`);
        expect(harness.guest.calls).toContain(`stage manifest.json -> ${guestPaths.stagingDir}\\fixtures\\manifest.json`);
    });

    it('uses the optional batch staging hook before publishing the guest job', async () => {
        const harness = await createHarness();
        harness.guest.channel.stageAndVerifyFiles = async (_vmId, files) => {
            harness.guest.calls.push(`batch ${files.length}`);
            return true;
        };

        const report = await harness.run();

        expect(report.outcome).toBe('passed');
        expect(harness.guest.calls).toContain('batch 2');
        expect(harness.guest.calls.filter(call => call.startsWith('stage '))).toEqual([]);
        expect(harness.guest.calls).toContain(`job ${RUN_ID} WIN-SAVE-01`);
    });

    it('fails promptly when the owned clone stops before publishing a guest result', async () => {
        const harness = await createHarness({
            script: {resultText: null},
            utmctl: createFakeUtmctl({cloneStatusSequence: ['stopped']}),
        });

        const report = await harness.run();

        expect(report.outcome).toBe('infrastructure-failed');
        expect(report.summary?.failures).toContainEqual(expect.objectContaining({
            outcome: 'infrastructure-failed',
            phase: 'testing',
            reason: expect.stringContaining(`The owned clone ${CLONE_VM_ID} is no longer running`),
        }));
        expect(harness.utmctl.calls.filter(call => call === `status ${CLONE_VM_ID}`)).toHaveLength(2);
    });

    it('keeps polling through transient UTM clone states', async () => {
        const harness = await createHarness({
            script: {resultTextAfterReads: 4},
            utmctl: createFakeUtmctl({cloneStatusSequence: [
                'starting',
                'pausing',
                'resuming',
                'started',
            ]}),
        });

        const report = await harness.run();

        expect(report.outcome).toBe('passed');
        expect(harness.utmctl.calls.filter(call => call === `status ${CLONE_VM_ID}`)).toHaveLength(5);
    });

    it('combines a host oracle product failure after guest evidence validates', async () => {
        type TOracleInput = Parameters<NonNullable<IWindowsTestRunDependencies['evaluateHostOracles']>>[0];
        const oracleInputs: TOracleInput[] = [];
        const harness = await createHarness({evaluateHostOracles: async input => {
            oracleInputs.push(input);
            return {
                outcome: 'product-failed',
                humanReviewRequired: false,
                errors: ['the independent PDF oracle found a blank output'],
            };
        }});

        const report = await harness.run();

        expect(report.outcome).toBe('product-failed');
        expect(report.exitCode).toBe(2);
        expect(oracleInputs).toHaveLength(1);
        const oracleInput = oracleInputs[0];
        expect(oracleInput?.runId).toBe(RUN_ID);
        expect(oracleInput?.environmentId).toBe('utm-win11-arm64-app-arm64');
        expect(oracleInput?.result.outcome).toBe('passed');
        expect(oracleInput?.evidenceDirectory).toBe(
            windowsTestRunLayout(harness.layout.runsDir, RUN_ID).evidenceDir,
        );
        expect(report.summary?.failures).toContainEqual({
            outcome: 'product-failed',
            phase: 'collecting',
            reason: 'the independent PDF oracle found a blank output',
        });
    });

    it('records a forward-only transition ledger and an immutable summary on disk', async () => {
        const harness = await createHarness();

        await harness.run();

        const runLayout = windowsTestRunLayout(harness.layout.runsDir, RUN_ID);
        const states = (await readFile(runLayout.transitionsFile, 'utf8'))
            .trim()
            .split('\n')
            .map(line => (JSON.parse(line) as {state: string}).state);
        expect(states).toEqual([
            'leased',
            'booting',
            'guest-ready',
            'desktop-ready',
            'staged',
            'testing',
            'collecting',
            'tearing-down',
            'complete',
        ]);
        const summary = JSON.parse(await readFile(runLayout.summaryFile, 'utf8')) as IWindowsTestRunSummary;
        expect(summary.runId).toBe(RUN_ID);
        expect(summary.evidenceDirectory).toBe(runLayout.evidenceDir);
        expect(await exists(path.join(runLayout.evidenceDir, 'screenshots', 'save.png'))).toBe(true);
        expect(await exists(harness.layout.leaseFile)).toBe(false);
    });

    it('refuses to share the VM and exits 6 while another run holds the lease', async () => {
        const harness = await createHarness();
        await mkdir(harness.layout.root, {recursive: true});
        await writeFile(harness.layout.leaseFile, JSON.stringify({
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: CLONE_VM_ID,
            runId: '20260903T090000Z-abcdefabcdef',
            ownerPid: OWNER_PID,
            ownerStartTime: OWNER_START_TIME,
            createdAt: '2026-09-03T09:00:00.000Z',
        }), 'utf8');

        const report = await harness.run();

        expect(report.exitCode).toBe(6);
        expect(report.activeRunId).toBe('20260903T090000Z-abcdefabcdef');
        expect(report.runId).toBeNull();
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('stops a stale owned clone before replacing its persisted lease', async () => {
        const oldRunId = '20260903T090000Z-abcdefabcdef';
        const harness = await createHarness({utmctl: createFakeUtmctl({
            existingClone: {
                runId: oldRunId,
                vmId: OLD_CLONE_VM_ID,
            },
            cloneStatusSequence: [
                'started',
                'stopped',
            ],
        })});
        await mkdir(harness.layout.root, {recursive: true});
        await writeFile(harness.layout.leaseFile, JSON.stringify({
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: OLD_CLONE_VM_ID,
            runId: oldRunId,
            ownerPid: 5_555,
            ownerStartTime: 'Thu Sep  3 09:00:00 2026',
            createdAt: '2026-09-03T09:00:00.000Z',
        }), 'utf8');

        const report = await harness.run();

        expect(report.outcome).toBe('passed');
        expect(report.messages.join(' ')).toContain(`Recovered a stale lease from run ${oldRunId}`);
        const calls = harness.utmctl.calls;
        expect(calls.indexOf(`stop request ${OLD_CLONE_VM_ID}`)).toBeGreaterThan(-1);
        expect(calls).not.toContain(`delete ${OLD_CLONE_VM_ID}`);
        expect(calls.indexOf(`clone ${GOLDEN_VM_ID} evb-win-test-${RUN_ID}`))
            .toBeGreaterThan(calls.indexOf(`stop request ${OLD_CLONE_VM_ID}`));
        expect(await exists(harness.layout.leaseFile)).toBe(false);
    });

    it('retains an exclusion when stale clone stop cannot prove the clone stopped', async () => {
        const oldRunId = '20260903T090000Z-abcdefabcdef';
        const harness = await createHarness({utmctl: createFakeUtmctl({
            existingClone: {
                runId: oldRunId,
                vmId: OLD_CLONE_VM_ID,
            },
            statusOverride: 'started',
        })});
        await mkdir(harness.layout.root, {recursive: true});
        await writeFile(harness.layout.leaseFile, JSON.stringify({
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: OLD_CLONE_VM_ID,
            runId: oldRunId,
            ownerPid: 5_555,
            ownerStartTime: 'Thu Sep  3 09:00:00 2026',
            createdAt: '2026-09-03T09:00:00.000Z',
        }), 'utf8');

        const report = await harness.run();

        expect(report.outcome).toBe('infrastructure-failed');
        expect(report.messages.join(' ')).toContain('refused to replace');
        expect(await exists(harness.layout.leaseFile)).toBe(true);
        expect(harness.utmctl.calls.some(call => call.startsWith(`clone ${GOLDEN_VM_ID}`))).toBe(false);
    });

    it('does not reclaim an unbound stale lease once its run directory exists', async () => {
        const oldRunId = '20260903T090000Z-abcdefabcdef';
        const harness = await createHarness();
        await mkdir(windowsTestRunLayout(harness.layout.runsDir, oldRunId).runDir, {recursive: true});
        await mkdir(harness.layout.root, {recursive: true});
        await writeFile(harness.layout.leaseFile, JSON.stringify({
            schemaVersion: 1,
            hostId: 'test-host',
            vmId: null,
            runId: oldRunId,
            ownerPid: 5_555,
            ownerStartTime: 'Thu Sep  3 09:00:00 2026',
            createdAt: '2026-09-03T09:00:00.000Z',
        }), 'utf8');

        const report = await harness.run();

        expect(report.outcome).toBe('infrastructure-failed');
        expect(await exists(harness.layout.leaseFile)).toBe(true);
        expect(harness.utmctl.calls).toEqual([]);
    });

    it('exits 5 and tells the guest to stop when a cancel request appears', async () => {
        const harness = await createHarness({script: {resultText: null}});
        const runLayout = windowsTestRunLayout(harness.layout.runsDir, RUN_ID);
        harness.script.onPublishReadyMarker = async () => {
            await writeFile(runLayout.cancelRequestFile, JSON.stringify({runId: RUN_ID}), 'utf8');
        };

        const report = await harness.run();

        expect(report.exitCode).toBe(5);
        expect(report.outcome).toBe('canceled');
        expect(report.summary?.failures[0]?.reason).toContain('cancellation was requested');
        expect(report.summary?.failures[0]?.reason).not.toContain('guest was told to stop');
        expect(harness.guest.calls).toContain(`cancel ${RUN_ID}`);
        expect(harness.utmctl.calls).toContain(`stop request ${CLONE_VM_ID}`);
    });

    it.each([
        'boot',
        'staging',
    ] as const)('honors cancellation during %s before publishing a job', async (phase) => {
        const harness = await createHarness();
        const runLayout = windowsTestRunLayout(harness.layout.runsDir, RUN_ID);
        const cancel = async () => {
            await writeFile(runLayout.cancelRequestFile, JSON.stringify({runId: RUN_ID}), 'utf8');
        };
        if (phase === 'boot') {
            harness.guest.channel.ping = async () => {
                await cancel();
                return false;
            };
        } else {
            harness.guest.channel.stageFile = cancel;
        }
        const report = await harness.run();
        expect(report.outcome).toBe('canceled');
        expect(report.exitCode).toBe(5);
        expect(harness.utmctl.calls).toContain(`stop request ${CLONE_VM_ID}`);
        expect(harness.guest.calls).not.toContain(`job ${RUN_ID} WIN-SAVE-01`);
        expect(harness.guest.calls).not.toContain(`ready ${RUN_ID}`);
        expect(await exists(runLayout.jobFile)).toBe(false);
    });

    it('keeps a product failure when teardown also fails', async () => {
        const utmctl = createFakeUtmctl({onDelete: () => {
            throw new Error('utmctl delete failed while the clone was still registered');
        }});
        const harness = await createHarness({
            utmctl,
            script: {resultText: guestResultText({
                outcome: 'product-failed',
                failedAssertionCount: 1,
                failureReason: 'The saved document was blank.',
                cases: [{
                    testId: 'WIN-SAVE-01',
                    driver: 'APP',
                    actionKind: 'app',
                    outcome: 'product-failed',
                    startedAt: '2026-09-04T12:00:20.000Z',
                    endedAt: '2026-09-04T12:01:00.000Z',
                    assertions: [{
                        id: 'saved-file-exists',
                        passed: false,
                        detail: 'The saved document was blank.',
                    }],
                    evidenceFiles: [EVIDENCE_PATH],
                    failureReason: 'The saved document was blank.',
                }],
            })},
        });

        const report = await harness.run();

        expect(report.outcome).toBe('product-failed');
        expect(report.exitCode).toBe(2);
        expect(report.summary?.failedTests).toEqual(['WIN-SAVE-01']);
        expect(report.summary?.failures.map(failure => failure.phase)).toEqual([
            'testing',
            'tearing-down',
        ]);
        expect(await exists(harness.layout.leaseFile)).toBe(true);
    });

    it('retains the lease when a forced teardown has no stopped acknowledgement', async () => {
        const harness = await createHarness({utmctl: createFakeUtmctl({cloneStatusSequence: Array.from({length: 8}, () => 'started')})});

        const report = await harness.run();

        expect(report.outcome).toBe('infrastructure-failed');
        expect(report.summary?.failures).toContainEqual(expect.objectContaining({
            outcome: 'infrastructure-failed',
            phase: 'tearing-down',
            reason: expect.stringContaining('did not acknowledge stopped status'),
        }));
        expect(await exists(harness.layout.leaseFile)).toBe(true);
        expect(await exists(windowsTestRunLayout(harness.layout.runsDir, RUN_ID).summaryFile)).toBe(true);
        expect(harness.utmctl.calls).toContain(`stop force ${CLONE_VM_ID}`);
        expect(harness.utmctl.calls).not.toContain(`delete ${CLONE_VM_ID}`);
    });

    it('retains a failed clone for inspection while the retention budget allows it', async () => {
        const harness = await createHarness({
            maxFailedClones: 2,
            script: {resultText: JSON.stringify({error: 'the worker could not launch the installer'})},
        });

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.outcome).toBe('infrastructure-failed');
        expect(report.summary?.retainedClone).toBe(true);
        expect(harness.utmctl.calls).not.toContain(`delete ${CLONE_VM_ID}`);
        expect(report.summary?.failures[0]?.reason).toContain('guest-error-response');
        expect(report.summary?.passedTests).toEqual([]);
    });

    it('normalizes clone UUID casing before retention accounting', async () => {
        const uppercaseCloneId = CLONE_VM_ID.toUpperCase();
        const utmctl = createFakeUtmctl({cloneVmId: uppercaseCloneId});
        const harness = await createHarness({
            utmctl,
            maxFailedClones: 1,
            script: {resultText: JSON.stringify({error: 'the worker could not launch the installer'})},
        });

        const report = await harness.run();

        expect(report.outcome).toBe('infrastructure-failed');
        expect(report.summary?.retainedClone).toBe(true);
        expect(harness.utmctl.calls.filter(call => call.startsWith('delete '))).toEqual([]);
    });

    it('deletes a failed clone once the retention budget is already full', async () => {
        const utmctl = createFakeUtmctl({extraClones: [
            '44444444-5555-4666-8777-888888888888',
            '55555555-6666-4777-8888-999999999999',
        ]});
        const harness = await createHarness({
            utmctl,
            maxFailedClones: 2,
            script: {resultText: null},
        });

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.retainedClone).toBe(false);
        expect(harness.utmctl.calls).toContain(`delete ${CLONE_VM_ID}`);
    });

    it('never counts an uncovered obligation as a pass and exits 4 with nothing implemented', async () => {
        const harness = await createHarness({selection: {
            tests: [],
            uncoveredObligations: [
                'WIN-PRINT-09',
                'WIN-SAVE-01',
            ],
        }});

        const report = await harness.run();

        expect(report.exitCode).toBe(4);
        expect(report.outcome).toBe('unsupported');
        expect(report.summary?.passedTests).toEqual([]);
        expect(report.summary?.uncoveredObligations).toEqual([
            'WIN-PRINT-09',
            'WIN-SAVE-01',
        ]);
        expect(harness.utmctl.calls).not.toContain(`clone ${GOLDEN_VM_ID} evb-win-test-${RUN_ID}`);
    });

    it('lists an unregistered requested test as uncovered instead of running it', async () => {
        const harness = await createHarness({tests: [
            'WIN-SAVE-01',
            'WIN-GHOST-99',
        ]});

        const report = await harness.run();

        expect(report.summary?.expectedTests).toEqual(['WIN-SAVE-01']);
        expect(report.summary?.uncoveredObligations).toContain('WIN-GHOST-99');
    });

    it('refuses to clone while the golden image is running', async () => {
        const harness = await createHarness({utmctl: createFakeUtmctl({goldenStatus: 'started'})});

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.failures[0]?.reason).toContain('must be stopped');
        expect(harness.utmctl.calls).not.toContain(`clone ${GOLDEN_VM_ID} evb-win-test-${RUN_ID}`);
    });

    it('refuses an environment whose app architecture does not match the candidate', async () => {
        const harness = await createHarness({environment: 'utm-win11-arm64-app-x64'});

        const report = await harness.run();

        expect(report.exitCode).toBe(4);
        expect(report.outcome).toBe('unsupported');
        expect(report.summary?.failures[0]?.reason).toContain('expects an x64 app');
        expect(harness.utmctl.calls).not.toContain(`clone ${GOLDEN_VM_ID} evb-win-test-${RUN_ID}`);
    });

    it('refuses a denied personal VM UUID even when utmctl reports it as the clone', async () => {
        const harness = await createHarness({utmctl: createFakeUtmctl({cloneVmId: PERSONAL_VM_ID})});

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.failures[0]?.reason).toContain('vm-id-denied');
        expect(harness.utmctl.calls).not.toContain(`delete ${PERSONAL_VM_ID}`);
        expect(harness.utmctl.calls).not.toContain(`start ${PERSONAL_VM_ID}`);
    });

    it('fails as infrastructure when the guest only ever reports Session 0', async () => {
        const harness = await createHarness({script: {heartbeat: heartbeat({worker: {
            ...heartbeat().worker,
            sessionId: 0,
            interactive: false,
        }})}});

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.failures[0]?.reason).toContain('Session 0');
        expect(harness.guest.calls).not.toContain(`job ${RUN_ID} WIN-SAVE-01`);
    });

    it('fails as infrastructure when the staged artifact does not hash inside the guest', async () => {
        const harness = await createHarness({script: {stagedHashOk: false}});

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.failures[0]?.reason).toContain('did not hash to');
    });

    it('rejects a result that belongs to an earlier boot', async () => {
        const harness = await createHarness({script: {resultText: guestResultText({bootId: 'boot-from-a-previous-run'})}});

        const report = await harness.run();

        expect(report.exitCode).toBe(3);
        expect(report.summary?.failures.map(failure => failure.reason).join(' '))
            .toContain('result-identity-mismatch');
    });
});
