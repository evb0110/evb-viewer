import {
    mkdir,
    mkdtemp,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { windowsTestExitCodes } from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestRunSummary,
    TWindowsTestOutcome,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    WINDOWS_TEST_DATA_ROOT_ENV,
    windowsTestHostLayout,
    windowsTestRunLayout,
} from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    WINDOWS_TEST_CLI_USAGE,
    WINDOWS_TEST_PROVISION_USAGE,
    parseWindowsTestArgs,
    parseWindowsTestDoctorArgs,
    parseWindowsTestProvisionArgs,
    parseWindowsTestReportArgs,
    parseWindowsTestStopArgs,
} from '@scripts/windows-test/cli/windowsTestArgs';
import type { IWindowsTestCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { createProcessCliIo } from '@scripts/windows-test/cli/windowsTestCliIo';
import { runWindowsTestCli } from '@scripts/windows-test/cli/runWindowsTestCli';
import {
    formatWindowsTestDoctorReport,
    runWindowsTestDoctorCli,
} from '@scripts/windows-test/cli/runWindowsTestDoctorCli';
import { runWindowsTestReportCli } from '@scripts/windows-test/cli/runWindowsTestReportCli';
import { runWindowsTestStopCli } from '@scripts/windows-test/cli/runWindowsTestStopCli';
import { runWindowsTestProvisionCli } from '@scripts/windows-test/cli/runWindowsTestProvisionCli';
import type { IWindowsTestRunReport } from '@scripts/windows-test/host/runCoordinator';

const RUN_ID = '20260904T120000Z-0123456789ab';
const CLONE_VM_ID = '33333333-4444-4555-8666-777777777777';

function createRecordingIo() {
    const out: string[] = [];
    const err: string[] = [];
    const io: IWindowsTestCliIo = {
        write: line => out.push(line),
        writeError: line => err.push(line),
    };
    return {
        io,
        out,
        err,
    };
}

function summary(overrides: Partial<IWindowsTestRunSummary> = {}): IWindowsTestRunSummary {
    return {
        schemaVersion: 1,
        runId: RUN_ID,
        suite: 'smoke',
        environment: 'win11-arm64',
        sourceSha: 'b'.repeat(40),
        artifactSha256: 'a'.repeat(64),
        artifactFileName: 'EVBViewer-Setup.exe',
        imageId: 'win11-arm64-2026-09',
        vmId: CLONE_VM_ID,
        runnerVersion: '2026-09-04.1',
        outcome: 'passed',
        exitCode: 0,
        startedAt: '2026-09-04T12:00:00.000Z',
        endedAt: '2026-09-04T12:10:00.000Z',
        transitions: [],
        failures: [],
        expectedTests: ['WIN-SAVE-01'],
        executedTests: ['WIN-SAVE-01'],
        passedTests: ['WIN-SAVE-01'],
        failedTests: [],
        unsupportedTests: [],
        uncoveredObligations: ['WIN-PRINT-09'],
        humanReviewRequired: false,
        evidenceDirectory: '/tmp/evidence',
        retainedClone: false,
        ...overrides,
    };
}

function runReport(
    outcome: TWindowsTestOutcome,
    exitCode: number,
    overrides: Partial<IWindowsTestRunReport> = {},
): IWindowsTestRunReport {
    return {
        exitCode: exitCode as IWindowsTestRunReport['exitCode'],
        outcome,
        runId: RUN_ID,
        activeRunId: null,
        summary: summary({
            outcome,
            exitCode: exitCode as IWindowsTestRunSummary['exitCode'],
        }),
        messages: [],
        ...overrides,
    };
}

describe('windows test argument parsing', () => {
    it('defaults to the smoke suite and no overrides', () => {
        const parsed = parseWindowsTestArgs([]);

        expect(parsed).toEqual({
            ok: true,
            args: {
                suite: 'smoke',
                artifact: null,
                environment: null,
                tests: null,
                dataRoot: null,
                json: false,
                help: false,
            },
        });
    });

    it('accepts every documented flag', () => {
        const parsed = parseWindowsTestArgs([
            '--suite',
            'all',
            '--artifact',
            '/tmp/EVBViewer-Setup.exe',
            '--environment',
            'win11-arm64',
            '--tests',
            'WIN-SAVE-01, WIN-PRINT-02',
            '--data-root',
            '/tmp/windows-tests',
            '--json',
        ]);

        expect(parsed.ok && parsed.args).toMatchObject({
            suite: 'all',
            artifact: '/tmp/EVBViewer-Setup.exe',
            environment: 'win11-arm64',
            tests: [
                'WIN-SAVE-01',
                'WIN-PRINT-02',
            ],
            dataRoot: '/tmp/windows-tests',
            json: true,
        });
    });

    it('rejects unknown flags, missing values and relative paths', () => {
        expect(parseWindowsTestArgs(['--wat'])).toMatchObject({
            ok: false,
            error: 'Unrecognized argument "--wat".',
        });
        expect(parseWindowsTestArgs([
            '--artifact',
            '--json',
        ])).toMatchObject({
            ok: false,
            error: 'Flag --artifact needs a value.',
        });
        expect(parseWindowsTestArgs([
            '--artifact',
            'build/setup.exe',
        ])).toMatchObject({ok: false});
        expect(parseWindowsTestArgs([
            '--data-root',
            './runs',
        ])).toMatchObject({ok: false});
    });

    it('rejects an unknown suite and non case-shaped test IDs', () => {
        expect(parseWindowsTestArgs([
            '--suite',
            'everything',
        ])).toMatchObject({ok: false});
        expect(parseWindowsTestArgs([
            '--tests',
            'save-01',
        ])).toMatchObject({ok: false});
        expect(parseWindowsTestArgs([
            '--tests',
            ' , ',
        ])).toMatchObject({ok: false});
    });

    it('parses the doctor, report and stop argument sets', () => {
        expect(parseWindowsTestDoctorArgs(['--json'])).toMatchObject({
            ok: true,
            args: {json: true},
        });
        expect(parseWindowsTestReportArgs([
            '--run',
            RUN_ID,
        ])).toMatchObject({
            ok: true,
            args: {runId: RUN_ID},
        });
        expect(parseWindowsTestReportArgs([
            '--run',
            'yesterday',
        ])).toMatchObject({ok: false});
        expect(parseWindowsTestStopArgs([
            '--run',
            RUN_ID,
            '--reason',
            'operator asked',
        ])).toMatchObject({
            ok: true,
            args: {
                runId: RUN_ID,
                reason: 'operator asked',
            },
        });
        expect(parseWindowsTestStopArgs(['--run'])).toMatchObject({ok: false});
    });

    it('parses headless golden healing while preserving the native-input plan mode', () => {
        expect(parseWindowsTestProvisionArgs([
            '--heal-golden',
            '--data-root',
            '/tmp/windows-tests',
        ])).toEqual({
            ok: true,
            args: {
                planPath: null,
                healGolden: true,
                dataRoot: '/tmp/windows-tests',
                json: false,
                help: false,
            },
        });
        expect(parseWindowsTestProvisionArgs([
            '--plan',
            '/tmp/provision-plan.json',
        ])).toMatchObject({
            ok: true,
            args: {
                planPath: '/tmp/provision-plan.json',
                healGolden: false,
            },
        });
        expect(parseWindowsTestProvisionArgs([])).toMatchObject({ok: false});
        expect(parseWindowsTestProvisionArgs([
            '--plan',
            '/tmp/plan.json',
            '--heal-golden',
        ])).toMatchObject({ok: false});
        expect(parseWindowsTestProvisionArgs([
            '--heal-golden',
            '--plan',
            'relative.json',
        ])).toMatchObject({ok: false});
    });
});

describe('windows test CLI exit codes', () => {
    it('maps every run outcome onto its documented exit code', async () => {
        const cases: ReadonlyArray<[TWindowsTestOutcome, number]> = [
            [
                'passed',
                windowsTestExitCodes.passed,
            ],
            [
                'product-failed',
                windowsTestExitCodes.productFailed,
            ],
            [
                'infrastructure-failed',
                windowsTestExitCodes.infrastructureFailed,
            ],
            [
                'unsupported',
                windowsTestExitCodes.unsupported,
            ],
            [
                'canceled',
                windowsTestExitCodes.canceled,
            ],
        ];

        for (const [
            outcome,
            exitCode,
        ] of cases) {
            const recorder = createRecordingIo();
            const observed = await runWindowsTestCli(
                [],
                recorder.io,
                () => Promise.resolve(runReport(outcome, exitCode)),
                {},
            );
            expect(observed).toBe(exitCode);
        }
    });

    it('returns 6 and names the active run when the host lease is busy', async () => {
        const recorder = createRecordingIo();

        const observed = await runWindowsTestCli(
            [],
            recorder.io,
            () => Promise.resolve({
                exitCode: windowsTestExitCodes.busyLease,
                outcome: null,
                runId: null,
                activeRunId: RUN_ID,
                summary: null,
                messages: [`Another Windows test run (${RUN_ID}) already holds the host lease.`],
            }),
            {},
        );

        expect(observed).toBe(6);
        expect(recorder.out.join('\n')).toContain(RUN_ID);
    });

    it('prints the build identity before any guest work and lists uncovered obligations', async () => {
        const recorder = createRecordingIo();

        await runWindowsTestCli(
            [
                '--suite',
                'all',
            ],
            recorder.io,
            (options) => {
                options.onIdentity?.({
                    runnerVersion: '2026-09-04.1',
                    appVersion: '3.4.5',
                    sourceSha: 'b'.repeat(40),
                    artifactFileName: 'EVBViewer-Setup.exe',
                    artifactSha256: 'a'.repeat(64),
                    imageId: 'win11-arm64-2026-09',
                    environment: 'win11-arm64',
                });
                return Promise.resolve(runReport('passed', 0));
            },
            {},
        );

        expect(recorder.out[0]).toContain('Windows lane runner 2026-09-04.1 testing version 3.4.5');
        expect(recorder.out[1]).toContain(`sha256 ${'a'.repeat(64)}`);
        expect(recorder.out.join('\n')).toContain('Uncovered obligations (1): WIN-PRINT-09');
        expect(recorder.out.join('\n')).toContain('Passed 1,');
    });

    it('prints the stored summary as JSON on request', async () => {
        const recorder = createRecordingIo();

        await runWindowsTestCli(
            ['--json'],
            recorder.io,
            () => Promise.resolve(runReport('passed', 0)),
            {},
        );

        expect(JSON.parse(recorder.out.at(-1) ?? '')).toMatchObject({runId: RUN_ID});
    });

    it('returns 1 on a usage error and on a crashing executor', async () => {
        const usage = createRecordingIo();
        const crash = createRecordingIo();

        expect(await runWindowsTestCli(
            ['--nope'],
            usage.io,
            () => Promise.resolve(runReport('passed', 0)),
            {},
        )).toBe(1);
        expect(usage.err.join('\n')).toContain(WINDOWS_TEST_CLI_USAGE);
        expect(await runWindowsTestCli(
            [],
            crash.io,
            () => Promise.reject(new Error('utmctl is not installed')),
            {},
        )).toBe(1);
        expect(crash.err.join('\n')).toContain('utmctl is not installed');
    });

    it('prints usage and returns 0 for --help on every CLI', async () => {
        const recorder = createRecordingIo();

        expect(await runWindowsTestCli(
            ['--help'],
            recorder.io,
            () => Promise.reject(new Error('never executed')),
            {},
        )).toBe(0);
        expect(await runWindowsTestDoctorCli(
            ['--help'],
            recorder.io,
            () => Promise.reject(new Error('never executed')),
            {},
        )).toBe(0);
        expect(await runWindowsTestReportCli(['--help'], recorder.io, {})).toBe(0);
        expect(await runWindowsTestStopCli(
            ['--help'],
            recorder.io,
            () => Promise.reject(new Error('never executed')),
            {},
        )).toBe(0);
        expect(await runWindowsTestProvisionCli(
            ['--help'],
            recorder.io,
            {healGolden: () => Promise.reject(new Error('never executed'))},
        )).toBe(0);
        expect(recorder.out.join('\n')).toContain(WINDOWS_TEST_PROVISION_USAGE);
    });

    it('runs the headless mode through the host callback and keeps failures secret-free', async () => {
        const success = createRecordingIo();
        let observedDataRoot: string | null = null;
        expect(await runWindowsTestProvisionCli(
            [
                '--heal-golden',
                '--data-root',
                '/tmp/windows-tests',
                '--json',
            ],
            success.io,
            {healGolden: async options => {
                observedDataRoot = options.dataRoot;
                return {
                    alreadyProvisioned: false,
                    evidencePath: '/tmp/windows-tests/provisioning/redacted.json',
                };
            }},
        )).toBe(0);
        expect(observedDataRoot).toBe('/tmp/windows-tests');
        expect(JSON.parse(success.out[0] ?? '')).toEqual({
            alreadyProvisioned: false,
            evidencePath: '/tmp/windows-tests/provisioning/redacted.json',
        });

        const failure = createRecordingIo();
        expect(await runWindowsTestProvisionCli(
            ['--heal-golden'],
            failure.io,
            {healGolden: () => Promise.reject(new Error('transport detail is suppressed'))},
        )).toBe(windowsTestExitCodes.infrastructureFailed);
        expect(failure.err.join('\n')).not.toContain('transport detail');
    });

    it('returns 0 for a healthy doctor report and 3 for a failing one', async () => {
        const healthy = createRecordingIo();
        const failing = createRecordingIo();

        expect(await runWindowsTestDoctorCli([], healthy.io, () => Promise.resolve({
            ok: true,
            checks: [{
                id: 'utmctl-present',
                ok: true,
                detail: 'utmctl reported version 4.7.5.',
                remedy: 'No action needed.',
            }],
        }), {})).toBe(0);
        expect(await runWindowsTestDoctorCli([], failing.io, () => Promise.resolve({
            ok: false,
            checks: [{
                id: 'automation-consent',
                ok: false,
                detail: 'utmctl list failed.',
                remedy: 'Grant Automation access to UTM.',
            }],
        }), {})).toBe(3);
        expect(failing.out.join('\n')).toContain('FAIL automation-consent');
        expect(failing.out.join('\n')).toContain('Remedy: Grant Automation access to UTM.');
        expect(healthy.out.at(-1)).toBe('The Windows test host is ready.');
    });

    it('formats a doctor report line per check', () => {
        const lines = formatWindowsTestDoctorReport({
            ok: false,
            checks: [
                {
                    id: 'gui-session',
                    ok: true,
                    detail: 'launchctl managername reported Aqua.',
                    remedy: 'No action needed.',
                },
                {
                    id: 'golden-image-stopped',
                    ok: false,
                    detail: 'The golden image reports status "started".',
                    remedy: 'Stop the golden image.',
                },
            ],
        });

        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain('ok   gui-session');
        expect(lines[2]).toContain('not ready');
    });

    it('reads a recorded summary through the report CLI and its data root override', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-windows-cli-'));
        const layout = windowsTestHostLayout(root);
        const runLayout = windowsTestRunLayout(layout.runsDir, RUN_ID);
        await mkdir(runLayout.runDir, {recursive: true});
        await writeFile(runLayout.summaryFile, `${JSON.stringify(summary(), null, 4)}\n`, 'utf8');
        const viaFlag = createRecordingIo();
        const viaEnv = createRecordingIo();

        expect(await runWindowsTestReportCli([
            '--data-root',
            root,
        ], viaFlag.io, {})).toBe(0);
        expect(await runWindowsTestReportCli([], viaEnv.io, {[WINDOWS_TEST_DATA_ROOT_ENV]: root})).toBe(0);
        expect(viaFlag.out.join('\n')).toContain(`Run ${RUN_ID}`);
        expect(viaEnv.out.join('\n')).toContain('Human review obligation: no');
        expect(await runWindowsTestReportCli([
            '--data-root',
            path.join(root, 'empty'),
        ], createRecordingIo().io, {})).toBe(1);
    });

    it('requires --run before asking the host to stop a run', async () => {
        const recorder = createRecordingIo();
        const executed: string[] = [];

        expect(await runWindowsTestStopCli(
            [],
            recorder.io,
            () => Promise.reject(new Error('never executed')),
            {},
        )).toBe(1);
        expect(recorder.err.join('\n')).toContain('--run <run id> is required.');
        expect(await runWindowsTestStopCli(
            [
                '--run',
                RUN_ID,
            ],
            recorder.io,
            (options) => {
                executed.push(options.runId);
                return Promise.resolve({
                    exitCode: windowsTestExitCodes.passed,
                    messages: [`Wrote a cancel request for run ${options.runId}.`],
                    recovered: false,
                });
            },
            {},
        )).toBe(0);
        expect(executed).toEqual([RUN_ID]);
        expect(recorder.out.join('\n')).toContain(`Wrote a cancel request for run ${RUN_ID}.`);
    });

    it('writes CLI output through the process streams rather than console', () => {
        const io = createProcessCliIo();
        const written: string[] = [];
        const originalOut = process.stdout.write.bind(process.stdout);
        const originalErr = process.stderr.write.bind(process.stderr);
        process.stdout.write = ((chunk: string) => {
            written.push(`out:${chunk}`);
            return true;
        }) as typeof process.stdout.write;
        process.stderr.write = ((chunk: string) => {
            written.push(`err:${chunk}`);
            return true;
        }) as typeof process.stderr.write;
        try {
            io.write('hello');
            io.writeError('boom');
        } finally {
            process.stdout.write = originalOut;
            process.stderr.write = originalErr;
        }

        expect(written).toEqual([
            'out:hello\n',
            'err:boom\n',
        ]);
    });
});
