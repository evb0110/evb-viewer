import { getErrorMessage } from '@contracts/getErrorMessage';
import { createHash } from 'node:crypto';
import {
    mkdir,
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
    WINDOWS_TEST_RUNNER_VERSION,
    WINDOWS_TEST_SCHEMA_VERSION,
    combineOutcomes,
    exitCodeForOutcome,
    windowsTestDefaultDeadlines,
    windowsTestExitCodes,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestEvidenceEntry,
    IWindowsTestFailureRecord,
    IWindowsTestJob,
    IWindowsTestResult,
    IWindowsTestRunSummary,
    IWindowsTestWorkerHeartbeat,
    TWindowsTestExitCode,
    TWindowsTestOutcome,
    TWindowsTestRunState,
    TWindowsTestSuite,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    windowsTestGuestLayout,
    windowsTestGuestRunPaths,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type {
    IFixtureManifestSource,
    IWindowsTestSuiteResolver,
} from '@scripts/windows-test/host/capabilityRegistry';
import type { IWindowsCapabilityEnvironment } from '@scripts/windows-test/registry/capabilityRegistry';
import type { IWindowsTestClock } from '@scripts/windows-test/host/hostClock';
import type { IWindowsTestHostConfig } from '@scripts/windows-test/host/hostConfig';
import {
    acquireHostLease,
    bindLeaseToVm,
    releaseHostLease,
} from '@scripts/windows-test/host/hostLease';
import type { IHostLockDependencies } from '@scripts/windows-test/host/hostLock';
import type { IHostProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import type {
    IWindowsTestGuestChannel,
    IWindowsTestGuestStageFile,
} from '@scripts/windows-test/host/guestChannel';
import {
    outcomeForRejections,
    validateWindowsTestResultBundle,
} from '@scripts/windows-test/host/resultValidation';
import type { IWindowsTestObservedEvidenceFile } from '@scripts/windows-test/host/resultValidation';
import { createTransitionRecorder } from '@scripts/windows-test/host/runTransitions';
import type { IUtmctlClient } from '@scripts/windows-test/host/utmctlClient';
import type { IWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import { utmBundlePathForName } from '@scripts/windows-test/images/vmBundleLocator';
import { WINDOWS_HOST_ORACLE_RESULTS_FILE } from '@scripts/windows-test/oracles/windowsHostOracleDispatcher';
import {
    WindowsTestIdentityGuardError,
    assertDestructiveTarget,
    destructivePolicyFromConfig,
    selectClonedVmId,
    withOwnedCloneAllowlisted,
} from '@scripts/windows-test/images/vmIdentityGuard';
import type { IWindowsTestIdentityGuardDependencies } from '@scripts/windows-test/images/vmIdentityGuard';

export const WINDOWS_TEST_CLONE_NAME_PREFIX = 'evb-win-test-';

export interface IWindowsTestRunDeadlines {
    bootToGuestReadyMs: number;
    guestReadyToDesktopReadyMs: number;
    jobMs: number;
    pollIntervalMs: number;
    cancelGraceMs: number;
    heartbeatStaleAfterMs: number;
    commandTimeoutMs: number;
    stageFileMs: number;
}

export function defaultWindowsTestRunDeadlines(): IWindowsTestRunDeadlines {
    return {
        bootToGuestReadyMs: windowsTestDefaultDeadlines.bootToGuestReadySeconds * 1_000,
        guestReadyToDesktopReadyMs: windowsTestDefaultDeadlines.guestReadyToDesktopReadySeconds * 1_000,
        jobMs: windowsTestDefaultDeadlines.jobSeconds * 1_000,
        pollIntervalMs: 2_000,
        cancelGraceMs: windowsTestDefaultDeadlines.uiStepSeconds * 1_000,
        heartbeatStaleAfterMs: windowsTestDefaultDeadlines.guestReadyToDesktopReadySeconds * 1_000,
        // Cold PowerShell transport took 57 seconds on the live Windows
        // probe. Keep its deadline separate from native UI interaction limits.
        commandTimeoutMs: windowsTestDefaultDeadlines.guestTransportSeconds * 1_000,
        stageFileMs: windowsTestDefaultDeadlines.jobSeconds * 1_000,
    };
}

export interface IWindowsTestStagedInput {
    hostPath: string;
    /** Path relative to the run-scoped guest staging directory. */
    guestRelativePath: string;
    sha256: string;
}

export interface IWindowsTestHostOracleEvaluationInput {
    runId: string;
    environmentId: string;
    evidenceDirectory: string;
    resultsFile: string;
    result: IWindowsTestResult;
}

export interface IWindowsTestHostOracleEvaluationResult {
    outcome: TWindowsTestOutcome;
    humanReviewRequired: boolean;
    errors: readonly string[];
}

export interface IWindowsTestRunRequest {
    suite: TWindowsTestSuite;
    environment: string;
    tests: string[] | null;
}

export interface IWindowsTestRunDependencies {
    config: IWindowsTestHostConfig;
    layout: IWindowsTestHostLayout;
    utmctl: IUtmctlClient;
    guest: IWindowsTestGuestChannel;
    clock: IWindowsTestClock;
    suiteResolver: IWindowsTestSuiteResolver;
    fixtureManifest: IFixtureManifestSource;
    imageManifest: IWindowsTestImageManifest;
    lock: IHostLockDependencies;
    probe: IHostProcessIdentityProbe;
    hostId: string;
    randomRunSuffix(): string;
    stagedInputs?: readonly IWindowsTestStagedInput[];
    /** Optional guarded clone implementation for UTM versions that place clones elsewhere. */
    cloneVm?(cloneName: string): Promise<void>;
    /** Run host-side output oracles only after guest evidence has validated. */
    evaluateHostOracles?(input: IWindowsTestHostOracleEvaluationInput): Promise<IWindowsTestHostOracleEvaluationResult>;
    identityGuard?: IWindowsTestIdentityGuardDependencies;
    deadlines?: Partial<IWindowsTestRunDeadlines>;
    hashFile?(filePath: string): Promise<string>;
}

export interface IWindowsTestRunReport {
    exitCode: TWindowsTestExitCode;
    outcome: TWindowsTestOutcome | null;
    runId: string | null;
    activeRunId: string | null;
    summary: IWindowsTestRunSummary | null;
    messages: string[];
}

export function createWindowsTestRunId(nowIso: string, randomSuffix: string) {
    const stamp = nowIso
        .replace(/[-:]/gu, '')
        .replace(/\.\d+Z$/u, 'Z');
    return `${stamp}-${randomSuffix}`;
}

async function sha256OfFile(filePath: string) {
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

class WindowsTestRunAbort extends Error {
    readonly record: IWindowsTestFailureRecord;

    constructor(record: IWindowsTestFailureRecord) {
        super(record.reason);
        this.name = 'WindowsTestRunAbort';
        this.record = record;
    }
}

function abort(
    outcome: Exclude<TWindowsTestOutcome, 'passed'>,
    phase: TWindowsTestRunState,
    reason: string,
): never {
    throw new WindowsTestRunAbort({
        outcome,
        phase,
        reason,
    });
}

function isSafeRelativePath(relativePath: string) {
    if (relativePath.length === 0 || path.isAbsolute(relativePath) || /^[a-zA-Z]:/u.test(relativePath)) {
        return false;
    }
    return !relativePath
        .split(/[\\/]/u)
        .some(segment => segment === '..' || segment === '');
}

function guestStagingPath(runStagingDir: string, relativePath: string) {
    if (!isSafeRelativePath(relativePath)) {
        throw new Error(`The staged guest path ${relativePath} is not a safe relative path.`);
    }
    return `${runStagingDir}\\${relativePath.split('/').join('\\')}`;
}

function inferUtmEnvironment(environment: string): IWindowsCapabilityEnvironment | null {
    const match = /^utm-[^-]+-(arm64|x64)-app-(arm64|x64)$/u.exec(environment);
    if (match === null) {
        return null;
    }
    const [
        , osArch,
        appArch,
    ] = match;
    if (osArch !== 'arm64' && osArch !== 'x64') {
        return null;
    }
    if (appArch !== 'arm64' && appArch !== 'x64') {
        return null;
    }
    return {
        id: environment,
        osArch,
        appArch,
        kind: 'utm',
        primary: false,
    };
}

function readEvidenceEntries(manifestText: string | null): IWindowsTestEvidenceEntry[] {
    if (manifestText === null) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(manifestText);
    } catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed)) {
        return [];
    }
    const entries = (parsed).entries;
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries.filter((entry): entry is IWindowsTestEvidenceEntry => typeof entry === 'object'
        && entry !== null
        && typeof (entry as IWindowsTestEvidenceEntry).relativePath === 'string'
        && isSafeRelativePath((entry as IWindowsTestEvidenceEntry).relativePath));
}

function classifyTests(result: IWindowsTestResult | null) {
    const passedTests: string[] = [];
    const failedTests: string[] = [];
    const unsupportedTests: string[] = [];
    for (const caseResult of result?.cases ?? []) {
        if (caseResult.outcome === 'passed') {
            passedTests.push(caseResult.testId);
            continue;
        }
        if (caseResult.outcome === 'unsupported') {
            unsupportedTests.push(caseResult.testId);
            continue;
        }
        failedTests.push(caseResult.testId);
    }
    return {
        passedTests,
        failedTests,
        unsupportedTests,
    };
}

async function pollUntil<T>(
    clock: IWindowsTestClock,
    budgetMs: number,
    intervalMs: number,
    attempt: () => Promise<T | null>,
): Promise<T | null> {
    const deadlineMs = clock.monotonicMs() + budgetMs;
    for (;;) {
        const value = await attempt();
        if (value !== null) {
            return value;
        }
        if (clock.monotonicMs() >= deadlineMs) {
            return null;
        }
        await clock.sleep(intervalMs);
    }
}

async function pathExists(target: string) {
    return (await stat(target).catch(() => null)) !== null;
}

const transientUtmVmStatuses = new Set([
    'starting',
    'pausing',
    'resuming',
    'stopping',
]);

function ownedCloneCanStillProduceResult(status: string) {
    const normalized = status.trim().toLowerCase();
    return normalized === 'started' || transientUtmVmStatuses.has(normalized);
}

function statusDetail(error: unknown) {
    return getErrorMessage(error);
}

async function collectEvidence(options: {
    guest: IWindowsTestGuestChannel;
    vmId: string;
    runId: string;
    evidenceDir: string;
    manifestFile: string;
    timeoutMs: number;
    hashFile(filePath: string): Promise<string>;
}) {
    const guestPaths = windowsTestGuestRunPaths(options.runId);
    await mkdir(options.evidenceDir, {recursive: true});
    const manifestPulled = await options.guest.pullGuestFile(
        options.vmId,
        guestPaths.evidenceManifestFile,
        options.manifestFile,
        options.timeoutMs,
    );
    const manifestText = manifestPulled
        ? await readFile(options.manifestFile, 'utf8').catch(() => null)
        : null;
    const manifestSha256 = manifestText === null ? null : await options.hashFile(options.manifestFile);

    const observed: IWindowsTestObservedEvidenceFile[] = [];
    for (const entry of readEvidenceEntries(manifestText)) {
        const segments = entry.relativePath.split(/[\\/]/u);
        const hostFile = path.join(options.evidenceDir, ...segments);
        await mkdir(path.dirname(hostFile), {recursive: true});
        const pulled = await options.guest.pullGuestFile(
            options.vmId,
            `${guestPaths.evidenceDir}\\${segments.join('\\')}`,
            hostFile,
            options.timeoutMs,
        );
        if (!pulled) {
            continue;
        }
        const fileStat = await stat(hostFile).catch(() => null);
        if (fileStat === null) {
            continue;
        }
        observed.push({
            relativePath: entry.relativePath,
            sha256: await options.hashFile(hostFile),
            bytes: fileStat.size,
        });
    }

    return {
        manifestText,
        manifestSha256,
        observed,
    };
}

export async function executeWindowsTestRun(
    request: IWindowsTestRunRequest,
    dependencies: IWindowsTestRunDependencies,
): Promise<IWindowsTestRunReport> {
    const deadlines: IWindowsTestRunDeadlines = {
        ...defaultWindowsTestRunDeadlines(),
        ...dependencies.deadlines,
    };
    const hashFile = dependencies.hashFile ?? sha256OfFile;
    const {
        clock,
        config,
        guest,
        layout,
        utmctl,
    } = dependencies;
    const runId = createWindowsTestRunId(clock.nowIso(), dependencies.randomRunSuffix());
    const runLayout = windowsTestRunLayout(layout.runsDir, runId);
    const guestPaths = windowsTestGuestRunPaths(runId);
    const messages: string[] = [];

    let acquisition;
    try {
        acquisition = await acquireHostLease({
            leaseFile: layout.leaseFile,
            lockDirectory: layout.lockFile,
            runId,
            hostId: dependencies.hostId,
            lock: dependencies.lock,
            probe: dependencies.probe,
            nowIso: () => clock.nowIso(),
            recoverStaleOwner: async (staleLease) => {
                if (staleLease.vmId === null) {
                    const staleRun = windowsTestRunLayout(layout.runsDir, staleLease.runId);
                    const runExists = await stat(staleRun.runDir).then(() => true).catch(() => false);
                    if (runExists) {
                        throw new Error(`Stale run ${staleLease.runId} has no bound clone identity; refusing to replace its host exclusion.`);
                    }
                    return;
                }
                const staleVmId = staleLease.vmId;
                const cloneName = `${WINDOWS_TEST_CLONE_NAME_PREFIX}${staleLease.runId}`;
                const registered = await utmctl.list();
                const ownedUuid = staleVmId.toLowerCase();
                const byUuid = registered.filter(entry => entry.uuid.toLowerCase() === ownedUuid);
                const byName = registered.filter(entry => entry.name === cloneName);
                if (byUuid.length !== 1 || byName.length !== 1 || byUuid[0] !== byName[0]) {
                    throw new WindowsTestIdentityGuardError(
                        'registered-vm-mismatch',
                        `Refusing stale-owner recovery: run ${staleLease.runId} does not identify one registered owned clone.`,
                    );
                }
                const policy = withOwnedCloneAllowlisted(
                    destructivePolicyFromConfig(config),
                    staleLease.vmId,
                );
                await assertDestructiveTarget(
                    {
                        vmId: staleVmId,
                        bundlePath: utmBundlePathForName(config.testImageRoot, cloneName),
                    },
                    policy,
                    dependencies.identityGuard,
                );
                await utmctl.stop(staleVmId, 'request');
                const stoppedAfterRequest = await pollUntil(
                    clock,
                    deadlines.cancelGraceMs,
                    deadlines.pollIntervalMs,
                    async () => (await utmctl.status(staleVmId)) === 'stopped' ? true : null,
                );
                if (stoppedAfterRequest === null) {
                    await assertDestructiveTarget(
                        {
                            vmId: staleVmId,
                            bundlePath: utmBundlePathForName(config.testImageRoot, cloneName),
                        },
                        policy,
                        dependencies.identityGuard,
                    );
                    await utmctl.stop(staleVmId, 'force');
                    const stoppedAfterForce = await pollUntil(
                        clock,
                        deadlines.cancelGraceMs,
                        deadlines.pollIntervalMs,
                        async () => (await utmctl.status(staleVmId)) === 'stopped' ? true : null,
                    );
                    if (stoppedAfterForce === null) {
                        throw new Error(`Stale clone ${staleVmId} did not acknowledge stopped status; retaining the host exclusion.`);
                    }
                }
            },
        });
    } catch (error) {
        return {
            exitCode: windowsTestExitCodes.infrastructureFailed,
            outcome: 'infrastructure-failed',
            runId: null,
            activeRunId: null,
            summary: null,
            messages: [`Windows test host recovery refused to replace the existing lease: ${getErrorMessage(error)}.`],
        };
    }
    if (!acquisition.acquired) {
        return {
            exitCode: windowsTestExitCodes.busyLease,
            outcome: null,
            runId: null,
            activeRunId: acquisition.activeRunId,
            summary: null,
            messages: [`Another Windows test run (${acquisition.activeRunId ?? 'unknown'}) already holds the host lease; refusing to share the single test VM.`],
        };
    }
    if (acquisition.recoveredLease !== null) {
        messages.push(`Recovered a stale lease from run ${acquisition.recoveredLease.runId}; its incomplete run directory was preserved.`);
    }

    let summary: IWindowsTestRunSummary;
    // Fail closed. Only the normal completion path after durable summary
    // persistence may release the lease.
    let leaseReleaseAllowed = false;
    try {
        await mkdir(runLayout.runDir, {recursive: true});
        const recorder = createTransitionRecorder({
            transitionsFile: runLayout.transitionsFile,
            clock,
        });
        const startedAt = clock.nowIso();
        await recorder.record('leased', `Run ${runId} holds the host lease on ${dependencies.hostId}.`);

        let outcome: TWindowsTestOutcome = 'passed';
        const failures: IWindowsTestFailureRecord[] = [];
        let policy = destructivePolicyFromConfig(config);
        const cloneName = `${WINDOWS_TEST_CLONE_NAME_PREFIX}${runId}`;
        let clonedVmId: string | null = null;
        let cloneBundlePath: string | null = null;
        let job: IWindowsTestJob | null = null;
        let result: IWindowsTestResult | null = null;
        let uncoveredObligations: string[] = [];
        let humanReviewRequired = false;
        let expectedTests: string[] = [];
        const throwIfCanceled = async (
            phase: TWindowsTestRunState,
            checkpoint = 'before publishing a guest job',
        ) => {
            if (await pathExists(runLayout.cancelRequestFile)) {
                abort('canceled', phase, `Run ${runId} was canceled ${checkpoint}; the owned clone is being recovered.`);
            }
        };

        try {
            const candidate = config.candidate;
            if (candidate === null) {
                abort(
                    'infrastructure-failed',
                    'queued',
                    `No candidate artifact is recorded in ${layout.configFile}; pass --artifact <absolute path> to stage one.`,
                );
            }
            const artifactStat = await stat(candidate.artifactPath).catch(() => null);
            if (artifactStat === null || !artifactStat.isFile()) {
                abort(
                    'infrastructure-failed',
                    'queued',
                    `The candidate artifact ${candidate.artifactPath} is missing; re-stage it with --artifact.`,
                );
            }
            const observedArtifactSha = await hashFile(candidate.artifactPath);
            if (observedArtifactSha !== candidate.sha256) {
                abort(
                    'infrastructure-failed',
                    'queued',
                    `The candidate artifact hashes to ${observedArtifactSha} but the configuration records ${candidate.sha256}.`,
                );
            }

            const environmentDefinition = dependencies.suiteResolver.resolveEnvironment === undefined
                ? inferUtmEnvironment(request.environment)
                : await dependencies.suiteResolver.resolveEnvironment(request.environment);
            if (environmentDefinition === null) {
                abort(
                    'unsupported',
                    'queued',
                    `Environment "${request.environment}" is not declared in the Windows capability registry; refusing to run an unqualified target.`,
                );
            }
            if (environmentDefinition.kind !== 'utm') {
                abort(
                    'unsupported',
                    'queued',
                    `Environment "${request.environment}" has kind "${environmentDefinition.kind}"; this local runner only executes UTM environments.`,
                );
            }
            if (environmentDefinition.osArch !== dependencies.imageManifest.osArch) {
                abort(
                    'unsupported',
                    'queued',
                    `Environment "${request.environment}" expects ${environmentDefinition.osArch} Windows but the qualified image is ${dependencies.imageManifest.osArch}.`,
                );
            }
            if (environmentDefinition.appArch !== candidate.appArch) {
                abort(
                    'unsupported',
                    'queued',
                    `Environment "${request.environment}" expects an ${environmentDefinition.appArch} app but the candidate is ${candidate.appArch}.`,
                );
            }

            const selection = await dependencies.suiteResolver.resolveSuite(request.suite, request.environment);
            uncoveredObligations = [...selection.uncoveredObligations];
            humanReviewRequired = selection.humanReviewObligations.length > 0;
            if (request.tests === null) {
                expectedTests = [...selection.tests];
            } else {
                expectedTests = request.tests.filter(testId => selection.tests.includes(testId));
                const unknown = request.tests.filter(testId => !selection.tests.includes(testId));
                uncoveredObligations = [
                    ...uncoveredObligations,
                    ...unknown,
                ];
            }
            if (expectedTests.length === 0) {
                abort(
                    'unsupported',
                    'queued',
                    `No implemented Windows test cases match suite "${request.suite}" in environment "${request.environment}".`,
                );
            }
            const fixtureManifestSha256 = await dependencies.fixtureManifest.sha256();

            const goldenStatus = await utmctl.status(config.goldenVmId);
            if (goldenStatus !== 'stopped') {
                abort(
                    'infrastructure-failed',
                    'queued',
                    `The golden image ${config.goldenVmId} reports status "${goldenStatus}"; it must be stopped so every run clones an identical baseline.`,
                );
            }

            await throwIfCanceled('leased');
            const before = await utmctl.list();
            // Set before cloning so teardown looks for the clone even when the
            // clone command or the UUID diff fails part-way.
            cloneBundlePath = utmBundlePathForName(config.testImageRoot, cloneName);
            if (dependencies.cloneVm === undefined) {
                await utmctl.clone(config.goldenVmId, cloneName);
            } else {
                await dependencies.cloneVm(cloneName);
            }
            const after = await utmctl.list();
            clonedVmId = selectClonedVmId(before, after);
            policy = withOwnedCloneAllowlisted(policy, clonedVmId);
            await assertDestructiveTarget(
                {
                    vmId: clonedVmId,
                    bundlePath: cloneBundlePath,
                },
                policy,
                dependencies.identityGuard,
            );
            await bindLeaseToVm({
                leaseFile: layout.leaseFile,
                lockDirectory: layout.lockFile,
                runId,
                lock: dependencies.lock,
            }, clonedVmId);
            await throwIfCanceled('leased');

            await recorder.record('booting', `Starting owned clone ${clonedVmId} cloned from the stopped golden image.`);
            await utmctl.start(clonedVmId);

            const guestReady = await pollUntil(clock, deadlines.bootToGuestReadyMs, deadlines.pollIntervalMs, async () => {
                await throwIfCanceled('booting');
                const alive = await guest.ping(clonedVmId ?? '', deadlines.commandTimeoutMs);
                await throwIfCanceled('booting');
                return alive ? true : null;
            });
            if (guestReady === null) {
                abort(
                    'infrastructure-failed',
                    'booting',
                    `The guest agent never answered within ${deadlines.bootToGuestReadyMs} ms of boot.`,
                );
            }
            await recorder.record('guest-ready', 'The guest agent answered a read-only file-transfer probe.');

            let bootId = '';
            const startedAtMs = Date.parse(startedAt);
            const heartbeat = await pollUntil(
                clock,
                deadlines.guestReadyToDesktopReadyMs,
                deadlines.pollIntervalMs,
                async () => {
                    await throwIfCanceled('guest-ready');
                    // Read the boot token on every poll. The worker replaces a
                    // copied golden-image token when its logon task starts, and
                    // retaining the first QGA read would make the fresh
                    // heartbeat look stale forever.
                    const bootIdText = await guest.readGuestText(
                        clonedVmId ?? '',
                        windowsTestGuestLayout.bootIdFile,
                        deadlines.commandTimeoutMs,
                    );
                    const currentBootId = bootIdText === null ? '' : bootIdText.trim();
                    if (currentBootId.length === 0) {
                        return null;
                    }
                    bootId = currentBootId;
                    const observed = await guest.readHeartbeat(clonedVmId ?? '', deadlines.commandTimeoutMs);
                    if (observed === null) {
                        return null;
                    }
                    const heartbeatUpdatedAtMs = Date.parse(observed.updatedAt);
                    const freshSinceRunStart = Number.isFinite(startedAtMs)
                        && Number.isFinite(heartbeatUpdatedAtMs)
                        && heartbeatUpdatedAtMs >= startedAtMs;
                    const usable = observed.bootId === bootId
                        && observed.worker.interactive
                        && observed.worker.sessionId !== 0
                        && !observed.locked;
                    return usable && freshSinceRunStart ? observed : null;
                },
            );
            if (heartbeat === null) {
                abort(
                    'infrastructure-failed',
                    'guest-ready',
                    bootId.length === 0
                        ? 'The guest never published a boot ID, so no result could be tied to this boot.'
                        : 'The guest worker never reported a fresh interactive unlocked desktop for this boot; a copied heartbeat, Session 0 or locked session cannot execute a user journey.',
                );
            }
            if (heartbeat.guestTestMarker !== dependencies.imageManifest.guestTestMarker) {
                abort(
                    'infrastructure-failed',
                    'guest-ready',
                    `The guest test marker "${heartbeat.guestTestMarker}" does not match image ${dependencies.imageManifest.imageId}; refusing to drive an unknown machine.`,
                );
            }
            await recorder.record('desktop-ready', `Interactive desktop confirmed in session ${heartbeat.worker.sessionId}.`);
            await throwIfCanceled('desktop-ready');

            // UTM's file-push operation opens the destination directly. Create
            // the run-scoped tree first because the golden image only contains
            // the shared staging root.
            await guest.ensureDirectory(
                clonedVmId,
                `${guestPaths.stagingDir}\\fixtures`,
                deadlines.commandTimeoutMs,
            );
            await throwIfCanceled('desktop-ready');
            const artifactGuestPath = guestStagingPath(guestPaths.stagingDir, candidate.fileName);
            const stagedInputs = dependencies.stagedInputs ?? [];
            if (!stagedInputs.some(input => input.guestRelativePath === 'fixtures/manifest.json')) {
                abort(
                    'infrastructure-failed',
                    'desktop-ready',
                    'The prepared fixture manifest was not supplied for staging; run windows:test:prepare before the suite.',
                );
            }
            const filesToStage: IWindowsTestGuestStageFile[] = [
                {
                    hostPath: candidate.artifactPath,
                    guestPath: artifactGuestPath,
                    expectedSha256: candidate.sha256,
                },
                ...stagedInputs.map(input => ({
                    hostPath: input.hostPath,
                    guestPath: guestStagingPath(guestPaths.stagingDir, input.guestRelativePath),
                    expectedSha256: input.sha256,
                })),
            ];
            const batchHandled = guest.stageAndVerifyFiles === undefined
                ? false
                : await guest.stageAndVerifyFiles(
                    clonedVmId,
                    filesToStage,
                    deadlines.commandTimeoutMs,
                );
            await throwIfCanceled('desktop-ready');
            if (!batchHandled) {
                for (const file of filesToStage) {
                    await throwIfCanceled('desktop-ready');
                    await guest.stageFile(clonedVmId, file.hostPath, file.guestPath, deadlines.stageFileMs);
                    await throwIfCanceled('desktop-ready');
                    const verified = await guest.verifyStagedFileHash(
                        clonedVmId,
                        file.guestPath,
                        file.expectedSha256,
                        deadlines.commandTimeoutMs,
                    );
                    if (!verified) {
                        abort(
                            'infrastructure-failed',
                            'desktop-ready',
                            `The staged input ${file.guestPath} did not hash to ${file.expectedSha256} inside the guest.`,
                        );
                    }
                }
            }
            await recorder.record('staged', 'The candidate artifact and fixtures were staged and hash-verified inside the guest.');
            await throwIfCanceled('staged');

            job = {
                schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
                runId,
                sourceSha: candidate.sourceSha,
                artifactSha256: candidate.sha256,
                artifactFileName: candidate.fileName,
                imageId: dependencies.imageManifest.imageId,
                vmId: clonedVmId,
                bootId,
                guestTestMarker: dependencies.imageManifest.guestTestMarker,
                runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
                suite: request.suite,
                tests: expectedTests,
                fixtureManifestSha256,
                expectedOsArch: dependencies.imageManifest.osArch,
                expectedAppArch: candidate.appArch,
                deadlineSeconds: Math.round(deadlines.jobMs / 1_000),
            };
            await writeFile(runLayout.jobFile, `${JSON.stringify(job, null, 4)}\n`, 'utf8');
            await guest.writeJob(clonedVmId, job, deadlines.commandTimeoutMs);
            await throwIfCanceled('staged', 'after the guest job was published');
            await guest.publishReadyMarker(clonedVmId, runId, deadlines.commandTimeoutMs);
            await recorder.record('testing', `Published job ${runId} to the guest inbox.`);

            let latestHeartbeat: IWindowsTestWorkerHeartbeat = heartbeat;
            let lastHeartbeatStamp = heartbeat.updatedAt;
            let lastHeartbeatChangeMs = clock.monotonicMs();
            let resultText: string | null = null;
            let canceled = false;
            const jobDeadlineMs = clock.monotonicMs() + deadlines.jobMs;
            for (;;) {
                if (await pathExists(runLayout.cancelRequestFile)) {
                    canceled = true;
                    break;
                }
                const text = await guest.readGuestText(clonedVmId, guestPaths.resultFile, deadlines.commandTimeoutMs);
                if (text !== null && text.trim().length > 0) {
                    resultText = text;
                    break;
                }
                // A stopped or paused clone cannot publish a future guest
                // result. Check cancellation first so an explicit user
                // request wins if it arrives at the same time as a VM loss.
                if (await pathExists(runLayout.cancelRequestFile)) {
                    canceled = true;
                    break;
                }
                let vmStatus: string;
                try {
                    vmStatus = await utmctl.status(clonedVmId);
                } catch (error) {
                    if (await pathExists(runLayout.cancelRequestFile)) {
                        canceled = true;
                        break;
                    }
                    abort(
                        'infrastructure-failed',
                        'testing',
                        `Could not inspect the owned clone ${clonedVmId} while waiting for its guest result: ${statusDetail(error)}.`,
                    );
                }
                if (await pathExists(runLayout.cancelRequestFile)) {
                    canceled = true;
                    break;
                }
                if (!ownedCloneCanStillProduceResult(vmStatus)) {
                    abort(
                        'infrastructure-failed',
                        'testing',
                        `The owned clone ${clonedVmId} is no longer running (UTM status "${vmStatus}") while waiting for its guest result; stopping the wait early.`,
                    );
                }
                const observed = await guest.readHeartbeat(clonedVmId, deadlines.commandTimeoutMs);
                if (observed !== null) {
                    latestHeartbeat = observed;
                    if (observed.updatedAt !== lastHeartbeatStamp) {
                        lastHeartbeatStamp = observed.updatedAt;
                        lastHeartbeatChangeMs = clock.monotonicMs();
                    }
                }
                if (clock.monotonicMs() >= jobDeadlineMs) {
                    break;
                }
                await clock.sleep(deadlines.pollIntervalMs);
            }

            if (canceled) {
                await guest.requestGuestCancel(clonedVmId, runId, deadlines.commandTimeoutMs);
                await pollUntil(clock, deadlines.cancelGraceMs, deadlines.pollIntervalMs, async () => {
                    const text = await guest.readGuestText(clonedVmId ?? '', guestPaths.resultFile, deadlines.commandTimeoutMs);
                    return text !== null && text.trim().length > 0 ? text : null;
                });
                abort(
                    'canceled',
                    'testing',
                    `Run ${runId} was canceled on request; cancellation was requested and the owned clone is being recovered.`,
                );
            }

            await recorder.record('collecting', 'Collecting the guest completion record and evidence.');
            if (resultText !== null) {
                await writeFile(runLayout.guestResultFile, resultText, 'utf8');
            }
            const evidence = await collectEvidence({
                guest,
                vmId: clonedVmId,
                runId,
                evidenceDir: runLayout.evidenceDir,
                manifestFile: runLayout.evidenceManifestFile,
                timeoutMs: deadlines.commandTimeoutMs,
                hashFile,
            });

            const validation = validateWindowsTestResultBundle({
                job,
                resultText,
                evidenceManifestText: evidence.manifestText,
                evidenceManifestSha256: evidence.manifestSha256,
                observedEvidenceFiles: evidence.observed,
                heartbeat: latestHeartbeat,
                heartbeatAgeMs: clock.monotonicMs() - lastHeartbeatChangeMs,
                heartbeatStaleAfterMs: deadlines.heartbeatStaleAfterMs,
            });
            if (validation.ok) {
                result = validation.result;
                outcome = combineOutcomes(outcome, result.outcome);
                humanReviewRequired = humanReviewRequired || result.humanReviewRequired;
                if (result.outcome !== 'passed') {
                    failures.push({
                        outcome: result.outcome,
                        phase: 'testing',
                        reason: result.failureReason ?? `The guest reported ${result.outcome}.`,
                    });
                }
                if (dependencies.evaluateHostOracles !== undefined) {
                    const oracleResultsFile = path.join(runLayout.runDir, WINDOWS_HOST_ORACLE_RESULTS_FILE);
                    try {
                        const oracleRun = await dependencies.evaluateHostOracles({
                            runId,
                            environmentId: request.environment,
                            evidenceDirectory: runLayout.evidenceDir,
                            resultsFile: oracleResultsFile,
                            result,
                        });
                        messages.push(`Host oracle report: ${oracleResultsFile}`);
                        humanReviewRequired = humanReviewRequired || oracleRun.humanReviewRequired;
                        outcome = combineOutcomes(outcome, oracleRun.outcome);
                        if (oracleRun.outcome !== 'passed') {
                            failures.push({
                                outcome: oracleRun.outcome,
                                phase: 'collecting',
                                reason: oracleRun.errors.length > 0
                                    ? oracleRun.errors.join(' ')
                                    : `Host oracles reported ${oracleRun.outcome}.`,
                            });
                        }
                    } catch (error) {
                        failures.push({
                            outcome: 'infrastructure-failed',
                            phase: 'collecting',
                            reason: `Host oracle dispatch failed: ${getErrorMessage(error)}.`,
                        });
                        outcome = combineOutcomes(outcome, 'infrastructure-failed');
                    }
                }
            } else {
                for (const rejection of validation.rejections) {
                    failures.push({
                        outcome: rejection.outcome,
                        phase: 'collecting',
                        reason: `${rejection.reason}: ${rejection.detail}`,
                    });
                }
                outcome = combineOutcomes(outcome, outcomeForRejections(validation.rejections));
            }
        } catch (error) {
            if (error instanceof WindowsTestRunAbort) {
                failures.push(error.record);
                outcome = combineOutcomes(outcome, error.record.outcome);
            } else {
                failures.push({
                    outcome: 'infrastructure-failed',
                    phase: recorder.currentState(),
                    reason: error instanceof WindowsTestIdentityGuardError
                        ? `${error.refusal}: ${error.message}`
                        : (getErrorMessage(error)),
                });
                outcome = combineOutcomes(outcome, 'infrastructure-failed');
            }
        }

        let retainedClone = false;
        await recorder.record('tearing-down', `Tearing down after outcome ${outcome}.`);
        if (cloneBundlePath !== null) {
            try {
                const registered = await utmctl.list();
                const registrationsWithExpectedName = registered.filter(entry => entry.name === cloneName);
                const ownedVmId = (clonedVmId ?? registrationsWithExpectedName[0]?.uuid ?? null)?.toLowerCase() ?? null;
                if (ownedVmId === null) {
                    // The clone command failed before UTM registered anything.
                    cloneBundlePath = null;
                } else {
                    const registrationsWithOwnedUuid = registered.filter(
                        entry => entry.uuid.toLowerCase() === ownedVmId,
                    );
                    if (registrationsWithOwnedUuid.length !== 1
                        || registrationsWithExpectedName.length !== 1
                        || registrationsWithExpectedName[0] !== registrationsWithOwnedUuid[0]) {
                        throw new WindowsTestIdentityGuardError(
                            'registered-vm-mismatch',
                            `Refusing teardown: the registered VM UUID and name do not identify clone ${cloneName}.`,
                        );
                    }
                    if (clonedVmId === null) {
                        policy = withOwnedCloneAllowlisted(policy, ownedVmId);
                    }
                    // Re-read the owned bundle identity immediately before each
                    // stop. UTM registration can change while a run is active,
                    // so the check that protected start cannot be reused for
                    // teardown.
                    const assertOwnedClone = () => assertDestructiveTarget(
                        {
                            vmId: ownedVmId,
                            bundlePath: cloneBundlePath ?? '',
                        },
                        policy,
                        dependencies.identityGuard,
                    );
                    const waitForStopped = () => pollUntil(
                        clock,
                        deadlines.cancelGraceMs,
                        deadlines.pollIntervalMs,
                        async () => (await utmctl.status(ownedVmId)) === 'stopped' ? true : null,
                    );
                    await assertOwnedClone();
                    await utmctl.stop(ownedVmId, 'request');
                    if (await waitForStopped() === null) {
                        await assertOwnedClone();
                        await utmctl.stop(ownedVmId, 'force');
                        if (await waitForStopped() === null) {
                            // Everything below this point either deletes the bundle or
                            // releases the host exclusion. Both are unsafe against a VM
                            // that may still be writing to its disk.
                            throw new Error(`Owned clone ${ownedVmId} did not acknowledge stopped status after a forced stop; retaining the host exclusion.`);
                        }
                    }
                    const alreadyRetained = registered.filter(entry => entry.name.startsWith(WINDOWS_TEST_CLONE_NAME_PREFIX)
                        && entry.uuid.toLowerCase() !== ownedVmId).length;
                    retainedClone = outcome !== 'passed' && alreadyRetained < config.retention.maxFailedClones;
                    if (!retainedClone) {
                        await assertDestructiveTarget(
                            {
                                vmId: ownedVmId,
                                bundlePath: cloneBundlePath,
                            },
                            policy,
                            dependencies.identityGuard,
                        );
                        await utmctl.deleteVm(ownedVmId);
                    } else {
                        messages.push(`Retained the failed clone ${ownedVmId} for inspection.`);
                    }
                }
            } catch (error) {
                // A teardown failure is recorded alongside, never instead of, an
                // earlier product failure.
                failures.push({
                    outcome: 'infrastructure-failed',
                    phase: 'tearing-down',
                    reason: getErrorMessage(error),
                });
                outcome = combineOutcomes(outcome, 'infrastructure-failed');
                leaseReleaseAllowed = false;
            }
        }
        await recorder.record('complete', `Run ${runId} finished with outcome ${outcome}.`);

        const {
            passedTests,
            failedTests,
            unsupportedTests,
        } = classifyTests(result);
        summary = {
            schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
            runId,
            suite: request.suite,
            environment: request.environment,
            sourceSha: config.candidate?.sourceSha ?? '',
            artifactSha256: config.candidate?.sha256 ?? '',
            artifactFileName: config.candidate?.fileName ?? '',
            imageId: dependencies.imageManifest.imageId,
            vmId: clonedVmId ?? '',
            runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
            outcome,
            exitCode: exitCodeForOutcome(outcome),
            startedAt,
            endedAt: clock.nowIso(),
            transitions: recorder.transitions(),
            failures,
            expectedTests,
            executedTests: result?.executedTests ?? [],
            passedTests,
            failedTests,
            unsupportedTests,
            uncoveredObligations,
            humanReviewRequired,
            evidenceDirectory: runLayout.evidenceDir,
            retainedClone,
        };
        leaseReleaseAllowed = false;
        await writeFile(runLayout.summaryFile, `${JSON.stringify(summary, null, 4)}\n`, 'utf8');
        // Keep the lease until the durable summary exists. If teardown or
        // persistence failed, explicit stop must retain a recovery path.
        leaseReleaseAllowed = !failures.some(failure => failure.phase === 'tearing-down');
    } finally {
        if (leaseReleaseAllowed) {
            await releaseHostLease({
                leaseFile: layout.leaseFile,
                lockDirectory: layout.lockFile,
                runId,
                lock: dependencies.lock,
            });
        }
    }

    return {
        exitCode: summary.exitCode,
        outcome: summary.outcome,
        runId,
        activeRunId: null,
        summary,
        messages,
    };
}
