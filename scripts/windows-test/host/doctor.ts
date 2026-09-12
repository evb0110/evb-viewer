import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    stat,
    statfs,
} from 'node:fs/promises';
import path from 'node:path';
import { detectsAutomationConsentFailure } from '@scripts/windows-test/host/utmctlClient';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    WindowsTestConfigError,
    loadWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import {
    isQualifiedWindowsTestImage,
    loadWindowsTestImageManifest,
} from '@scripts/windows-test/images/imageManifest';

export interface IWindowsTestDoctorCheck {
    id: string;
    ok: boolean;
    detail: string;
    remedy: string;
}

export interface IWindowsTestDoctorReport {
    ok: boolean;
    checks: IWindowsTestDoctorCheck[];
}

export interface IWindowsTestSessionProbe {managerName(): Promise<string | null>;}

export async function resolveWindowsTestLauncher(
    env: NodeJS.ProcessEnv,
    runner: ICommandRunner,
    processId = process.pid,
) {
    if (env.EVB_WINDOWS_TESTS_LAUNCHER) {
        return env.EVB_WINDOWS_TESTS_LAUNCHER;
    }
    let pid = processId;
    const visited = new Set<number>();
    for (let depth = 0; depth < 12 && pid > 1 && !visited.has(pid); depth += 1) {
        visited.add(pid);
        const result = await runner.run('/bin/ps', [
            '-p',
            String(pid),
            '-o',
            'ppid=,comm=',
        ], { timeoutMs: 5_000 }).catch(() => null);
        const match = result?.exitCode === 0 ? /^\s*(\d+)\s+(.+)$/u.exec(result.stdout.trim()) : null;
        if (match === null) {
            break;
        }
        const application = /^(.*?\.app)(?:\/|$)/u.exec(match[2] ?? '');
        if (application?.[1]) {
            return application[1];
        }
        pid = Number(match[1]);
    }
    return env.TERM_PROGRAM === 'Apple_Terminal'
        ? '/System/Applications/Utilities/Terminal.app'
        : env.TERM_PROGRAM === 'iTerm.app'
            ? '/Applications/iTerm.app'
            : process.execPath;
}

// `utmctl` drives UTM through ScriptingBridge, which only works from a real Aqua
// session. `launchctl managername` is the cheapest way to tell an Aqua login
// apart from an SSH or pre-login context.
export function createLaunchctlSessionProbe(
    runner: ICommandRunner,
    options: {
        launchctlPath?: string;
        timeoutMs?: number;
    } = {},
): IWindowsTestSessionProbe {
    const launchctlPath = options.launchctlPath ?? '/bin/launchctl';
    const timeoutMs = options.timeoutMs ?? 5_000;
    return {managerName: async () => {
        const result = await runner
            .run(launchctlPath, ['managername'], {timeoutMs})
            .catch(() => null);
        if (result === null || result.exitCode !== 0) {
            return null;
        }
        const name = result.stdout.trim();
        return name.length === 0 ? null : name;
    }};
}

export const UTMCTL_VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?/u;
export const UTM_SCREENSHOT_PREFERENCE_DOMAIN = 'com.utmapp.UTM';
export const UTM_SCREENSHOT_PREFERENCE_KEY = 'NoScreenshot';
export const UTM_SCREENSHOT_PREFERENCE_COMMAND = '/usr/bin/defaults';
export const UTM_SCREENSHOT_PREFERENCE_REMEDY = 'Before changing the preference, verify every VM is stopped and UTM has been quit normally. Then enable UTM Settings > Display > Disable VM screenshot, or run defaults write com.utmapp.UTM NoScreenshot -bool YES. Never target a personal VM.';
const UTM_SCREENSHOT_PREFERENCE_MIN_VERSION = [
    4,
    7,
    5,
] as const;

export interface IUtmScreenshotPreferenceStatus {
    enabled: boolean;
    detail: string;
    remedy: string;
}

export function parseUtmctlVersion(text: string) {
    const match = UTMCTL_VERSION_PATTERN.exec(text);
    return match === null ? null : match[0];
}

export function isUtmScreenshotPreferenceRequired(version: string | null) {
    if (version === null) {
        return true;
    }
    const parts = version.split('.').map(Number);
    if (parts.some(part => !Number.isInteger(part) || part < 0)) {
        return true;
    }
    for (let index = 0; index < UTM_SCREENSHOT_PREFERENCE_MIN_VERSION.length; index += 1) {
        const current = parts[index] ?? 0;
        const minimum = UTM_SCREENSHOT_PREFERENCE_MIN_VERSION[index] ?? 0;
        if (current > minimum) {
            return true;
        }
        if (current < minimum) {
            return false;
        }
    }
    return true;
}

export async function readUtmScreenshotPreference(
    runner: ICommandRunner,
): Promise<IUtmScreenshotPreferenceStatus> {
    let result;
    try {
        result = await runner.run(
            UTM_SCREENSHOT_PREFERENCE_COMMAND,
            [
                'read',
                UTM_SCREENSHOT_PREFERENCE_DOMAIN,
                UTM_SCREENSHOT_PREFERENCE_KEY,
            ],
            {timeoutMs: 5_000},
        );
    } catch (error) {
        return {
            enabled: false,
            detail: `Could not read ${UTM_SCREENSHOT_PREFERENCE_DOMAIN} ${UTM_SCREENSHOT_PREFERENCE_KEY}: ${getErrorMessage(error)}.`,
            remedy: UTM_SCREENSHOT_PREFERENCE_REMEDY,
        };
    }
    if (result.exitCode !== 0 || result.timedOut) {
        const detail = result.stderr.trim() || 'defaults read failed';
        if (!result.timedOut && /(?:does not exist|not found)/iu.test(detail)) {
            return {
                enabled: false,
                detail: `${UTM_SCREENSHOT_PREFERENCE_DOMAIN} ${UTM_SCREENSHOT_PREFERENCE_KEY} is unset; UTM periodic screenshot capture remains enabled.`,
                remedy: UTM_SCREENSHOT_PREFERENCE_REMEDY,
            };
        }
        return {
            enabled: false,
            detail: `The ${UTM_SCREENSHOT_PREFERENCE_DOMAIN} ${UTM_SCREENSHOT_PREFERENCE_KEY} preference is unavailable: ${detail}.`,
            remedy: UTM_SCREENSHOT_PREFERENCE_REMEDY,
        };
    }
    const value = result.stdout.trim().toLowerCase();
    const enabled = value === '1' || value === 'true' || value === 'yes';
    return {
        enabled,
        detail: value.length === 0
            ? `${UTM_SCREENSHOT_PREFERENCE_DOMAIN} ${UTM_SCREENSHOT_PREFERENCE_KEY} is unset; UTM periodic screenshot capture remains enabled.`
            : `${UTM_SCREENSHOT_PREFERENCE_DOMAIN} ${UTM_SCREENSHOT_PREFERENCE_KEY} is ${value}; ${enabled ? 'periodic screenshot capture is disabled.' : 'periodic screenshot capture remains enabled.'}`,
        remedy: enabled ? 'No action needed.' : UTM_SCREENSHOT_PREFERENCE_REMEDY,
    };
}

export interface IWindowsTestDoctorDependencies {
    layout: IWindowsTestHostLayout;
    utmctl: IUtmctlClient;
    sessionProbe: IWindowsTestSessionProbe;
    env: NodeJS.ProcessEnv;
    launcherPath: string;
    hashFile(filePath: string): Promise<string>;
    readUtmScreenshotPreference(): Promise<IUtmScreenshotPreferenceStatus>;
    freeBytes?(target: string): Promise<number | null>;
    loadConfig?(configFile: string): Promise<IWindowsTestHostConfig>;
}

export async function nodeFreeBytes(target: string) {
    const stats = await statfs(target).catch(() => null);
    return stats === null ? null : stats.bsize * stats.bavail;
}

function check(id: string, ok: boolean, detail: string, remedy: string): IWindowsTestDoctorCheck {
    return {
        id,
        ok,
        detail,
        remedy,
    };
}

async function directoryExists(target: string) {
    const stats = await stat(target).catch(() => null);
    return stats !== null && stats.isDirectory();
}

async function checkSession(dependencies: IWindowsTestDoctorDependencies) {
    const sshConnection = dependencies.env.SSH_CONNECTION;
    if (sshConnection !== undefined && sshConnection.length > 0) {
        return check(
            'gui-session',
            false,
            'SSH_CONNECTION is set, so this shell is not a macOS GUI session.',
            'Run the Windows lane from a Terminal window inside a logged-in Aqua session; utmctl cannot reach UTM over SSH.',
        );
    }
    const managerName = await dependencies.sessionProbe.managerName();
    return check(
        'gui-session',
        managerName === 'Aqua',
        `launchctl managername reported ${managerName ?? 'nothing'}.`,
        'Run the lane from a logged-in Aqua session; a pre-login or SSH context cannot script UTM.',
    );
}

async function checkUtmctl(dependencies: IWindowsTestDoctorDependencies) {
    const checks: IWindowsTestDoctorCheck[] = [];
    let version: string | null = null;
    try {
        version = parseUtmctlVersion(await dependencies.utmctl.version());
    } catch (error) {
        const detail = getErrorMessage(error);
        const consentMissing = detectsAutomationConsentFailure(detail);
        checks.push(check(
            consentMissing ? 'automation-consent' : 'utmctl-present',
            false,
            `utmctl version failed for launcher ${dependencies.launcherPath}: ${detail}`,
            consentMissing
                ? 'Grant this launcher Automation access to UTM in System Settings > Privacy & Security > Automation, then retry. If no UTM entry or consent prompt appears, check the launcher Apple Events entitlement and usage description; see docs/contributing/windows-tests/setup-and-repair.md.'
                : 'Install UTM and confirm /Applications/UTM.app/Contents/MacOS/utmctl is executable.',
        ));
        return checks;
    }
    checks.push(check(
        'utmctl-present',
        version !== null,
        `utmctl reported version ${version ?? 'in an unparsable form'}.`,
        'Install a UTM build whose utmctl prints a parsable version.',
    ));
    if (isUtmScreenshotPreferenceRequired(version)) {
        const screenshotPreference = await dependencies.readUtmScreenshotPreference();
        checks.push(check(
            'utm-screenshot-preference',
            screenshotPreference.enabled,
            screenshotPreference.detail,
            screenshotPreference.remedy,
        ));
    }

    try {
        const registered = await dependencies.utmctl.list();
        checks.push(check(
            'automation-consent',
            true,
            `utmctl listed ${registered.length} registered virtual machines.`,
            'No action needed.',
        ));
    } catch (error) {
        checks.push(check(
            'automation-consent',
            false,
            `utmctl list failed: ${getErrorMessage(error)}.`,
            'Grant the qualified launcher Automation access to UTM in System Settings > Privacy & Security > Automation, then retry.',
        ));
    }
    return checks;
}

async function checkGoldenImage(
    dependencies: IWindowsTestDoctorDependencies,
    config: IWindowsTestHostConfig,
) {
    try {
        const status = await dependencies.utmctl.status(config.goldenVmId);
        return check(
            'golden-image-stopped',
            status === 'stopped',
            `The golden image ${config.goldenVmId} reports status "${status}".`,
            'Stop the golden image; every run must clone an identical stopped baseline.',
        );
    } catch (error) {
        return check(
            'golden-image-stopped',
            false,
            `The golden image ${config.goldenVmId} could not be queried: ${getErrorMessage(error)}.`,
            'Register the golden image in UTM and record its UUID as goldenVmId.',
        );
    }
}

function checkAllowlist(config: IWindowsTestHostConfig) {
    const golden = config.goldenVmId.toLowerCase();
    const allowlisted = config.allowedTestVmIds.map(vmId => vmId.toLowerCase());
    const overlapsGolden = allowlisted.includes(golden);
    const overlapsDenied = allowlisted.some(vmId => config.personalVmIdsDenied.includes(vmId));
    return check(
        'allowlist-sane',
        !overlapsGolden && !overlapsDenied,
        `allowedTestVmIds holds ${allowlisted.length} UUIDs, golden overlap: ${String(overlapsGolden)}, denied overlap: ${String(overlapsDenied)}.`,
        'List only disposable test VM UUIDs in allowedTestVmIds and keep the golden and personal UUIDs out of it.',
    );
}

async function checkCandidate(
    dependencies: IWindowsTestDoctorDependencies,
    config: IWindowsTestHostConfig,
) {
    if (config.candidate === null) {
        return check(
            'candidate-artifact',
            false,
            'No candidate artifact is recorded in the host configuration.',
            'Record the candidate build in config.json. --artifact overrides it for one run and requires a matching build metadata sidecar.',
        );
    }
    const stats = await stat(config.candidate.artifactPath).catch(() => null);
    if (stats === null || !stats.isFile()) {
        return check(
            'candidate-artifact',
            false,
            `The candidate artifact ${config.candidate.artifactPath} is missing.`,
            'Re-stage the candidate artifact with --artifact <absolute path>.',
        );
    }
    const observed = await dependencies.hashFile(config.candidate.artifactPath).catch(() => null);
    return check(
        'candidate-artifact',
        observed === config.candidate.sha256,
        `The candidate artifact hashes to ${observed ?? 'nothing readable'} against the recorded ${config.candidate.sha256}.`,
        'Re-stage the candidate artifact so its recorded sha256 matches the file on disk.',
    );
}

export async function runWindowsTestDoctor(
    dependencies: IWindowsTestDoctorDependencies,
): Promise<IWindowsTestDoctorReport> {
    const freeBytes = dependencies.freeBytes ?? nodeFreeBytes;
    const loadConfig = dependencies.loadConfig ?? loadWindowsTestHostConfig;
    const checks: IWindowsTestDoctorCheck[] = [await checkSession(dependencies)];
    checks.push(...await checkUtmctl(dependencies));

    let config: IWindowsTestHostConfig | null = null;
    try {
        config = await loadConfig(dependencies.layout.configFile);
        checks.push(check(
            'config-present',
            true,
            `Loaded host configuration from ${dependencies.layout.configFile}.`,
            'No action needed.',
        ));
    } catch (error) {
        checks.push(check(
            'config-present',
            false,
            error instanceof WindowsTestConfigError
                ? `${error.kind}: ${error.message}`
                : `The host configuration could not be loaded: ${getErrorMessage(error)}.`,
            `Create ${dependencies.layout.configFile} and record the golden image, the test VM allowlist and the retention policy.`,
        ));
    }

    const cacheDirectories = [
        {
            label: 'artifacts',
            cacheDir: dependencies.layout.artifactsCacheDir,
        },
        {
            label: 'fixtures',
            cacheDir: dependencies.layout.fixturesCacheDir,
        },
        {
            label: 'tools',
            cacheDir: dependencies.layout.toolsCacheDir,
        },
    ];
    for (const {
        label,
        cacheDir,
    } of cacheDirectories) {
        checks.push(check(
            `cache-directory-${label}`,
            await directoryExists(cacheDir),
            `Cache directory ${cacheDir}.`,
            `Create ${cacheDir} so staged inputs are cached between runs.`,
        ));
    }

    if (config === null) {
        return {
            ok: checks.every(entry => entry.ok),
            checks,
        };
    }

    const manifestPath = path.join(dependencies.layout.baselinesDir, `${config.goldenImageId}.json`);
    const manifest = await loadWindowsTestImageManifest(manifestPath).catch(() => null);
    checks.push(check(
        'golden-image-manifest',
        manifest !== null && manifest.imageId === config.goldenImageId
            && manifest.vmId.toLowerCase() === config.goldenVmId.toLowerCase(),
        manifest === null
            ? `The image manifest ${manifestPath} is missing or malformed.`
            : `Manifest image ID matches configuration: ${manifest.imageId === config.goldenImageId}; VM ID matches: ${manifest.vmId.toLowerCase() === config.goldenVmId.toLowerCase()}.`,
        'Record the observed lab image in its manifest; do not copy identities from another VM.',
    ));
    checks.push(check(
        'golden-image-qualified',
        manifest !== null && isQualifiedWindowsTestImage(manifest),
        manifest !== null && isQualifiedWindowsTestImage(manifest)
            ? 'The lab image has recorded guest setup and cold-reset qualification.'
            : 'The lab image needs recorded guest setup and cold-reset qualification.',
        'Complete the image qualification in docs/contributing/windows-tests/setup-and-repair.md and record its evidence before running suites.',
    ));

    for (const {
        id,
        file,
    } of [
            {
                id: 'fixture-manifest',
                file: path.join(dependencies.layout.fixturesCacheDir, 'manifest.json'),
            },
            {
                id: 'guest-worker-bundle',
                file: path.join(dependencies.layout.toolsCacheDir, 'worker', 'guestWorker.cjs'),
            },
        ]) {
        const fileStat = await stat(file).catch(() => null);
        checks.push(check(
            id,
            fileStat !== null && fileStat.isFile() && fileStat.size > 0,
            `Prepared input ${file}.`,
            'Run pnpm windows:test:prepare to build the worker and generate fixtures.',
        ));
    }

    const automationAvailable = checks.some(entry => entry.id === 'automation-consent' && entry.ok);
    checks.push(automationAvailable
        ? await checkGoldenImage(dependencies, config)
        : check(
            'golden-image-stopped',
            false,
            'The VM state cannot be checked until this launcher can control UTM.',
            'Resolve the Automation failure first; a denied VM query does not prove that the registered lab image is missing.',
        ));
    checks.push(checkAllowlist(config));
    checks.push(check(
        'test-image-root',
        await directoryExists(config.testImageRoot),
        `Test image root ${config.testImageRoot}.`,
        'Create the configured test image root and keep every disposable clone inside it.',
    ));

    const observedFreeBytes = await freeBytes(config.testImageRoot).catch(() => null);
    checks.push(check(
        'free-disk-space',
        observedFreeBytes !== null && observedFreeBytes >= config.retention.minFreeBytes,
        `${String(observedFreeBytes)} bytes free against the required ${config.retention.minFreeBytes}.`,
        'Free disk space or delete retained failed clones before running the lane.',
    ));
    checks.push(await checkCandidate(dependencies, config));
    checks.push(check(
        'launcher-qualified',
        config.qualifiedLaunchers.includes(dependencies.launcherPath),
        `Launcher ${dependencies.launcherPath} against ${config.qualifiedLaunchers.length} qualified launchers.`,
        'Complete the documented live launcher qualification after granting UTM Automation consent, then record this launcher in qualifiedLaunchers.',
    ));

    return {
        ok: checks.every(entry => entry.ok),
        checks,
    };
}
