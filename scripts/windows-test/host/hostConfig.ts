import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';
import {
    WINDOWS_TEST_SCHEMA_VERSION,
    isSha256Hex,
    isVmUuid,
    windowsTestArchitectures,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { TWindowsTestArchitecture } from '@scripts/windows-test/contracts/windowsTestContracts';

export interface IWindowsTestCandidate {
    artifactPath: string;
    sha256: string;
    fileName: string;
    version: string;
    sourceSha: string;
    appArch: TWindowsTestArchitecture;
}

export interface IWindowsTestRetentionPolicy {
    passDays: number;
    failureDays: number;
    maxFailedClones: number;
    minFreeBytes: number;
}

export interface IWindowsTestHostConfig {
    schemaVersion: typeof WINDOWS_TEST_SCHEMA_VERSION;
    testImageRoot: string;
    allowedTestVmIds: string[];
    goldenImageId: string;
    goldenVmId: string;
    personalVmIdsDenied: string[];
    candidate: IWindowsTestCandidate | null;
    environment: string;
    qualifiedLaunchers: string[];
    retention: IWindowsTestRetentionPolicy;
}

export const windowsTestConfigErrorKinds = [
    'config-missing',
    'config-unreadable',
    'config-malformed',
    'config-invalid',
] as const;

export type TWindowsTestConfigErrorKind = typeof windowsTestConfigErrorKinds[number];

export class WindowsTestConfigError extends Error {
    readonly kind: TWindowsTestConfigErrorKind;

    readonly configFile: string;

    readonly field: string | null;

    constructor(options: {
        kind: TWindowsTestConfigErrorKind;
        configFile: string;
        field?: string | null;
        message: string;
    }) {
        super(options.message);
        this.name = 'WindowsTestConfigError';
        this.kind = options.kind;
        this.configFile = options.configFile;
        this.field = options.field ?? null;
    }
}

function fail(
    configFile: string,
    field: string,
    detail: string,
    kind: TWindowsTestConfigErrorKind = 'config-invalid',
): never {
    throw new WindowsTestConfigError({
        kind,
        configFile,
        field,
        message: `Windows test host config ${configFile} field "${field}" ${detail}.`,
    });
}

function requireNonEmptyString(
    record: Record<string, unknown>,
    configFile: string,
    field: string,
    reportedField: string = field,
) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
        fail(configFile, reportedField, 'must be a non-empty string');
    }
    return value;
}

function requireAbsolutePath(
    record: Record<string, unknown>,
    configFile: string,
    field: string,
    reportedField: string = field,
) {
    const value = requireNonEmptyString(record, configFile, field, reportedField);
    if (!path.isAbsolute(value)) {
        fail(configFile, reportedField, 'must be an absolute path');
    }
    return path.normalize(value);
}

function requireVmUuidArray(record: Record<string, unknown>, configFile: string, field: string) {
    const value = record[field];
    if (!isStringArray(value)) {
        fail(configFile, field, 'must be an array of VM UUID strings');
    }
    const invalid = value.filter(entry => !isVmUuid(entry));
    if (invalid.length > 0) {
        fail(configFile, field, `contains values that are not VM UUIDs: ${invalid.join(', ')}`);
    }
    return value.map(entry => entry.toLowerCase());
}

function requireOptionalVmUuidArray(record: Record<string, unknown>, configFile: string, field: string) {
    if (record[field] === undefined) {
        return [];
    }
    return requireVmUuidArray(record, configFile, field);
}

function requireNonNegativeInteger(
    record: Record<string, unknown>,
    configFile: string,
    field: string,
    reportedField: string = field,
) {
    const value = record[field];
    if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0) {
        fail(configFile, reportedField, 'must be a non-negative integer');
    }
    return value;
}

function parseRetention(value: unknown, configFile: string): IWindowsTestRetentionPolicy {
    if (!isRecord(value)) {
        fail(configFile, 'retention', 'must be an object');
    }
    return {
        passDays: requireNonNegativeInteger(value, configFile, 'passDays', 'retention.passDays'),
        failureDays: requireNonNegativeInteger(value, configFile, 'failureDays', 'retention.failureDays'),
        maxFailedClones: requireNonNegativeInteger(value, configFile, 'maxFailedClones', 'retention.maxFailedClones'),
        minFreeBytes: requireNonNegativeInteger(value, configFile, 'minFreeBytes', 'retention.minFreeBytes'),
    };
}

function parseCandidate(value: unknown, configFile: string): IWindowsTestCandidate | null {
    if (value === null || value === undefined) {
        return null;
    }
    if (!isRecord(value)) {
        fail(configFile, 'candidate', 'must be an object or null');
    }
    const sha256 = requireNonEmptyString(value, configFile, 'sha256', 'candidate.sha256');
    if (!isSha256Hex(sha256)) {
        fail(configFile, 'candidate.sha256', 'must be a lowercase 64-character sha256 hex digest');
    }
    const appArch = value.appArch;
    if (!isOneOf(windowsTestArchitectures, appArch)) {
        fail(configFile, 'candidate.appArch', `must be one of ${windowsTestArchitectures.join(', ')}`);
    }
    return {
        artifactPath: requireAbsolutePath(value, configFile, 'artifactPath', 'candidate.artifactPath'),
        sha256,
        fileName: requireNonEmptyString(value, configFile, 'fileName', 'candidate.fileName'),
        version: requireNonEmptyString(value, configFile, 'version', 'candidate.version'),
        sourceSha: requireNonEmptyString(value, configFile, 'sourceSha', 'candidate.sourceSha'),
        appArch,
    };
}

export function parseWindowsTestHostConfig(value: unknown, configFile: string): IWindowsTestHostConfig {
    if (!isRecord(value)) {
        throw new WindowsTestConfigError({
            kind: 'config-malformed',
            configFile,
            message: `Windows test host config ${configFile} must contain a JSON object.`,
        });
    }
    if (value.schemaVersion !== WINDOWS_TEST_SCHEMA_VERSION) {
        fail(configFile, 'schemaVersion', `must equal ${WINDOWS_TEST_SCHEMA_VERSION}`);
    }
    const testImageRoot = requireAbsolutePath(value, configFile, 'testImageRoot');
    const allowedTestVmIds = requireVmUuidArray(value, configFile, 'allowedTestVmIds');
    const goldenVmId = requireNonEmptyString(value, configFile, 'goldenVmId');
    if (!isVmUuid(goldenVmId)) {
        fail(configFile, 'goldenVmId', 'must be a VM UUID');
    }
    if (allowedTestVmIds.includes(goldenVmId.toLowerCase())) {
        fail(configFile, 'allowedTestVmIds', 'must not include the golden image');
    }
    const personalVmIdsDenied = requireOptionalVmUuidArray(value, configFile, 'personalVmIdsDenied');
    const qualifiedLaunchers = value.qualifiedLaunchers;
    if (!isStringArray(qualifiedLaunchers)) {
        fail(configFile, 'qualifiedLaunchers', 'must be an array of qualified launcher paths; leave it empty until consent is verified');
    }
    const deniedGolden = personalVmIdsDenied.includes(goldenVmId.toLowerCase());
    if (deniedGolden) {
        fail(configFile, 'goldenVmId', 'must not also appear in personalVmIdsDenied');
    }
    const deniedAllowlisted = allowedTestVmIds.filter(vmId => personalVmIdsDenied.includes(vmId));
    if (deniedAllowlisted.length > 0) {
        fail(configFile, 'allowedTestVmIds', 'must not list denied personal VM UUIDs');
    }

    return {
        schemaVersion: WINDOWS_TEST_SCHEMA_VERSION,
        testImageRoot,
        allowedTestVmIds,
        goldenImageId: requireNonEmptyString(value, configFile, 'goldenImageId'),
        goldenVmId: goldenVmId.toLowerCase(),
        personalVmIdsDenied,
        candidate: parseCandidate(value.candidate, configFile),
        environment: requireNonEmptyString(value, configFile, 'environment'),
        qualifiedLaunchers,
        retention: parseRetention(value.retention, configFile),
    };
}

export function describeMissingWindowsTestConfig(configFile: string) {
    return [
        `Windows test host config not found at ${configFile}.`,
        'Follow docs/contributing/windows-tests/setup-and-repair.md to configure a separate lab image. --artifact supplies an installer only and cannot replace host setup.',
    ].join(' ');
}

export async function loadWindowsTestHostConfig(configFile: string): Promise<IWindowsTestHostConfig> {
    let raw: string;
    try {
        raw = await readFile(configFile, 'utf8');
    } catch (error) {
        const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
        throw new WindowsTestConfigError({
            kind: code === 'ENOENT' ? 'config-missing' : 'config-unreadable',
            configFile,
            message: code === 'ENOENT'
                ? describeMissingWindowsTestConfig(configFile)
                : `Windows test host config ${configFile} could not be read: ${String(error)}.`,
        });
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new WindowsTestConfigError({
            kind: 'config-malformed',
            configFile,
            message: `Windows test host config ${configFile} is not valid JSON: ${String(error)}.`,
        });
    }

    return parseWindowsTestHostConfig(parsed, configFile);
}
