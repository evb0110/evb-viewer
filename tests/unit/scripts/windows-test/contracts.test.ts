import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    combineOutcomes,
    exitCodeForOutcome,
    findResultIdentityMismatches,
    isWindowsTestEvidenceManifest,
    isWindowsTestJob,
    isWindowsTestResult,
    isWindowsTestRunId,
    WINDOWS_TEST_SCHEMA_VERSION,
    windowsTestExitCodes,
    windowsTestOutcomes,
    windowsTestRunStates,
    type IWindowsTestJob,
    type IWindowsTestResult,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    resolveWindowsTestDataRoot,
    WINDOWS_TEST_DATA_ROOT_ENV,
    WINDOWS_TEST_DEFAULT_DATA_ROOT,
    windowsTestGuestRunPaths,
    windowsTestHostLayout,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';

const sha = 'a'.repeat(64);
const gitSha = 'b'.repeat(40);
const vmId = '11111111-2222-4333-8444-555555555555';
const runId = '20260904T120000Z-0123456789ab';

function job(overrides: Partial<IWindowsTestJob> = {}): IWindowsTestJob {
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        runId,
        sourceSha: gitSha,
        artifactSha256: sha,
        artifactFileName: 'EVB-Viewer-Setup-arm64.exe',
        imageId: 'win11-arm64-pro-25h2-baseline-001',
        vmId,
        bootId: 'boot-1',
        guestTestMarker: 'evb-test-clone',
        runnerVersion: '2026-09-04.1',
        suite: 'critical',
        tests: [
            'WIN-SAVE-01',
            'WIN-PRINT-01',
        ],
        fixtureManifestSha256: sha,
        expectedOsArch: 'arm64',
        expectedAppArch: 'arm64',
        deadlineSeconds: 1200,
        ...overrides,
    };
}

function result(overrides: Partial<IWindowsTestResult> = {}): IWindowsTestResult {
    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        runId,
        vmId,
        imageId: 'win11-arm64-pro-25h2-baseline-001',
        bootId: 'boot-1',
        guestTestMarker: 'evb-test-clone',
        artifactSha256: sha,
        runnerVersion: '2026-09-04.1',
        terminalState: 'complete',
        outcome: 'passed',
        startedAt: '2026-09-04T12:00:00.000Z',
        endedAt: '2026-09-04T12:10:00.000Z',
        expectedTests: [
            'WIN-SAVE-01',
            'WIN-PRINT-01',
        ],
        executedTests: [
            'WIN-SAVE-01',
            'WIN-PRINT-01',
        ],
        assertionCount: 4,
        failedAssertionCount: 0,
        cases: [{
            testId: 'WIN-SAVE-01',
            driver: 'APP',
            actionKind: 'app',
            outcome: 'passed',
            startedAt: '2026-09-04T12:01:00.000Z',
            endedAt: '2026-09-04T12:02:00.000Z',
            assertions: [{
                id: 'page-count',
                passed: true,
                detail: '10 pages',
            }],
            evidenceFiles: ['WIN-SAVE-01/output.pdf'],
            failureReason: null,
        }],
        worker: {
            userSid: 'S-1-5-21-1-2-3-1001',
            sessionId: 1,
            integrityLevel: 'Medium',
            inputDesktop: 'Default',
            interactive: true,
            workerPid: 4242,
            workerStartTime: '2026-09-04T11:59:00.000Z',
        },
        platform: {
            osVersion: '10.0.26200',
            osArch: 'arm64',
            appVersion: '0.1.451',
            appArch: 'arm64',
            installedExecutableSha256: sha,
            hostname: 'evb-test-clone-01',
        },
        evidenceManifestSha256: sha,
        logTruncated: false,
        humanReviewRequired: true,
        failureReason: null,
        ...overrides,
    };
}

describe('Windows recording request', () => {
    it('accepts an optional boolean and rejects malformed recording requests', () => {
        expect(isWindowsTestJob(job({recordVideo: true}))).toBe(true);
        expect(isWindowsTestJob({
            ...job(),
            recordVideo: 'true',
        })).toBe(false);
    });
});

describe('windows test contracts', () => {
    it('maps every outcome to its documented exit code and reserves 1 and 6 for the host', () => {
        expect(windowsTestOutcomes.map(exitCodeForOutcome)).toEqual([
            0,
            2,
            3,
            4,
            5,
        ]);
        expect(windowsTestExitCodes.usageOrCrash).toBe(1);
        expect(windowsTestExitCodes.busyLease).toBe(6);
    });

    it('keeps the plan state machine order', () => {
        expect(windowsTestRunStates[0]).toBe('queued');
        expect(windowsTestRunStates.at(-1)).toBe('complete');
        expect(windowsTestRunStates).toHaveLength(12);
    });

    it('never lets a later infrastructure failure hide an earlier product failure', () => {
        expect(combineOutcomes('product-failed', 'infrastructure-failed')).toBe('product-failed');
        expect(combineOutcomes('passed', 'infrastructure-failed')).toBe('infrastructure-failed');
        expect(combineOutcomes('unsupported', 'passed')).toBe('unsupported');
        expect(combineOutcomes('canceled', 'product-failed')).toBe('product-failed');
    });

    it('accepts a complete job and rejects identity or scope gaps', () => {
        expect(isWindowsTestJob(job())).toBe(true);
        expect(isWindowsTestJob({
            ...job(),
            schemaVersion: 2,
        })).toBe(false);
        expect(isWindowsTestJob(job({tests: []}))).toBe(false);
        expect(isWindowsTestJob(job({tests: ['save-01']}))).toBe(false);
        expect(isWindowsTestJob(job({vmId: 'Windows'}))).toBe(false);
        expect(isWindowsTestJob(job({artifactSha256: 'latest'}))).toBe(false);
        expect(isWindowsTestJob(job({deadlineSeconds: 0}))).toBe(false);
        expect(isWindowsTestJob(null)).toBe(false);
    });

    it('accepts a complete result and rejects partial or malformed records', () => {
        expect(isWindowsTestResult(result())).toBe(true);
        expect(isWindowsTestResult({
            ...result(),
            terminalState: 'testing',
        })).toBe(false);
        expect(isWindowsTestResult({
            ...result(),
            cases: [{testId: 'WIN-SAVE-01'}],
        })).toBe(false);
        expect(isWindowsTestResult({})).toBe(false);
        expect(isWindowsTestResult('')).toBe(false);
    });

    it('reports every identity mismatch between job and result, including missing tests', () => {
        expect(findResultIdentityMismatches(job(), result())).toEqual([]);
        const mismatches = findResultIdentityMismatches(job(), result({
            bootId: 'boot-0',
            executedTests: ['WIN-SAVE-01'],
        }));
        expect(mismatches.map(mismatch => mismatch.field)).toEqual([
            'bootId',
            'executedTests',
        ]);
    });

    it('reports tests the guest executed that the job never asked for', () => {
        const mismatches = findResultIdentityMismatches(job(), result({executedTests: [
            ...job().tests,
            'WIN-PRINT-99',
        ]}));
        expect(mismatches.map(mismatch => mismatch.field)).toEqual(['executedTests']);
    });

    it('validates evidence manifests and rejects path escapes', () => {
        expect(isWindowsTestEvidenceManifest({
            schemaVersion: 1,
            runId,
            entries: [{
                relativePath: 'WIN-SAVE-01/output.pdf',
                sha256: sha,
                bytes: 10,
            }],
        })).toBe(true);
        for (const relativePath of [
            '../host.log',
            'WIN-SAVE-01\\..\\host.log',
            'C:\\Windows\\host.log',
            '\\\\server\\share\\host.log',
            '\\Windows\\host.log',
            '/etc/passwd',
        ]) {
            expect(isWindowsTestEvidenceManifest({
                schemaVersion: 1,
                runId,
                entries: [{
                    relativePath,
                    sha256: sha,
                    bytes: 10,
                }],
            }), relativePath).toBe(false);
        }
    });

    it('recognizes the run id format', () => {
        expect(isWindowsTestRunId(runId)).toBe(true);
        expect(isWindowsTestRunId('run-1')).toBe(false);
    });
});

describe('windows test paths', () => {
    it('uses the dedicated Application Support root unless overridden', () => {
        expect(WINDOWS_TEST_DEFAULT_DATA_ROOT.endsWith('/Library/Application Support/EVBViewerWindowsTests')).toBe(true);
        expect(resolveWindowsTestDataRoot({})).toBe(WINDOWS_TEST_DEFAULT_DATA_ROOT);
        expect(resolveWindowsTestDataRoot({[WINDOWS_TEST_DATA_ROOT_ENV]: '/tmp/evb-win'})).toBe('/tmp/evb-win');
        expect(resolveWindowsTestDataRoot({[WINDOWS_TEST_DATA_ROOT_ENV]: ''})).toBe(WINDOWS_TEST_DEFAULT_DATA_ROOT);
    });

    it('keeps every host and run path under the data root', () => {
        const layout = windowsTestHostLayout('/tmp/evb-win');
        for (const value of Object.values(layout)) {
            expect(value.startsWith('/tmp/evb-win')).toBe(true);
        }
        const run = windowsTestRunLayout(layout.runsDir, runId);
        for (const value of Object.values(run)) {
            expect(value.startsWith(`/tmp/evb-win/runs/${runId}`)).toBe(true);
        }
    });

    it('derives guest mailbox and work paths from the run id', () => {
        const paths = windowsTestGuestRunPaths(runId);
        expect(paths.jobFile).toBe(`C:\\EVBViewerTests\\inbox\\${runId}.job.json`);
        expect(paths.resultTempFile).toBe(`${paths.resultFile}.tmp`);
        expect(paths.evidenceDir).toBe(`C:\\EVBViewerTests\\work\\${runId}\\evidence`);
    });
});
