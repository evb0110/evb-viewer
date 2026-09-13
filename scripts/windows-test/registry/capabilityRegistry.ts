import { getErrorMessage } from '@contracts/getErrorMessage';
import { readFile } from 'node:fs/promises';
import {
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import type {
    TWindowsTestArchitecture,
    TWindowsTestCaseStatus,
    TWindowsTestDriver,
    TWindowsTestGatePolicy,
    TWindowsTestOutcome,
    TWindowsTestSuite,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    isWindowsTestId,
    WINDOWS_TEST_SCHEMA_VERSION,
    windowsTestArchitectures,
    windowsTestCaseStatuses,
    windowsTestDrivers,
    windowsTestGatePolicies,
    windowsTestSuites,
} from '@scripts/windows-test/contracts/windowsTestContracts';

export const windowsCapabilityEnvironmentKinds = [
    'utm',
    'hosted-ci',
    'hardware',
] as const;

export type TWindowsCapabilityEnvironmentKind = typeof windowsCapabilityEnvironmentKinds[number];

export const windowsCapabilityObligations = [
    'automated',
    'manual',
    'hardware',
] as const;

export type TWindowsCapabilityObligation = typeof windowsCapabilityObligations[number];

export const windowsCapabilityPriorities = [
    'P0',
    'P1',
    'P2',
] as const;

export type TWindowsCapabilityPriority = typeof windowsCapabilityPriorities[number];

export interface IWindowsCapabilityEnvironment {
    id: string;
    osArch: TWindowsTestArchitecture;
    appArch: TWindowsTestArchitecture;
    kind: TWindowsCapabilityEnvironmentKind;
    primary: boolean;
}

export interface IWindowsCapabilityQuarantine {
    owner: string;
    reason: string;
    expiresAt: string;
    replacementCoverage: string;
}

export interface IWindowsCapabilityCase {
    id: string;
    family: string;
    title: string;
    driver: TWindowsTestDriver;
    priority: TWindowsCapabilityPriority;
    obligation: TWindowsCapabilityObligation;
    status: TWindowsTestCaseStatus;
    gate: TWindowsTestGatePolicy;
    suites: TWindowsTestSuite[];
    primaryEnvironment: string;
    environments: string[];
    fixtures: string[];
    oracles: string[];
    negativeControl: string;
    owner: string;
    quarantine: IWindowsCapabilityQuarantine | null;
    note?: string;
    hostDisplayRequired?: boolean;
}

export interface IWindowsCapabilityRegistry {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    environments: IWindowsCapabilityEnvironment[];
    cases: IWindowsCapabilityCase[];
}

export interface IWindowsSuiteResolution {
    tests: string[];
    uncoveredObligations: string[];
    hostDisplayRequired: boolean;
}

export interface IWindowsCoverageBucket {
    executedPassed: number;
    executedFailed: number;
    notExecuted: number;
    plannedOrDeferred: number;
    applicable: number;
    total: number;
}

export interface IWindowsCoverageReport {
    environmentId: string;
    overall: IWindowsCoverageBucket;
    byFamily: Record<string, IWindowsCoverageBucket>;
    byEnvironment: Record<string, IWindowsCoverageBucket>;
    uncoveredObligations: string[];
}

export interface IWindowsExecutedResult {
    testId: string;
    outcome: TWindowsTestOutcome;
}

function isQuarantine(value: unknown): value is IWindowsCapabilityQuarantine {
    return isRecord(value)
        && typeof value.owner === 'string'
        && typeof value.reason === 'string'
        && typeof value.expiresAt === 'string'
        && typeof value.replacementCoverage === 'string';
}

function isEnvironment(value: unknown): value is IWindowsCapabilityEnvironment {
    return isRecord(value)
        && typeof value.id === 'string'
        && isOneOf(windowsTestArchitectures, value.osArch)
        && isOneOf(windowsTestArchitectures, value.appArch)
        && isOneOf(windowsCapabilityEnvironmentKinds, value.kind)
        && typeof value.primary === 'boolean';
}

function isSuiteList(value: unknown): value is TWindowsTestSuite[] {
    return Array.isArray(value) && value.every(entry => isOneOf(windowsTestSuites, entry));
}

export function isWindowsCapabilityCase(value: unknown): value is IWindowsCapabilityCase {
    return isRecord(value)
        && typeof value.id === 'string'
        && typeof value.family === 'string'
        && typeof value.title === 'string'
        && isOneOf(windowsTestDrivers, value.driver)
        && isOneOf(windowsCapabilityPriorities, value.priority)
        && isOneOf(windowsCapabilityObligations, value.obligation)
        && isOneOf(windowsTestCaseStatuses, value.status)
        && isOneOf(windowsTestGatePolicies, value.gate)
        && isSuiteList(value.suites)
        && typeof value.primaryEnvironment === 'string'
        && isStringArray(value.environments)
        && isStringArray(value.fixtures)
        && isStringArray(value.oracles)
        && typeof value.negativeControl === 'string'
        && typeof value.owner === 'string'
        && (value.quarantine === null || isQuarantine(value.quarantine))
        && (value.note === undefined || typeof value.note === 'string')
        && (value.hostDisplayRequired === undefined || typeof value.hostDisplayRequired === 'boolean');
}

export function isWindowsCapabilityRegistry(value: unknown): value is IWindowsCapabilityRegistry {
    return isRecord(value)
        && value.schemaVersion === WINDOWS_TEST_SCHEMA_VERSION
        && Array.isArray(value.environments)
        && value.environments.every(isEnvironment)
        && Array.isArray(value.cases)
        && value.cases.every(isWindowsCapabilityCase);
}

export async function loadCapabilityRegistry(registryPath: string) {
    const raw = await readFile(registryPath, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const detail = getErrorMessage(error);
        throw new Error(`Windows capability registry at ${registryPath} is not valid JSON: ${detail}`);
    }
    if (!isWindowsCapabilityRegistry(parsed)) {
        throw new Error(`Windows capability registry at ${registryPath} does not match the expected schema.`);
    }
    return parsed;
}

function selectsCase(capabilityCase: IWindowsCapabilityCase, suite: TWindowsTestSuite) {
    return suite === 'all' || capabilityCase.suites.includes(suite);
}

function isRunnableInEnvironment(capabilityCase: IWindowsCapabilityCase, environmentId: string) {
    return capabilityCase.obligation === 'automated'
        && capabilityCase.status === 'implemented'
        && capabilityCase.environments.includes(environmentId);
}

export function describeUncoveredObligation(
    capabilityCase: IWindowsCapabilityCase,
    environmentId: string,
) {
    if (capabilityCase.quarantine !== null) {
        return `quarantined until ${capabilityCase.quarantine.expiresAt}: ${capabilityCase.quarantine.reason}`;
    }
    if (capabilityCase.status === 'not-applicable') {
        return `not applicable: ${capabilityCase.note ?? capabilityCase.negativeControl}`;
    }
    if (capabilityCase.status === 'unsupported-in-environment') {
        return `unsupported in ${environmentId}${capabilityCase.note === undefined ? '' : `: ${capabilityCase.note}`}`;
    }
    if (capabilityCase.obligation === 'hardware') {
        return `hardware obligation owned by ${capabilityCase.owner}, primary environment ${capabilityCase.primaryEnvironment}`;
    }
    if (capabilityCase.obligation === 'manual') {
        return `manual obligation owned by ${capabilityCase.owner}, primary environment ${capabilityCase.primaryEnvironment}`;
    }
    if (!capabilityCase.environments.includes(environmentId)) {
        return `not applicable to ${environmentId}, primary environment ${capabilityCase.primaryEnvironment}`;
    }
    return `planned, not implemented, owned by ${capabilityCase.owner}`;
}

export function resolveSuite(
    registry: IWindowsCapabilityRegistry,
    suite: TWindowsTestSuite,
    environmentId: string,
): IWindowsSuiteResolution {
    const selectedEntries = registry.cases.filter(entry => selectsCase(entry, suite));
    const tests: string[] = [];
    const uncoveredObligations: string[] = [];
    for (const capabilityCase of selectedEntries) {
        if (isRunnableInEnvironment(capabilityCase, environmentId)) {
            tests.push(capabilityCase.id);
            continue;
        }
        uncoveredObligations.push(
            `${capabilityCase.id}: ${describeUncoveredObligation(capabilityCase, environmentId)}`,
        );
    }
    const runnable = new Set(tests);
    return {
        tests,
        uncoveredObligations,
        hostDisplayRequired: selectedEntries.some(entry => runnable.has(entry.id) && entry.hostDisplayRequired !== false),
    };
}

function createBucket(): IWindowsCoverageBucket {
    return {
        executedPassed: 0,
        executedFailed: 0,
        notExecuted: 0,
        plannedOrDeferred: 0,
        applicable: 0,
        total: 0,
    };
}

function readBucket(buckets: Record<string, IWindowsCoverageBucket>, key: string) {
    const existing = buckets[key];
    if (existing !== undefined) {
        return existing;
    }
    const created = createBucket();
    buckets[key] = created;
    return created;
}

function countCase(
    bucket: IWindowsCoverageBucket,
    capabilityCase: IWindowsCapabilityCase,
    environmentId: string,
    outcomes: Map<string, TWindowsTestOutcome>,
) {
    bucket.total += 1;
    if (!isRunnableInEnvironment(capabilityCase, environmentId)) {
        // I8: planned, manual, hardware and out-of-environment obligations are
        // never part of the passed numerator and never part of the applicable
        // denominator either, so a coverage percent cannot absorb them.
        bucket.plannedOrDeferred += 1;
        return;
    }
    bucket.applicable += 1;
    const outcome = outcomes.get(capabilityCase.id);
    if (outcome === undefined) {
        bucket.notExecuted += 1;
        return;
    }
    if (outcome === 'passed') {
        bucket.executedPassed += 1;
        return;
    }
    bucket.executedFailed += 1;
}

export function coverageReport(
    registry: IWindowsCapabilityRegistry,
    environmentId: string,
    executedResults: readonly IWindowsExecutedResult[],
): IWindowsCoverageReport {
    const outcomes = new Map(executedResults.map(result => [
        result.testId,
        result.outcome,
    ]));
    const overall = createBucket();
    const byFamily: Record<string, IWindowsCoverageBucket> = {};
    const byEnvironment: Record<string, IWindowsCoverageBucket> = {};
    for (const environment of registry.environments) {
        readBucket(byEnvironment, environment.id);
    }
    const uncoveredObligations: string[] = [];
    for (const capabilityCase of registry.cases) {
        countCase(overall, capabilityCase, environmentId, outcomes);
        countCase(readBucket(byFamily, capabilityCase.family), capabilityCase, environmentId, outcomes);
        for (const environment of registry.environments) {
            countCase(readBucket(byEnvironment, environment.id), capabilityCase, environment.id, outcomes);
        }
        if (!isRunnableInEnvironment(capabilityCase, environmentId)) {
            uncoveredObligations.push(
                `${capabilityCase.id}: ${describeUncoveredObligation(capabilityCase, environmentId)}`,
            );
        }
    }
    return {
        environmentId,
        overall,
        byFamily,
        byEnvironment,
        uncoveredObligations,
    };
}

export function findCapabilityCase(registry: IWindowsCapabilityRegistry, caseId: string) {
    return registry.cases.find(entry => entry.id === caseId) ?? null;
}

export function collectRegistryFixtureIds(registry: IWindowsCapabilityRegistry) {
    return [...new Set(registry.cases.flatMap(entry => entry.fixtures))].sort();
}

export function collectRegistryOracleIds(registry: IWindowsCapabilityRegistry) {
    return [...new Set(registry.cases.flatMap(entry => entry.oracles))].sort();
}

export function assertRegistryTestIds(registry: IWindowsCapabilityRegistry) {
    return registry.cases.filter(entry => !isWindowsTestId(entry.id)).map(entry => entry.id);
}
