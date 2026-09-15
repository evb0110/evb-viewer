import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { windowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    WindowsTestConfigError,
    type IWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import {
    createLaunchctlSessionProbe,
    parseUtmctlVersion,
    readUtmScreenshotPreference,
    resolveWindowsTestLauncher,
    UTM_SCREENSHOT_PREFERENCE_CONTAINER_PATH,
    runWindowsTestDoctor,
} from '@scripts/windows-test/host/doctor';
import type {
    IWindowsTestDoctorDependencies,
    IWindowsTestDoctorReport,
    IUtmScreenshotPreferenceStatus,
} from '@scripts/windows-test/host/doctor';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';

const GOLDEN_VM_ID = '11111111-2222-4333-8444-555555555555';
const TEST_VM_ID = '22222222-3333-4444-8555-666666666666';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const LAUNCHER = '/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
const ARTIFACT_BYTES = 'installer-bytes';

function sha256(value: string) {
    return createHash('sha256').update(value).digest('hex');
}

function createFakeUtmctl(options: {
    goldenStatus?: string;
    listError?: Error;
    versionError?: Error;
    versionText?: string;
} = {}) {
    const calls: string[] = [];
    const client: IUtmctlClient & {calls: string[]} = {
        calls,
        version: () => {
            calls.push('version');
            return options.versionError === undefined
                ? Promise.resolve(options.versionText ?? 'utmctl version 4.7.5 (118)')
                : Promise.reject(options.versionError);
        },
        list: () => {
            calls.push('list');
            return options.listError === undefined
                ? Promise.resolve([{
                    uuid: GOLDEN_VM_ID,
                    status: 'stopped',
                    name: 'windows-golden',
                }])
                : Promise.reject(options.listError);
        },
        status: (vmId) => {
            calls.push(`status ${vmId}`);
            return Promise.resolve(options.goldenStatus ?? 'stopped');
        },
        start: (vmId) => {
            calls.push(`start ${vmId}`);
            return Promise.resolve();
        },
        stop: (vmId) => {
            calls.push(`stop ${vmId}`);
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

interface IHarnessOptions {
    config?: Partial<IWindowsTestHostConfig>;
    configError?: Error;
    env?: NodeJS.ProcessEnv;
    managerName?: string | null;
    utmctl?: ReturnType<typeof createFakeUtmctl>;
    freeBytes?: number | null;
    launcherPath?: string;
    artifactBytes?: string | null;
    screenshotPreference?: Partial<IUtmScreenshotPreferenceStatus>;
}

async function createDoctorHarness(options: IHarnessOptions = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-doctor-'));
    const layout = windowsTestHostLayout(root);
    for (const directory of [
        layout.artifactsCacheDir,
        layout.fixturesCacheDir,
        layout.toolsCacheDir,
        layout.imagesDir,
    ]) {
        await mkdir(directory, {recursive: true});
    }
    const artifactPath = path.join(layout.artifactsCacheDir, 'EVBViewer-Setup.exe');
    if (options.artifactBytes !== null) {
        await writeFile(artifactPath, options.artifactBytes ?? ARTIFACT_BYTES, 'utf8');
    }

    const config: IWindowsTestHostConfig = {
        schemaVersion: 1,
        testImageRoot: layout.imagesDir,
        allowedTestVmIds: [TEST_VM_ID],
        goldenImageId: 'win11-arm64-2026-09',
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
        environment: 'win11-arm64',
        qualifiedLaunchers: [LAUNCHER],
        retention: {
            passDays: 3,
            failureDays: 14,
            maxFailedClones: 2,
            minFreeBytes: 1_024,
        },
        ...options.config,
    };

    await mkdir(layout.baselinesDir, { recursive: true });
    await mkdir(path.join(layout.toolsCacheDir, 'worker'), { recursive: true });
    await writeFile(path.join(layout.fixturesCacheDir, 'manifest.json'), '{}');
    await writeFile(path.join(layout.toolsCacheDir, 'worker', 'guestWorker.cjs'), 'worker');
    await writeFile(path.join(layout.baselinesDir, `${config.goldenImageId}.json`), JSON.stringify({
        schemaVersion: 1,
        imageId: config.goldenImageId,
        vmId: config.goldenVmId,
        bundlePath: path.join(layout.baselinesDir, 'golden.utm'),
        createdAt: '2026-09-05T00:00:00Z',
        windowsBuild: 'test-build',
        osArch: 'arm64',
        utmVersion: '4.7.5',
        qemuVersion: '10.0.2',
        driverVersions: {},
        disks: [{
            diskId: 'system',
            purpose: 'system',
            resetPolicy: 'restore-from-baseline',
        }],
        guestTestMarker: 'test-marker',
        qualifiedAt: '2026-09-04T00:00:00Z',
        qualification: {
            qualifiedBy: 'unit-test',
            runnerVersion: 'test',
            coldResetCycles: 3,
            notes: 'fixture',
        },
    }));

    const utmctl = options.utmctl ?? createFakeUtmctl();
    const screenshotPreference: IUtmScreenshotPreferenceStatus = {
        enabled: true,
        detail: 'com.utmapp.UTM NoScreenshot is 1; periodic screenshot capture is disabled.',
        remedy: 'No action needed.',
        ...options.screenshotPreference,
    };
    const dependencies: IWindowsTestDoctorDependencies = {
        layout,
        utmctl,
        sessionProbe: {managerName: () => Promise.resolve(options.managerName === undefined ? 'Aqua' : options.managerName)},
        env: options.env ?? {},
        launcherPath: options.launcherPath ?? LAUNCHER,
        hashFile: filePath => Promise.resolve(sha256(filePath === artifactPath ? ARTIFACT_BYTES : 'other')),
        readUtmScreenshotPreference: () => Promise.resolve(screenshotPreference),
        freeBytes: () => Promise.resolve(options.freeBytes === undefined ? 1_000_000 : options.freeBytes),
        loadConfig: () => (options.configError === undefined
            ? Promise.resolve(config)
            : Promise.reject(options.configError)),
    };

    return {
        layout,
        utmctl,
        config,
        artifactPath,
        run: () => runWindowsTestDoctor(dependencies),
    };
}

function checkById(report: IWindowsTestDoctorReport, id: string) {
    return report.checks.find(entry => entry.id === id) ?? null;
}

describe('windows test doctor', () => {
    it('finds the enclosing app through the CLI process ancestry', async () => {
        const runner: ICommandRunner = { run: async (_command, args) => ({
            exitCode: 0,
            stdout: args[1] === '100' ? '200 node\n' : '1 /Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)\n',
            stderr: '',
            timedOut: false,
            signal: null,
        }) };
        expect(await resolveWindowsTestLauncher({}, runner, 100)).toBe('/Applications/T3 Code (Nightly).app');
        expect(await resolveWindowsTestLauncher({ EVB_WINDOWS_TESTS_LAUNCHER: LAUNCHER }, runner, 100)).toBe(LAUNCHER);
    });
    it('reports every check green on a healthy host and never touches a VM', async () => {
        const harness = await createDoctorHarness();

        const report = await harness.run();

        expect(report.ok).toBe(true);
        expect(report.checks.map(entry => entry.id)).toEqual([
            'gui-session',
            'utmctl-present',
            'utm-screenshot-preference',
            'automation-consent',
            'config-present',
            'cache-directory-artifacts',
            'cache-directory-fixtures',
            'cache-directory-tools',
            'golden-image-manifest',
            'golden-image-qualified',
            'fixture-manifest',
            'guest-worker-bundle',
            'golden-image-stopped',
            'allowlist-sane',
            'test-image-root',
            'free-disk-space',
            'candidate-artifact',
            'launcher-qualified',
        ]);
        expect(harness.utmctl.calls).toEqual([
            'version',
            'list',
            `status ${GOLDEN_VM_ID}`,
        ]);
    });

    it('refuses readiness when the golden manifest or prepared bundle is missing', async () => {
        const harness = await createDoctorHarness();
        await rm(path.join(harness.layout.baselinesDir, `${harness.config.goldenImageId}.json`));
        await rm(path.join(harness.layout.toolsCacheDir, 'worker', 'guestWorker.cjs'));
        const report = await harness.run();
        expect(report.ok).toBe(false);
        expect(checkById(report, 'golden-image-manifest')?.ok).toBe(false);
        expect(checkById(report, 'guest-worker-bundle')?.ok).toBe(false);
    });

    it('keeps a registered but unqualified lab image red', async () => {
        const harness = await createDoctorHarness();
        const manifestPath = path.join(harness.layout.baselinesDir, `${harness.config.goldenImageId}.json`);
        const manifest = await loadWindowsTestImageManifest(manifestPath);
        await writeFile(manifestPath, JSON.stringify({
            ...manifest,
            qualifiedAt: null,
            qualification: null,
        }));
        const report = await harness.run();
        expect(report.ok).toBe(false);
        expect(checkById(report, 'golden-image-manifest')?.ok).toBe(true);
        expect(checkById(report, 'golden-image-qualified')?.ok).toBe(false);
    });

    it('fails the session check from an SSH shell without asking launchctl', async () => {
        const harness = await createDoctorHarness({
            env: {SSH_CONNECTION: '10.0.0.2 51000 10.0.0.3 22'},
            managerName: 'Aqua',
        });

        const report = await harness.run();

        expect(report.ok).toBe(false);
        expect(checkById(report, 'gui-session')?.detail).toContain('SSH_CONNECTION');
        expect(checkById(report, 'gui-session')?.remedy).toContain('Aqua session');
    });

    it('fails the session check outside an Aqua login session', async () => {
        const harness = await createDoctorHarness({managerName: 'Background'});

        const report = await harness.run();

        expect(checkById(report, 'gui-session')?.ok).toBe(false);
        expect(checkById(report, 'gui-session')?.detail).toContain('Background');
    });

    it('blames missing Automation consent when utmctl list fails', async () => {
        const harness = await createDoctorHarness({utmctl: createFakeUtmctl({listError: new Error('automation-consent-missing: OSStatus -1743')})});

        const report = await harness.run();

        expect(checkById(report, 'utmctl-present')?.ok).toBe(true);
        expect(checkById(report, 'automation-consent')?.ok).toBe(false);
        expect(checkById(report, 'automation-consent')?.remedy).toContain('Automation');
    });

    it('fails readiness when UTM 4.7.5 screenshot capture is enabled', async () => {
        const harness = await createDoctorHarness({screenshotPreference: {
            enabled: false,
            detail: 'com.utmapp.UTM NoScreenshot is 0; periodic screenshot capture remains enabled.',
            remedy: 'Enable NoScreenshot before the next run.',
        }});

        const report = await harness.run();

        expect(report.ok).toBe(false);
        expect(checkById(report, 'utm-screenshot-preference')).toMatchObject({
            ok: false,
            detail: expect.stringContaining('remains enabled'),
            remedy: expect.stringContaining('NoScreenshot'),
        });
    });

    it('keeps the screenshot workaround for newer or unknown UTM versions', async () => {
        const harness = await createDoctorHarness({
            utmctl: createFakeUtmctl({versionText: 'utmctl version 4.8.0 (120)'}),
            screenshotPreference: {
                enabled: false,
                detail: 'fixture preference is disabled',
                remedy: 'fixture remedy',
            },
        });

        const report = await harness.run();

        expect(report.ok).toBe(false);
        expect(checkById(report, 'utm-screenshot-preference')?.ok).toBe(false);
    });

    it('does not require the workaround for a version before the affected build', async () => {
        const harness = await createDoctorHarness({
            utmctl: createFakeUtmctl({versionText: 'utmctl version 4.7.4 (117)'}),
            screenshotPreference: {
                enabled: false,
                detail: 'fixture preference is disabled',
                remedy: 'fixture remedy',
            },
        });

        const report = await harness.run();

        expect(report.ok).toBe(true);
        expect(checkById(report, 'utm-screenshot-preference')).toBeNull();
    });

    it('reports version-probe consent denial without suggesting UTM installation', async () => {
        const harness = await createDoctorHarness({utmctl: createFakeUtmctl({versionError: new Error('OSStatus -1743')})});
        const report = await harness.run();
        expect(checkById(report, 'automation-consent')?.detail).toContain(LAUNCHER);
        expect(checkById(report, 'automation-consent')?.remedy).toContain('Automation');
        expect(checkById(report, 'utmctl-present')).toBeNull();
    });

    it('accepts an empty disposable allowlist before the first clone', async () => {
        const harness = await createDoctorHarness({config: {allowedTestVmIds: []}});
        expect(checkById(await harness.run(), 'allowlist-sane')?.ok).toBe(true);
    });

    it('stops after the cache checks when the configuration cannot be loaded', async () => {
        const harness = await createDoctorHarness({configError: new WindowsTestConfigError({
            kind: 'config-missing',
            configFile: '/tmp/config.json',
            message: 'Windows test host config /tmp/config.json does not exist.',
        })});

        const report = await harness.run();

        expect(report.ok).toBe(false);
        expect(checkById(report, 'config-present')?.detail).toContain('config-missing');
        expect(checkById(report, 'golden-image-stopped')).toBeNull();
        expect(harness.utmctl.calls).not.toContain(`status ${GOLDEN_VM_ID}`);
    });

    it('fails when the golden image is not stopped', async () => {
        const harness = await createDoctorHarness({utmctl: createFakeUtmctl({goldenStatus: 'started'})});

        const report = await harness.run();

        expect(checkById(report, 'golden-image-stopped')?.ok).toBe(false);
        expect(harness.utmctl.calls).not.toContain(`stop ${GOLDEN_VM_ID}`);
    });

    it('fails when the allowlist overlaps the golden or a denied personal VM', async () => {
        const goldenOverlap = await createDoctorHarness({config: {allowedTestVmIds: [
            TEST_VM_ID,
            GOLDEN_VM_ID,
        ]}});
        const personalOverlap = await createDoctorHarness({config: {allowedTestVmIds: [
            TEST_VM_ID,
            PERSONAL_VM_ID,
        ]}});

        expect(checkById(await goldenOverlap.run(), 'allowlist-sane')?.ok).toBe(false);
        expect(checkById(await personalOverlap.run(), 'allowlist-sane')?.ok).toBe(false);
    });

    it('fails when the candidate artifact is absent or hashes differently', async () => {
        const missing = await createDoctorHarness({artifactBytes: null});
        const mismatched = await createDoctorHarness({config: {candidate: {
            artifactPath: path.join(tmpdir(), 'never-read.exe'),
            sha256: 'a'.repeat(64),
            fileName: 'never-read.exe',
            version: '3.4.5',
            sourceSha: 'b'.repeat(40),
            appArch: 'arm64',
        }}});

        expect(checkById(await missing.run(), 'candidate-artifact')?.detail).toContain('missing');
        expect(checkById(await mismatched.run(), 'candidate-artifact')?.ok).toBe(false);
    });

    it('fails on low free space and on an unqualified launcher', async () => {
        const lowSpace = await createDoctorHarness({freeBytes: 512});
        const strangeLauncher = await createDoctorHarness({launcherPath: '/usr/bin/ssh'});

        expect(checkById(await lowSpace.run(), 'free-disk-space')?.ok).toBe(false);
        expect(checkById(await strangeLauncher.run(), 'launcher-qualified')?.ok).toBe(false);
    });

    it('parses a utmctl version banner and rejects one without digits', () => {
        expect(parseUtmctlVersion('utmctl version 4.7.5 (118)')).toBe('4.7.5');
        expect(parseUtmctlVersion('unknown build')).toBeNull();
    });

    it('reads the session manager name from launchctl and tolerates failure', async () => {
        const runner: ICommandRunner = {run: (command, args) => Promise.resolve({
            exitCode: command.endsWith('launchctl') && args[0] === 'managername' ? 0 : 1,
            stdout: 'Aqua\n',
            stderr: '',
            timedOut: false,
            signal: null,
        })};
        const failing: ICommandRunner = {run: () => Promise.reject(new Error('launchctl is missing'))};

        expect(await createLaunchctlSessionProbe(runner).managerName()).toBe('Aqua');
        expect(await createLaunchctlSessionProbe(failing).managerName()).toBeNull();
    });

    it('reads NoScreenshot with defaults without writing preferences', async () => {
        const calls: Array<{
            command: string;
            args: string[]
        }> = [];
        const runner: ICommandRunner = {run: async (command, args) => {
            calls.push({
                command,
                args,
            });
            return {
                exitCode: 0,
                stdout: '1\n',
                stderr: '',
                timedOut: false,
                signal: null,
            };
        }};

        await expect(readUtmScreenshotPreference(runner)).resolves.toMatchObject({enabled: true});
        expect(calls).toEqual([{
            command: '/usr/bin/defaults',
            args: [
                'read',
                UTM_SCREENSHOT_PREFERENCE_CONTAINER_PATH.slice(0, -'.plist'.length),
                'NoScreenshot',
            ],
        }]);
    });

    it('falls back to the plain domain only when the container plist is absent', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-utm-preferences-'));
        const containerPath = path.join(tempRoot, 'missing.plist');
        const calls: string[][] = [];
        const runner: ICommandRunner = {run: async (_command, args) => {
            calls.push(args);
            return {
                exitCode: 0,
                stdout: '1\n',
                stderr: '',
                timedOut: false,
                signal: null,
            };
        }};

        await expect(readUtmScreenshotPreference(runner, {containerPath})).resolves.toMatchObject({enabled: true});
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([
            'read',
            'com.utmapp.UTM',
            'NoScreenshot',
        ]);
        await rm(tempRoot, {
            recursive: true,
            force: true,
        });
    });

    it('does not fall back when an existing container plist lacks NoScreenshot', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-utm-preferences-'));
        const containerPath = path.join(tempRoot, 'present.plist');
        await writeFile(containerPath, 'plist');
        const calls: string[][] = [];
        const runner: ICommandRunner = {run: async (_command, args) => {
            calls.push(args);
            return {
                exitCode: 1,
                stdout: '',
                stderr: 'The domain/default pair does not exist',
                timedOut: false,
                signal: null,
            };
        }};

        await expect(readUtmScreenshotPreference(runner, {containerPath})).resolves.toMatchObject({
            enabled: false,
            detail: expect.stringContaining('unset'),
        });
        expect(calls).toHaveLength(1);
        await rm(tempRoot, {
            recursive: true,
            force: true,
        });
    });

    it('fails closed on a container permission error without falling back', async () => {
        const calls: string[][] = [];
        const runner: ICommandRunner = {run: async (_command, args) => {
            calls.push(args);
            return {
                exitCode: 1,
                stdout: '',
                stderr: 'Operation not permitted',
                timedOut: false,
                signal: null,
            };
        }};

        await expect(readUtmScreenshotPreference(runner)).resolves.toMatchObject({
            enabled: false,
            detail: expect.stringContaining('Operation not permitted'),
        });
        expect(calls).toHaveLength(1);
    });

    it('fails closed when NoScreenshot is unset', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-utm-preferences-'));
        const containerPath = path.join(tempRoot, 'missing.plist');
        const runner: ICommandRunner = {run: async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'The domain/default pair of (com.utmapp.UTM, NoScreenshot) does not exist',
            timedOut: false,
            signal: null,
        })};

        await expect(readUtmScreenshotPreference(runner, {containerPath})).resolves.toMatchObject({
            enabled: false,
            detail: expect.stringContaining('unset'),
            remedy: expect.stringContaining('NoScreenshot'),
        });
        await rm(tempRoot, {
            recursive: true,
            force: true,
        });
    });
});
