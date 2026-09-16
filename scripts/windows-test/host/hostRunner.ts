import { getErrorMessage } from '@contracts/getErrorMessage';
import {
    createHash,
    randomBytes,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
    hostname,
    tmpdir,
} from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_RUNNER_VERSION,
    windowsTestArchitectures,
    windowsTestExitCodes,
    isWindowsTestRunId,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';
import {loadFixtureManifest} from '@scripts/windows-test/fixtures/fixtureManifest';
import {
    resolveWindowsTestDataRoot,
    windowsTestGuestLayout,
    windowsTestHostLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    createCapabilityFileSuiteResolver,
    createFileFixtureManifestSource,
} from '@scripts/windows-test/host/capabilityRegistry';
import { createUtmctlGuestChannel } from '@scripts/windows-test/host/guestChannel';
import type { IWindowsTestGuestChannel } from '@scripts/windows-test/host/guestChannel';
import { buildWindowsTestInputMedia } from '@scripts/windows-test/host/inputMedia';
import type { IWindowsTestInputMedia } from '@scripts/windows-test/host/inputMedia';
import { createSystemClock } from '@scripts/windows-test/host/hostClock';
import {
    WindowsTestConfigError,
    describeMissingWindowsTestConfig,
    loadWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import type {
    IWindowsTestCandidate,
    IWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';
import {
    createLaunchctlSessionProbe,
    isUtmScreenshotPreferenceRequired,
    launcherWindowPermissionCheck,
    parseUtmctlVersion,
    readUtmScreenshotPreference,
    runWindowsTestDoctor,
} from '@scripts/windows-test/host/doctor';
import type {
    IWindowsTestDoctorCheck,
    IWindowsTestDoctorReport,
} from '@scripts/windows-test/host/doctor';
import { createProcessIdentityProbe } from '@scripts/windows-test/host/hostProcessIdentity';
import {createUtmAppleEventRunner} from '@scripts/windows-test/host/utmProcessGuard';
import type { IUtmAppleEventRunner } from '@scripts/windows-test/host/utmProcessGuard';
import {
    executeWindowsTestRun,
    WINDOWS_TEST_CLONE_NAME_PREFIX,
} from '@scripts/windows-test/host/runCoordinator';
import type {
    IWindowsTestRunReport,
    IWindowsTestStagedInput,
} from '@scripts/windows-test/host/runCoordinator';
import { requestWindowsTestStop } from '@scripts/windows-test/host/stopRun';
import type { IWindowsTestStopResult } from '@scripts/windows-test/host/stopRun';
import {
    createProcessCommandRunner,
    createUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import type {
    ICommandRunner,
    IUtmctlClient,
} from '@scripts/windows-test/host/utmctlClient';
import {createUtmInputCaptureGuard} from '@scripts/windows-test/host/utmInputCapture';
import type {IUtmInputCaptureGuard} from '@scripts/windows-test/host/utmInputCapture';
import {
    resolvePreparedStandaloneUtmctl,
    standaloneUtmctlPaths,
} from '@scripts/windows-test/host/standaloneUtmctl';
import { windowsTestWinappToolPaths } from '@scripts/windows-test/host/winappTool';
import { loadWindowsTestImageManifest } from '@scripts/windows-test/images/imageManifest';
import { createTestClone } from '@scripts/windows-test/images/createTestClone';
import { runWindowsHostOracles } from '@scripts/windows-test/oracles/windowsHostOracleDispatcher';

interface IProductionUtmTransport {
    runner: IUtmAppleEventRunner;
    processProbe: ReturnType<typeof createProcessIdentityProbe>;
    utmctl: IUtmctlClient;
    inputCapture: IUtmInputCaptureGuard;
}

export const WINDOWS_TEST_CAPABILITY_REGISTRY_RELATIVE_PATH = path.join('tests', 'windows', 'capabilities.json');

export const WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME = 'manifest.json';

export const WINDOWS_TEST_CANDIDATE_METADATA_SUFFIX = '.meta.json';

function fixtureFileName(relativePath: string) {
    const segments = relativePath.split(/[\\/]/u);
    const fileName = segments.at(-1);
    if (fileName === undefined || fileName.length === 0 || fileName === '.' || fileName === '..') {
        throw new Error(`Fixture path ${relativePath} does not name a file.`);
    }
    return fileName;
}

function resolveFixtureCachePath(manifestPath: string, relativePath: string) {
    const cacheRoot = path.dirname(manifestPath);
    const normalized = relativePath.split(/[\\/]/u).join(path.sep);
    const candidate = path.resolve(cacheRoot, normalized);
    const relative = path.relative(cacheRoot, candidate);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Fixture path ${relativePath} escapes the prepared fixture cache ${cacheRoot}.`);
    }
    return candidate;
}

/**
 * Reads the prepared manifest and returns every byte that the worker validates.
 * The guest protocol uses the raw manifest-file hash, so this list deliberately
 * carries that exact file before the fixture PDFs.
 */
export async function resolveWindowsTestFixtureInputs(manifestPath: string): Promise<IWindowsTestStagedInput[]> {
    const manifest = await loadFixtureManifest(manifestPath);
    const manifestBytes = await readFile(manifestPath);
    const inputs: IWindowsTestStagedInput[] = [{
        hostPath: manifestPath,
        guestRelativePath: 'fixtures/manifest.json',
        sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    }];
    const guestNames = new Set(['fixtures/manifest.json']);
    for (const pack of manifest.packs) {
        for (const file of pack.files) {
            if (file.sha256 === null) {
                throw new Error(`Prepared fixture ${file.id} has no sha256; planned fixtures cannot enter a run.`);
            }
            const hostPath = resolveFixtureCachePath(manifestPath, file.path);
            const bytes = await readFile(hostPath).catch((error: unknown) => {
                throw new Error(`Prepared fixture ${file.id} at ${hostPath} could not be read: ${String(error)}.`);
            });
            if (bytes.byteLength !== file.bytes) {
                throw new Error(`Prepared fixture ${file.id} is ${bytes.byteLength} bytes, expected ${file.bytes}.`);
            }
            const actualSha256 = createHash('sha256').update(bytes).digest('hex');
            if (actualSha256 !== file.sha256) {
                throw new Error(`Prepared fixture ${file.id} hashes to ${actualSha256}, expected ${file.sha256}.`);
            }
            const guestRelativePath = `fixtures/${fixtureFileName(file.path)}`;
            if (guestNames.has(guestRelativePath)) {
                throw new Error(`Prepared fixtures contain duplicate staged file name ${guestRelativePath}.`);
            }
            guestNames.add(guestRelativePath);
            inputs.push({
                hostPath,
                guestRelativePath,
                sha256: file.sha256,
            });
        }
    }
    return inputs;
}

export const WINDOWS_TEST_GUEST_WORKER_FILE = `${windowsTestGuestLayout.root}\\worker\\guestWorker.cjs`;
export const WINDOWS_TEST_GUEST_PDF_WORKER_FILE = `${windowsTestGuestLayout.root}\\worker\\pdf.worker.mjs`;
export const WINDOWS_TEST_GUEST_WINAPP_EXECUTABLE = `${windowsTestGuestLayout.winappToolsDir}\\winapp.exe`;
export const WINDOWS_TEST_GUEST_WINAPP_NATIVE_LIBRARY = `${windowsTestGuestLayout.winappToolsDir}\\libSkiaSharp.dll`;
export const WINDOWS_TEST_GUEST_WORKER_BOOTSTRAP_FILE = 'C:\\Windows\\System32\\GroupPolicy\\Machine\\Scripts\\Startup\\system-bootstrap-worker.cmd';
export const WINDOWS_TEST_GUEST_WORKER_SEED_FILE = 'C:\\Windows\\System32\\GroupPolicy\\Machine\\Scripts\\Startup\\guestWorker.cjs';

export function createPreparedGuestWorkerRefresher(options: {
    workerFile: string;
    pdfWorkerFile?: string;
    preparedFiles?: ReadonlyArray<{
        hostPath: string;
        guestPath: string;
        expectedSha256: string;
    }>;
    guest: Pick<IWindowsTestGuestChannel, 'readGuestText' | 'stageFile' | 'verifyStagedFileHash'>;
}) {
    return async (vmId: string, timeoutMs: number, refreshOptions: {allowStage?: boolean} = {}) => {
        const allowStage = refreshOptions.allowStage ?? true;
        const workerBytes = await readFile(options.workerFile);
        const expectedSha256 = createHash('sha256').update(workerBytes).digest('hex');
        const pdfWorkerBytes = options.pdfWorkerFile === undefined
            ? null
            : await readFile(options.pdfWorkerFile);
        const expectedPdfWorkerSha256 = pdfWorkerBytes === null
            ? null
            : createHash('sha256').update(pdfWorkerBytes).digest('hex');
        const preparedFiles = options.preparedFiles ?? [];
        const guestWorkerText = await options.guest.readGuestText(
            vmId,
            WINDOWS_TEST_GUEST_WORKER_FILE,
            timeoutMs,
        );
        const actualSha256 = guestWorkerText === null
            ? null
            : createHash('sha256').update(Buffer.from(guestWorkerText, 'utf8')).digest('hex');
        const bootstrapText = await options.guest.readGuestText(
            vmId,
            WINDOWS_TEST_GUEST_WORKER_BOOTSTRAP_FILE,
            timeoutMs,
        );
        const hasKnownBootstrap = bootstrapText !== null
            && bootstrapText.includes('EVB_STAGE%guestWorker.cjs');
        const seedText = hasKnownBootstrap
            ? await options.guest.readGuestText(vmId, WINDOWS_TEST_GUEST_WORKER_SEED_FILE, timeoutMs)
            : null;
        const seedSha256 = seedText === null
            ? null
            : createHash('sha256').update(Buffer.from(seedText, 'utf8')).digest('hex');
        const runtimeMatches = actualSha256 === expectedSha256;
        const seedMatches = !hasKnownBootstrap || seedSha256 === expectedSha256;
        const pdfWorkerMatches = expectedPdfWorkerSha256 === null
            ? true
            : await options.guest.verifyStagedFileHash(
                vmId,
                WINDOWS_TEST_GUEST_PDF_WORKER_FILE,
                expectedPdfWorkerSha256,
                timeoutMs,
            );
        const preparedFilesMatch = (await Promise.all(preparedFiles.map(file => options.guest.verifyStagedFileHash(
            vmId,
            file.guestPath,
            file.expectedSha256,
            timeoutMs,
        )))).every(Boolean);
        const stagePdfWorker = async () => {
            if (expectedPdfWorkerSha256 === null || pdfWorkerMatches) {
                return;
            }
            if (options.pdfWorkerFile === undefined) {
                throw new Error('The prepared PDF.js worker hash is present without a host file.');
            }
            await options.guest.stageFile(
                vmId,
                options.pdfWorkerFile,
                WINDOWS_TEST_GUEST_PDF_WORKER_FILE,
                timeoutMs,
            );
            const verifiedPdfWorker = await options.guest.verifyStagedFileHash(
                vmId,
                WINDOWS_TEST_GUEST_PDF_WORKER_FILE,
                expectedPdfWorkerSha256,
                timeoutMs,
            );
            if (!verifiedPdfWorker) {
                throw new Error(`The staged PDF.js worker at ${WINDOWS_TEST_GUEST_PDF_WORKER_FILE} did not hash to ${expectedPdfWorkerSha256} inside the guest.`);
            }
        };
        const stagePreparedFiles = async () => {
            for (const file of preparedFiles) {
                if (await options.guest.verifyStagedFileHash(vmId, file.guestPath, file.expectedSha256, timeoutMs)) {
                    continue;
                }
                await options.guest.stageFile(vmId, file.hostPath, file.guestPath, timeoutMs);
                const verified = await options.guest.verifyStagedFileHash(
                    vmId,
                    file.guestPath,
                    file.expectedSha256,
                    timeoutMs,
                );
                if (!verified) {
                    throw new Error(`The staged guest file at ${file.guestPath} did not hash to ${file.expectedSha256} inside the guest.`);
                }
            }
        };
        if (runtimeMatches && seedMatches && pdfWorkerMatches && preparedFilesMatch) {
            return false;
        }
        if (!allowStage) {
            return true;
        }
        if (hasKnownBootstrap && seedMatches) {
            await stagePdfWorker();
            await stagePreparedFiles();
            return true;
        }
        const destination = hasKnownBootstrap
            ? WINDOWS_TEST_GUEST_WORKER_SEED_FILE
            : WINDOWS_TEST_GUEST_WORKER_FILE;
        await options.guest.stageFile(vmId, options.workerFile, destination, timeoutMs);
        const verified = await options.guest.verifyStagedFileHash(vmId, destination, expectedSha256, timeoutMs);
        if (!verified) {
            throw new Error(`The staged guest worker at ${destination} did not hash to ${expectedSha256} inside the guest.`);
        }
        await stagePdfWorker();
        await stagePreparedFiles();
        return true;
    };
}

export function defaultRepositoryRoot() {
    return path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

function infrastructureReport(message: string): IWindowsTestRunReport {
    return {
        exitCode: windowsTestExitCodes.infrastructureFailed,
        outcome: 'infrastructure-failed',
        runId: null,
        activeRunId: null,
        summary: null,
        messages: [message],
    };
}

function standaloneUtmctlDoctorFailure(error: unknown): IWindowsTestDoctorReport {
    const detail = getErrorMessage(error);
    const check: IWindowsTestDoctorCheck = {
        id: 'utmctl-standalone',
        ok: false,
        detail,
        remedy: 'Run pnpm windows:test:prepare from the logged-in host session, then run doctor again.',
    };
    return {
        ok: false,
        checks: [check],
    };
}

function utmProcessDoctorFailure(error: unknown): IWindowsTestDoctorReport {
    const detail = getErrorMessage(error);
    const check: IWindowsTestDoctorCheck = {
        id: 'utm-app-running',
        ok: false,
        detail,
        remedy: 'Start exactly one UTM.app yourself, wait for its window to appear, then run doctor again.',
    };
    return {
        ok: false,
        checks: [check],
    };
}

function createProductionUtmTransport(
    utmctlPath: string,
    options: {
        validateUtmctlPath?: () => Promise<string>;
        layout?: ReturnType<typeof windowsTestHostLayout>;
        deniedVmIds?: readonly string[];
    } = {},
): IProductionUtmTransport {
    const rawRunner = createProcessCommandRunner();
    const validatedRunner: ICommandRunner = {run: async (command, args, runOptions) => {
        if (options.validateUtmctlPath !== undefined
                && path.resolve(command) === path.resolve(utmctlPath)) {
            const preparedPath = await options.validateUtmctlPath();
            if (path.resolve(preparedPath) !== path.resolve(utmctlPath)) {
                throw new Error(`The prepared standalone utmctl path changed from ${utmctlPath} to ${preparedPath}.`);
            }
        }
        return rawRunner.run(command, args, runOptions);
    }};
    const processProbe = createProcessIdentityProbe(rawRunner);
    const runner = createUtmAppleEventRunner({
        runner: validatedRunner,
        processProbe,
        utmctlPath,
    });
    const rawUtmctl = createUtmctlClient({
        runner,
        utmctlPath,
    });
    const inputCapture = createUtmInputCaptureGuard({
        runner,
        utmctl: rawUtmctl,
        ...(options.layout === undefined ? {} : {layout: options.layout}),
        ...(options.deniedVmIds === undefined ? {} : {deniedVmIds: options.deniedVmIds}),
    });
    const utmctl: IUtmctlClient = {
        ...rawUtmctl,
        start: async vmId => {
            await inputCapture.snapshotBeforeStart();
            await rawUtmctl.start(vmId);
            await inputCapture.ensureReleased(vmId);
        },
        stop: async (vmId, mode) => {
            try {
                await rawUtmctl.stop(vmId, mode);
            } finally {
                await inputCapture.restoreHostInput();
            }
        },
    };
    return {
        runner,
        processProbe,
        utmctl,
        inputCapture,
    };
}

// `--artifact` names the file; the version, source revision and architecture
// come from the recorded candidate or from a sidecar metadata file written by
// the build that produced the installer.
export async function resolveWindowsTestCandidate(
    config: IWindowsTestHostConfig,
    artifactPath: string | null,
): Promise<IWindowsTestCandidate | null> {
    if (artifactPath === null) {
        return config.candidate;
    }
    const bytes = await readFile(artifactPath).catch(() => null);
    if (bytes === null) {
        throw new Error(`The candidate artifact ${artifactPath} could not be read.`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (config.candidate !== null && path.resolve(config.candidate.artifactPath) === path.resolve(artifactPath)) {
        if (config.candidate.sha256 !== sha256) {
            throw new Error(
                `The configured candidate ${artifactPath} hashes to ${sha256}, but config.json records ${config.candidate.sha256}; re-register the build before running it.`,
            );
        }
        return config.candidate;
    }
    const metadataPath = `${artifactPath}${WINDOWS_TEST_CANDIDATE_METADATA_SUFFIX}`;
    const metadataText = await readFile(metadataPath, 'utf8').catch(() => null);
    if (metadataText === null) {
        throw new Error([
            `The artifact ${artifactPath} has no recorded build identity.`,
            `Write ${metadataPath} with {"version", "sourceSha", "appArch"} or record the candidate in the host configuration.`,
        ].join(' '));
    }
    const metadata: unknown = JSON.parse(metadataText);
    if (!isRecord(metadata)
        || typeof metadata.version !== 'string'
        || typeof metadata.sourceSha !== 'string'
        || !isOneOf(windowsTestArchitectures, metadata.appArch)) {
        throw new Error(`${metadataPath} must record a string version, a string sourceSha and an appArch of arm64 or x64.`);
    }
    return {
        artifactPath,
        sha256,
        fileName: path.basename(artifactPath),
        version: metadata.version,
        sourceSha: metadata.sourceSha,
        appArch: metadata.appArch,
    };
}

export interface IWindowsTestRunIdentity {
    runnerVersion: string;
    appVersion: string;
    sourceSha: string;
    artifactFileName: string;
    artifactSha256: string;
    imageId: string;
    environment: string;
}

export interface IWindowsTestHostRunOptions {
    suite: TWindowsTestSuite;
    tests: string[] | null;
    environment: string | null;
    artifact: string | null;
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
    repositoryRoot?: string;
    onIdentity?(identity: IWindowsTestRunIdentity): void;
}

export async function executeWindowsTestRunOnHost(
    options: IWindowsTestHostRunOptions,
): Promise<IWindowsTestRunReport> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    let config: IWindowsTestHostConfig;
    try {
        config = await loadWindowsTestHostConfig(layout.configFile);
    } catch (error) {
        if (error instanceof WindowsTestConfigError && error.kind === 'config-missing') {
            return infrastructureReport(describeMissingWindowsTestConfig(layout.configFile));
        }
        return infrastructureReport(getErrorMessage(error));
    }

    let candidate: IWindowsTestCandidate | null;
    try {
        candidate = await resolveWindowsTestCandidate(config, options.artifact);
    } catch (error) {
        return infrastructureReport(getErrorMessage(error));
    }
    if (candidate === null) {
        return infrastructureReport('A verified candidate installer is required before starting a Windows test run. Register the candidate artifact and its provenance, then retry.');
    }

    const manifestPath = path.join(layout.baselinesDir, `${config.goldenImageId}.json`);
    const imageManifest = await loadWindowsTestImageManifest(manifestPath).catch(() => null);
    if (imageManifest === null) {
        return infrastructureReport(`The golden image manifest ${manifestPath} is missing or malformed; qualify the image before running the lane.`);
    }
    let stagedInputs: IWindowsTestStagedInput[];
    try {
        stagedInputs = await resolveWindowsTestFixtureInputs(
            path.join(layout.fixturesCacheDir, WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME),
        );
    } catch (error) {
        return infrastructureReport(getErrorMessage(error));
    }

    let utmctlPath: string;
    try {
        utmctlPath = await resolvePreparedStandaloneUtmctl({layout});
    } catch (error) {
        return infrastructureReport(getErrorMessage(error));
    }
    const transport = createProductionUtmTransport(utmctlPath, {
        layout,
        deniedVmIds: config.personalVmIdsDenied,
    });
    try {
        await transport.runner.assertUtmProcess();
    } catch (error) {
        return infrastructureReport(getErrorMessage(error));
    }
    let installedUtmVersion: string;
    try {
        installedUtmVersion = parseUtmctlVersion(await transport.utmctl.version()) ?? '';
    } catch (error) {
        return infrastructureReport(getErrorMessage(error));
    }
    if (isUtmScreenshotPreferenceRequired(installedUtmVersion)) {
        const screenshotPreference = await readUtmScreenshotPreference(transport.runner);
        if (!screenshotPreference.enabled) {
            return infrastructureReport(`${screenshotPreference.detail} Remedy: ${screenshotPreference.remedy}`);
        }
    }
    options.onIdentity?.({
        runnerVersion: WINDOWS_TEST_RUNNER_VERSION,
        appVersion: candidate.version,
        sourceSha: candidate.sourceSha,
        artifactFileName: candidate.fileName,
        artifactSha256: candidate.sha256,
        imageId: imageManifest.imageId,
        environment: options.environment ?? config.environment,
    });

    const runner = transport.runner;
    const utmctl = transport.utmctl;
    let inputMedia: IWindowsTestInputMedia | undefined;
    const guest = createUtmctlGuestChannel({
        get inputMedia() { return inputMedia; },
        client: utmctl,
        temporaryFilePath: label => path.join(tmpdir(), `evb-windows-test-${label}-${randomBytes(8).toString('hex')}`),
    });
    const clock = createSystemClock();
    const probe = transport.processProbe;
    const repositoryRoot = options.repositoryRoot ?? defaultRepositoryRoot();
    const winappPaths = windowsTestWinappToolPaths(layout);
    const preparedWinappFiles = await Promise.all([
        {
            hostPath: winappPaths.executablePath,
            guestPath: WINDOWS_TEST_GUEST_WINAPP_EXECUTABLE,
        },
        {
            hostPath: winappPaths.nativeLibraryPath,
            guestPath: WINDOWS_TEST_GUEST_WINAPP_NATIVE_LIBRARY,
        },
    ].map(async ({
        hostPath,
        guestPath,
    }) => ({
        hostPath,
        guestPath,
        expectedSha256: createHash('sha256').update(await readFile(hostPath)).digest('hex'),
    })));

    try {
        return await executeWindowsTestRun(
            {
                suite: options.suite,
                environment: options.environment ?? config.environment,
                tests: options.tests,
            },
            {
                config: {
                    ...config,
                    candidate,
                },
                layout,
                utmctl,
                guest,
                clock,
                suiteResolver: createCapabilityFileSuiteResolver(
                    path.join(repositoryRoot, WINDOWS_TEST_CAPABILITY_REGISTRY_RELATIVE_PATH),
                ),
                fixtureManifest: createFileFixtureManifestSource(
                    path.join(layout.fixturesCacheDir, WINDOWS_TEST_FIXTURE_MANIFEST_FILE_NAME),
                ),
                imageManifest,
                stagedInputs,
                refreshGuestWorker: createPreparedGuestWorkerRefresher({
                    workerFile: path.join(layout.toolsCacheDir, 'worker', 'guestWorker.cjs'),
                    pdfWorkerFile: path.join(layout.toolsCacheDir, 'worker', 'pdf.worker.mjs'),
                    preparedFiles: preparedWinappFiles,
                    guest,
                }),
                evaluateHostOracles: input => runWindowsHostOracles({
                    ...input,
                    repositoryRoot,
                }),
                cloneVm: async (cloneName, cloneOptions) => {
                    if (!cloneName.startsWith(WINDOWS_TEST_CLONE_NAME_PREFIX)) {
                        throw new Error(`The disposable clone name ${cloneName} does not use the expected prefix.`);
                    }
                    const runId = cloneName.slice(WINDOWS_TEST_CLONE_NAME_PREFIX.length);
                    if (!isWindowsTestRunId(runId)) {
                        throw new Error(`The disposable clone name ${cloneName} does not contain a valid run identifier.`);
                    }
                    inputMedia = await buildWindowsTestInputMedia({
                        outputPath: path.join(layout.runsDir, runId, 'input-media.iso'),
                        sources: [
                            {
                                hostPath: candidate.artifactPath,
                                sha256: candidate.sha256,
                            },
                            ...stagedInputs.map(input => ({
                                hostPath: input.hostPath,
                                sha256: input.sha256,
                            })),
                            ...preparedWinappFiles.map(file => ({
                                hostPath: file.hostPath,
                                sha256: file.expectedSha256,
                            })),
                        ],
                        runner,
                    });
                    await createTestClone({
                        config,
                        manifest: imageManifest,
                        cloneName,
                        inputMediaPath: inputMedia.isoPath,
                        runner,
                        utmctl,
                        headless: cloneOptions.headless,
                    });
                },
                lock: {
                    hostId: hostname(),
                    pid: process.pid,
                    probe,
                    nowIso: () => clock.nowIso(),
                    sleep: milliseconds => clock.sleep(milliseconds),
                },
                probe,
                hostId: hostname(),
                randomRunSuffix: () => randomBytes(6).toString('hex'),
            },
        );
    } finally {
        await transport.inputCapture.restoreHostInput();
    }
}

export interface IWindowsTestDoctorHostOptions {
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
    launcherPath: string;
}

export async function runWindowsTestDoctorOnHost(
    options: IWindowsTestDoctorHostOptions,
): Promise<IWindowsTestDoctorReport> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    let utmctlPath: string;
    try {
        utmctlPath = await resolvePreparedStandaloneUtmctl({layout});
    } catch (error) {
        return standaloneUtmctlDoctorFailure(error);
    }
    const config = await loadWindowsTestHostConfig(layout.configFile).catch(() => null);
    const transport = createProductionUtmTransport(utmctlPath, {
        layout,
        ...(config === null ? {} : {deniedVmIds: config.personalVmIdsDenied}),
    });
    try {
        await transport.runner.assertUtmProcess();
    } catch (error) {
        return utmProcessDoctorFailure(error);
    }
    const runner = transport.runner;
    const report = await runWindowsTestDoctor({
        layout,
        utmctl: transport.utmctl,
        sessionProbe: createLaunchctlSessionProbe(runner),
        readUtmScreenshotPreference: () => readUtmScreenshotPreference(runner),
        env: options.env,
        launcherPath: options.launcherPath,
        hashFile: async filePath => createHash('sha256').update(await readFile(filePath)).digest('hex'),
    });
    let inputCaptureCheck: IWindowsTestDoctorCheck = {
        id: 'utm-input-capture',
        ok: false,
        detail: 'The host configuration was unavailable, so the UTM Capture Input control could not be checked.',
        remedy: 'Run doctor from the logged-in host session after preparing the lab; the test launcher will fail closed if Capture Input cannot be released.',
    };
    let permissionCheck = launcherWindowPermissionCheck(options.launcherPath, null);
    if (config !== null) {
        const goldenStopped = report.checks.find(check => check.id === 'golden-image-stopped')?.ok === true;
        try {
            const snapshot = await transport.inputCapture.snapshotBeforeStart();
            permissionCheck = launcherWindowPermissionCheck(options.launcherPath, snapshot);
            const result = await transport.inputCapture.ensureReleased(config.goldenVmId);
            inputCaptureCheck = {
                id: 'utm-input-capture',
                ok: result.after === 0,
                detail: `Capture Input for ${result.windowTitle} is ${result.after === 0 ? 'off' : 'on'}; host input ${result.frontmostPid === result.utmPid ? 'remains focused by UTM' : 'is available'}.`,
                remedy: 'Release capture with UTM Command+Option, then rerun doctor. The harness refuses to start a test while capture remains enabled.',
            };
        } catch (error) {
            const detail = getErrorMessage(error);
            const noTargetWindow = /target(?: window|WindowUnavailable)/iu.test(detail);
            const noUtmProcess = /UTM process count/iu.test(detail);
            inputCaptureCheck = {
                id: 'utm-input-capture',
                ok: goldenStopped && (noTargetWindow || noUtmProcess),
                detail: goldenStopped && noTargetWindow
                    ? 'The stopped golden image has no active UTM display window to inspect; the launch guard will check Capture Input after every clone start.'
                    : `The UTM Capture Input control could not be verified: ${detail}`,
                remedy: 'Keep the lab window registered in UTM, release capture with Command+Option if needed, and rerun doctor from the logged-in Aqua session.',
            };
        } finally {
            await transport.inputCapture.restoreHostInput().catch(() => undefined);
        }
    }
    return {
        ...report,
        checks: [
            ...report.checks.map(check => check.id === 'utmctl-present'
                ? {
                    ...check,
                    detail: `${check.detail} Transport: ${utmctlPath}.`,
                }
                : check),
            permissionCheck,
            inputCaptureCheck,
        ],
        ok: report.ok && permissionCheck.ok && inputCaptureCheck.ok,
    };
}

export interface IWindowsTestStopHostOptions {
    runId: string;
    reason: string;
    dataRoot: string | null;
    env: NodeJS.ProcessEnv;
}

export async function requestWindowsTestStopOnHost(
    options: IWindowsTestStopHostOptions,
): Promise<IWindowsTestStopResult> {
    const layout = windowsTestHostLayout(options.dataRoot ?? resolveWindowsTestDataRoot(options.env));
    let config: IWindowsTestHostConfig;
    try {
        config = await loadWindowsTestHostConfig(layout.configFile);
    } catch (error) {
        return {
            exitCode: windowsTestExitCodes.infrastructureFailed,
            messages: [error instanceof WindowsTestConfigError && error.kind === 'config-missing'
                ? describeMissingWindowsTestConfig(layout.configFile)
                : (getErrorMessage(error))],
            recovered: false,
        };
    }
    const utmctlPath = standaloneUtmctlPaths(layout).executable;
    const transport = createProductionUtmTransport(utmctlPath, {
        layout,
        deniedVmIds: config.personalVmIdsDenied,
        validateUtmctlPath: async () => resolvePreparedStandaloneUtmctl({layout}),
    });
    const clock = createSystemClock();
    const probe = transport.processProbe;
    try {
        return await requestWindowsTestStop(
            {
                runId: options.runId,
                reason: options.reason,
            },
            {
                layout,
                config,
                utmctl: transport.utmctl,
                inputCapture: transport.inputCapture,
                probe,
                lock: {
                    hostId: hostname(),
                    pid: process.pid,
                    probe,
                    nowIso: () => clock.nowIso(),
                    sleep: milliseconds => clock.sleep(milliseconds),
                },
                nowIso: () => clock.nowIso(),
            },
        );
    } finally {
        await transport.inputCapture.restoreHostInput();
    }
}
