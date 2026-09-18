import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    combineOutcomes,
    isWindowsTestRunId,
    WINDOWS_TEST_RUNNER_VERSION,
    WINDOWS_TEST_SCHEMA_VERSION,
    type IWindowsTestCaseResult,
    type IWindowsTestGuestPlatform,
    type IWindowsTestJob,
    type IWindowsTestResult,
    type IWindowsTestWorkerHeartbeat,
    type IWindowsTestWorkerIdentity,
    type TWindowsTestArchitecture,
    type TWindowsTestOutcome,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    isWindowsFixtureManifest,
    type IWindowsFixtureManifest,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import {
    guestRunPaths,
    joinGuestPath,
    readyMarkerRunId,
    type IGuestLayout,
    type IGuestRunPaths,
} from '@scripts/windows-test/guest/guestPaths';
import type {
    IGuestClock,
    IGuestCommandRunner,
    IGuestFileSystem,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    createGuestPowerShellRunner,
    type IGuestPowerShellRunner,
} from '@scripts/windows-test/guest/guestPowerShell';
import {
    describeNonInteractiveSession,
    probeGuestEnvironment,
} from '@scripts/windows-test/guest/guestIdentity';
import {
    isGuestTestMarkerRecord,
    validateGuestJob,
} from '@scripts/windows-test/guest/guestJobValidation';
import {
    buildEvidenceManifest,
    createBoundedLog,
    evidenceManifestSha256,
    serializeEvidenceManifest,
} from '@scripts/windows-test/guest/guestEvidence';
import {
    resolveInstalledExecutablePath,
    verifyInstalledExecutable,
    type IInstalledExecutableIdentity,
} from '@scripts/windows-test/guest/appLaunch';
import {
    loadSelectorRecords,
    unverifiedSelectorIds,
} from '@scripts/windows-test/guest/native-ui/selectorRecords';
import type { INativeUiAdapter } from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import type { IViewerFactory } from '@scripts/windows-test/guest/viewer/viewerDriver';
import {
    runRegisteredCase,
    type ICaseDefinition,
    type ICaseEnvironment,
} from '@scripts/windows-test/guest/cases/caseContext';
import { windowsTestCaseDefinitions } from '@scripts/windows-test/guest/cases/caseRegistry';

export const SENTINEL_VM_ID = '00000000-0000-4000-8000-000000000000';

export const SENTINEL_SHA256 = '0'.repeat(64);

export const DEFAULT_WORKER_LOG_MAX_BYTES = 2 * 1024 * 1024;

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

export type TGuestWorkerState =
    | 'idle'
    | 'validating'
    | 'probing'
    | 'installed'
    | 'testing'
    | 'collecting'
    | 'complete';

// Keep the on-disk heartbeat identical to the host contract. The coordinator
// reads this file before it publishes a job, so a guest-only shape here would
// make every real worker look absent.
export type IGuestHeartbeat = IWindowsTestWorkerHeartbeat & {lastState: TGuestWorkerState;};

export interface IGuestWorkerAdapterOptions {
    exec: IGuestCommandRunner;
    clock: IGuestClock;
    powerShell: IGuestPowerShellRunner;
    paths: IGuestRunPaths;
    executable: IInstalledExecutableIdentity;
}

export interface IGuestWorkerViewerFactoryOptions extends IGuestWorkerAdapterOptions {
    nativeUi: INativeUiAdapter;
    recordVideo?: boolean;
}

export interface IGuestWorkerAdapters {
    createNativeUiAdapter(options: IGuestWorkerAdapterOptions): INativeUiAdapter;
    createViewerFactory(options: IGuestWorkerViewerFactoryOptions): IViewerFactory;
}

export interface IRunGuestWorkerOptions {
    fs: IGuestFileSystem;
    exec: IGuestCommandRunner;
    clock: IGuestClock;
    paths: IGuestLayout;
    adapters: IGuestWorkerAdapters;
    env?: NodeJS.ProcessEnv;
    workerPid?: number;
    caseDefinitions?: readonly ICaseDefinition[];
    powerShellScriptsDirectory?: string;
    maxLogBytes?: number;
    waitForJobMs?: number;
    pollIntervalMs?: number;
    heartbeatIntervalMs?: number;
}

export interface IGuestWorkerRunSummary {
    result: IWindowsTestResult | null;
    resultFile: string | null;
    reason: string | null;
}

export function selectReadyMarker(names: readonly string[]) {
    const markers = names
        .map(readyMarkerRunId)
        .filter((runId): runId is string => runId !== null && isWindowsTestRunId(runId))
        .sort((left, right) => left.localeCompare(right));
    return markers[0] ?? null;
}

export function sentinelWorkerIdentity(workerPid: number, workerStartTime: string): IWindowsTestWorkerIdentity {
    return {
        userSid: 'S-0-0-0',
        sessionId: -1,
        integrityLevel: 'unknown',
        inputDesktop: 'unknown',
        interactive: false,
        workerPid,
        workerStartTime,
    };
}

export function sentinelPlatform(osArch: TWindowsTestArchitecture): IWindowsTestGuestPlatform {
    return {
        osVersion: 'unknown',
        osArch,
        appVersion: 'unknown',
        appArch: osArch,
        installedExecutableSha256: SENTINEL_SHA256,
        hostname: 'unknown',
    };
}

export interface IBuildResultOptions {
    runId: string;
    job: IWindowsTestJob | null;
    outcome: TWindowsTestOutcome;
    startedAt: string;
    endedAt: string;
    cases: readonly IWindowsTestCaseResult[];
    worker: IWindowsTestWorkerIdentity;
    platform: IWindowsTestGuestPlatform;
    evidenceManifestSha256: string;
    logTruncated: boolean;
    humanReviewRequired: boolean;
    failureReason: string | null;
}

export function buildWorkerResult({
    runId,
    job,
    outcome,
    startedAt,
    endedAt,
    cases,
    worker,
    platform,
    evidenceManifestSha256: manifestSha256,
    logTruncated,
    humanReviewRequired,
    failureReason,
}: IBuildResultOptions): IWindowsTestResult {
    const assertions = cases.flatMap(caseResult => caseResult.assertions);
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        runId,
        vmId: job?.vmId ?? SENTINEL_VM_ID,
        imageId: job?.imageId ?? 'unknown',
        bootId: job?.bootId ?? 'unknown',
        guestTestMarker: job?.guestTestMarker ?? 'unknown',
        artifactSha256: job?.artifactSha256 ?? SENTINEL_SHA256,
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        terminalState: 'complete',
        outcome,
        startedAt,
        endedAt,
        expectedTests: job?.tests ?? [],
        executedTests: cases.map(caseResult => caseResult.testId),
        assertionCount: assertions.length,
        failedAssertionCount: assertions.filter(assertion => !assertion.passed).length,
        cases: [...cases],
        worker,
        platform,
        evidenceManifestSha256: manifestSha256,
        logTruncated,
        humanReviewRequired,
        failureReason,
    };
}

export async function writeResultAtomically(
    fs: IGuestFileSystem,
    paths: IGuestRunPaths,
    result: IWindowsTestResult,
) {
    await fs.makeDirectory(directoryOf(paths.resultFile));
    await fs.writeTextDurable(paths.resultTempFile, `${JSON.stringify(result, null, 4)}\n`);
    await fs.rename(paths.resultTempFile, paths.resultFile);
    return paths.resultFile;
}

function directoryOf(filePath: string) {
    const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
    return index <= 0 ? filePath : filePath.slice(0, index);
}

export function fixtureLookup(
    manifest: IWindowsFixtureManifest,
    stagedFixturesDir: string,
    separator: string,
) {
    const byId = new Map<string, string>();
    for (const pack of manifest.packs) {
        for (const file of pack.files) {
            const fileName = file.path.split(/[\\/]/u).pop() ?? file.path;
            byId.set(file.id, joinGuestPath(separator, stagedFixturesDir, fileName));
        }
    }
    return (fixtureId: string) => {
        const resolved = byId.get(fixtureId);
        if (resolved === undefined) {
            throw new Error(`The staged fixture manifest has no entry for ${fixtureId}`);
        }
        return resolved;
    };
}

async function readFixtureManifest(fs: IGuestFileSystem, manifestFile: string) {
    const text = await fs.readText(manifestFile);
    const parsed: unknown = JSON.parse(text);
    if (!isWindowsFixtureManifest(parsed)) {
        throw new Error('The staged fixture manifest does not match the fixture manifest schema');
    }
    return parsed;
}

export async function runGuestWorker({
    fs,
    exec,
    clock,
    paths: layout,
    adapters,
    env = process.env,
    workerPid = process.pid,
    caseDefinitions = windowsTestCaseDefinitions,
    powerShellScriptsDirectory = joinGuestPath(layout.separator, layout.root, 'worker', 'powershell'),
    maxLogBytes = DEFAULT_WORKER_LOG_MAX_BYTES,
    waitForJobMs = 0,
    pollIntervalMs = 1_000,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
}: IRunGuestWorkerOptions): Promise<IGuestWorkerRunSummary> {
    const startedAt = clock.nowIso();
    const log = createBoundedLog(maxLogBytes);
    const appendLog = (message: string) => {
        log.append(`${clock.nowIso()} ${message}`);
    };

    const powerShell = createGuestPowerShellRunner({
        exec,
        scriptsDirectory: powerShellScriptsDirectory,
        separator: layout.separator,
    });
    let executablePath: string | null = null;
    try {
        executablePath = resolveInstalledExecutablePath(env, layout.separator);
    } catch (error) {
        appendLog(`installed executable path could not be resolved before the run: ${describe(error)}`);
    }

    const markerRecord = await readGuestTestMarker(fs, layout.markerFile);
    // Publish an idle heartbeat before invoking PowerShell or waiting for a job.
    // A broken probe must still leave the host a live, fail-closed signal instead
    // of making it guess whether the worker ever started.
    const heartbeat = createHeartbeatWriter({
        fs,
        clock,
        layout,
        worker: sentinelWorkerIdentity(workerPid, startedAt),
        guestTestMarker: markerRecord?.guestTestMarker ?? 'unknown',
        locked: true,
        intervalMs: heartbeatIntervalMs,
    });
    await heartbeat.write('idle');

    // Probe the logged-on session while idle. Once it succeeds, replace the
    // sentinel identity in the heartbeat so the host can certify the desktop.
    let initialProbe: Awaited<ReturnType<typeof probeGuestEnvironment>> | null = null;
    try {
        initialProbe = await probeGuestEnvironment(powerShell, executablePath ?? '', workerPid);
        heartbeat.updateIdentity(initialProbe.identity, initialProbe.logonUiPresent);
        await heartbeat.write('idle');
    } catch (error) {
        appendLog(`initial identity probe failed: ${describe(error)}`);
    }

    let lastIdleProbeAt = clock.now();
    const refreshIdleHeartbeat = async () => {
        const now = clock.now();
        if (heartbeatIntervalMs > 0 && now - lastIdleProbeAt < heartbeatIntervalMs) {
            return;
        }
        lastIdleProbeAt = now;
        try {
            const refreshedProbe = await probeGuestEnvironment(powerShell, executablePath ?? '', workerPid);
            heartbeat.updateIdentity(refreshedProbe.identity, refreshedProbe.logonUiPresent);
            await heartbeat.write('idle');
        } catch (error) {
            // A failed probe cannot certify the desktop. Clear a previously
            // usable identity until a later retry succeeds.
            heartbeat.updateIdentity(sentinelWorkerIdentity(workerPid, startedAt), true);
            await heartbeat.write('idle').catch(() => undefined);
            appendLog(`idle identity probe failed: ${describe(error)}`);
        }
    };
    const markerRunId = await waitForReadyMarker(
        fs,
        layout,
        clock,
        waitForJobMs,
        pollIntervalMs,
        refreshIdleHeartbeat,
    );
    if (markerRunId === null) {
        heartbeat.stop();
        return {
            result: null,
            resultFile: null,
            reason: 'no ready marker appeared in the guest inbox',
        };
    }

    const runPaths = guestRunPaths(layout, markerRunId);
    if (await fs.exists(runPaths.startedMarkerFile) || await fs.exists(runPaths.resultFile)) {
        heartbeat.stop();
        return {
            result: null,
            resultFile: null,
            reason: `run ${markerRunId} already has prior output; duplicate execution refused`,
        };
    }
    await heartbeat.write('validating');

    const finish = async (
        outcome: TWindowsTestOutcome,
        failureReason: string | null,
        options: {
            job?: IWindowsTestJob | null;
            cases?: readonly IWindowsTestCaseResult[];
            worker?: IWindowsTestWorkerIdentity;
            platform?: IWindowsTestGuestPlatform;
            humanReviewRequired?: boolean;
        } = {},
    ) => {
        const cases = options.cases ?? [];
        await heartbeat.write('collecting');
        await fs.makeDirectory(runPaths.evidenceDir);
        await fs.writeText(runPaths.workerLogFile, log.text());
        const manifest = await buildEvidenceManifest(fs, markerRunId, runPaths.evidenceDir, layout.separator);
        await fs.writeText(runPaths.evidenceManifestFile, serializeEvidenceManifest(manifest));
        const result = buildWorkerResult({
            runId: markerRunId,
            job: options.job ?? null,
            outcome,
            startedAt,
            endedAt: clock.nowIso(),
            cases,
            worker: options.worker ?? sentinelWorkerIdentity(workerPid, startedAt),
            platform: options.platform ?? sentinelPlatform(defaultArchitecture(env)),
            evidenceManifestSha256: evidenceManifestSha256(manifest),
            logTruncated: log.state().truncated,
            humanReviewRequired: options.humanReviewRequired ?? outcome !== 'passed',
            failureReason,
        });
        const resultFile = await writeResultAtomically(fs, runPaths, result);
        await heartbeat.write('complete');
        heartbeat.stop();
        return {
            result,
            resultFile,
            reason: failureReason,
        };
    };

    let rawJob: unknown = null;
    try {
        rawJob = JSON.parse(await fs.readText(runPaths.jobFile));
    } catch (error) {
        appendLog(`job file unreadable: ${describe(error)}`);
        return finish('infrastructure-failed', `job file ${runPaths.jobFile} is missing or not JSON`);
    }

    const validation = await validateGuestJob({
        fs,
        layout,
        paths: runPaths,
        markerRunId,
        rawJob,
    });
    if (!validation.ok) {
        appendLog(`job rejected: ${validation.reason}`);
        return finish('infrastructure-failed', validation.reason, { job: validation.job });
    }

    const job = validation.job;
    await fs.writeTextDurable(runPaths.startedMarkerFile, `${startedAt}\n`);
    for (const directory of [
        runPaths.runRoot,
        runPaths.inputsDir,
        runPaths.outputsDir,
        runPaths.evidenceDir,
        runPaths.profileDir,
    ]) {
        await fs.makeDirectory(directory);
    }

    if (executablePath === null) {
        return finish('infrastructure-failed', 'the installed executable path could not be resolved', {job});
    }

    // Installing the candidate changes guest state, so certify the session
    // immediately before invoking the installer. A worker launched by the
    // logon task can briefly observe Session 0, LogonUI, or another desktop;
    // fail closed instead of installing into a session that cannot run a user
    // journey.
    await heartbeat.write('probing');
    let preInstallProbe;
    try {
        preInstallProbe = await probeGuestEnvironment(powerShell, executablePath, workerPid);
        heartbeat.updateIdentity(preInstallProbe.identity, preInstallProbe.logonUiPresent);
        await heartbeat.write('probing');
    } catch (error) {
        appendLog(`pre-install identity probe failed: ${describe(error)}`);
        return finish('infrastructure-failed', `the pre-install identity probe failed: ${describe(error)}`, {job});
    }
    const preInstallNonInteractive = describeNonInteractiveSession(preInstallProbe);
    if (preInstallNonInteractive !== null || preInstallProbe.osArch === null) {
        const reason = preInstallNonInteractive
            ?? `the guest reported an unsupported OS architecture for run ${job.runId}`;
        appendLog(`refusing to install the candidate: ${reason}`);
        return finish('infrastructure-failed', reason, {
            job,
            worker: preInstallProbe.identity,
        });
    }

    const installerPath = joinGuestPath(
        layout.separator,
        runPaths.stagingDir,
        job.artifactFileName,
    );
    let installResult;
    try {
        installResult = await powerShell.run('install-nsis-per-user.ps1', [
            '-InstallerPath',
            installerPath,
            '-ExpectedSha256',
            job.artifactSha256,
            '-ExecutablePath',
            executablePath,
        ]);
    } catch (error) {
        appendLog(`candidate installer could not be started: ${describe(error)}`);
        return finish('infrastructure-failed', `the candidate installer could not be started: ${describe(error)}`, {job});
    }
    if (installResult.exitCode !== 0) {
        appendLog(`candidate installer failed with exit code ${installResult.exitCode}: ${installResult.stderr.trim()}`);
        return finish(
            'infrastructure-failed',
            `the candidate installer exited with ${installResult.exitCode}: ${installResult.stderr.trim()}`,
            {job},
        );
    }

    await heartbeat.write('probing');
    let probe;
    try {
        probe = await probeGuestEnvironment(powerShell, executablePath, workerPid);
        heartbeat.updateIdentity(probe.identity, probe.logonUiPresent);
        await heartbeat.write('probing');
    } catch (error) {
        appendLog(`identity probe failed: ${describe(error)}`);
        return finish('infrastructure-failed', `the identity probe failed: ${describe(error)}`, { job });
    }
    const nonInteractive = describeNonInteractiveSession(probe);
    if (nonInteractive !== null || probe.osArch === null) {
        const reason = nonInteractive ?? `the guest reported an unsupported OS architecture for run ${job.runId}`;
        appendLog(`refusing to run cases: ${reason}`);
        return finish('infrastructure-failed', reason, {
            job,
            worker: probe.identity,
        });
    }

    let executable;
    try {
        executable = await verifyInstalledExecutable({
            fs,
            executablePath,
            expectedArchitecture: job.expectedAppArch,
        });
    } catch (error) {
        appendLog(`installed executable rejected: ${describe(error)}`);
        return finish('infrastructure-failed', `the installed executable was rejected: ${describe(error)}`, {
            job,
            worker: probe.identity,
        });
    }

    const platform: IWindowsTestGuestPlatform = {
        osVersion: probe.osVersion,
        osArch: probe.osArch,
        appVersion: probe.appVersion,
        appArch: executable.architecture,
        installedExecutableSha256: executable.sha256,
        hostname: probe.hostname,
    };
    if (probe.osArch !== job.expectedOsArch) {
        const reason = `the guest reports ${probe.osArch} but the job expects ${job.expectedOsArch}`;
        return finish('infrastructure-failed', reason, {
            job,
            worker: probe.identity,
            platform,
        });
    }

    let fixtureManifest: IWindowsFixtureManifest;
    try {
        fixtureManifest = await readFixtureManifest(fs, runPaths.fixtureManifestFile);
    } catch (error) {
        appendLog(`fixture manifest rejected: ${describe(error)}`);
        return finish('infrastructure-failed', `the staged fixture manifest was rejected: ${describe(error)}`, {
            job,
            worker: probe.identity,
            platform,
        });
    }

    const adapterOptions: IGuestWorkerAdapterOptions = {
        exec,
        clock,
        powerShell,
        paths: runPaths,
        executable,
    };
    const deadlineAt = clock.now() + (job.deadlineSeconds * 1_000);
    let selectors: ReturnType<typeof loadSelectorRecords>;
    let environment: ICaseEnvironment;
    try {
        selectors = loadSelectorRecords();
        const nativeUi = adapters.createNativeUiAdapter(adapterOptions);
        environment = {
            clock,
            fs,
            exec,
            powerShell,
            nativeUi,
            viewer: adapters.createViewerFactory({
                ...adapterOptions,
                recordVideo: job.recordVideo === true,
                nativeUi,
            }),
            selectors,
            paths: runPaths,
            separator: layout.separator,
            installDirectory: directoryOf(executablePath),
            fixturePath: fixtureLookup(
                fixtureManifest,
                joinGuestPath(layout.separator, runPaths.stagingDir, 'fixtures'),
                layout.separator,
            ),
            log: appendLog,
            throwIfCanceled: async () => {
                if (await fs.exists(runPaths.cancelFile)) {
                    throw new CanceledRunError();
                }
            },
            remainingMs: () => deadlineAt - clock.now(),
        };
    } catch (error) {
        // Without a written result the host would wait out the whole job
        // deadline to learn that nothing ran.
        appendLog(`case environment rejected: ${describe(error)}`);
        return finish('infrastructure-failed', `the case environment could not be prepared: ${describe(error)}`, {
            job,
            worker: probe.identity,
            platform,
        });
    }

    await heartbeat.write('testing');
    const cases: IWindowsTestCaseResult[] = [];
    let outcome: TWindowsTestOutcome = 'passed';
    let failureReason: string | null = null;

    for (const testId of job.tests) {
        if (await fs.exists(runPaths.cancelFile)) {
            outcome = combineOutcomes(outcome, 'canceled');
            failureReason = `run ${job.runId} was canceled before ${testId}`;
            appendLog(failureReason);
            break;
        }
        if (clock.now() >= deadlineAt) {
            outcome = combineOutcomes(outcome, 'infrastructure-failed');
            failureReason = `the job deadline of ${job.deadlineSeconds}s expired before ${testId}`;
            appendLog(failureReason);
            break;
        }
        const definition = caseDefinitions.find(candidate => candidate.id === testId);
        if (definition === undefined) {
            const now = clock.nowIso();
            cases.push({
                testId,
                driver: 'APP',
                actionKind: 'app',
                outcome: 'unsupported',
                startedAt: now,
                endedAt: now,
                assertions: [],
                evidenceFiles: [],
                failureReason: `${testId} is not registered in the guest case registry`,
            });
            outcome = combineOutcomes(outcome, 'unsupported');
            continue;
        }
        appendLog(`running ${testId}`);
        const caseResult = await runRegisteredCase(definition, environment);
        cases.push(caseResult);
        outcome = combineOutcomes(outcome, caseResult.outcome);
        if (caseResult.failureReason !== null && failureReason === null) {
            failureReason = caseResult.failureReason;
        }
    }

    if (cases.length === 0) {
        outcome = combineOutcomes(outcome, 'unsupported');
        failureReason ??= `run ${job.runId} executed no cases`;
    }
    if (clock.now() >= deadlineAt) {
        outcome = combineOutcomes(outcome, 'infrastructure-failed');
        failureReason ??= `the job deadline of ${job.deadlineSeconds}s expired`;
    }

    return finish(outcome, outcome === 'passed' ? null : failureReason, {
        job,
        cases,
        worker: probe.identity,
        platform,
        humanReviewRequired: outcome !== 'passed'
            || cases.some(caseResult => caseResult.outcome === 'unsupported')
            || unverifiedSelectorIds(selectors).length > 0,
    });
}

class CanceledRunError extends Error {
    constructor() {
        super('The run was canceled');
        this.name = 'CanceledRunError';
    }
}

function describe(error: unknown) {
    return getErrorMessage(error);
}

function defaultArchitecture(env: NodeJS.ProcessEnv): TWindowsTestArchitecture {
    const declared = (env.PROCESSOR_ARCHITECTURE ?? '').toLowerCase();
    return declared === 'arm64' ? 'arm64' : 'x64';
}

async function readGuestTestMarker(fs: IGuestFileSystem, markerFile: string) {
    const text = await fs.readText(markerFile).catch(() => '');
    try {
        const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
        return isGuestTestMarkerRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

async function waitForReadyMarker(
    fs: IGuestFileSystem,
    layout: IGuestLayout,
    clock: IGuestClock,
    waitForJobMs: number,
    pollIntervalMs: number,
    onPoll?: () => Promise<void>,
) {
    const deadline = clock.now() + waitForJobMs;
    for (;;) {
        const marker = selectReadyMarker(await fs.listNames(layout.inboxDir));
        if (marker !== null) {
            return marker;
        }
        if (clock.now() >= deadline) {
            return null;
        }
        await onPoll?.();
        if (clock.now() >= deadline) {
            return null;
        }
        await clock.sleep(pollIntervalMs);
    }
}

interface ICreateHeartbeatOptions {
    fs: IGuestFileSystem;
    clock: IGuestClock;
    layout: IGuestLayout;
    worker: IWindowsTestWorkerIdentity;
    guestTestMarker: string;
    locked: boolean;
    intervalMs: number;
}

export function createHeartbeatWriter({
    fs,
    clock,
    layout,
    worker,
    guestTestMarker,
    locked,
    intervalMs,
}: ICreateHeartbeatOptions) {
    let lastState: TGuestWorkerState = 'idle';
    let bootId = '';
    let currentWorker = worker;
    let currentLocked = locked;
    let timer: ReturnType<typeof setInterval> | null = null;

    const writeNow = async (state: TGuestWorkerState) => {
        if (bootId.length === 0) {
            bootId = (await fs.readText(layout.bootIdFile).catch(() => '')).trim();
        }
        const payload: IGuestHeartbeat = {
            schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
            bootId,
            guestTestMarker,
            updatedAt: clock.nowIso(),
            locked: currentLocked,
            worker: currentWorker,
            lastState: state,
        };
        await fs.writeText(layout.heartbeatFile, `${JSON.stringify(payload, null, 4)}\n`);
    };

    // Explicit and timer-driven writes share one chain so two writes never
    // race on the heartbeat file and the newest state is the one left behind.
    let chain = Promise.resolve();
    const write = (state: TGuestWorkerState) => {
        lastState = state;
        const next = chain.catch(() => undefined).then(() => writeNow(state));
        chain = next;
        return next;
    };

    let writing = false;
    if (intervalMs > 0) {
        // A slow or failing heartbeat write must neither overlap the next tick
        // nor become an unhandled rejection that kills the worker.
        timer = setInterval(() => {
            if (writing) {
                return;
            }
            writing = true;
            write(lastState)
                .catch(() => undefined)
                .finally(() => {
                    writing = false;
                });
        }, intervalMs);
        timer.unref();
    }

    return {
        write,
        updateIdentity: (nextWorker: IWindowsTestWorkerIdentity, nextLocked: boolean) => {
            currentWorker = nextWorker;
            currentLocked = nextLocked;
        },
        stop: () => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        },
    };
}
