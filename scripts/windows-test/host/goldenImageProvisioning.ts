import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    writeFile,
} from 'node:fs/promises';
import {
    randomBytes,
    randomUUID,
} from 'node:crypto';
import path from 'node:path';
import {WINDOWS_TEST_RUNNER_VERSION} from '@scripts/windows-test/contracts/windowsTestContracts';
import {windowsTestGuestLayout} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import type { IWindowsTestClock } from '@scripts/windows-test/host/hostClock';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { IUtmctlClient } from '@scripts/windows-test/host/utmctlClient';
import {
    defaultWindowsTestRunDeadlines,
    pollUntil,
} from '@scripts/windows-test/host/runCoordinator';
import type { IWindowsTestRunDeadlines } from '@scripts/windows-test/host/runCoordinator';
import { destructivePolicyFromConfig } from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestIdentityGuardDependencies } from '@scripts/windows-test/images/vmIdentityGuard';
import { assertGoldenImageTarget } from '@scripts/windows-test/host/assertGoldenImageTarget';
import { loadWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import { isFreshInteractiveWorkerHeartbeat } from '@scripts/windows-test/host/isFreshInteractiveWorkerHeartbeat';

// This is intentionally a command users can paste after the coordinator
// reports that a clone has no interactive worker.
export const WINDOWS_TEST_GOLDEN_HEAL_COMMAND = 'pnpm windows:test:heal';

const WINDOWS_TEST_NODE_ARCHIVE_RELATIVE_PATH = path.join(
    'node-v22.23.2-win-arm64',
    'node-v22.23.2-win-arm64.zip',
);

const SYSTEM_BOOTSTRAP_COMPLETE_FILE = `${windowsTestGuestLayout.stateDir}\\system-bootstrap-complete.marker`;
const SYSTEM_BOOTSTRAP_DIRECTORY = 'C:\\Windows\\System32\\GroupPolicy\\Machine\\Scripts\\Startup';

interface IGoldenProvisionFile {
    hostPath: string;
    guestPath: string;
    label: string;
}

interface IGoldenProvisionEvent {
    step: string;
    status: 'started' | 'completed' | 'skipped' | 'failed';
    at: string;
}

export interface IWindowsTestGoldenProvisionSources {
    repositoryRoot: string;
    workerDirectory?: string;
    nodeArchivePath?: string;
}

export interface IWindowsTestGoldenProvisionDependencies {
    config: IWindowsTestHostConfig;
    layout: IWindowsTestHostLayout;
    imageManifest: IWindowsTestImageManifest;
    manifestPath: string;
    utmctl: IUtmctlClient;
    guest: IWindowsTestGuestChannel;
    clock: IWindowsTestClock;
    sources: IWindowsTestGoldenProvisionSources;
    identityGuard?: IWindowsTestIdentityGuardDependencies;
    deadlines?: Partial<IWindowsTestRunDeadlines>;
    randomPassword?: () => string;
    randomId?: () => string;
}

export interface IWindowsTestGoldenProvisionResult {
    alreadyProvisioned: boolean;
    evidencePath: string;
}

interface IGoldenProvisionEvidence {
    schemaVersion: 1;
    operation: 'golden-image-headless-heal';
    imageId: string;
    startedAt: string;
    endedAt: string;
    alreadyProvisioned: boolean;
    secretGenerated: boolean;
    events: IGoldenProvisionEvent[];
    failure: string | null;
    cleanupFailure: string | null;
}

function safeError(error: unknown, secret: string | null) {
    const text = error instanceof Error ? error.message : String(error);
    if (secret === null) {
        return text;
    }
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return text.replace(new RegExp(escaped, 'giu'), '<REDACTED>');
}

function safeProvisionId(value: string) {
    const normalized = value.replace(/[^a-zA-Z0-9-]/gu, '-');
    return normalized.length > 0 ? normalized : randomUUID();
}

function isSameOrInside(parent: string, child: string) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolvePathForContainment(candidate: string) {
    const absolute = path.resolve(candidate);
    let current = absolute;
    const suffix: string[] = [];
    for (;;) {
        const resolved = await realpath(current).catch(() => null);
        if (resolved !== null) {
            return path.join(resolved, ...suffix);
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return absolute;
        }
        suffix.unshift(path.basename(current));
        current = parent;
    }
}

export function generateWindowsTestAccountPassword() {
    // The fixed ASCII prefix supplies upper/lowercase/digit/symbol classes for
    // Windows complexity policies. The random hex body carries 256 bits of
    // entropy and has no quoting or shell metacharacter concerns.
    return `Az9_${randomBytes(32).toString('hex')}`;
}

async function requireRegularFile(filePath: string, label: string) {
    const details = await lstat(filePath).catch((error: unknown) => {
        throw new Error(`The ${label} ${filePath} could not be inspected: ${String(error)}.`);
    });
    if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error(`The ${label} ${filePath} is not a regular file.`);
    }
}

async function hasCurrentProvisioning(
    options: IWindowsTestGoldenProvisionDependencies,
    assertTarget: () => Promise<unknown>,
    timeoutMs: number,
) {
    const sourceDirectory = path.join(options.sources.repositoryRoot, 'scripts', 'windows-test', 'guest');
    const workerDirectory = options.sources.workerDirectory ?? path.join(options.layout.toolsCacheDir, 'worker');
    const files: Array<[string, string[]]> = [
        [
            path.join(sourceDirectory, 'system-bootstrap-worker.cmd'),
            [`${SYSTEM_BOOTSTRAP_DIRECTORY}\\system-bootstrap-worker.cmd`],
        ],
        [
            path.join(sourceDirectory, 'start-worker.cmd'),
            [
                `${SYSTEM_BOOTSTRAP_DIRECTORY}\\start-worker.cmd`,
                `${windowsTestGuestLayout.root}\\worker\\start-worker.cmd`,
            ],
        ],
        [
            path.join(workerDirectory, 'guestWorker.cjs'),
            [
                `${SYSTEM_BOOTSTRAP_DIRECTORY}\\guestWorker.cjs`,
                `${windowsTestGuestLayout.root}\\worker\\guestWorker.cjs`,
            ],
        ],
    ];
    for (const entry of await readdir(path.join(sourceDirectory, 'powershell'), {withFileTypes: true})) {
        if (entry.isFile() && entry.name.endsWith('.ps1')) {
            files.push([
                path.join(sourceDirectory, 'powershell', entry.name),
                [
                    `${SYSTEM_BOOTSTRAP_DIRECTORY}\\powershell\\${entry.name}`,
                    `${windowsTestGuestLayout.root}\\worker\\powershell\\${entry.name}`,
                ],
            ]);
        }
    }
    for (const [
        source,
        destinations,
    ] of files) {
        const expected = await readFile(source, 'utf8');
        for (const destination of destinations) {
            await assertTarget();
            if (await options.guest.readGuestText(options.config.goldenVmId, destination, timeoutMs) !== expected) {
                return false;
            }
        }
    }
    return true;
}

async function resolveProvisionFiles(
    options: IWindowsTestGoldenProvisionDependencies,
    stagingDirectory: string,
    secretPath: string,
) {
    const guestFile = (name: string) => `${stagingDirectory}\\${name}`;
    const guestDirectory = `${stagingDirectory}\\powershell`;
    const guestPathForPowerShell = (name: string) => `${guestDirectory}\\${name}`;
    const guestDirectoryOnHost = path.join(options.sources.repositoryRoot, 'scripts', 'windows-test', 'guest');
    const workerDirectory = options.sources.workerDirectory
        ?? path.join(options.layout.toolsCacheDir, 'worker');
    const nodeArchivePath = options.sources.nodeArchivePath
        ?? path.join(options.layout.toolsCacheDir, WINDOWS_TEST_NODE_ARCHIVE_RELATIVE_PATH);
    const fixedFiles: Array<[string, string, string]> = [
        [
            path.join(guestDirectoryOnHost, 'install-system-bootstrap.cmd'),
            guestFile('install-system-bootstrap.cmd'),
            'SYSTEM bootstrap installer',
        ],
        [
            path.join(guestDirectoryOnHost, 'system-bootstrap-worker.cmd'),
            guestFile('system-bootstrap-worker.cmd'),
            'SYSTEM bootstrap worker',
        ],
        [
            path.join(guestDirectoryOnHost, 'start-worker.cmd'),
            guestFile('start-worker.cmd'),
            'worker launcher',
        ],
        [
            path.join(guestDirectoryOnHost, 'machine-startup-scripts.ini'),
            guestFile('scripts.ini'),
            'machine startup policy',
        ],
        [
            path.join(workerDirectory, 'guestWorker.cjs'),
            guestFile('guestWorker.cjs'),
            'prepared guest worker',
        ],
        [
            path.join(workerDirectory, 'guestWorker.cjs.map'),
            guestFile('guestWorker.cjs.map'),
            'prepared guest worker map',
        ],
        [
            nodeArchivePath,
            guestFile('node.zip'),
            'prepared Windows Node archive',
        ],
        [
            secretPath,
            guestFile('test-account.secret'),
            'generated test-account secret',
        ],
    ];
    for (const [
        hostPath, , label,
    ] of fixedFiles) {
        await requireRegularFile(hostPath, label);
    }
    const powerShellEntries = await readdir(path.join(guestDirectoryOnHost, 'powershell'), {withFileTypes: true});
    const powerShellFiles = powerShellEntries
        .filter(entry => entry.name.endsWith('.ps1'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(entry => [
            path.join(guestDirectoryOnHost, 'powershell', entry.name),
            guestPathForPowerShell(entry.name),
            `PowerShell helper ${entry.name}`,
        ] as const);
    for (const [
        hostPath, , label,
    ] of powerShellFiles) {
        await requireRegularFile(hostPath, label);
    }
    return {
        guestDirectory,
        files: [
            ...fixedFiles.map(([
                hostPath,
                guestPath,
                label,
            ]) => ({
                hostPath,
                guestPath,
                label,
            })),
            ...powerShellFiles.map(([
                hostPath,
                guestPath,
                label,
            ]) => ({
                hostPath,
                guestPath,
                label,
            })),
        ] satisfies IGoldenProvisionFile[],
    };
}

async function writeTestAccountSecret(secretPath: string, secret: string) {
    const existing = await lstat(secretPath).catch(() => null);
    if (existing?.isSymbolicLink() === true) {
        throw new Error(`Refusing to replace the test-account secret symlink ${secretPath}.`);
    }
    await mkdir(path.dirname(secretPath), {recursive: true});
    await writeFile(secretPath, `${secret}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await chmod(secretPath, 0o600);
}

async function writeEvidence(
    options: IWindowsTestGoldenProvisionDependencies,
    evidence: IGoldenProvisionEvidence,
    id: string,
) {
    const directory = path.join(options.layout.root, 'provisioning');
    await mkdir(directory, {recursive: true});
    const filePath = path.join(directory, `golden-heal-${safeProvisionId(id)}.json`);
    await writeFile(filePath, `${JSON.stringify(evidence, null, 4)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    return filePath;
}

async function readGoldenHeartbeat(
    options: IWindowsTestGoldenProvisionDependencies,
    vmId: string,
    startedAtMs: number,
    previousBootId: string | null,
    requireBootIdChange: boolean,
    assertTarget: () => Promise<unknown>,
    deadlines: ReturnType<typeof defaultWindowsTestRunDeadlines>,
) {
    let bootId = '';
    const heartbeat = await pollUntil(
        options.clock,
        deadlines.guestReadyToDesktopReadyMs,
        deadlines.pollIntervalMs,
        async () => {
            await assertTarget();
            const bootIdText = await options.guest.readGuestText(
                vmId,
                windowsTestGuestLayout.bootIdFile,
                deadlines.commandTimeoutMs,
            );
            const currentBootId = bootIdText?.trim() ?? '';
            if (currentBootId.length === 0
                || (requireBootIdChange && previousBootId !== null && currentBootId === previousBootId)) {
                return null;
            }
            bootId = currentBootId;
            await assertTarget();
            const observed = await options.guest.readHeartbeat(vmId, deadlines.commandTimeoutMs);
            return isFreshInteractiveWorkerHeartbeat(currentBootId, observed, startedAtMs)
                ? observed
                : null;
        },
    );
    return {
        bootId,
        heartbeat,
    };
}

async function waitForGuest(
    options: IWindowsTestGoldenProvisionDependencies,
    vmId: string,
    startedAtMs: number,
    previousBootId: string | null,
    requireBootIdChange: boolean,
    assertTarget: () => Promise<unknown>,
    deadlines: ReturnType<typeof defaultWindowsTestRunDeadlines>,
) {
    const guestReady = await pollUntil(
        options.clock,
        deadlines.bootToGuestReadyMs,
        deadlines.pollIntervalMs,
        async () => {
            await assertTarget();
            if (await options.guest.ping(vmId, deadlines.commandTimeoutMs)) {
                return true;
            }
            // A golden image that has never completed the SYSTEM bootstrap may
            // not have the lab marker yet. A no-op command still proves that
            // QEMU guest-agent exec is available without touching the desktop.
            await assertTarget();
            const probe = await options.guest.execute?.(
                vmId,
                [
                    'cmd.exe',
                    '/d',
                    '/c',
                    'exit',
                    '0',
                ],
                deadlines.commandTimeoutMs,
            );
            return probe !== undefined
                && probe.transportFailure === null
                && probe.exitCode === 0
                ? true
                : null;
        },
    );
    if (guestReady === null) {
        throw new Error(`The golden guest agent did not answer within ${deadlines.bootToGuestReadyMs} ms of boot.`);
    }
    return readGoldenHeartbeat(
        options,
        vmId,
        startedAtMs,
        previousBootId,
        requireBootIdChange,
        assertTarget,
        deadlines,
    );
}

async function waitForSystemBootstrap(
    options: IWindowsTestGoldenProvisionDependencies,
    vmId: string,
    assertTarget: () => Promise<unknown>,
    deadlines: ReturnType<typeof defaultWindowsTestRunDeadlines>,
) {
    const complete = await pollUntil(
        options.clock,
        deadlines.guestReadyToDesktopReadyMs,
        deadlines.pollIntervalMs,
        async () => {
            await assertTarget();
            const marker = await options.guest.readGuestText(
                vmId,
                SYSTEM_BOOTSTRAP_COMPLETE_FILE,
                deadlines.commandTimeoutMs,
            );
            return marker?.includes('complete=v2') === true ? true : null;
        },
    );
    if (complete === null) {
        throw new Error('The SYSTEM bootstrap did not publish its completion marker before the reboot.');
    }
}

async function stopGoldenImage(
    options: IWindowsTestGoldenProvisionDependencies,
    vmId: string,
    assertTarget: () => Promise<unknown>,
    deadlines: ReturnType<typeof defaultWindowsTestRunDeadlines>,
) {
    const waitForStopped = () => pollUntil(
        options.clock,
        deadlines.cancelGraceMs,
        deadlines.pollIntervalMs,
        async () => {
            try {
                await assertTarget();
                return (await options.utmctl.status(vmId)) === 'stopped' ? true : null;
            } catch {
                return null;
            }
        },
    );
    let requestError: unknown = null;
    try {
        await assertTarget();
        await options.utmctl.stop(vmId, 'request');
    } catch (error) {
        requestError = error;
    }
    if (await waitForStopped() !== null) {
        return;
    }
    let forceError: unknown = null;
    try {
        await assertTarget();
        await options.utmctl.stop(vmId, 'force');
    } catch (error) {
        forceError = error;
    }
    if (await waitForStopped() === null) {
        throw new Error(`The golden image could not be stopped after healing${requestError === null ? '' : ` (request failed: ${safeError(requestError, null)})`}${forceError === null ? '' : ` (force failed: ${safeError(forceError, null)})`}.`);
    }
}

async function qualifyManifest(
    options: IWindowsTestGoldenProvisionDependencies,
) {
    const current = await loadWindowsTestImageManifest(options.manifestPath);
    if (current.imageId !== options.config.goldenImageId
        || current.vmId.toLowerCase() !== options.config.goldenVmId.toLowerCase()
        || current.bundlePath !== options.imageManifest.bundlePath) {
        throw new Error('The golden image manifest identity changed while healing; refusing to qualify it.');
    }
    const now = options.clock.nowIso();
    const qualification = current.qualification ?? {
        qualifiedBy: 'windows-test-headless-heal',
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        coldResetCycles: 1,
        notes: 'Headless SYSTEM bootstrap verified a fresh interactive unlocked EVBTester heartbeat.',
    };
    const updated: IWindowsTestImageManifest = {
        ...current,
        qualifiedAt: current.qualifiedAt ?? now,
        qualification,
    };
    const temporaryPath = `${options.manifestPath}.${safeProvisionId(options.randomId?.() ?? randomUUID())}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(updated, null, 4)}\n`, 'utf8');
    await rename(temporaryPath, options.manifestPath);
    return updated;
}

export async function healWindowsTestGoldenImage(
    options: IWindowsTestGoldenProvisionDependencies,
): Promise<IWindowsTestGoldenProvisionResult> {
    const repositoryRoot = await resolvePathForContainment(options.sources.repositoryRoot);
    const dataRoot = await resolvePathForContainment(options.layout.root);
    const secretDirectory = await resolvePathForContainment(path.join(options.layout.root, 'secrets'));
    if (isSameOrInside(repositoryRoot, dataRoot)
        || isSameOrInside(repositoryRoot, secretDirectory)
        || !isSameOrInside(dataRoot, secretDirectory)
        || secretDirectory === dataRoot) {
        throw new Error('The Windows test data root and secrets directory must stay outside the repository and inside the data root; refusing to create a golden-image secret in the checkout.');
    }
    const deadlines = {
        ...defaultWindowsTestRunDeadlines(),
        ...options.deadlines,
    };
    const target = {
        vmId: options.config.goldenVmId,
        bundlePath: options.imageManifest.bundlePath,
    };
    const policy = destructivePolicyFromConfig(options.config);
    const assertTarget = () => assertGoldenImageTarget(target, policy, options.identityGuard);
    const events: IGoldenProvisionEvent[] = [];
    const startedAt = options.clock.nowIso();
    const record = (step: string, status: IGoldenProvisionEvent['status']) => {
        events.push({
            step,
            status,
            at: options.clock.nowIso(),
        });
    };
    const provisionId = safeProvisionId(options.randomId?.() ?? randomUUID());
    const secretPath = path.join(options.layout.root, 'secrets', 'test-account.secret');
    const randomPassword = options.randomPassword ?? generateWindowsTestAccountPassword;
    let secret: string | null = null;
    let startIssued = false;
    let alreadyProvisioned = false;
    let primaryError: unknown = null;
    let cleanupError: unknown = null;
    let qualificationError: unknown = null;

    const registered = async () => {
        await assertTarget();
        const entries = await options.utmctl.list();
        const matches = entries.filter(entry => entry.uuid.toLowerCase() === options.config.goldenVmId.toLowerCase());
        if (matches.length !== 1) {
            throw new Error('The configured golden VM is not registered exactly once in UTM.');
        }
        const name = matches[0]?.name.trim() ?? '';
        if (name.length === 0) {
            throw new Error('Refusing a golden VM with an empty display name.');
        }
        if (name.toLowerCase() === 'windows') {
            throw new Error('Refusing the personal VM display name "Windows".');
        }
    };

    try {
        if (options.imageManifest.imageId !== options.config.goldenImageId
            || options.imageManifest.vmId.toLowerCase() !== options.config.goldenVmId.toLowerCase()) {
            throw new Error('The golden image manifest does not match the configured image identity.');
        }
        await registered();
        const status = await (async () => {
            await assertTarget();
            return options.utmctl.status(options.config.goldenVmId);
        })();
        if (status !== 'stopped') {
            // A manually started golden is still a protected target. Mark it
            // for cleanup so a refusal cannot leave the image running.
            startIssued = true;
            throw new Error('The golden image must be stopped before headless healing.');
        }
        record('start-golden', 'started');
        startIssued = true;
        // Capture the lower bound before issuing start. A very fast guest can
        // publish its first heartbeat before the host call returns; recording
        // the timestamp afterwards would incorrectly reject that fresh boot.
        const startedAtMs = Date.parse(options.clock.nowIso());
        if (!Number.isFinite(startedAtMs)) {
            throw new Error('The host clock returned an invalid ISO timestamp.');
        }
        await assertTarget();
        await options.utmctl.start(options.config.goldenVmId);
        record('start-golden', 'completed');
        const initial = await waitForGuest(
            options,
            options.config.goldenVmId,
            startedAtMs,
            null,
            false,
            assertTarget,
            deadlines,
        );
        if (initial.heartbeat !== null) {
            if (initial.heartbeat.guestTestMarker !== options.imageManifest.guestTestMarker) {
                throw new Error('The golden heartbeat marker does not match the image manifest.');
            }
        }
        if (initial.heartbeat !== null && await hasCurrentProvisioning(options, assertTarget, deadlines.commandTimeoutMs)) {
            alreadyProvisioned = true;
            record('interactive-heartbeat', 'skipped');
        } else {
            secret = randomPassword();
            if (!/^[A-Za-z0-9_-]{48,}$/u.test(secret)) {
                throw new Error('The generated test-account secret did not meet the ASCII length policy.');
            }
            await writeTestAccountSecret(secretPath, secret);
            record('generate-test-account-secret', 'completed');
            const stagingDirectory = `${windowsTestGuestLayout.stagingDir}\\golden-heal-${provisionId}`;
            const provisionFiles = await resolveProvisionFiles(options, stagingDirectory, secretPath);
            await assertTarget();
            await options.guest.ensureDirectory(options.config.goldenVmId, windowsTestGuestLayout.stagingDir, deadlines.commandTimeoutMs);
            await assertTarget();
            await options.guest.ensureDirectory(options.config.goldenVmId, stagingDirectory, deadlines.commandTimeoutMs);
            await assertTarget();
            await options.guest.ensureDirectory(options.config.goldenVmId, provisionFiles.guestDirectory, deadlines.commandTimeoutMs);
            record('prepare-guest-staging', 'completed');
            for (const file of provisionFiles.files) {
                await assertTarget();
                await options.guest.stageFile(options.config.goldenVmId, file.hostPath, file.guestPath, deadlines.stageFileMs);
            }
            record('stage-system-bootstrap', 'completed');
            const installerPath = `${stagingDirectory}\\install-system-bootstrap.cmd`;
            await assertTarget();
            const installOutcome = await options.guest.execute?.(
                options.config.goldenVmId,
                [
                    'cmd.exe',
                    '/d',
                    '/c',
                    installerPath,
                ],
                deadlines.commandTimeoutMs,
            );
            if (installOutcome === undefined
                || installOutcome.transportFailure !== null
                || installOutcome.exitCode !== 0) {
                throw new Error('The SYSTEM bootstrap installer did not complete successfully.');
            }
            record('run-system-bootstrap', 'completed');
            await waitForSystemBootstrap(options, options.config.goldenVmId, assertTarget, deadlines);
            record('system-bootstrap-complete', 'completed');
            const previousBootId = initial.bootId.length > 0 ? initial.bootId : null;
            const rebootStartedAtMs = Date.parse(options.clock.nowIso());
            await assertTarget();
            const rebootOutcome = await options.guest.execute?.(
                options.config.goldenVmId,
                [
                    'shutdown.exe',
                    '/r',
                    '/t',
                    '5',
                    '/f',
                ],
                deadlines.commandTimeoutMs,
            );
            if (rebootOutcome === undefined
                || rebootOutcome.transportFailure !== null
                || rebootOutcome.exitCode !== 0) {
                throw new Error('The guest reboot command did not complete successfully.');
            }
            record('reboot-golden', 'completed');
            const afterReboot = await waitForGuest(
                options,
                options.config.goldenVmId,
                rebootStartedAtMs,
                previousBootId,
                true,
                assertTarget,
                deadlines,
            );
            if (afterReboot.heartbeat === null) {
                throw new Error('The healed golden image did not publish a fresh interactive unlocked heartbeat after reboot.');
            }
            if (afterReboot.heartbeat.guestTestMarker !== options.imageManifest.guestTestMarker) {
                throw new Error('The healed golden heartbeat marker does not match the image manifest.');
            }
            if (!await hasCurrentProvisioning(options, assertTarget, deadlines.commandTimeoutMs)) {
                throw new Error('The healed golden image still has outdated bootstrap or worker files after reboot.');
            }
            record('interactive-heartbeat', 'completed');
        }
    } catch (error) {
        primaryError = error;
        record('heal-golden', 'failed');
    }

    if (startIssued) {
        try {
            await stopGoldenImage(options, options.config.goldenVmId, assertTarget, deadlines);
            record('stop-golden', 'completed');
        } catch (error) {
            cleanupError = error;
            record('stop-golden', 'failed');
        }
    }

    if (primaryError === null && cleanupError === null) {
        try {
            await assertTarget();
            await qualifyManifest(options);
            record('qualify-image-manifest', 'completed');
        } catch (error) {
            qualificationError = error;
            record('qualify-image-manifest', 'failed');
        }
    }

    const evidence: IGoldenProvisionEvidence = {
        schemaVersion: 1,
        operation: 'golden-image-headless-heal',
        imageId: options.config.goldenImageId,
        startedAt,
        endedAt: options.clock.nowIso(),
        alreadyProvisioned,
        secretGenerated: secret !== null,
        events,
        failure: primaryError === null ? null : safeError(primaryError, secret),
        cleanupFailure: cleanupError === null ? null : safeError(cleanupError, secret),
    };
    let evidencePath: string;
    try {
        evidencePath = await writeEvidence(options, evidence, provisionId);
    } catch (error) {
        const evidenceError = safeError(error, secret);
        if (primaryError === null && cleanupError === null && qualificationError === null) {
            throw new Error(`Golden image healing completed but its evidence could not be written: ${evidenceError}`);
        }
        throw new Error([
            primaryError === null ? null : `Golden image healing failed: ${safeError(primaryError, secret)}`,
            cleanupError === null ? null : `Golden image cleanup failed: ${safeError(cleanupError, secret)}`,
            qualificationError === null ? null : `Golden image qualification failed: ${safeError(qualificationError, secret)}`,
            `Redacted evidence could not be written: ${evidenceError}`,
        ].filter((entry): entry is string => entry !== null).join(' '));
    }

    if (primaryError !== null || cleanupError !== null || qualificationError !== null) {
        throw new Error([
            primaryError === null ? null : `Golden image healing failed: ${safeError(primaryError, secret)}`,
            cleanupError === null ? null : `Golden image cleanup failed: ${safeError(cleanupError, secret)}`,
            qualificationError === null ? null : `Golden image qualification failed: ${safeError(qualificationError, secret)}`,
            `Redacted evidence: ${evidencePath}`,
        ].filter((entry): entry is string => entry !== null).join(' '));
    }

    return {
        alreadyProvisioned,
        evidencePath,
    };
}
