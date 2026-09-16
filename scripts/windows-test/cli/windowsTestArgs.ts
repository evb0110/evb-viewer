import { getErrorMessage } from '@contracts/getErrorMessage';
import path from 'node:path';
import { isOneOf } from '@contracts/runtimeGuards';
import {
    isWindowsTestId,
    isWindowsTestRunId,
    windowsTestSuites,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';

export const WINDOWS_TEST_CLI_USAGE = [
    'Usage: pnpm windows:test [options]',
    '',
    '  --suite <smoke|critical|all>  Suite to execute (default: smoke).',
    '  --artifact <absolute path>    Windows candidate installer to stage into the guest.',
    '  --environment <id>            Qualified image environment (default: the configured environment).',
    '  --tests WIN-A-01,WIN-B-02     Restrict the run to specific registered case IDs.',
    '  --data-root <absolute path>   Override the Windows test data root.',
    '  --json                        Print the machine-readable run summary.',
    '  --help                        Print this message.',
    '',
    'Exit codes: 0 passed, 1 usage or crash, 2 product failed, 3 infrastructure failed,',
    '4 unsupported, 5 canceled, 6 another run holds the host lease.',
].join('\n');

export const WINDOWS_TEST_DOCTOR_USAGE = [
    'Usage: pnpm windows:test:doctor [options]',
    '',
    '  --data-root <absolute path>   Override the Windows test data root.',
    '  --json                        Print the machine-readable check list.',
    '  --help                        Print this message.',
    '',
    'Exit codes: 0 every check passed, 1 usage, 3 at least one check failed.',
].join('\n');

export const WINDOWS_TEST_REPORT_USAGE = [
    'Usage: pnpm windows:test:report [options]',
    '',
    '  --run <run id>                Run to report (default: the most recent run).',
    '  --data-root <absolute path>   Override the Windows test data root.',
    '  --json                        Print the stored summary as JSON.',
    '  --help                        Print this message.',
    '',
    'Exit codes: 0 summary found, 1 usage or no readable summary.',
].join('\n');

export const WINDOWS_TEST_STOP_USAGE = [
    'Usage: pnpm windows:test:stop --run <run id> [options]',
    '',
    '  --run <run id>                Run to cancel (required).',
    '  --reason <text>               Reason recorded with the cancel request.',
    '  --data-root <absolute path>   Override the Windows test data root.',
    '  --help                        Print this message.',
    '',
    'Exit codes: 0 cancel requested, 1 usage, 3 stale-owner recovery failed.',
].join('\n');

export const WINDOWS_TEST_PROVISION_USAGE = [
    'Usage: pnpm windows:test:provision (--plan <absolute path> | --heal-golden) [options]',
    '',
    '  --plan <absolute path>        Run the existing native-input provision plan.',
    '  --heal-golden                 Headlessly provision the configured golden image through the guest agent.',
    '  --data-root <absolute path>   Override the Windows test data root.',
    '  --json                        Print a machine-readable result.',
    '  --help                        Print this message.',
    '',
    'The --heal-golden path never sends native keyboard or mouse input and generates its local test-account secret itself.',
].join('\n');

export interface IWindowsTestRunArgs {
    suite: TWindowsTestSuite;
    artifact: string | null;
    environment: string | null;
    tests: string[] | null;
    dataRoot: string | null;
    json: boolean;
    help: boolean;
}

export interface IWindowsTestDoctorArgs {
    dataRoot: string | null;
    json: boolean;
    help: boolean;
}

export interface IWindowsTestReportArgs {
    runId: string | null;
    dataRoot: string | null;
    json: boolean;
    help: boolean;
}

export interface IWindowsTestStopArgs {
    runId: string | null;
    reason: string;
    dataRoot: string | null;
    json: boolean;
    help: boolean;
}

export interface IWindowsTestProvisionArgs {
    planPath: string | null;
    healGolden: boolean;
    dataRoot: string | null;
    json: boolean;
    help: boolean;
}

export type TWindowsTestArgsParse<T> =
    | {
        ok: true;
        args: T;
    }
    | {
        ok: false;
        error: string;
    };

function failure<T>(error: string): TWindowsTestArgsParse<T> {
    return {
        ok: false,
        error,
    };
}

interface IRawArgs {
    flags: Set<string>;
    values: Map<string, string>;
}

function readRawArgs(argv: readonly string[], valueFlags: readonly string[], booleanFlags: readonly string[]) {
    const flags = new Set<string>();
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === undefined) {
            continue;
        }
        if (booleanFlags.includes(token)) {
            flags.add(token);
            continue;
        }
        if (valueFlags.includes(token)) {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) {
                return `Flag ${token} needs a value.`;
            }
            values.set(token, value);
            index += 1;
            continue;
        }
        return `Unrecognized argument "${token}".`;
    }
    return {
        flags,
        values,
    };
}

function readDataRoot(raw: IRawArgs) {
    const dataRoot = raw.values.get('--data-root');
    if (dataRoot === undefined) {
        return null;
    }
    return path.isAbsolute(dataRoot) ? dataRoot : new Error(`--data-root must be an absolute path, received "${dataRoot}".`);
}

function readRunScope(raw: IRawArgs) {
    const dataRoot = readDataRoot(raw);
    if (dataRoot instanceof Error) {
        return dataRoot;
    }
    const runId = raw.values.get('--run') ?? null;
    if (runId !== null && !isWindowsTestRunId(runId)) {
        return new Error(`--run must be a run ID such as 20260904T120000Z-0123456789ab, received ${JSON.stringify(runId)}.`);
    }
    return {
        dataRoot,
        runId,
    };
}

export function parseWindowsTestArgs(argv: readonly string[]): TWindowsTestArgsParse<IWindowsTestRunArgs> {
    const raw = readRawArgs(
        argv,
        [
            '--suite',
            '--artifact',
            '--environment',
            '--tests',
            '--data-root',
        ],
        [
            '--json',
            '--help',
        ],
    );
    if (typeof raw === 'string') {
        return failure(raw);
    }
    const dataRoot = readDataRoot(raw);
    if (dataRoot instanceof Error) {
        return failure(getErrorMessage(dataRoot));
    }
    const suite = raw.values.get('--suite') ?? 'smoke';
    if (!isOneOf(windowsTestSuites, suite)) {
        return failure(`--suite must be one of ${windowsTestSuites.join(', ')}, received "${suite}".`);
    }
    const artifact = raw.values.get('--artifact') ?? null;
    if (artifact !== null && !path.isAbsolute(artifact)) {
        return failure(`--artifact must be an absolute path, received "${artifact}".`);
    }
    const testsValue = raw.values.get('--tests');
    let tests: string[] | null = null;
    if (testsValue !== undefined) {
        tests = testsValue
            .split(',')
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0);
        const invalid = tests.filter(entry => !isWindowsTestId(entry));
        if (tests.length === 0 || invalid.length > 0) {
            return failure(`--tests must list case IDs such as WIN-SAVE-01; rejected "${invalid.join(', ')}".`);
        }
    }
    return {
        ok: true,
        args: {
            suite,
            artifact,
            environment: raw.values.get('--environment') ?? null,
            tests,
            dataRoot,
            json: raw.flags.has('--json'),
            help: raw.flags.has('--help'),
        },
    };
}

export function parseWindowsTestDoctorArgs(argv: readonly string[]): TWindowsTestArgsParse<IWindowsTestDoctorArgs> {
    const raw = readRawArgs(argv, ['--data-root'], [
        '--json',
        '--help',
    ]);
    if (typeof raw === 'string') {
        return failure(raw);
    }
    const dataRoot = readDataRoot(raw);
    if (dataRoot instanceof Error) {
        return failure(getErrorMessage(dataRoot));
    }
    return {
        ok: true,
        args: {
            dataRoot,
            json: raw.flags.has('--json'),
            help: raw.flags.has('--help'),
        },
    };
}

export function parseWindowsTestReportArgs(argv: readonly string[]): TWindowsTestArgsParse<IWindowsTestReportArgs> {
    const raw = readRawArgs(
        argv,
        [
            '--run',
            '--data-root',
        ],
        [
            '--json',
            '--help',
        ],
    );
    if (typeof raw === 'string') {
        return failure(raw);
    }
    const scope = readRunScope(raw);
    if (scope instanceof Error) {
        return failure(getErrorMessage(scope));
    }
    const {
        dataRoot,
        runId,
    } = scope;
    return {
        ok: true,
        args: {
            runId,
            dataRoot,
            json: raw.flags.has('--json'),
            help: raw.flags.has('--help'),
        },
    };
}

export function parseWindowsTestStopArgs(argv: readonly string[]): TWindowsTestArgsParse<IWindowsTestStopArgs> {
    const raw = readRawArgs(
        argv,
        [
            '--run',
            '--reason',
            '--data-root',
        ],
        [
            '--json',
            '--help',
        ],
    );
    if (typeof raw === 'string') {
        return failure(raw);
    }
    const scope = readRunScope(raw);
    if (scope instanceof Error) {
        return failure(getErrorMessage(scope));
    }
    const {
        dataRoot,
        runId,
    } = scope;
    return {
        ok: true,
        args: {
            runId,
            reason: raw.values.get('--reason') ?? 'Canceled from the command line.',
            dataRoot,
            json: raw.flags.has('--json'),
            help: raw.flags.has('--help'),
        },
    };
}

export function parseWindowsTestProvisionArgs(argv: readonly string[]): TWindowsTestArgsParse<IWindowsTestProvisionArgs> {
    const raw = readRawArgs(
        argv,
        [
            '--plan',
            '--data-root',
        ],
        [
            '--heal-golden',
            '--json',
            '--help',
        ],
    );
    if (typeof raw === 'string') {
        return failure(raw);
    }
    const dataRoot = readDataRoot(raw);
    if (dataRoot instanceof Error) {
        return failure(getErrorMessage(dataRoot));
    }
    const planPath = raw.values.get('--plan') ?? null;
    if (planPath !== null && !path.isAbsolute(planPath)) {
        return failure(`--plan must be an absolute path, received "${planPath}".`);
    }
    const healGolden = raw.flags.has('--heal-golden');
    if (planPath === null && !healGolden && !raw.flags.has('--help')) {
        return failure('Choose exactly one provisioning mode: --plan or --heal-golden.');
    }
    if (planPath !== null && healGolden) {
        return failure('--plan and --heal-golden cannot be used together.');
    }
    return {
        ok: true,
        args: {
            planPath,
            healGolden,
            dataRoot,
            json: raw.flags.has('--json'),
            help: raw.flags.has('--help'),
        },
    };
}
