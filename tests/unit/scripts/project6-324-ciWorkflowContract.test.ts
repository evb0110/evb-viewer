/* eslint-disable custom/file-naming -- The task contract fixes this filename. */

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getStaticYAMLValue,
    parseYAML,
} from 'yaml-eslint-parser';

interface IWorkflowStep {
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, unknown>;
}

interface IWorkflowJob { steps?: IWorkflowStep[] }

const ciSetupJobs = [
    'pr_quality',
    'pr_electron_blocking_smoke',
    'pr_electron_native_save_reopen',
    'pr_native_pdf_integration',
    'pr_browser_integration',
    'pr_native_build_safety',
    'pr_scan_cleanup_heavy',
    'pr_rust_tests_arm64',
    'pr_scan_cleanup_oracles',
    'pr_landing_quality',
    'nuxt_compatibility_v5',
    'manual_quality',
    'manual_landing',
    'nightly_maintenance',
    'nightly_electron_e2e_regression',
    'nightly_electron_e2e_save_pipeline',
    'nightly_electron_e2e_rapid_navigation',
    'nightly_electron_e2e_large_pdf',
    'nightly_electron_e2e_quarantine',
    'nightly_electron_e2e_visible_window',
    'nightly_pdf_tabs_diagnostics',
] as const;

const allCiJobs = [
    'commit_attribution',
    ...ciSetupJobs,
    'pr_packaged_linux',
    'pr_changed_areas',
    'gates_ok',
    'nightly_rust_fuzz',
].sort();

const electronVerificationOptIns = [
    'pr_electron_blocking_smoke',
    'nightly_electron_e2e_regression',
    'nightly_electron_e2e_save_pipeline',
    'nightly_electron_e2e_rapid_navigation',
    'nightly_electron_e2e_large_pdf',
    'nightly_electron_e2e_quarantine',
    'nightly_electron_e2e_visible_window',
    'nightly_pdf_tabs_diagnostics',
].sort();

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}

function parseWorkflowJobs(source: string) {
    const parsed = getStaticYAMLValue(parseYAML(source)) as {jobs?: Record<string, IWorkflowJob>};
    return parsed.jobs ?? {};
}

describe('Project 6 #324 CI workflow contract', () => {
    it('keeps one shared setup owner for every dependency-installing CI job', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const jobs = parseWorkflowJobs(workflow);
        expect(Object.keys(jobs).sort()).toEqual(allCiJobs);

        for (const jobName of ciSetupJobs) {
            const steps = jobs[jobName]?.steps ?? [];
            const setupSteps = steps.filter(step => step.uses === './.github/actions/setup-ci-env');
            expect(setupSteps, jobName).toHaveLength(1);
            expect(steps.some(step => step.uses?.startsWith('pnpm/action-setup@')), jobName).toBe(false);
            expect(steps.some(step => step.uses?.startsWith('actions/setup-node@')), jobName).toBe(false);
            expect(steps.some(step => step.run === 'node scripts/ci-install-dependencies.mjs --frozen-lockfile'), jobName)
                .toBe(false);
        }

        expect(jobs.pr_changed_areas?.steps?.some(step => step.uses?.startsWith('actions/setup-node@'))).toBe(true);
    });

    it('keeps Electron verification explicit for every Electron lane', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const jobs = parseWorkflowJobs(workflow);
        const actualOptIns = ciSetupJobs.filter(jobName => {
            const setupStep = (jobs[jobName]?.steps ?? []).find(step => step.uses === './.github/actions/setup-ci-env');
            return setupStep?.with?.['verify-electron'] === 'true';
        }).sort();
        expect(actualOptIns).toEqual(electronVerificationOptIns);

        for (const jobName of electronVerificationOptIns) {
            const setupStep = (jobs[jobName]?.steps ?? []).find(step => step.uses === './.github/actions/setup-ci-env');
            expect(setupStep?.with?.['verify-electron'], jobName).toBe('true');
        }

        const blockingSteps = jobs.pr_electron_blocking_smoke?.steps ?? [];
        const cacheIndex = blockingSteps.findIndex(step => step.name === 'Restore staged Electron native binaries');
        const smokeIndex = blockingSteps.findIndex(step => step.name === 'Electron blocking core-PDF smoke');
        expect(cacheIndex).toBeGreaterThanOrEqual(0);
        expect(smokeIndex).toBeGreaterThan(cacheIndex);
        expect(blockingSteps.some(step => step.name === 'Verify Electron install')).toBe(false);
    });

    it('defines the shared action without changing the frozen install contract', async () => {
        const action = await readProjectFile('.github/actions/setup-ci-env/action.yml');

        expect(action).toContain('uses: pnpm/action-setup@fc06bc1257f339d1d5d8b3a19a8cae5388b55320');
        expect(action).toContain('uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38');
        expect(action).toContain('cache: pnpm');
        expect(action).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(action).toContain('if: inputs.verify-electron == \'true\'');
        expect(action).toContain('default: \'false\'');
        expect(action).toContain('using: composite');
        expect(action.match(/shell: bash/gu) ?? []).toHaveLength(2);
    });
});
