import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    isWindowsTestResult,
    isWindowsTestWorkerHeartbeat,
    WINDOWS_TEST_RUNNER_VERSION,
    WINDOWS_TEST_SCHEMA_VERSION,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    windowsTestGuestLayout,
    windowsTestGuestRunPaths,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsFixtureManifest } from '@scripts/windows-test/fixtures/fixtureManifest';
import {guestLayoutForRoot} from '@scripts/windows-test/guest/guestPaths';
import {
    createNodeGuestFileSystem,
    nodeGuestClock,
    sha256Hex,
} from '@scripts/windows-test/guest/guestRuntime';
import type {
    IGuestWorkerAdapters,
    IGuestWorkerRunSummary,
} from '@scripts/windows-test/guest/guestWorker';
import { runGuestWorker } from '@scripts/windows-test/guest/guestWorker';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import type { INativeUiAdapter } from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import type { IViewerFactory } from '@scripts/windows-test/guest/viewer/viewerDriver';
import { createManualClock } from '@scripts/windows-test/host/hostClock';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type {
    IWindowsTestRunDependencies,
    IWindowsTestStagedInput,
} from '@scripts/windows-test/host/runCoordinator';
import { executeWindowsTestRun } from '@scripts/windows-test/host/runCoordinator';
import type {IHostProcessIdentityProbe} from '@scripts/windows-test/host/hostProcessIdentity';
import type {
    IUtmVmListEntry,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';

const GOLDEN_VM_ID = '11111111-2222-4333-8444-555555555555';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';
const OTHER_VM_ID = '22222222-3333-4444-8555-666666666666';
const RUN_SUFFIX = '0123456789ab';
const RUN_ID = `20260904T120000Z-${RUN_SUFFIX}`;
const BOOT_ID = 'boot-protocol-01';
const IMAGE_ID = 'win11-arm64-protocol';
const GUEST_TEST_MARKER = 'protocol-marker-01';
const ARTIFACT_CONTENTS = 'protocol-installer';
const FIXTURE_CONTENTS = 'protocol-fixture-bytes';
const OWNER_PID = 4_242;
const OWNER_START_TIME = 'Fri Sep  4 12:00:00 2026';

function digest(value: string | Uint8Array) {
    return createHash('sha256').update(value).digest('hex');
}

function fakePeImage(machine: number) {
    const bytes = new Uint8Array(0x100);
    const view = new DataView(bytes.buffer);
    bytes[0] = 0x4d;
    bytes[1] = 0x5a;
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x0000_4550, true);
    view.setUint16(0x84, machine, true);
    return bytes;
}

const fixtureHash = digest(FIXTURE_CONTENTS);
const fixtureManifest: IWindowsFixtureManifest = {
    schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
    packs: [{
        id: 'F01',
        name: 'Protocol fixture',
        purpose: 'A small fixture used by the host and guest protocol test.',
        license: 'synthetic',
        publishable: true,
        provenance: 'generated in the integration test',
        variants: [],
        metadata: {},
        files: [{
            id: 'F01-protocol',
            path: 'protocol.pdf',
            bytes: Buffer.byteLength(FIXTURE_CONTENTS),
            sha256: fixtureHash,
            expectedPages: 1,
            markers: [],
            generated: true,
        }],
    }],
};
const fixtureManifestText = JSON.stringify(fixtureManifest);

function probePayload() {
    return JSON.stringify({
        userSid: 'S-1-5-21-1-2-3-1001',
        sessionId: 2,
        integrityLevel: 'Medium',
        inputDesktop: 'Default',
        logonUiPresent: false,
        workerPid: 7_331,
        workerStartTime: '2026-09-04T12:00:05.000Z',
        osVersion: '10.0.26100',
        osArchitecture: 'ARM64',
        hostname: 'EVB-PROTOCOL-VM',
        appVersion: '1.4.2',
    });
}

const workerAdapters: IGuestWorkerAdapters = {
    createNativeUiAdapter: () => new Proxy({}, { get: () => () => {
        throw new Error('the native UI adapter must not be used by the protocol case');
    } }) as INativeUiAdapter,
    createViewerFactory: () => new Proxy({}, { get: () => () => {
        throw new Error('the viewer factory must not be used by the protocol case');
    } }) as IViewerFactory,
};

function guestPathOnDisk(root: string, guestPath: string) {
    const prefix = windowsTestGuestLayout.root;
    if (guestPath !== prefix && !guestPath.startsWith(`${prefix}\\`)) {
        throw new Error(`The protocol bridge received a path outside ${prefix}: ${guestPath}`);
    }
    const relative = guestPath.slice(prefix.length).replaceAll('\\', '/');
    return path.join(root, relative);
}

function createGuestCommandRunner() {
    const calls: string[][] = [];
    return {
        calls,
        run: async (_command: string, args: readonly string[]) => {
            calls.push([...args]);
            if (args.some(argument => argument.endsWith('probe-identity.ps1'))) {
                return {
                    exitCode: 0,
                    stdout: probePayload(),
                    stderr: '',
                };
            }
            if (args.some(argument => argument.endsWith('install-nsis-per-user.ps1'))) {
                return {
                    exitCode: 0,
                    stdout: JSON.stringify({installed: true}),
                    stderr: '',
                };
            }
            throw new Error(`Unexpected guest command ${args.join(' ')}`);
        },
    };
}

interface IFilesystemGuestBridge {
    channel: IWindowsTestGuestChannel;
    worker: Promise<IGuestWorkerRunSummary>;
    calls: string[];
    commands: string[][];
}

async function createFilesystemGuestBridge(root: string, executablePath: string): Promise<IFilesystemGuestBridge> {
    const fs = createNodeGuestFileSystem();
    const layout = guestLayoutForRoot(root, '/');
    const calls: string[] = [];
    const commandRunner = createGuestCommandRunner();
    const readGuestText = async (guestPath: string) => readFile(guestPathOnDisk(root, guestPath), 'utf8').catch(() => null);
    const channel: IWindowsTestGuestChannel = {
        ping: async () => true,
        ensureDirectory: async (_vmId, guestPath) => {
            calls.push(`mkdir ${guestPath}`);
            await fs.makeDirectory(guestPathOnDisk(root, guestPath));
        },
        readHeartbeat: async () => {
            const text = await readGuestText(windowsTestGuestLayout.heartbeatFile);
            if (text === null) {
                return null;
            }
            try {
                const parsed: unknown = JSON.parse(text);
                return isWindowsTestWorkerHeartbeat(parsed) ? parsed : null;
            } catch {
                return null;
            }
        },
        stageFile: async (_vmId, hostPath, guestPath) => {
            calls.push(`stage ${guestPath}`);
            await fs.copyFile(hostPath, guestPathOnDisk(root, guestPath));
        },
        stageText: async (_vmId, contents, guestPath) => {
            await fs.writeText(guestPathOnDisk(root, guestPath), contents);
        },
        verifyStagedFileHash: async (_vmId, guestPath, expectedSha256) => {
            const actual = sha256Hex(await fs.readBytes(guestPathOnDisk(root, guestPath))).toLowerCase();
            return actual === expectedSha256.toLowerCase();
        },
        writeJob: async (_vmId, job) => {
            await fs.writeText(
                guestPathOnDisk(root, windowsTestGuestRunPaths(job.runId).jobFile),
                `${JSON.stringify(job, null, 4)}\n`,
            );
        },
        publishReadyMarker: async (_vmId, runId) => {
            calls.push(`ready ${runId}`);
            await fs.writeText(guestPathOnDisk(root, windowsTestGuestRunPaths(runId).readyMarkerFile), `${runId}\n`);
        },
        requestGuestCancel: async (_vmId, runId) => {
            await fs.writeText(guestPathOnDisk(root, windowsTestGuestRunPaths(runId).cancelFile), `${runId}\n`);
        },
        readGuestText: async (_vmId, guestPath) => readGuestText(guestPath),
        pullGuestFile: async (_vmId, guestPath, hostPath) => {
            try {
                await mkdir(path.dirname(hostPath), {recursive: true});
                await copyFile(guestPathOnDisk(root, guestPath), hostPath);
                return true;
            } catch {
                return false;
            }
        },
    };

    await fs.writeText(layout.bootIdFile, `${BOOT_ID}\n`);
    await fs.writeText(layout.markerFile, JSON.stringify({
        guestTestMarker: GUEST_TEST_MARKER,
        imageId: IMAGE_ID,
    }));
    await fs.writeBytes(executablePath, fakePeImage(0xaa64));

    const caseDefinition = {
        id: 'WIN-SAVE-01',
        family: 'save',
        driver: 'APP' as const,
        ledgerDrivers: 'APP',
        actionKind: 'app' as const,
        status: 'implemented' as const,
        run: async (context: ICaseContext) => {
            const stagedFixture = await context.fs.readBytes(context.fixturePath('F01-protocol'));
            context.assert(
                'protocol-fixture-consumed',
                Buffer.from(stagedFixture).toString('utf8') === FIXTURE_CONTENTS,
                'the worker consumed the fixture staged under the run-specific directory',
            );
        },
    };
    const worker = runGuestWorker({
        fs,
        exec: commandRunner,
        clock: nodeGuestClock,
        paths: layout,
        adapters: workerAdapters,
        env: {
            EVB_WINDOWS_TEST_APP_EXECUTABLE: executablePath,
            PROCESSOR_ARCHITECTURE: 'ARM64',
        },
        caseDefinitions: [caseDefinition],
        waitForJobMs: 4_000,
        pollIntervalMs: 2,
        heartbeatIntervalMs: 2,
    });
    return {
        channel,
        worker,
        calls,
        commands: commandRunner.calls,
    };
}

function createUtmctl(): IUtmctlClient {
    const registered: IUtmVmListEntry[] = [
        {
            uuid: GOLDEN_VM_ID,
            status: 'stopped',
            name: 'windows-golden',
        },
        {
            uuid: OTHER_VM_ID,
            status: 'stopped',
            name: 'unrelated',
        },
    ];
    const statuses = new Map(registered.map(entry => [
        entry.uuid,
        entry.status,
    ]));
    return {
        version: () => Promise.resolve('utmctl version 4.7.5'),
        list: () => Promise.resolve(registered.map(entry => ({...entry}))),
        status: vmId => Promise.resolve(statuses.get(vmId) ?? 'stopped'),
        start: vmId => {
            statuses.set(vmId, 'started');
            return Promise.resolve();
        },
        stop: vmId => {
            statuses.set(vmId, 'stopped');
            return Promise.resolve();
        },
        clone: (_sourceVmId, name) => {
            registered.push({
                uuid: CLONE_VM_ID,
                status: 'stopped',
                name,
            });
            statuses.set(CLONE_VM_ID, 'stopped');
            return Promise.resolve();
        },
        deleteVm: () => Promise.resolve(),
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
}

function createProbe(): IHostProcessIdentityProbe {
    return {
        isAlive: pid => pid === OWNER_PID,
        startTime: pid => Promise.resolve(pid === OWNER_PID ? OWNER_START_TIME : null),
    };
}

describe('host and guest Windows test protocol', () => {
    let hostRoot = '';
    let guestRoot = '';
    let workerToSettle: Promise<IGuestWorkerRunSummary> | null = null;

    afterEach(async () => {
        // The worker owns asynchronous writes inside guestRoot. Settle it
        // before removing that directory, including when the test fails
        // before it can await the successful-run assertion below.
        await workerToSettle?.catch(() => undefined);
        workerToSettle = null;
        await Promise.all([
            hostRoot === '' ? Promise.resolve() : rm(hostRoot, {
                force: true,
                recursive: true,
            }),
            guestRoot === '' ? Promise.resolve() : rm(guestRoot, {
                force: true,
                recursive: true,
            }),
        ]);
        hostRoot = '';
        guestRoot = '';
    });

    it('stages a run-scoped job and fixture that the real worker consumes', async () => {
        hostRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-protocol-host-'));
        guestRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-protocol-guest-'));
        const hostLayout = windowsTestHostLayout(hostRoot);
        await mkdir(hostLayout.imagesDir, {recursive: true});
        const artifactPath = path.join(hostLayout.artifactsCacheDir, 'EVBViewer-Setup-arm64.exe');
        const manifestPath = path.join(hostLayout.fixturesCacheDir, 'manifest.json');
        const fixturePath = path.join(hostLayout.fixturesCacheDir, 'protocol.pdf');
        await mkdir(path.dirname(artifactPath), {recursive: true});
        await mkdir(path.dirname(manifestPath), {recursive: true});
        await writeFile(artifactPath, ARTIFACT_CONTENTS, 'utf8');
        await writeFile(manifestPath, fixtureManifestText, 'utf8');
        await writeFile(fixturePath, FIXTURE_CONTENTS, 'utf8');

        const executablePath = path.join(guestRoot, 'app', 'EVB Viewer.exe');
        const bridge = await createFilesystemGuestBridge(guestRoot, executablePath);
        workerToSettle = bridge.worker;
        const stagedInputs: IWindowsTestStagedInput[] = [
            {
                hostPath: manifestPath,
                guestRelativePath: 'fixtures/manifest.json',
                sha256: digest(await readFile(manifestPath)),
            },
            {
                hostPath: fixturePath,
                guestRelativePath: 'fixtures/protocol.pdf',
                sha256: fixtureHash,
            },
        ];
        const clock = createManualClock();
        const probe = createProbe();
        const config: IWindowsTestHostConfig = {
            schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
            testImageRoot: hostLayout.imagesDir,
            allowedTestVmIds: [OTHER_VM_ID],
            goldenImageId: IMAGE_ID,
            goldenVmId: GOLDEN_VM_ID,
            personalVmIdsDenied: [],
            candidate: {
                artifactPath,
                sha256: digest(ARTIFACT_CONTENTS),
                fileName: path.basename(artifactPath),
                version: '1.4.2',
                sourceSha: 'b'.repeat(40),
                appArch: 'arm64',
            },
            environment: 'utm-win11-arm64-app-arm64',
            qualifiedLaunchers: ['installed-exe'],
            retention: {
                passDays: 3,
                failureDays: 14,
                maxFailedClones: 0,
                minFreeBytes: 1_024,
            },
        };
        const imageManifest: IWindowsTestImageManifest = {
            schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
            imageId: IMAGE_ID,
            vmId: GOLDEN_VM_ID,
            bundlePath: path.join(hostLayout.imagesDir, 'golden.utm'),
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
            guestTestMarker: GUEST_TEST_MARKER,
            qualifiedAt: '2026-08-02T00:00:00.000Z',
            qualification: {
                qualifiedBy: 'protocol-test',
                runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
                coldResetCycles: 3,
                notes: 'Protocol regression fixture.',
            },
        };
        const selection = {
            tests: ['WIN-SAVE-01'],
            uncoveredObligations: [],
            humanReviewObligations: [],
            hostDisplayRequired: false,
        };
        const dependencies: IWindowsTestRunDependencies = {
            config,
            layout: hostLayout,
            utmctl: createUtmctl(),
            guest: bridge.channel,
            clock,
            suiteResolver: {resolveSuite: () => Promise.resolve(selection)},
            fixtureManifest: {sha256: () => Promise.resolve(digest(fixtureManifestText))},
            imageManifest,
            stagedInputs,
            lock: {
                hostId: 'protocol-test-host',
                pid: OWNER_PID,
                probe,
                nowIso: () => clock.nowIso(),
                sleep: milliseconds => clock.sleep(milliseconds),
            },
            probe,
            hostId: 'protocol-test-host',
            randomRunSuffix: () => RUN_SUFFIX,
            identityGuard: {
                resolvePath: target => Promise.resolve(target),
                readVmId: () => Promise.resolve(CLONE_VM_ID),
                readVmName: () => Promise.resolve(`evb-win-test-${RUN_ID}`),
            },
            deadlines: {
                bootToGuestReadyMs: 1_000,
                guestReadyToDesktopReadyMs: 1_000,
                jobMs: 5_000,
                pollIntervalMs: 10,
                cancelGraceMs: 100,
                heartbeatStaleAfterMs: 2_000,
                commandTimeoutMs: 200,
                stageFileMs: 200,
            },
        };

        const report = await executeWindowsTestRun({
            suite: 'smoke',
            environment: 'utm-win11-arm64-app-arm64',
            tests: null,
        }, dependencies);
        const workerSummary = await bridge.worker;

        expect(report.outcome).toBe('passed');
        expect(report.exitCode).toBe(0);
        expect(workerSummary.result?.outcome).toBe('passed');
        expect(workerSummary.result?.cases[0]?.assertions[0]?.id).toBe('protocol-fixture-consumed');
        expect(bridge.calls).toContain(`mkdir ${windowsTestGuestRunPaths(RUN_ID).stagingDir}\\fixtures`);
        expect(bridge.calls).toContain(`stage ${windowsTestGuestRunPaths(RUN_ID).stagingDir}\\fixtures\\manifest.json`);
        expect(bridge.calls).toContain(`stage ${windowsTestGuestRunPaths(RUN_ID).stagingDir}\\fixtures\\protocol.pdf`);
        const installCommand = bridge.commands.find(command => command.some(argument => argument.endsWith('install-nsis-per-user.ps1')));
        expect(installCommand).toBeDefined();
        expect(installCommand).toEqual(expect.arrayContaining([
            '-InstallerPath',
            path.join(guestRoot, 'staging', RUN_ID, path.basename(artifactPath)),
            '-ExpectedSha256',
            digest(ARTIFACT_CONTENTS),
        ]));

        const heartbeatText = await readFile(guestPathOnDisk(guestRoot, windowsTestGuestLayout.heartbeatFile), 'utf8');
        const resultText = await readFile(guestPathOnDisk(guestRoot, windowsTestGuestRunPaths(RUN_ID).resultFile), 'utf8');
        expect(isWindowsTestWorkerHeartbeat(JSON.parse(heartbeatText))).toBe(true);
        expect(isWindowsTestResult(JSON.parse(resultText))).toBe(true);
    });
});
