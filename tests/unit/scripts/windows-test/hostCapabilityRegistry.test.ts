import { createHash } from 'node:crypto';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    HUMAN_REVIEW_ORACLE_ID,
    createCapabilityFileSuiteResolver,
    createFileFixtureManifestSource,
    selectWindowsTestSuite,
} from '@scripts/windows-test/host/capabilityRegistry';
import type {
    IWindowsCapabilityCase,
    IWindowsCapabilityRegistry,
} from '@scripts/windows-test/registry/capabilityRegistry';
import { loadCapabilityRegistry } from '@scripts/windows-test/registry/capabilityRegistry';

const PRIMARY_ENVIRONMENT = 'utm-win11-arm64-app-arm64';
const OTHER_ENVIRONMENT = 'hosted-win-x64-native';
const REAL_REGISTRY_PATH = path.join(process.cwd(), 'tests', 'windows', 'capabilities.json');

const temporaryDirectories: string[] = [];

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, {
            recursive: true,
            force: true,
        });
    }
});

async function scratchDirectory() {
    const directory = await mkdtemp(path.join(tmpdir(), 'evb-windows-host-registry-'));
    temporaryDirectories.push(directory);
    return directory;
}

function runnableCase(id: string, overrides: Partial<IWindowsCapabilityCase> = {}): IWindowsCapabilityCase {
    return {
        id,
        family: 'Printing',
        title: `Case ${id}`,
        driver: 'WIN',
        priority: 'P0',
        obligation: 'automated',
        status: 'implemented',
        gate: 'advisory',
        suites: ['smoke'],
        primaryEnvironment: PRIMARY_ENVIRONMENT,
        environments: [PRIMARY_ENVIRONMENT],
        fixtures: ['F01'],
        oracles: ['page-count'],
        negativeControl: 'A blank page fails the oracle.',
        owner: 'windows-lane',
        quarantine: null,
        ...overrides,
    };
}

function registryOf(cases: IWindowsCapabilityCase[]): IWindowsCapabilityRegistry {
    return {
        schemaVersion: 1,
        environments: [
            {
                id: PRIMARY_ENVIRONMENT,
                osArch: 'arm64',
                appArch: 'arm64',
                kind: 'utm',
                primary: true,
            },
            {
                id: OTHER_ENVIRONMENT,
                osArch: 'x64',
                appArch: 'x64',
                kind: 'hosted-ci',
                primary: false,
            },
        ],
        cases,
    };
}

describe('selectWindowsTestSuite', () => {
    it('lists a human review obligation only for cases that will execute', () => {
        const registry = registryOf([
            runnableCase('WIN-PRINT-01', {oracles: [
                'page-count',
                HUMAN_REVIEW_ORACLE_ID,
            ]}),
            runnableCase('WIN-PRINT-02'),
            runnableCase('WIN-PRINT-03', {
                status: 'planned',
                oracles: [HUMAN_REVIEW_ORACLE_ID],
            }),
            runnableCase('WIN-PRINT-04', {
                environments: [OTHER_ENVIRONMENT],
                oracles: [HUMAN_REVIEW_ORACLE_ID],
            }),
            runnableCase('WIN-SAVE-01', {suites: ['critical']}),
        ]);

        const selection = selectWindowsTestSuite(registry, 'smoke', PRIMARY_ENVIRONMENT);

        expect(selection.tests).toEqual([
            'WIN-PRINT-01',
            'WIN-PRINT-02',
        ]);
        expect(selection.humanReviewObligations).toEqual(['WIN-PRINT-01']);
        expect(selection.uncoveredObligations).toEqual([
            'WIN-PRINT-03: planned, not implemented, owned by windows-lane',
            `WIN-PRINT-04: not applicable to ${PRIMARY_ENVIRONMENT}, primary environment ${PRIMARY_ENVIRONMENT}`,
        ]);
    });

    it('selects every registered case for the all suite', () => {
        const registry = registryOf([
            runnableCase('WIN-PRINT-01'),
            runnableCase('WIN-SAVE-01', {suites: ['critical']}),
        ]);

        const selection = selectWindowsTestSuite(registry, 'all', PRIMARY_ENVIRONMENT);

        expect(selection.tests).toEqual([
            'WIN-PRINT-01',
            'WIN-SAVE-01',
        ]);
        expect(selection.uncoveredObligations).toEqual([]);
        expect(selection.humanReviewObligations).toEqual([]);
    });
});

describe('createCapabilityFileSuiteResolver', () => {
    it('resolves the committed registry with the host-side parser', async () => {
        const resolver = createCapabilityFileSuiteResolver(REAL_REGISTRY_PATH);
        const registry = await loadCapabilityRegistry(REAL_REGISTRY_PATH);
        const byId = new Map(registry.cases.map(entry => [
            entry.id,
            entry,
        ]));

        const selection = await resolver.resolveSuite('smoke', PRIMARY_ENVIRONMENT);

        expect(selection.tests).toContain('WIN-PRINT-01');
        expect(selection.tests).toContain('WIN-SAVE-10');
        expect(selection.tests.length).toBeGreaterThan(0);
        for (const testId of selection.tests) {
            const entry = byId.get(testId);
            expect(entry?.status).toBe('implemented');
            expect(entry?.obligation).toBe('automated');
            expect(entry?.environments).toContain(PRIMARY_ENVIRONMENT);
        }
        expect(byId.get('WIN-SAVE-10')?.hostDisplayRequired).toBe(false);
        expect(selection.hostDisplayRequiredByTest?.['WIN-SAVE-10']).toBe(false);
        for (const testId of selection.humanReviewObligations) {
            expect(selection.tests).toContain(testId);
            expect(byId.get(testId)?.oracles).toContain(HUMAN_REVIEW_ORACLE_ID);
        }
        expect(selection.uncoveredObligations).toEqual([]);

        const everything = await resolver.resolveSuite('all', PRIMARY_ENVIRONMENT);

        expect(everything.tests.length).toBeGreaterThan(selection.tests.length);
        expect(everything.uncoveredObligations.length).toBeGreaterThan(0);
        for (const obligation of everything.uncoveredObligations) {
            const [testId] = obligation.split(': ');
            expect(everything.tests).not.toContain(testId);
            expect(byId.has(testId ?? '')).toBe(true);
        }

        await expect(resolver.resolveEnvironment?.(PRIMARY_ENVIRONMENT)).resolves.toMatchObject({
            id: PRIMARY_ENVIRONMENT,
            osArch: 'arm64',
            appArch: 'arm64',
            kind: 'utm',
        });
        await expect(resolver.resolveEnvironment?.('missing-environment')).resolves.toBeNull();
    });

    it('names a missing registry file instead of returning an empty selection', async () => {
        const directory = await scratchDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        const resolver = createCapabilityFileSuiteResolver(registryPath);

        await expect(resolver.resolveSuite('smoke', PRIMARY_ENVIRONMENT))
            .rejects.toThrow(`Windows capability registry ${registryPath} is missing`);
    });

    it('rejects a registry whose environments are bare strings', async () => {
        const directory = await scratchDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        await writeFile(registryPath, JSON.stringify({
            schemaVersion: 1,
            environments: [PRIMARY_ENVIRONMENT],
            cases: [runnableCase('WIN-PRINT-01')],
        }));
        const resolver = createCapabilityFileSuiteResolver(registryPath);

        await expect(resolver.resolveSuite('smoke', PRIMARY_ENVIRONMENT))
            .rejects.toThrow('does not match the expected schema');
    });

    it('reports malformed JSON with the registry path', async () => {
        const directory = await scratchDirectory();
        const registryPath = path.join(directory, 'capabilities.json');
        await writeFile(registryPath, '{not json');
        const resolver = createCapabilityFileSuiteResolver(registryPath);

        await expect(resolver.resolveSuite('smoke', PRIMARY_ENVIRONMENT))
            .rejects.toThrow(`Windows capability registry at ${registryPath} is not valid JSON`);
    });
});

describe('createFileFixtureManifestSource', () => {
    it('hashes the manifest bytes', async () => {
        const directory = await scratchDirectory();
        const manifestPath = path.join(directory, 'manifest.json');
        const bytes = '{"schemaVersion":1,"fixtures":[]}';
        await writeFile(manifestPath, bytes);

        await expect(createFileFixtureManifestSource(manifestPath).sha256())
            .resolves.toBe(createHash('sha256').update(bytes).digest('hex'));
    });

    it('tells the operator to stage the fixture cache when the manifest is missing', async () => {
        const directory = await scratchDirectory();
        const manifestPath = path.join(directory, 'manifest.json');

        await expect(createFileFixtureManifestSource(manifestPath).sha256())
            .rejects.toThrow(`Windows test fixture manifest ${manifestPath} is missing; stage the fixture cache`);
    });
});
