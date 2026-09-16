import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    generateWindowsTestAccountPassword,
    healWindowsTestGoldenImage,
} from '@scripts/windows-test/host/goldenImageProvisioning';
import type { IWindowsTestGoldenProvisionDependencies } from '@scripts/windows-test/host/goldenImageProvisioning';
import { WINDOWS_TEST_SCHEMA_VERSION } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import { createManualClock } from '@scripts/windows-test/host/hostClock';
import type { IUtmctlClient } from '@scripts/windows-test/host/utmctlClient';
import { windowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import {
    isQualifiedWindowsTestImage,
    loadWindowsTestImageManifest,
} from '@scripts/windows-test/images/imageManifest';

const GOLDEN_VM_ID = '22222222-3333-4444-8555-666666666666';
const GOLDEN_IMAGE_ID = 'evb-win11-arm64-test-golden';

function digest(value: string) {
    return createHash('sha256').update(value).digest('hex');
}

function createConfig(testImageRoot: string): IWindowsTestHostConfig {
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        testImageRoot,
        allowedTestVmIds: [],
        goldenImageId: GOLDEN_IMAGE_ID,
        goldenVmId: GOLDEN_VM_ID,
        personalVmIdsDenied: ['99999999-8888-4777-8666-555555555555'],
        candidate: null,
        environment: 'win11-arm64',
        qualifiedLaunchers: [],
        retention: {
            passDays: 1,
            failureDays: 1,
            maxFailedClones: 1,
            minFreeBytes: 1,
        },
    };
}

function createManifest(bundlePath: string): IWindowsTestImageManifest {
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        imageId: GOLDEN_IMAGE_ID,
        vmId: GOLDEN_VM_ID,
        bundlePath,
        createdAt: '2026-09-16T00:00:00.000Z',
        windowsBuild: 'Windows 11',
        osArch: 'arm64',
        utmVersion: '4.7.5',
        qemuVersion: '9.2.0',
        driverVersions: {},
        disks: [{
            diskId: 'system',
            purpose: 'system',
            resetPolicy: 'restore-from-baseline',
        }],
        guestTestMarker: 'system-startup',
        qualifiedAt: null,
        qualification: null,
    };
}

function freshHeartbeat(bootId: string, updatedAt: string) {
    return {
        schemaVersion: 1 as const,
        bootId,
        guestTestMarker: 'system-startup',
        updatedAt,
        locked: false,
        worker: {
            userSid: 'S-1-5-21-test',
            sessionId: 1,
            integrityLevel: 'medium',
            inputDesktop: 'Default',
            interactive: true,
            workerPid: 123,
            workerStartTime: updatedAt,
        },
    };
}

async function createFixtureSources(root: string, repositoryRoot: string) {
    const workerDirectory = path.join(root, 'worker');
    const toolsDirectory = path.join(root, 'tools');
    await mkdir(workerDirectory, {recursive: true});
    await mkdir(toolsDirectory, {recursive: true});
    await writeFile(path.join(workerDirectory, 'guestWorker.cjs'), 'worker');
    await writeFile(path.join(workerDirectory, 'guestWorker.cjs.map'), 'map');
    const nodeArchivePath = path.join(toolsDirectory, 'node.zip');
    await writeFile(nodeArchivePath, 'node archive');
    return {
        repositoryRoot,
        workerDirectory,
        nodeArchivePath,
    };
}

function createGuest(clock: ReturnType<typeof createManualClock>, options: {
    initialHeartbeat: ReturnType<typeof freshHeartbeat> | null;
    installerExitCode?: number;
    markerAvailable?: boolean;
}) {
    let bootId = options.initialHeartbeat?.bootId ?? 'boot-old';
    let heartbeat = options.initialHeartbeat;
    let bootstrapComplete = false;
    const staged: string[] = [];
    const executions: string[][] = [];
    const guest: IWindowsTestGuestChannel = {
        ping: async () => options.markerAvailable !== false,
        ensureDirectory: async () => undefined,
        readHeartbeat: async () => heartbeat,
        stageFile: async (_vmId, _hostPath, guestPath) => {
            staged.push(guestPath);
        },
        stageText: async () => undefined,
        verifyStagedFileHash: async () => false,
        writeJob: async () => undefined,
        publishReadyMarker: async () => undefined,
        requestGuestCancel: async () => undefined,
        readGuestText: async (_vmId, guestPath) => {
            if (guestPath.endsWith('boot-id.txt')) {
                return bootId;
            }
            if (guestPath.endsWith('system-bootstrap-complete.marker')) {
                return bootstrapComplete ? 'complete=v2\n' : null;
            }
            return null;
        },
        pullGuestFile: async () => false,
        execute: async (_vmId, command) => {
            executions.push([...command]);
            if (command[0] === 'cmd.exe' && command.at(-1) === '0') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    signal: null,
                    transportFailure: null,
                };
            }
            if (command[0] === 'cmd.exe') {
                bootstrapComplete = true;
                return {
                    exitCode: options.installerExitCode ?? 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    signal: null,
                    transportFailure: null,
                };
            }
            if (command[0] === 'shutdown.exe') {
                clock.advance(1);
                bootId = 'boot-new';
                heartbeat = freshHeartbeat(bootId, clock.nowIso());
            }
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
                timedOut: false,
                signal: null,
                transportFailure: null,
            };
        },
    };
    return {
        guest,
        staged,
        executions,
    };
}

function createUtm(initialStatus = 'stopped') {
    let status = initialStatus;
    const calls = {
        start: 0,
        stop: [] as Array<'request' | 'force'>,
    };
    const utmctl: IUtmctlClient = {
        version: async () => '4.7.5',
        list: async () => [{
            uuid: GOLDEN_VM_ID,
            status,
            name: 'evb-win11-arm64-lab-golden',
        }],
        status: async () => status,
        start: async () => {
            calls.start += 1;
            status = 'started';
        },
        stop: async (_vmId: string, mode: 'request' | 'force') => {
            calls.stop.push(mode);
            status = 'stopped';
        },
        clone: async () => undefined,
        deleteVm: async () => undefined,
        ipAddress: async () => [],
        exec: async () => ({
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            signal: null,
            transportFailure: null,
        }),
        pushFile: async () => undefined,
        pullFile: async () => undefined,
    };
    return {
        utmctl,
        calls,
    };
}

async function createOptions(overrides: {
    initialHeartbeat?: ReturnType<typeof freshHeartbeat> | null;
    installerExitCode?: number;
    markerAvailable?: boolean;
} = {}) {
    const root = await mkdtemp(path.join('/tmp', 'evb-windows-golden-heal-'));
    const layout = windowsTestHostLayout(root);
    const bundlePath = path.join(layout.baselinesDir, 'golden.utm');
    await mkdir(bundlePath, {recursive: true});
    const manifestPath = path.join(layout.baselinesDir, `${GOLDEN_IMAGE_ID}.json`);
    const manifest = createManifest(bundlePath);
    await mkdir(layout.baselinesDir, {recursive: true});
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    const repositoryRoot = path.resolve(process.cwd());
    const sources = await createFixtureSources(root, repositoryRoot);
    const clock = createManualClock();
    const guestFixture = createGuest(clock, {
        initialHeartbeat: overrides.initialHeartbeat ?? null,
        ...(overrides.installerExitCode === undefined ? {} : {installerExitCode: overrides.installerExitCode}),
        ...(overrides.markerAvailable === undefined ? {} : {markerAvailable: overrides.markerAvailable}),
    });
    const utmFixture = createUtm();
    const dependencies: IWindowsTestGoldenProvisionDependencies = {
        config: createConfig(layout.imagesDir),
        layout,
        imageManifest: manifest,
        manifestPath,
        utmctl: utmFixture.utmctl,
        guest: guestFixture.guest,
        clock,
        sources,
        identityGuard: {
            resolvePath: target => Promise.resolve(path.resolve(target)),
            readVmId: () => Promise.resolve(GOLDEN_VM_ID),
            readVmName: () => Promise.resolve('evb-win11-arm64-lab-golden'),
        },
        deadlines: {
            bootToGuestReadyMs: 1,
            guestReadyToDesktopReadyMs: 1,
            jobMs: 1,
            pollIntervalMs: 1,
            cancelGraceMs: 1,
            heartbeatStaleAfterMs: 1,
            commandTimeoutMs: 1,
            stageFileMs: 1,
        },
    };
    return {
        root,
        dependencies,
        guestFixture,
        utmFixture,
    };
}

describe('headless golden image provisioning', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map(root => rm(root, {
            force: true,
            recursive: true,
        })));
    });

    it('generates a long shell-safe password with Windows complexity classes', () => {
        const secret = generateWindowsTestAccountPassword();

        expect(secret.length).toBeGreaterThanOrEqual(48);
        expect(/^[A-Za-z0-9_-]+$/u.test(secret)).toBe(true);
        expect(/[A-Z]/u.test(secret)).toBe(true);
        expect(/[a-z]/u.test(secret)).toBe(true);
        expect(/[0-9]/u.test(secret)).toBe(true);
        expect(/[^A-Za-z0-9]/u.test(secret)).toBe(true);
    });

    it('refuses a data root that resolves inside the checkout before creating a secret', async () => {
        const fixture = await createOptions();
        roots.push(fixture.root);
        fixture.dependencies.sources = {
            ...fixture.dependencies.sources,
            repositoryRoot: fixture.root,
        };

        await expect(healWindowsTestGoldenImage(fixture.dependencies))
            .rejects.toThrow(/outside the repository/u);
        await expect(stat(path.join(fixture.root, 'secrets', 'test-account.secret')))
            .rejects.toThrow();
    });

    it('stages the SYSTEM bootstrap, waits for a fresh interactive heartbeat, qualifies, and stops the golden', async () => {
        const fixture = await createOptions();
        roots.push(fixture.root);
        const generatedSecret = generateWindowsTestAccountPassword();
        const result = await healWindowsTestGoldenImage({
            ...fixture.dependencies,
            randomPassword: () => generatedSecret,
            randomId: () => 'provision-test',
        });

        expect(result.alreadyProvisioned).toBe(false);
        expect(fixture.utmFixture.calls.start).toBe(1);
        expect(fixture.utmFixture.calls.stop).toEqual(['request']);
        expect(fixture.guestFixture.staged).toContain('C:\\EVBViewerTests\\staging\\golden-heal-provision-test\\test-account.secret');
        expect(fixture.guestFixture.staged).toContain('C:\\EVBViewerTests\\staging\\golden-heal-provision-test\\install-system-bootstrap.cmd');
        expect(fixture.guestFixture.staged).toContain('C:\\EVBViewerTests\\staging\\golden-heal-provision-test\\node.zip');
        expect(fixture.guestFixture.staged).toContain('C:\\EVBViewerTests\\staging\\golden-heal-provision-test\\guestWorker.cjs.map');
        expect(fixture.guestFixture.staged.some(file => file.endsWith('\\powershell\\register-worker-logon-task.ps1'))).toBe(true);
        expect(fixture.guestFixture.executions.map(command => command[0])).toEqual([
            'cmd.exe',
            'shutdown.exe',
        ]);
        const secretPath = path.join(fixture.root, 'secrets', 'test-account.secret');
        expect(digest((await readFile(secretPath, 'utf8')).trim())).toBe(digest(generatedSecret));
        expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
        const manifest = await loadWindowsTestImageManifest(fixture.dependencies.manifestPath);
        expect(isQualifiedWindowsTestImage(manifest)).toBe(true);
        const evidence = await readFile(result.evidencePath, 'utf8');
        expect(evidence).toContain('golden-image-headless-heal');
        expect(evidence.includes(generatedSecret)).toBe(false);
    });

    it('uses a guest-agent exec probe when the unprovisioned image has no lab marker yet', async () => {
        const fixture = await createOptions({markerAvailable: false});
        roots.push(fixture.root);

        const result = await healWindowsTestGoldenImage(fixture.dependencies);

        expect(result.alreadyProvisioned).toBe(false);
        expect(fixture.guestFixture.executions[0]).toEqual([
            'cmd.exe',
            '/d',
            '/c',
            'exit',
            '0',
        ]);
    });

    it('is idempotent when the golden already publishes a fresh interactive heartbeat', async () => {
        const clock = createManualClock();
        const fixture = await createOptions({initialHeartbeat: freshHeartbeat('boot-ready', clock.nowIso())});
        roots.push(fixture.root);
        const result = await healWindowsTestGoldenImage(fixture.dependencies);

        expect(result.alreadyProvisioned).toBe(true);
        expect(fixture.guestFixture.staged).toEqual([]);
        expect(fixture.guestFixture.executions).toEqual([]);
        expect(fixture.utmFixture.calls.stop).toEqual(['request']);
        await expect(readFile(path.join(fixture.root, 'secrets', 'test-account.secret'))).rejects.toThrow();
    });

    it('stops the golden and records redacted evidence when bootstrap fails', async () => {
        const fixture = await createOptions({installerExitCode: 1});
        roots.push(fixture.root);
        const generatedSecret = generateWindowsTestAccountPassword();

        await expect(healWindowsTestGoldenImage({
            ...fixture.dependencies,
            randomPassword: () => generatedSecret,
        })).rejects.toThrow(/Redacted evidence:/u);
        expect(fixture.utmFixture.calls.stop).toEqual(['request']);
        const evidenceFiles = await readdir(path.join(fixture.root, 'provisioning'));
        expect(evidenceFiles).toHaveLength(1);
        const evidence = await readFile(path.join(fixture.root, 'provisioning', evidenceFiles[0] ?? ''), 'utf8');
        expect(evidence).toContain('The SYSTEM bootstrap installer did not complete successfully.');
        expect(evidence.includes(generatedSecret)).toBe(false);
    });

    it('stops a manually started golden before reporting that healing requires a stopped image', async () => {
        const fixture = await createOptions();
        roots.push(fixture.root);
        fixture.utmFixture = {
            ...fixture.utmFixture,
            ...createUtm('started'),
        };

        await expect(healWindowsTestGoldenImage({
            ...fixture.dependencies,
            utmctl: fixture.utmFixture.utmctl,
        })).rejects.toThrow(/must be stopped/u);
        expect(fixture.utmFixture.calls.stop).toEqual(['request']);
    });
});
