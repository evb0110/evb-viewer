import {
    isFiniteNumber,
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';

export const WINDOWS_TEST_SCHEMA_VERSION = 1;

export const WINDOWS_TEST_RUNNER_VERSION = '2026-09-05.1';

export const windowsTestExitCodes = {
    passed: 0,
    usageOrCrash: 1,
    productFailed: 2,
    infrastructureFailed: 3,
    unsupported: 4,
    canceled: 5,
    busyLease: 6,
} as const;

export type TWindowsTestExitCode = typeof windowsTestExitCodes[keyof typeof windowsTestExitCodes];

export const windowsTestRunStates = [
    'queued',
    'leased',
    'booting',
    'guest-ready',
    'desktop-ready',
    'staged',
    'installed',
    'launched',
    'testing',
    'collecting',
    'tearing-down',
    'complete',
] as const;

export type TWindowsTestRunState = typeof windowsTestRunStates[number];

export const windowsTestOutcomes = [
    'passed',
    'product-failed',
    'infrastructure-failed',
    'unsupported',
    'canceled',
] as const;

export type TWindowsTestOutcome = typeof windowsTestOutcomes[number];

export const windowsTestSuites = [
    'smoke',
    'critical',
    'all',
] as const;

export type TWindowsTestSuite = typeof windowsTestSuites[number];

export const windowsTestArchitectures = [
    'arm64',
    'x64',
] as const;

export type TWindowsTestArchitecture = typeof windowsTestArchitectures[number];

export const windowsTestDrivers = [
    'APP',
    'WIN',
    'NATIVE',
] as const;

export type TWindowsTestDriver = typeof windowsTestDrivers[number];

export const windowsTestCaseStatuses = [
    'planned',
    'implemented',
    'unsupported-in-environment',
    'not-applicable',
    'quarantined',
] as const;

export type TWindowsTestCaseStatus = typeof windowsTestCaseStatuses[number];

export const windowsTestGatePolicies = [
    'advisory',
    'required',
] as const;

export type TWindowsTestGatePolicy = typeof windowsTestGatePolicies[number];

export const windowsTestDefaultDeadlines = {
    bootToGuestReadySeconds: 180,
    guestReadyToDesktopReadySeconds: 180,
    uiStepSeconds: 30,
    guestTransportSeconds: 180,
    printReadinessCeilingSeconds: 120,
    jobSeconds: 1200,
} as const;

export const WINDOWS_TEST_ID_PATTERN = /^WIN-[A-Z]+-\d{2}$/u;

export const WINDOWS_TEST_RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u;

export const WINDOWS_TEST_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const WINDOWS_TEST_GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export const WINDOWS_TEST_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const forbiddenAcceptanceLaunchFlags = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-web-security',
    '--ignore-certificate-errors',
    '--allow-running-insecure-content',
    '--disable-features=IsolateOrigins',
] as const;

export interface IWindowsTestJob {
    recordVideo?: boolean;
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    runId: string;
    sourceSha: string;
    artifactSha256: string;
    artifactFileName: string;
    imageId: string;
    vmId: string;
    bootId: string;
    guestTestMarker: string;
    runnerVersion: string;
    suite: TWindowsTestSuite;
    tests: string[];
    fixtureManifestSha256: string;
    expectedOsArch: TWindowsTestArchitecture;
    expectedAppArch: TWindowsTestArchitecture;
    deadlineSeconds: number;
}

export interface IWindowsTestAssertionResult {
    id: string;
    passed: boolean;
    detail: string;
}

export interface IWindowsTestCaseResult {
    testId: string;
    driver: TWindowsTestDriver;
    actionKind: 'pattern' | 'input' | 'process' | 'app';
    outcome: TWindowsTestOutcome;
    startedAt: string;
    endedAt: string;
    assertions: IWindowsTestAssertionResult[];
    evidenceFiles: string[];
    failureReason: string | null;
}

export interface IWindowsTestWorkerIdentity {
    userSid: string;
    sessionId: number;
    integrityLevel: string;
    inputDesktop: string;
    interactive: boolean;
    workerPid: number;
    workerStartTime: string;
}

export interface IWindowsTestGuestPlatform {
    osVersion: string;
    osArch: TWindowsTestArchitecture;
    appVersion: string;
    appArch: TWindowsTestArchitecture;
    installedExecutableSha256: string;
    hostname: string;
}

export interface IWindowsTestResult {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    runId: string;
    vmId: string;
    imageId: string;
    bootId: string;
    guestTestMarker: string;
    artifactSha256: string;
    runnerVersion: string;
    terminalState: 'complete';
    outcome: TWindowsTestOutcome;
    startedAt: string;
    endedAt: string;
    expectedTests: string[];
    executedTests: string[];
    assertionCount: number;
    failedAssertionCount: number;
    cases: IWindowsTestCaseResult[];
    worker: IWindowsTestWorkerIdentity;
    platform: IWindowsTestGuestPlatform;
    evidenceManifestSha256: string;
    logTruncated: boolean;
    humanReviewRequired: boolean;
    failureReason: string | null;
}

export interface IWindowsTestEvidenceEntry {
    relativePath: string;
    sha256: string;
    bytes: number;
}

export interface IWindowsTestEvidenceManifest {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    runId: string;
    entries: IWindowsTestEvidenceEntry[];
}

export interface IWindowsTestTransition {
    state: TWindowsTestRunState;
    elapsedMs: number;
    reason: string;
}

export interface IWindowsTestFailureRecord {
    outcome: Exclude<TWindowsTestOutcome, 'passed'>;
    phase: TWindowsTestRunState;
    reason: string;
}

export interface IWindowsTestRunSummary {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    runId: string;
    suite: TWindowsTestSuite;
    environment: string;
    sourceSha: string;
    artifactSha256: string;
    artifactFileName: string;
    imageId: string;
    vmId: string;
    runnerVersion: string;
    outcome: TWindowsTestOutcome;
    exitCode: TWindowsTestExitCode;
    startedAt: string;
    endedAt: string;
    transitions: IWindowsTestTransition[];
    failures: IWindowsTestFailureRecord[];
    expectedTests: string[];
    executedTests: string[];
    passedTests: string[];
    failedTests: string[];
    unsupportedTests: string[];
    uncoveredObligations: string[];
    humanReviewRequired: boolean;
    evidenceDirectory: string;
    retainedClone: boolean;
}

export type TWindowsTestOutcomeExitCode = Exclude<TWindowsTestExitCode, 1 | 6>;

export function exitCodeForOutcome(outcome: TWindowsTestOutcome): TWindowsTestOutcomeExitCode {
    switch (outcome) {
        case 'passed':
            return windowsTestExitCodes.passed;
        case 'product-failed':
            return windowsTestExitCodes.productFailed;
        case 'infrastructure-failed':
            return windowsTestExitCodes.infrastructureFailed;
        case 'unsupported':
            return windowsTestExitCodes.unsupported;
        case 'canceled':
            return windowsTestExitCodes.canceled;
    }
}

const outcomeSeverity: Record<TWindowsTestOutcome, number> = {
    passed: 0,
    unsupported: 1,
    canceled: 2,
    'infrastructure-failed': 3,
    'product-failed': 4,
};

export function combineOutcomes(first: TWindowsTestOutcome, second: TWindowsTestOutcome) {
    return outcomeSeverity[second] > outcomeSeverity[first] ? second : first;
}

export function isWindowsTestId(value: unknown): value is string {
    return typeof value === 'string' && WINDOWS_TEST_ID_PATTERN.test(value);
}

export function isWindowsTestRunId(value: unknown): value is string {
    return typeof value === 'string' && WINDOWS_TEST_RUN_ID_PATTERN.test(value);
}

export function isSha256Hex(value: unknown): value is string {
    return typeof value === 'string' && WINDOWS_TEST_SHA256_PATTERN.test(value);
}

export function isGitSha(value: unknown): value is string {
    return typeof value === 'string' && WINDOWS_TEST_GIT_SHA_PATTERN.test(value);
}

export function isVmUuid(value: unknown): value is string {
    return typeof value === 'string' && WINDOWS_TEST_UUID_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isTestIdArray(value: unknown): value is string[] {
    return isStringArray(value) && value.every(isWindowsTestId);
}

export function isWindowsTestJob(value: unknown): value is IWindowsTestJob {
    return isRecord(value)
        && (value.recordVideo === undefined || typeof value.recordVideo === 'boolean')
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isWindowsTestRunId(value.runId)
        && isGitSha(value.sourceSha)
        && isSha256Hex(value.artifactSha256)
        && isNonEmptyString(value.artifactFileName)
        && isNonEmptyString(value.imageId)
        && isVmUuid(value.vmId)
        && isNonEmptyString(value.bootId)
        && isNonEmptyString(value.guestTestMarker)
        && isNonEmptyString(value.runnerVersion)
        && isOneOf(windowsTestSuites, value.suite)
        && isTestIdArray(value.tests)
        && value.tests.length > 0
        && isSha256Hex(value.fixtureManifestSha256)
        && isOneOf(windowsTestArchitectures, value.expectedOsArch)
        && isOneOf(windowsTestArchitectures, value.expectedAppArch)
        && isFiniteNumber(value.deadlineSeconds)
        && value.deadlineSeconds > 0;
}

export function isWindowsTestAssertionResult(value: unknown): value is IWindowsTestAssertionResult {
    return isRecord(value)
        && isNonEmptyString(value.id)
        && typeof value.passed === 'boolean'
        && typeof value.detail === 'string';
}

const caseActionKinds = [
    'pattern',
    'input',
    'process',
    'app',
] as const;

export function isWindowsTestCaseResult(value: unknown): value is IWindowsTestCaseResult {
    return isRecord(value)
        && isWindowsTestId(value.testId)
        && isOneOf(windowsTestDrivers, value.driver)
        && isOneOf(caseActionKinds, value.actionKind)
        && isOneOf(windowsTestOutcomes, value.outcome)
        && isNonEmptyString(value.startedAt)
        && isNonEmptyString(value.endedAt)
        && Array.isArray(value.assertions)
        && value.assertions.every(isWindowsTestAssertionResult)
        && isStringArray(value.evidenceFiles)
        && (value.failureReason === null || typeof value.failureReason === 'string');
}

export function isWindowsTestWorkerIdentity(value: unknown): value is IWindowsTestWorkerIdentity {
    return isRecord(value)
        && isNonEmptyString(value.userSid)
        && isFiniteNumber(value.sessionId)
        && isNonEmptyString(value.integrityLevel)
        && isNonEmptyString(value.inputDesktop)
        && typeof value.interactive === 'boolean'
        && isFiniteNumber(value.workerPid)
        && isNonEmptyString(value.workerStartTime);
}

export function isWindowsTestGuestPlatform(value: unknown): value is IWindowsTestGuestPlatform {
    return isRecord(value)
        && isNonEmptyString(value.osVersion)
        && isOneOf(windowsTestArchitectures, value.osArch)
        && isNonEmptyString(value.appVersion)
        && isOneOf(windowsTestArchitectures, value.appArch)
        && isSha256Hex(value.installedExecutableSha256)
        && isNonEmptyString(value.hostname);
}

export function isWindowsTestResult(value: unknown): value is IWindowsTestResult {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isWindowsTestRunId(value.runId)
        && isVmUuid(value.vmId)
        && isNonEmptyString(value.imageId)
        && isNonEmptyString(value.bootId)
        && isNonEmptyString(value.guestTestMarker)
        && isSha256Hex(value.artifactSha256)
        && isNonEmptyString(value.runnerVersion)
        && value.terminalState === 'complete'
        && isOneOf(windowsTestOutcomes, value.outcome)
        && isNonEmptyString(value.startedAt)
        && isNonEmptyString(value.endedAt)
        && isTestIdArray(value.expectedTests)
        && isTestIdArray(value.executedTests)
        && isFiniteNumber(value.assertionCount)
        && isFiniteNumber(value.failedAssertionCount)
        && Array.isArray(value.cases)
        && value.cases.every(isWindowsTestCaseResult)
        && isWindowsTestWorkerIdentity(value.worker)
        && isWindowsTestGuestPlatform(value.platform)
        && isSha256Hex(value.evidenceManifestSha256)
        && typeof value.logTruncated === 'boolean'
        && typeof value.humanReviewRequired === 'boolean'
        && (value.failureReason === null || typeof value.failureReason === 'string');
}

// A guest-written path is data: a drive root, a UNC or POSIX root, or a parent
// segment would let the manifest choose where the host writes evidence.
const ABSOLUTE_EVIDENCE_PATH_PATTERN = /^(?:[A-Za-z]:|[\\/])/u;

function isSafeEvidenceRelativePath(value: unknown): value is string {
    return isNonEmptyString(value)
        && !ABSOLUTE_EVIDENCE_PATH_PATTERN.test(value)
        && value.split(/[\\/]/u).every(segment => segment !== '..');
}

export function isWindowsTestEvidenceManifest(value: unknown): value is IWindowsTestEvidenceManifest {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isWindowsTestRunId(value.runId)
        && Array.isArray(value.entries)
        && value.entries.every(entry => isRecord(entry)
            && isSafeEvidenceRelativePath(entry.relativePath)
            && isSha256Hex(entry.sha256)
            && isFiniteNumber(entry.bytes)
            && entry.bytes >= 0);
}

export interface IWindowsTestResultMismatch {
    field: string;
    expected: string;
    actual: string;
}

export function findResultIdentityMismatches(job: IWindowsTestJob, result: IWindowsTestResult) {
    const comparisons: Array<[string, string, string]> = [
        [
            'runId',
            job.runId,
            result.runId,
        ],
        [
            'vmId',
            job.vmId,
            result.vmId,
        ],
        [
            'imageId',
            job.imageId,
            result.imageId,
        ],
        [
            'bootId',
            job.bootId,
            result.bootId,
        ],
        [
            'guestTestMarker',
            job.guestTestMarker,
            result.guestTestMarker,
        ],
        [
            'artifactSha256',
            job.artifactSha256,
            result.artifactSha256,
        ],
        [
            'runnerVersion',
            job.runnerVersion,
            result.runnerVersion,
        ],
        [
            'expectedTests',
            job.tests.join(','),
            result.expectedTests.join(','),
        ],
        [
            'platform.osArch',
            job.expectedOsArch,
            result.platform.osArch,
        ],
        [
            'platform.appArch',
            job.expectedAppArch,
            result.platform.appArch,
        ],
    ];
    const mismatches: IWindowsTestResultMismatch[] = [];
    for (const [
        field,
        expected,
        actual,
    ] of comparisons) {
        if (expected !== actual) {
            mismatches.push({
                field,
                expected,
                actual,
            });
        }
    }
    const missingTests = job.tests.filter(testId => !result.executedTests.includes(testId));
    const unexpectedTests = result.executedTests.filter(testId => !job.tests.includes(testId));
    if (missingTests.length > 0 || unexpectedTests.length > 0) {
        mismatches.push({
            field: 'executedTests',
            expected: job.tests.join(','),
            actual: result.executedTests.join(','),
        });
    }
    return mismatches;
}

export interface IWindowsTestWorkerHeartbeat {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    bootId: string;
    guestTestMarker: string;
    updatedAt: string;
    locked: boolean;
    worker: IWindowsTestWorkerIdentity;
}

export function isWindowsTestWorkerHeartbeat(value: unknown): value is IWindowsTestWorkerHeartbeat {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && isNonEmptyString(value.bootId)
        && isNonEmptyString(value.guestTestMarker)
        && isNonEmptyString(value.updatedAt)
        && typeof value.locked === 'boolean'
        && isWindowsTestWorkerIdentity(value.worker);
}
