import { homedir } from 'node:os';
import path from 'node:path';

export const WINDOWS_TEST_DATA_ROOT_ENV = 'EVB_WINDOWS_TESTS_ROOT';

export const WINDOWS_TEST_DEFAULT_DATA_ROOT = path.join(
    homedir(),
    'Library',
    'Application Support',
    'EVBViewerWindowsTests',
);

export function resolveWindowsTestDataRoot(env: NodeJS.ProcessEnv = process.env) {
    const override = env[WINDOWS_TEST_DATA_ROOT_ENV];
    return override !== undefined && override.length > 0
        ? path.resolve(override)
        : WINDOWS_TEST_DEFAULT_DATA_ROOT;
}

export interface IWindowsTestHostLayout {
    root: string;
    configFile: string;
    lockFile: string;
    leaseFile: string;
    imagesDir: string;
    baselinesDir: string;
    clonesDir: string;
    cachesDir: string;
    artifactsCacheDir: string;
    fixturesCacheDir: string;
    toolsCacheDir: string;
    runsDir: string;
    mailboxDir: string;
}

export function windowsTestHostLayout(root: string = resolveWindowsTestDataRoot()): IWindowsTestHostLayout {
    return {
        root,
        configFile: path.join(root, 'config.json'),
        lockFile: path.join(root, 'host.lock'),
        leaseFile: path.join(root, 'lease.json'),
        imagesDir: path.join(root, 'images'),
        baselinesDir: path.join(root, 'images', 'baselines'),
        clonesDir: path.join(root, 'images', 'clones'),
        cachesDir: path.join(root, 'caches'),
        artifactsCacheDir: path.join(root, 'caches', 'artifacts'),
        fixturesCacheDir: path.join(root, 'caches', 'fixtures'),
        toolsCacheDir: path.join(root, 'caches', 'tools'),
        runsDir: path.join(root, 'runs'),
        mailboxDir: path.join(root, 'mailbox'),
    };
}

export interface IWindowsTestRunLayout {
    runDir: string;
    jobFile: string;
    summaryFile: string;
    transitionsFile: string;
    hostLogFile: string;
    guestResultFile: string;
    evidenceDir: string;
    evidenceManifestFile: string;
    cancelRequestFile: string;
}

export function windowsTestRunLayout(runsDir: string, runId: string): IWindowsTestRunLayout {
    const runDir = path.join(runsDir, runId);
    return {
        runDir,
        jobFile: path.join(runDir, 'job.json'),
        summaryFile: path.join(runDir, 'summary.json'),
        transitionsFile: path.join(runDir, 'transitions.ndjson'),
        hostLogFile: path.join(runDir, 'host.log'),
        guestResultFile: path.join(runDir, 'guest-result.json'),
        evidenceDir: path.join(runDir, 'evidence'),
        evidenceManifestFile: path.join(runDir, 'evidence-manifest.json'),
        cancelRequestFile: path.join(runDir, 'cancel-request.json'),
    };
}

export const windowsTestGuestLayout = {
    root: 'C:\\EVBViewerTests',
    winappToolsDir: 'C:\\EVBViewerTests\\tools\\winapp',
    inboxDir: 'C:\\EVBViewerTests\\inbox',
    outboxDir: 'C:\\EVBViewerTests\\outbox',
    stateDir: 'C:\\EVBViewerTests\\state',
    stagingDir: 'C:\\EVBViewerTests\\staging',
    workDir: 'C:\\EVBViewerTests\\work',
    markerFile: 'C:\\EVBViewerTests\\state\\test-marker.json',
    bootIdFile: 'C:\\EVBViewerTests\\state\\boot-id.txt',
    heartbeatFile: 'C:\\EVBViewerTests\\state\\heartbeat.json',
} as const;

export function windowsTestGuestRunPaths(runId: string) {
    const runRoot = `${windowsTestGuestLayout.workDir}\\${runId}`;
    const stagingDir = `${windowsTestGuestLayout.stagingDir}\\${runId}`;
    return {
        runRoot,
        stagingDir,
        jobFile: `${windowsTestGuestLayout.inboxDir}\\${runId}.job.json`,
        readyMarkerFile: `${windowsTestGuestLayout.inboxDir}\\${runId}.ready`,
        cancelFile: `${windowsTestGuestLayout.inboxDir}\\${runId}.cancel`,
        resultFile: `${windowsTestGuestLayout.outboxDir}\\${runId}.result.json`,
        resultTempFile: `${windowsTestGuestLayout.outboxDir}\\${runId}.result.json.tmp`,
        evidenceDir: `${runRoot}\\evidence`,
        evidenceManifestFile: `${runRoot}\\evidence-manifest.json`,
        workerLogFile: `${runRoot}\\worker.log`,
        inputsDir: `${runRoot}\\inputs`,
        outputsDir: `${runRoot}\\outputs`,
    };
}
