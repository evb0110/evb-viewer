import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { TWindowsTestSuite } from '@scripts/windows-test/contracts/windowsTestContracts';
import {
    loadCapabilityRegistry,
    resolveSuite,
    type IWindowsCapabilityEnvironment,
    type IWindowsCapabilityRegistry,
} from '@scripts/windows-test/registry/capabilityRegistry';

export const HUMAN_REVIEW_ORACLE_ID = 'human-review';

export interface IWindowsTestSuiteSelection {
    tests: string[];
    uncoveredObligations: string[];
    humanReviewObligations: string[];
    hostDisplayRequired: boolean;
}

export interface IWindowsTestSuiteResolver {
    resolveSuite(suite: TWindowsTestSuite, environment: string): Promise<IWindowsTestSuiteSelection>;
    resolveEnvironment?(environment: string): Promise<IWindowsCapabilityEnvironment | null>;
}

export interface IFixtureManifestSource {sha256(): Promise<string>;}

// A case that lists the human-review oracle produces evidence only a person can
// judge, so the run carries that obligation next to, never inside, the
// automated outcome (invariant I8). Only cases that will execute can produce
// such evidence; planned or out-of-environment cases stay uncovered instead.
export function selectWindowsTestSuite(
    registry: IWindowsCapabilityRegistry,
    suite: TWindowsTestSuite,
    environment: string,
): IWindowsTestSuiteSelection {
    const resolution = resolveSuite(registry, suite, environment);
    const executing = new Set(resolution.tests);
    const humanReviewObligations = registry.cases
        .filter(entry => executing.has(entry.id) && entry.oracles.includes(HUMAN_REVIEW_ORACLE_ID))
        .map(entry => entry.id);
    return {
        tests: [...resolution.tests],
        uncoveredObligations: [...resolution.uncoveredObligations],
        humanReviewObligations,
        hostDisplayRequired: resolution.hostDisplayRequired,
    };
}

export function createCapabilityFileSuiteResolver(registryPath: string): IWindowsTestSuiteResolver {
    const load = async () => {
        let registry: IWindowsCapabilityRegistry;
        try {
            registry = await loadCapabilityRegistry(registryPath);
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                throw new Error(`Windows capability registry ${registryPath} is missing; run the host from a full repository checkout.`);
            }
            throw error;
        }
        return registry;
    };
    return {
        resolveSuite: async (suite, environment) => {
            const registry = await load();
            return selectWindowsTestSuite(registry, suite, environment);
        },
        resolveEnvironment: async environment => {
            const registry = await load();
            return registry.environments.find(entry => entry.id === environment) ?? null;
        },
    };
}

export function createFileFixtureManifestSource(manifestPath: string): IFixtureManifestSource {
    return {sha256: async () => {
        const bytes = await readFile(manifestPath).catch(() => {
            throw new Error(`Windows test fixture manifest ${manifestPath} is missing; stage the fixture cache before running the suite.`);
        });
        return createHash('sha256').update(bytes).digest('hex');
    }};
}
