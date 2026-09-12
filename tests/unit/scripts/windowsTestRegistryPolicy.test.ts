import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import {
    collectFixturePackIds,
    loadFixtureManifest,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import { windowsOracleIds } from '@scripts/windows-test/oracles/oracleRegistry';
import { registeredCaseIds } from '@scripts/windows-test/guest/cases/caseRegistry';
import type { IWindowsCapabilityRegistry } from '@scripts/windows-test/registry/capabilityRegistry';
import {
    assertRegistryTestIds,
    collectRegistryFixtureIds,
    collectRegistryOracleIds,
    loadCapabilityRegistry,
    resolveSuite,
} from '@scripts/windows-test/registry/capabilityRegistry';
import {
    formatRegistryLintProblems,
    lintCapabilityRegistry,
} from '@scripts/windows-test/registry/registryLint';

const repositoryRoot = process.cwd();

const registryPath = path.join(repositoryRoot, 'tests', 'windows', 'capabilities.json');

const manifestPath = path.join(repositoryRoot, 'tests', 'windows', 'fixtures', 'manifest.json');

const planPath = path.join(
    repositoryRoot,
    'docs',
    'internal',
    'research',
    'utm-windows-autotest-plan-2026-09-04.md',
);

const ledgerPath = path.join(
    repositoryRoot,
    'docs',
    'internal',
    'research',
    'utm-windows-autotest-implementation-ledger-2026-09-04.md',
);

/**
 * The nine critical-suite rows of the implementation ledger, which the
 * registry, the plan, and the guest case registry must all agree on.
 */
const LEDGER_CRITICAL_CASE_IDS = [
    'WIN-SAVE-01',
    'WIN-SAVE-02',
    'WIN-SAVE-04',
    'WIN-SAVE-08',
    'WIN-PRINT-01',
    'WIN-PRINT-02',
    'WIN-PRINT-07',
    'WIN-UI-02',
    'WIN-TOOLS-01',
];

const PRIMARY_ENVIRONMENT = 'utm-win11-arm64-app-arm64';

function extractTestIds(markdown: string) {
    const ids: string[] = [];
    for (const line of markdown.split('\n')) {
        const match = /^\|\s*(WIN-[A-Z]+-\d{2})\s*\|/u.exec(line);
        if (match?.[1] !== undefined) {
            ids.push(match[1]);
        }
    }
    return ids;
}

let registry: IWindowsCapabilityRegistry;
let knownFixtureIds: string[];
const implementedCaseIds = registeredCaseIds();

beforeAll(async () => {
    registry = await loadCapabilityRegistry(registryPath);
    knownFixtureIds = collectFixturePackIds(await loadFixtureManifest(manifestPath));
});

describe('tests/windows/capabilities.json', () => {
    it('passes the registry lint with the real fixture and oracle IDs', () => {
        const result = lintCapabilityRegistry(registry, {
            knownFixtureIds,
            knownOracleIds: windowsOracleIds,
            implementedCaseIds,
        });
        expect(formatRegistryLintProblems(result)).toEqual([]);
        expect(result.ok).toBe(true);
    });

    it('names an implementation source for every implemented case', () => {
        const implemented = registry.cases
            .filter(entry => entry.status === 'implemented')
            .map(entry => entry.id);
        expect(implemented.filter(caseId => !implementedCaseIds.includes(caseId))).toEqual([]);
    });

    it('uses only well-formed test IDs and no duplicates', () => {
        expect(assertRegistryTestIds(registry)).toEqual([]);
        const ids = registry.cases.map(entry => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('references only fixture packs and oracles that exist', () => {
        for (const fixtureId of collectRegistryFixtureIds(registry)) {
            expect(knownFixtureIds, fixtureId).toContain(fixtureId);
        }
        for (const oracleId of collectRegistryOracleIds(registry)) {
            expect(windowsOracleIds, oracleId).toContain(oracleId);
        }
    });

    it('declares the four environments the host runner expects', () => {
        expect(registry.environments.map(environment => environment.id)).toEqual([
            PRIMARY_ENVIRONMENT,
            'utm-win11-arm64-app-x64',
            'hosted-win-x64-native',
            'physical-win-x64',
        ]);
        expect(registry.environments.filter(environment => environment.primary)).toHaveLength(1);
    });

    it('keeps every gate advisory until the lane has earned a required gate', () => {
        expect(registry.cases.filter(entry => entry.gate === 'required')).toEqual([]);
    });

    it('distinguishes automated, manual and hardware obligations', () => {
        const obligations = new Set(registry.cases.map(entry => entry.obligation));
        expect([...obligations].sort()).toEqual([
            'automated',
            'hardware',
            'manual',
        ]);
        for (const capabilityCase of registry.cases) {
            if (capabilityCase.obligation !== 'hardware') {
                continue;
            }
            expect(
                capabilityCase.environments.every(id => id !== PRIMARY_ENVIRONMENT),
                capabilityCase.id,
            ).toBe(true);
        }
    });
});

describe('the critical suite', () => {
    it('marks exactly the nine ledger cases implemented and critical', () => {
        const critical = registry.cases
            .filter(entry => entry.suites.includes('critical'))
            .map(entry => entry.id);
        expect(critical.sort()).toEqual([...LEDGER_CRITICAL_CASE_IDS].sort());
        for (const caseId of LEDGER_CRITICAL_CASE_IDS) {
            const capabilityCase = registry.cases.find(entry => entry.id === caseId);
            expect(capabilityCase, caseId).toBeDefined();
            expect(capabilityCase?.status, caseId).toBe('implemented');
            expect(capabilityCase?.gate, caseId).toBe('advisory');
        }
    });

    it('puts the two smoke cases in the smoke suite', () => {
        const smoke = registry.cases
            .filter(entry => entry.suites.includes('smoke'))
            .map(entry => entry.id)
            .sort();
        expect(smoke).toEqual([
            'WIN-PRINT-01',
            'WIN-SAVE-01',
        ]);
    });

    it('resolves to the nine cases on the primary environment', () => {
        const resolution = resolveSuite(registry, 'critical', PRIMARY_ENVIRONMENT);
        expect(resolution.tests.sort()).toEqual([...LEDGER_CRITICAL_CASE_IDS].sort());
        expect(resolution.uncoveredObligations).toEqual([]);
    });
});

describe('catalogue completeness', () => {
    it('contains every case ID the plan catalogue lists', async () => {
        const plan = await readFile(planPath, 'utf8');
        const planIds = extractTestIds(plan);
        expect(planIds.length).toBe(75);
        expect(new Set(planIds).size).toBe(planIds.length);
        const registryIds = new Set(registry.cases.map(entry => entry.id));
        expect(planIds.filter(id => !registryIds.has(id))).toEqual([]);
        expect(registry.cases.filter(entry => !planIds.includes(entry.id))).toEqual([]);
    });

    it('contains every case ID the ledger critical suite table lists', async () => {
        const ledger = await readFile(ledgerPath, 'utf8');
        const ledgerIds = extractTestIds(ledger);
        expect(ledgerIds.sort()).toEqual([...LEDGER_CRITICAL_CASE_IDS].sort());
        const registryIds = new Set(registry.cases.map(entry => entry.id));
        for (const caseId of ledgerIds) {
            expect(registryIds.has(caseId), caseId).toBe(true);
        }
    });

    it('assigns every case to one of the seven plan families', () => {
        const families = new Set(registry.cases.map(entry => entry.family));
        expect([...families].sort()).toEqual([
            'Filesystem and paths',
            'Input, display and accessibility',
            'Installation, shell and application lifecycle',
            'PDF, native tools and conversion',
            'Printing',
            'Resources, security and network behavior',
            'Saving, editing, identity and recovery',
        ]);
    });
});
