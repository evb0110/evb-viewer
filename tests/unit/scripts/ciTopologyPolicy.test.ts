import {isRecord} from '@contracts/runtimeGuards';
import {spawnSync} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    readFile,
    readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getStaticYAMLValue,
    parseYAML,
} from 'yaml-eslint-parser';
import type {
    SetRequired,
    Simplify,
    TsConfigJson,
} from 'type-fest';

type TTsConfigJsonWithGlobs = Simplify<SetRequired<TsConfigJson, 'exclude' | 'include'>>;

interface IWorkflowStep {
    'continue-on-error'?: boolean;
    env?: Record<string, unknown>;
    id?: string;
    if?: string;
    name?: string;
    run?: string;
    uses?: string;
}

interface IWorkflowJob {
    'continue-on-error'?: boolean;
    if?: string;
    needs?: string | string[];
    secrets?: Record<string, unknown>;
    steps?: IWorkflowStep[];
    uses?: string;
    with?: Record<string, unknown>;
}

interface IPackageJson { scripts: Record<string, string> }

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}


function parseTsConfigJsonWithGlobs(source: string, label: string): TTsConfigJsonWithGlobs {
    const parsed = JSON.parse(source) as unknown;

    if (!isRecord(parsed)) {
        throw new Error(`${label} must be a JSON object.`);
    }

    const tsConfig = parsed as TsConfigJson;
    for (const key of [
        'exclude',
        'include',
    ] as const) {
        if (!Array.isArray(tsConfig[key]) || !tsConfig[key].every(item => typeof item === 'string')) {
            throw new Error(`${label} must contain a ${key} array.`);
        }
    }

    return tsConfig as TTsConfigJsonWithGlobs;
}

async function readTsConfigJsonWithGlobs(filePath: string) {
    return parseTsConfigJsonWithGlobs(await readProjectFile(filePath), filePath);
}

function workflowJob(workflow: string, jobName: string) {
    const jobsStart = workflow.indexOf('\njobs:\n');
    const start = workflow.indexOf(`  ${jobName}:\n`, Math.max(0, jobsStart));
    if (start === -1) {
        throw new Error(`Missing workflow job: ${jobName}`);
    }

    const nextJob = workflow.slice(start + 1).search(/\n {2}[a-z0-9_]+:\n/u);
    return nextJob === -1
        ? workflow.slice(start)
        : workflow.slice(start, start + 1 + nextJob);
}

function shellFunction(source: string, functionName: string) {
    const start = source.indexOf(`${functionName}() {\n`);
    if (start === -1) {
        throw new Error(`Missing shell function: ${functionName}`);
    }
    const nextFunction = source.slice(start + 1).search(/\n[a-z][a-z0-9_]*\(\) \{\n/u);
    return nextFunction === -1
        ? source.slice(start)
        : source.slice(start, start + 1 + nextFunction);
}

function parseWorkflowJobs(workflow: string) {
    const parsed = getStaticYAMLValue(parseYAML(workflow)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.jobs)) {
        throw new Error('The CI workflow must contain a jobs mapping.');
    }

    const jobs: Record<string, IWorkflowJob> = {};
    for (const [
        jobName,
        value,
    ] of Object.entries(parsed.jobs)) {
        if (!isRecord(value)) {
            throw new Error(`The CI workflow job ${jobName} must be a mapping.`);
        }
        jobs[jobName] = value as IWorkflowJob;
    }
    return jobs;
}

function parseWorkflowTriggers(workflow: string) {
    const parsed = getStaticYAMLValue(parseYAML(workflow)) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.on)) {
        throw new Error('The CI workflow must contain an event mapping.');
    }
    return parsed.on;
}

function expectAcyclicNeedsGraph(workflow: string, label: string) {
    const jobs = parseWorkflowJobs(workflow);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (jobName: string) => {
        expect(jobs[jobName], `${label}: missing job ${jobName}`).toBeDefined();
        if (visited.has(jobName)) {
            return;
        }
        expect(visiting.has(jobName), `${label}: needs graph contains a cycle at ${jobName}`).toBe(false);
        visiting.add(jobName);
        const needs = jobs[jobName]?.needs;
        const dependencies = needs === undefined
            ? []
            : Array.isArray(needs) ? needs : [needs];
        for (const dependency of dependencies) {
            visit(dependency);
        }
        visiting.delete(jobName);
        visited.add(jobName);
    };

    for (const jobName of Object.keys(jobs)) {
        visit(jobName);
    }
}

function expectScriptJobsHaveCheckout(workflow: string, label: string) {
    const jobs = parseWorkflowJobs(workflow);
    for (const [
        jobName,
        job,
    ] of Object.entries(jobs)) {
        const steps = job.steps ?? [];
        const scriptIndex = steps.findIndex(step => (step.run ?? '').includes('scripts/'));
        if (scriptIndex === -1) {
            continue;
        }
        const checkoutIndex = steps.findIndex(step => step.uses?.startsWith('actions/checkout@'));
        expect(checkoutIndex, `${label}: ${jobName} runs a script without checkout`).toBeGreaterThanOrEqual(0);
        expect(checkoutIndex, `${label}: ${jobName} checks out after running a script`).toBeLessThan(scriptIndex);
    }
}

const requiredPrPushConditions = new Set([
    '${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.electron_smoke == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.packaged_smoke == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.electron_save_reopen == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.browser_integration == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.native_or_build == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.scan_cleanup_export == \'true\' }}',
    '${{ (github.event_name == \'pull_request\' || github.event_name == \'push\') && needs.pr_changed_areas.outputs.landing == \'true\' }}',
    '${{ always() && (github.event_name == \'pull_request\' || github.event_name == \'push\') }}',
]);

const supportedNonPrPushConditions = new Set([ '${{ github.event_name == \'workflow_dispatch\' }}' ]);

interface INativePdfSavePolicyModule {
    getCiChangedAreaPolicy: () => Record<string, {paths: string[]}>;
    getNativePdfSaveDependencyPaths: () => string[];
}

const {
    getCiChangedAreaPolicy,
    getNativePdfSaveDependencyPaths,
} = await import(
    pathToFileURL(path.resolve(process.cwd(), 'scripts/release/policy.mjs')).href,
) as INativePdfSavePolicyModule;

function requiredPrPushJobs(jobs: Record<string, IWorkflowJob>) {
    const requiredJobs = new Set<string>();
    for (const [
        jobName,
        job,
    ] of Object.entries(jobs)) {
        if (job['continue-on-error'] === true) {
            continue;
        }
        if (job.if === undefined || (
            !requiredPrPushConditions.has(job.if)
            && !supportedNonPrPushConditions.has(job.if)
        )) {
            throw new Error(`Unsupported event condition for non-advisory job ${jobName}: ${job.if ?? '<missing>'}`);
        }
        if (jobName !== 'gates_ok' && requiredPrPushConditions.has(job.if)) {
            requiredJobs.add(jobName);
        }
    }
    return requiredJobs;
}

function escapeRegExp(source: string) {
    return source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expectNoExactRunStep(job: string, command: string) {
    expect(job).not.toMatch(new RegExp(`run: ${escapeRegExp(command)}(?:\\s|$)`, 'u'));
}

// Compares what a step runs rather than how the YAML reads: a trailing
// comment is enough to slip a forbidden command past a substring check.
function runCommandLines(step: IWorkflowStep) {
    return (step.run ?? '')
        .split('\n')
        .map(line => line.replace(/#.*$/u, '').trim())
        .filter(Boolean);
}

function expectExactRunStep(job: string, command: string) {
    expect(job).toMatch(new RegExp(`^[\\t ]*run:[\\t ]*${escapeRegExp(command)}[\\t ]*$`, 'mu'));
}

function expectRunSteps(job: string, commands: string[]) {
    for (const command of commands) {
        expect(job).toContain(`run: ${command}`);
    }
}

function expectManualQualitySteps(job: string, commands: string[]) {
    expect(job).not.toContain('run: pnpm run validate');
    expectNoExactRunStep(job, 'pnpm run test:unit');
    expectNoExactRunStep(job, 'pnpm run build:strict');
    expectRunSteps(job, commands);
}

async function collectTestFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nestedFiles: string[][] = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            return collectTestFiles(entryPath);
        }

        return entry.isFile() && entry.name.endsWith('.test.ts')
            ? [entryPath]
            : [];
    }));

    return nestedFiles.flat();
}

interface IAffectedOracleScenario {
    classifierExit?: number;
    nativeChanged: boolean;
    nativeOutputPresent?: boolean;
    scanCleanupChanged: boolean;
    scanCleanupOutputPresent?: boolean;
    supportsTypeStripping?: boolean;
}

function runAffectedOracleBranch({
    classifierExit = 0,
    nativeChanged,
    nativeOutputPresent = true,
    scanCleanupChanged,
    scanCleanupOutputPresent = true,
    supportsTypeStripping = true,
}: IAffectedOracleScenario) {
    const workdir = mkdtempSync(path.join(tmpdir(), 'scan-cleanup-affected-'));
    try {
        const binDirectory = path.join(workdir, 'bin');
        const callsPath = path.join(workdir, 'calls.log');
        const harnessPath = path.join(workdir, 'scan-cleanup-oracles-harness.sh');
        mkdirSync(binDirectory, {recursive: true});

        writeFileSync(path.join(binDirectory, 'git'), [
            '#!/bin/sh',
            'case "$*" in',
            '  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") printf \'%s\\n\' origin/main ;;',
            '  rev-parse\\ --verify*) exit 0 ;;',
            '  *) exit 9 ;;',
            'esac',
            '',
        ].join('\n'), {mode: 0o755});
        writeFileSync(path.join(binDirectory, 'node'), [
            '#!/bin/sh',
            'case "$*" in',
            '  *classify-changed-areas.mjs*)',
            '    [ "$EVB_TEST_CLASSIFIER_EXIT" -eq 0 ] || exit "$EVB_TEST_CLASSIFIER_EXIT"',
            '    [ "$EVB_TEST_SCAN_OUTPUT" = true ] && printf \'scan_cleanup_export=%s\\n\' "$EVB_TEST_SCAN_CHANGED" >> "$GITHUB_OUTPUT"',
            '    [ "$EVB_TEST_NATIVE_OUTPUT" = true ] && printf \'native_or_build=%s\\n\' "$EVB_TEST_NATIVE_CHANGED" >> "$GITHUB_OUTPUT"',
            '    exit 0',
            '    ;;',
            '  *) exit 9 ;;',
            'esac',
            '',
        ].join('\n'), {mode: 0o755});

        const source = readFileSync(
            path.resolve(process.cwd(), 'scripts/ci/scan-cleanup-oracles.sh'),
            'utf8',
        );
        const caseMarker = 'case "$mode" in\n';
        const recorders = [
            'record_call() { printf \'%s\\n\' "$1" >> "$EVB_TEST_CALLS"; }',
            'run_catastrophe_oracle() { record_call catastrophe-oracle; }',
            'build_scan_cleanup_tool() { record_call build; }',
            'run_stroke_weight_oracle() { record_call stroke-weight-oracle; }',
            'run_export_oracles() { record_call export-oracles; }',
            'supports_type_stripping() { [ "$EVB_TEST_TYPE_STRIPPING" = true ]; }',
            '',
        ].join('\n');
        expect(source).toContain(caseMarker);
        writeFileSync(harnessPath, source.replace(caseMarker, `${recorders}${caseMarker}`), {mode: 0o755});

        const result = spawnSync('/bin/sh', [
            harnessPath,
            'affected',
            path.join(workdir, 'output'),
            'origin',
        ], {
            cwd: workdir,
            encoding: 'utf8',
            env: {
                ...process.env,
                EVB_TEST_CALLS: callsPath,
                EVB_TEST_CLASSIFIER_EXIT: String(classifierExit),
                EVB_TEST_NATIVE_CHANGED: String(nativeChanged),
                EVB_TEST_NATIVE_OUTPUT: String(nativeOutputPresent),
                EVB_TEST_SCAN_CHANGED: String(scanCleanupChanged),
                EVB_TEST_SCAN_OUTPUT: String(scanCleanupOutputPresent),
                EVB_TEST_TYPE_STRIPPING: String(supportsTypeStripping),
                PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
            },
        });
        const calls = existsSync(callsPath)
            ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)
            : [];
        return {
            calls,
            status: result.status,
            stderr: result.stderr,
        };
    } finally {
        rmSync(workdir, {
            force: true,
            recursive: true,
        });
    }
}

describe('CI topology policy', () => {
    it('runs hosted push CI for every commit on main without filtering required pull-request checks', async () => {
        const triggers = parseWorkflowTriggers(await readProjectFile('.github/workflows/ci.yml'));
        const push = triggers.push;
        if (!isRecord(push)) {
            throw new Error('The CI push trigger must be a mapping.');
        }

        expect(push.branches).toEqual(['main']);
        // The release cutter trusts only exact-SHA push runs, so no path filter
        // may leave a commit on main without one.
        expect(push.paths).toBeUndefined();
        expect(push['paths-ignore']).toBeUndefined();
        expect(push.schedule).toBeUndefined();

        // GitHub leaves required checks pending when a pull-request workflow is
        // skipped by a path filter, so keep PR triggering unconditional.
        expect(triggers.pull_request).toBeNull();
    });

    it('routes the canonical native-save graph through pressure, reopen, and native lanes', () => {
        const changedAreas = getCiChangedAreaPolicy();
        for (const dependency of getNativePdfSaveDependencyPaths()) {
            expect(changedAreas.electronSmoke?.paths, `${dependency} is missing from pressure smoke`).toContain(dependency);
            expect(changedAreas.nativePdfSave?.paths, `${dependency} is missing from save/reopen`).toContain(dependency);
            expect(changedAreas.nativeOrBuild?.paths, `${dependency} is missing from native integration`).toContain(dependency);
        }
    });

    it('requires every non-advisory PR and push job through gates_ok', async () => {
        const jobs = parseWorkflowJobs(await readProjectFile('.github/workflows/ci.yml'));
        const gatesOk = jobs.gates_ok;
        if (
            !gatesOk
            || !Array.isArray(gatesOk.needs)
            || !gatesOk.needs.every(jobName => typeof jobName === 'string')
        ) {
            throw new Error('gates_ok must declare its required jobs as a needs array.');
        }
        const requiredJobs = requiredPrPushJobs(jobs);

        expect(new Set(gatesOk.needs)).toEqual(requiredJobs);
    });

    it('rejects an unrecognized non-advisory event condition', () => {
        expect(() => requiredPrPushJobs({future_required_job: {if: '${{ github.event_name == \'merge_group\' }}'}}))
            .toThrow('Unsupported event condition for non-advisory job future_required_job');
    });

    it('keeps PR feedback bounded and release workflow checks delegated', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const packageScripts = (JSON.parse(packageJson) as {scripts: Record<string, string>;}).scripts;
        const prQuality = workflowJob(workflow, 'pr_quality');

        expect(workflow).toContain('push:');
        expect(workflow).toContain('branches:');
        expect(workflow).toContain('- main');
        expect(workflow).not.toContain('\n  schedule:');
        expect(workflow).not.toContain('cron:');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('pull_request:');
        expect(workflow).toContain('group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event_name == \'pull_request\' && github.ref || github.run_id }}');
        expect(workflow).toContain('cancel-in-progress: ${{ github.event_name == \'pull_request\' }}');
        expect(workflow).toContain('name: Quality Gates');
        expect(prQuality).toContain('if: ${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}');
        expect(prQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(prQuality).toContain('uses: actions/cache@v5');
        expect(prQuality).toContain('.devkit/cache/lint');
        expect(prQuality).toContain('.devkit/cache/typecheck');
        expect(prQuality).toContain('key: quality-');
        expect(prQuality).not.toContain('restore-keys:');
        expect(workflow).not.toContain('landing/pnpm-lock.yaml');
        expect(workflow).not.toContain('pnpm --dir landing install');
        expect(prQuality).not.toContain('playwright install');
        expect(prQuality).toContain('pnpm run generate:build-artifacts');
        expect(prQuality).toContain('pnpm run copy:pdfjs');
        expect(prQuality).toContain('git diff --exit-code --');
        expect(prQuality).not.toContain('.tmp/generated-electron-builder-resources.yml');
        expect(prQuality).toContain('git ls-files --others --exclude-standard');
        const lintStep = parseWorkflowJobs(workflow).pr_quality?.steps?.find(step => step.name === 'Lint changed sources');
        const lintScript = lintStep?.run ?? '';
        expect(lintStep?.run, 'pr_quality must define its lint control flow').toBeDefined();
        expect(lintScript).toContain('if [ -n "$base_sha" ]');
        expect(lintScript).toContain('git rev-parse --verify "${base_sha}^{commit}"');
        expect(lintScript).toContain('pnpm run lint --changed --base="$base_sha"');
        // The release workflow's quality job is deleted; release-commit push
        // CI is the publication validation authority, so the deploy-source
        // policy and generated/configuration checks run here once.
        expect(prQuality).toContain('run: pnpm run check:static:assets');
        expect(prQuality).toContain('run: pnpm run check:drizzle-schema');
        expect(prQuality).toContain('run: pnpm run check:electron-builder:asar-unpack');
        expect(packageScripts.lint).toBe('node scripts/validation-gates.mjs lint');
        expect(packageScripts['check:tests:as-never']).toBe('pnpm exec tsx scripts/checkTestsAsNever.ts');
        expect(packageScripts['generate:build-artifacts']).toContain('scripts/generateBuildArtifacts.ts');
        expect(packageScripts.prepare).toContain('pnpm run generate:build-artifacts');
        expect(packageJson).not.toContain('check:native-tool-protocols');
        expect(packageJson).not.toContain('check:platform-api-generated');
        expect(packageJson).not.toContain('check:pdfjs-viewer-css');
        expect(packageScripts['check:static:reports']).toContain('reportPlatformManifestConsumers.ts');
        expect(packageScripts['check:static:assets']).toContain('check-web-deploy-source.mjs');
        expect(prQuality).toContain('run: pnpm run typecheck');
        expect(prQuality).toContain('run: pnpm run test:unit');
        expectNoExactRunStep(prQuality, 'pnpm run test:coverage');
        expectNoExactRunStep(prQuality, 'pnpm run check:tests:as-never');
        expectNoExactRunStep(prQuality, 'pnpm run fallow');
        expectNoExactRunStep(prQuality, 'pnpm run fallow:dupes');
        expectNoExactRunStep(prQuality, 'pnpm run check:static:reports');
        expect(prQuality).not.toContain('Scan-cleanup line budget');

        // No dependency audit on the merge-blocking lane. Both audits reject
        // any advisory at any severity and permit no waiver, and an advisory
        // is published on the registry's clock, not the author's: on this lane
        // one upstream publication stopped two release cuts in one afternoon
        // for something no commit introduced. The audit runs daily in
        // dependency-audit.yml and reports through an issue instead, so it
        // stays visible without being invisible-nightly or release-blocking.
        const prQualityCommands = (parseWorkflowJobs(workflow).pr_quality?.steps ?? [])
            .flatMap(step => runCommandLines(step));
        expect(
            prQualityCommands.filter(command => command.startsWith('pnpm run check:production-dependency-audit')),
            'the merge-blocking lane must not run any dependency audit',
        ).toEqual([]);
        const dependencyAuditWorkflow = await readProjectFile('.github/workflows/dependency-audit.yml');
        const dependencyAuditTriggers = parseWorkflowTriggers(dependencyAuditWorkflow);
        expect(dependencyAuditTriggers).toHaveProperty('schedule');
        expect(dependencyAuditTriggers).toHaveProperty('workflow_dispatch');
        expect(dependencyAuditWorkflow).toContain('- cron: \'40 4 * * *\'');
        const dependencyAuditJob = workflowJob(dependencyAuditWorkflow, 'audit');
        expectExactRunStep(dependencyAuditJob, 'pnpm run check:production-dependency-audit:production-only');
        expectExactRunStep(dependencyAuditJob, 'pnpm run check:production-dependency-audit');
        expect(dependencyAuditJob).toContain('issues: write');
        expect(dependencyAuditJob).toContain('label=\'dependency-audit\'');
        expect(dependencyAuditJob).toContain('gh issue create');
        expect(dependencyAuditJob).not.toContain('gh issue close');
        expect(packageScripts['test:unit']).toContain('validation-gates.mjs heavy');
        for (const project of [
            'unit-core',
            'unit-app',
            'unit-electron',
            'unit-scripts',
            'unit-policy',
            'unit-static-architecture',
        ]) {
            expect(packageScripts['test:unit']).toContain(`--project ${project}`);
        }
        expect(packageJson).not.toContain('"test:unit:core"');
        expect(packageJson).not.toContain('"test:unit:app"');
        expect(packageJson).not.toContain('"test:unit:electron"');
        expect(packageJson).not.toContain('"test:unit:scripts"');
        expect(packageJson).not.toContain('"test:unit:policy"');
        expect(prQuality).not.toContain('rustup target add');
        expect(prQuality).not.toContain('run: pnpm run build:strict');
        expect(prQuality).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(prQuality).not.toContain('if: ${{ github.event_name == \'push\' }}');
        expect(prQuality).not.toContain('run: pnpm run test:rust');
        expect(prQuality).not.toContain('run: pnpm run test:e2e');
        expect(prQuality).not.toContain('run: pnpm run test:e2e:electron:large');
        expect(prQuality).not.toContain('run: pnpm run diag:pdf-tabs:ci');
        expect(prQuality).not.toContain('pnpm exec electron-builder');
        const gatesOk = workflowJob(workflow, 'gates_ok');
        expect(gatesOk).toContain('if: ${{ always() && (github.event_name == \'pull_request\' || github.event_name == \'push\') }}');
        expect(gatesOk).not.toContain('nuxt_compatibility_v5');
        expect(gatesOk).not.toContain('gates_ok is not applicable');
        expect(workflow).toContain('name: Manual Quality Gates');
        const manualQuality = workflowJob(workflow, 'manual_quality');
        expect(manualQuality).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(manualQuality).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(manualQuality).toContain('run: pnpm run check:wasm:strict');
        expectManualQualitySteps(manualQuality, [
            'pnpm run lint:clean',
            'pnpm run check:static:assets',
            'pnpm run typecheck:clean',
            'pnpm run build:strict:no-wasm-check',
        ]);
        expectNoExactRunStep(manualQuality, 'pnpm run check:tests:as-never');
        expectNoExactRunStep(manualQuality, 'pnpm run check:static:reports');
        expectNoExactRunStep(manualQuality, 'pnpm run typecheck:coverage');
        expectNoExactRunStep(manualQuality, 'pnpm run fallow');
        expectNoExactRunStep(manualQuality, 'pnpm run fallow:dupes');
        expectNoExactRunStep(manualQuality, 'pnpm run test:coverage');
        expect(manualQuality).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(manualQuality).not.toContain('playwright install');
        expect(manualQuality).not.toContain('Restore validation caches');
        expect(releaseWorkflow).not.toContain('test:coverage');
        expect(packageJson).not.toMatch(/"gate:commit":\s*"[^"]*coverage/u);
    });

    it('falls back to full lint when the push base is missing, zero, or unresolved', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const lintScript = parseWorkflowJobs(workflow).pr_quality?.steps
            ?.find(step => step.name === 'Lint changed sources')?.run;
        expect(lintScript, 'pr_quality must define its lint step').toBeDefined();

        const zeroSha = '0000000000000000000000000000000000000000';
        const scenarios = [
            {
                eventName: 'pull_request',
                gitVerifyExit: 0,
                prBaseSha: 'pull-request-base',
                pushBeforeSha: '',
                expectedCommand: 'run lint --changed --base=pull-request-base',
            },
            {
                eventName: 'push',
                gitVerifyExit: 0,
                prBaseSha: '',
                pushBeforeSha: zeroSha,
                expectedCommand: 'run lint',
            },
            {
                eventName: 'push',
                gitVerifyExit: 0,
                prBaseSha: '',
                pushBeforeSha: '',
                expectedCommand: 'run lint',
            },
            {
                eventName: 'push',
                gitVerifyExit: 1,
                prBaseSha: '',
                pushBeforeSha: 'unresolved-push-base',
                expectedCommand: 'run lint',
            },
        ] as const;

        for (const scenario of scenarios) {
            const workdir = mkdtempSync(path.join(tmpdir(), 'ci-lint-base-'));
            try {
                const binDirectory = path.join(workdir, 'bin');
                const callsPath = path.join(workdir, 'calls.log');
                mkdirSync(binDirectory, {recursive: true});
                writeFileSync(path.join(binDirectory, 'git'), [
                    '#!/bin/sh',
                    'if [ "$1" = rev-parse ] && [ "$2" = --verify ]; then',
                    '  exit "$EVB_TEST_GIT_VERIFY_EXIT"',
                    'fi',
                    'exit 9',
                    '',
                ].join('\n'), {mode: 0o755});
                writeFileSync(path.join(binDirectory, 'pnpm'), [
                    '#!/bin/sh',
                    'printf \'%s\\n\' "$*" >> "$EVB_TEST_CALLS"',
                    '',
                ].join('\n'), {mode: 0o755});

                const result = spawnSync('/bin/sh', [
                    '-c',
                    lintScript ?? '',
                ], {
                    cwd: workdir,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        EVENT_NAME: scenario.eventName,
                        EVB_TEST_CALLS: callsPath,
                        EVB_TEST_GIT_VERIFY_EXIT: String(scenario.gitVerifyExit),
                        PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
                        PR_BASE_SHA: scenario.prBaseSha,
                        PUSH_BEFORE_SHA: scenario.pushBeforeSha,
                    },
                });
                const calls = existsSync(callsPath)
                    ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)
                    : [];
                expect(result.status, `${scenario.eventName} lint control flow failed`).toBe(0);
                expect(calls, `${scenario.eventName} lint command`).toEqual([scenario.expectedCommand]);
            } finally {
                rmSync(workdir, {
                    force: true,
                    recursive: true,
                });
            }
        }
    });

    it('keeps expensive PR and release-push checks path-filtered from checked-in policy', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const jobs = parseWorkflowJobs(workflow);
        const testsTsconfig = await readTsConfigJsonWithGlobs('tests/tsconfig.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('if: ${{ github.event_name == \'pull_request\' || github.event_name == \'push\' }}');
        expect(workflow).toContain('name: Changed Area Detection');
        expect(workflowJob(workflow, 'pr_changed_areas'))
            .toContain('node scripts/ci/classify-changed-areas.mjs --base="$base_sha" --head="$head_sha"');
        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('PUSH_BEFORE_SHA: ${{ github.event.before }}');
        expect(workflowJob(workflow, 'pr_changed_areas')).toContain('fetch-depth: 0');
        expect(workflowJob(workflow, 'pr_changed_areas')).not.toContain('dorny/paths-filter');
        expect(workflowJob(workflow, 'pr_changed_areas')).not.toContain('native/**');
        const electronBlockingSmoke = workflowJob(workflow, 'pr_electron_blocking_smoke');
        expect(electronBlockingSmoke).toContain('needs.pr_changed_areas.outputs.electron_smoke == \'true\'');
        expect(electronBlockingSmoke).toContain('name: Restore staged Electron native binaries');
        expect(electronBlockingSmoke).toContain('.tmp/scan-cleanup');
        expect(electronBlockingSmoke).toContain('.tmp/pdf-page-ops');
        expect(electronBlockingSmoke).toContain('electron-native-v2-');
        expect(electronBlockingSmoke).toContain('run: pnpm run test:e2e:electron:blocking-smoke:headless');
        const nativeSaveReopen = workflowJob(workflow, 'pr_electron_native_save_reopen');
        expect(nativeSaveReopen).toContain('needs.pr_changed_areas.outputs.electron_save_reopen == \'true\'');
        expect(nativeSaveReopen).toContain('run: pnpm run test:e2e:electron:save-pipeline');
        expect(nativeSaveReopen).not.toContain('continue-on-error: true');
        const nativePdfIntegration = workflowJob(workflow, 'pr_native_pdf_integration');
        expect(nativePdfIntegration).toContain('run: pnpm run build:pdf-page-ops');
        expect(nativePdfIntegration).toContain('run: pnpm exec vitest run --project native-integration');
        expect(Object.keys(jobs)).not.toEqual(expect.arrayContaining([
            'pr_xlarge_pdf_acceptance',
            'pr_exact_fixture_save',
        ]));
        const requiredJobs = requiredPrPushJobs(jobs);
        expect(JSON.stringify([...requiredJobs].map(jobName => jobs[jobName]))).not.toMatch(
            /fixture|ovh|cloud\/files|xlarge/iu,
        );
        const parsedJobConfiguration = JSON.stringify(jobs);
        expect(parsedJobConfiguration).not.toMatch(
            /exact-pdf-fixtures|ovh\.net|\/api\/cloud\/files|xlargeZaliznyak2646/iu,
        );
        const manualLargePdfStep = jobs.nightly_electron_e2e_large_pdf?.steps
            ?.find(step => step.run === 'pnpm run test:e2e:electron:large');
        expect(manualLargePdfStep?.env).toEqual({EVB_EXACT_FIXTURE_PROFILE: 'localZaliznyak882'});
        expect(manualLargePdfStep?.env?.EVB_EXACT_FIXTURE_PROFILE).not.toContain('${{');
        const blockingSmokeSource = await readProjectFile('tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts');
        expect(blockingSmokeSource).toContain('createLargeScannedFixturePdf');
        expect(blockingSmokeSource).toContain('blocking pressure annotation');
        expect(blockingSmokeSource).toContain('saveViaWindowHandle');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('needs.pr_changed_areas.outputs.browser_integration == \'true\'');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('run: pnpm run test:integration:browser');
        expect(workflowJob(workflow, 'pr_browser_integration')).toContain('playwright install --with-deps chromium');
        expect(workflowJob(workflow, 'pr_scan_cleanup_oracles')).toContain('needs: pr_changed_areas');
        expect(workflowJob(workflow, 'pr_scan_cleanup_oracles'))
            .toContain('needs.pr_changed_areas.outputs.scan_cleanup_export == \'true\'');
        expect(workflow).toContain('name: Native And Build Safety');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('needs: pr_changed_areas');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('needs.pr_changed_areas.outputs.native_or_build == \'true\'');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run test:rust');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: rustup component add rustfmt clippy');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run lint:rust');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('uses: EmbarkStudios/cargo-deny-action@v2');
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('run: pnpm run build:strict');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run build:strict:no-wasm-check');
        expect(workflowJob(workflow, 'pr_native_build_safety')).not.toContain('run: pnpm run test:e2e');
        expect(workflow).not.toContain('manual_native:');
        expect(workflow).toContain('name: Landing Quality Gates');
        expect(workflow).toContain('name: Landing Quality Gates For Changed Sources');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('needs.pr_changed_areas.outputs.landing == \'true\'');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: node scripts/ci-install-dependencies.mjs --frozen-lockfile');
        expect(workflowJob(workflow, 'pr_landing_quality')).not.toContain('check:vendor');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run lint');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run typecheck');
        expect(workflowJob(workflow, 'pr_landing_quality')).toContain('run: pnpm --dir landing run build');
        expect(workflowJob(workflow, 'pr_landing_quality')).not.toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'manual_landing')).toContain('if: ${{ github.event_name == \'workflow_dispatch\' }}');
        expect(workflowJob(workflow, 'manual_landing')).not.toContain('continue-on-error: true');
        const gatesOk = workflowJob(workflow, 'gates_ok');
        expect(gatesOk).toContain('SCAN_CLEANUP_EXPORT_CHANGED: ${{ needs.pr_changed_areas.outputs.scan_cleanup_export }}');
        expect(gatesOk).toContain('[\'pr_scan_cleanup_oracles\', process.env.SCAN_CLEANUP_EXPORT_CHANGED]');
        expect(sharedVitestConfig).toContain('tests/unit/landing/**/*.test.ts');
        expect(testsTsconfig.exclude).not.toContain('./unit/landing/**/*.ts');
    });

    it('pins scan-cleanup oracle enforcement and Linux arm64 execution', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const oracleScript = await readProjectFile('scripts/ci/scan-cleanup-oracles.sh');
        const prePush = await readProjectFile('.husky/pre-push');
        const packageJson = JSON.parse(await readProjectFile('package.json')) as IPackageJson;
        const catastropheOracle = shellFunction(oracleScript, 'run_catastrophe_oracle');
        const exportOracles = shellFunction(oracleScript, 'run_export_oracles');
        const resolveScanCleanupTool = shellFunction(oracleScript, 'resolve_scan_cleanup_tool');
        const strokeWeightOracle = shellFunction(oracleScript, 'run_stroke_weight_oracle');
        const affectedOracles = shellFunction(oracleScript, 'run_affected_oracles');
        const nativeJob = workflowJob(workflow, 'pr_native_build_safety');
        const arm64Job = workflowJob(workflow, 'pr_rust_tests_arm64');
        const exportJob = workflowJob(workflow, 'pr_scan_cleanup_oracles');

        expect(nativeJob).toContain('run: scripts/ci/scan-cleanup-oracles.sh native');
        expect(catastropheOracle).toContain('--baseline native/scan-cleanup/harness-baseline.json');
        expect(exportJob).toContain('run: scripts/ci/scan-cleanup-oracles.sh export');
        expect(exportOracles).toContain('scan-cleanup-preview-harness.mjs');
        expect(exportOracles).toContain('--check');
        expect(exportOracles).toContain('scan-cleanup-word-loss-audit.mjs');
        expect(exportOracles).toContain('--fail-on text-loss');
        expect(resolveScanCleanupTool).toContain('getRequestedNativeRustTarget');
        expect(resolveScanCleanupTool).toContain('".tmp"');
        expect(strokeWeightOracle).toContain('scan_cleanup_tool=$(resolve_scan_cleanup_tool)');
        expect(strokeWeightOracle).not.toContain('native/target/release/evb-scan-cleanup');
        expect(arm64Job).toContain('runs-on: ubuntu-24.04-arm');
        expect(arm64Job).toContain('run: scripts/ci/apt-install.sh poppler-utils');
        expect(prePush).not.toContain('scripts/ci/scan-cleanup-oracles.sh');
        expect(packageJson.scripts['test:scan-cleanup:affected-oracles'])
            .toBe('scripts/ci/scan-cleanup-oracles.sh affected');
        expect(affectedOracles).toContain('--include-worktree');
        expect(workflow).not.toContain('node scripts/diagnostics/scan-cleanup-preview-harness.mjs');
        expect(prePush).not.toContain('node scripts/diagnostics/scan-cleanup-preview-harness.mjs');
    });

    it.skipIf(process.platform === 'win32')('runs only the affected scan-cleanup oracle groups', () => {
        expect(runAffectedOracleBranch({
            nativeChanged: false,
            scanCleanupChanged: false,
        })).toMatchObject({
            calls: [],
            status: 0,
        });
        expect(runAffectedOracleBranch({
            nativeChanged: true,
            scanCleanupChanged: false,
        })).toMatchObject({
            calls: ['catastrophe-oracle'],
            status: 0,
        });
        expect(runAffectedOracleBranch({
            nativeChanged: false,
            scanCleanupChanged: true,
        })).toMatchObject({
            calls: [
                'build',
                'stroke-weight-oracle',
                'export-oracles',
            ],
            status: 0,
        });
        expect(runAffectedOracleBranch({
            nativeChanged: true,
            scanCleanupChanged: true,
        })).toMatchObject({
            calls: [
                'catastrophe-oracle',
                'build',
                'stroke-weight-oracle',
                'export-oracles',
            ],
            status: 0,
        });
    }, 15_000);

    it.skipIf(process.platform === 'win32')('fails closed when affected-oracle classification is unavailable', () => {
        const classifierFailure = runAffectedOracleBranch({
            classifierExit: 8,
            nativeChanged: false,
            scanCleanupChanged: false,
        });
        expect(classifierFailure).toMatchObject({
            calls: [
                'catastrophe-oracle',
                'build',
                'stroke-weight-oracle',
                'export-oracles',
            ],
            status: 0,
        });
        expect(classifierFailure.stderr).toContain('classification failed');

        const missingOutput = runAffectedOracleBranch({
            nativeChanged: false,
            nativeOutputPresent: false,
            scanCleanupChanged: false,
        });
        expect(missingOutput).toMatchObject({
            calls: [
                'catastrophe-oracle',
                'build',
                'stroke-weight-oracle',
                'export-oracles',
            ],
            status: 0,
        });
        expect(missingOutput.stderr).toContain('expected changed-area outputs missing');
    });

    it.skipIf(process.platform === 'win32')('stops before affected oracles when Node lacks type stripping', () => {
        const result = runAffectedOracleBranch({
            nativeChanged: false,
            scanCleanupChanged: true,
            supportsTypeStripping: false,
        });

        expect(result.calls).toEqual([]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Node >= 22.18');
    });

    it('runs regular packaged-content verification against extracted Store AppX contents', async () => {
        const storeWorkflow = await readProjectFile('.github/workflows/store-appx.yml');
        const buildJob = workflowJob(storeWorkflow, 'build');
        const installedSmokeJob = workflowJob(storeWorkflow, 'installed_smoke');
        const extractIndex = storeWorkflow.indexOf('Get-Command makeappx.exe -ErrorAction SilentlyContinue');
        const nativeVerifyIndex = storeWorkflow.indexOf('bash scripts/verify-packaged-native-tools.sh win');
        const contentsVerifyIndex = storeWorkflow.indexOf('node scripts/release/assert-packaged-app-contents.mjs');

        expect(extractIndex).toBeGreaterThan(-1);
        expect(storeWorkflow).toContain('${env:ProgramFiles(x86)}');
        expect(storeWorkflow).toContain('Windows Kits\\10\\bin');
        expect(storeWorkflow).toContain('needs-msys2: ${{ matrix.arch == \'arm64\' }}');
        expect(storeWorkflow).toContain('Where-Object { $_.FullName -match \'[\\\\/]x64[\\\\/]makeappx\\.exe$\' }');
        expect(storeWorkflow).toContain('& $makeAppxPath unpack /o /p $packages[0].FullName /d $extractDir');
        expect(storeWorkflow).not.toContain('tar.exe -xf $packages[0].FullName');
        expect(nativeVerifyIndex).toBeGreaterThan(extractIndex);
        expect(contentsVerifyIndex).toBeGreaterThan(nativeVerifyIndex);
        expect(storeWorkflow).toContain('".tmp/store-appx-${{ matrix.arch }}"');
        expect(buildJob).not.toContain('Add-AppxPackage -Path $packagePath');
        expect(installedSmokeJob).toContain('needs: build');
        expect(installedSmokeJob).toContain('runs-on: windows-11-arm');
        expect(installedSmokeJob).toContain('arch:\n          - x64\n          - arm64');
        expect(installedSmokeJob).toContain('actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c');
        expect(installedSmokeJob).toContain('name: store-appx-win-${{ matrix.arch }}');
        expect(installedSmokeJob).toContain('Add-AppxPackage -Path $packagePath');
        expect(installedSmokeJob).not.toContain('-PassThru');
        expect(installedSmokeJob).toContain('New-SelfSignedCertificate @certificateParameters');
        expect(installedSmokeJob).toContain('Subject = $publisher');
        expect(installedSmokeJob).toContain('Cert:\\LocalMachine\\TrustedPeople');
        expect(installedSmokeJob).toContain('& $signToolPath sign /fd SHA256 /f $pfxPath /p $pfxPassword $packagePath');
        expect(installedSmokeJob).toContain('$appUserModelId = "$($package.PackageFamilyName)!EVBViewer"');
        expect(installedSmokeJob).toContain('Start-Process -FilePath "shell:AppsFolder\\$appUserModelId"');
        expect(installedSmokeJob).toContain('Remove-AppxPackage -Package');
    });

    it('verifies release build artifacts before upload', async () => {
        const workflow = await readProjectFile('.github/workflows/build-target.yml');
        const coreBuildWorkflow = await readProjectFile('.github/workflows/build.yml');
        const macIntelWorkflow = await readProjectFile('.github/workflows/build-mac-intel.yml');
        const win7Workflow = await readProjectFile('.github/workflows/build-win7-legacy.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const supplementalWorkflow = await readProjectFile('.github/workflows/release-supplemental.yml');
        const macSigningScript = await readProjectFile('scripts/release/configure-macos-signing.sh');
        const macCertificateImportScript = await readProjectFile('scripts/release/import-macos-codesign-certificate.sh');
        const buildJob = workflowJob(workflow, 'build');
        const installedNsisStep = buildJob.slice(
            buildJob.indexOf('- name: Verify installed Windows NSIS journey'),
            buildJob.indexOf('- name: Verify packaged macOS arm64 core PDF journey'),
        );
        const verifyStep = workflow.slice(
            workflow.indexOf('- name: Verify release artifacts'),
            workflow.indexOf('- name: Upload artifacts'),
        );
        const dmgNotarizationStep = workflow.slice(
            workflow.indexOf('- name: Notarize and staple macOS disk images'),
            workflow.indexOf('- name: Verify macOS signature'),
        );

        expect(verifyStep).toContain(
            'node scripts/release/assert-build-artifacts.mjs release "$EVB_RELEASE_TARGET_PLATFORM" "$EVB_RELEASE_TARGET_ARCH"',
        );
        expect(verifyStep).toContain('EVB_RELEASE_HAS_MAC_SIGNING');
        expect(verifyStep).toContain('EVB_RELEASE_HAS_WINDOWS_SIGNING');
        expect(verifyStep).not.toContain('CSC_LINK');
        expect(verifyStep).not.toContain('WIN_CSC_LINK');
        expect(workflow).toContain('value: ${{ jobs.build.outputs.artifact_ready }}');
        expect(buildJob).not.toContain('continue-on-error: ${{ inputs.advisory }}');
        expect(buildJob).toContain('artifact_ready: ${{ steps.artifact_status.outputs.artifact_ready }}');
        expect(buildJob).toContain('if: ${{ always() }}');
        expect(buildJob).toContain(
            'artifact_ready=${{ steps.upload_artifacts.outcome == \'success\' }}',
        );
        expect(dmgNotarizationStep).toContain('bash scripts/release/import-macos-codesign-certificate.sh');
        expect(dmgNotarizationStep).toContain('node scripts/release/notarize-macos-dmgs.mjs release');
        expect(workflow).toContain('::error::Partial WIN_CSC_* secrets detected; set both WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD or neither');
        // One core-PDF proof per shipped artifact: the Linux unpacked-dir
        // smoke duplicated the AppImage proof of the same binary and is gone.
        expect(workflow).not.toContain('name: Verify packaged Linux core PDF journey');
        expect(workflow).not.toContain('find release -type f -path \'*/linux*-unpacked/evb-viewer\'');
        expect(workflow).toContain('if: runner.os == \'Linux\'');
        expect(workflow).toContain('name: Verify packaged Windows core PDF journey');
        expect(workflow).toContain('find release -type f -path \'*/win*-unpacked/EVB Viewer.exe\'');
        expect(workflow).toContain('name: Verify installed Linux AppImage and DEB journeys');
        expect(workflow).not.toContain('TARGET_ARCH=${{ inputs.arch }}');
        expect(workflow).not.toMatch(/run:[^\n]*\$\{\{ inputs\.(?:arch|platform) \}\}/u);
        expect(workflow).toContain('APPIMAGE_EXTRACT_AND_RUN=1 xvfb-run -a');
        expect(workflow).toContain('sudo apt-get install -y "$(realpath "$deb")"');
        expect(workflow).toContain('sudo apt-get remove -y "$package_name"');
        expect(installedNsisStep).toContain('name: Verify installed Windows NSIS journey');
        expect(installedNsisStep).toContain('-ArgumentList \'/S\', "/D=$installDir" -PassThru');
        expect(installedNsisStep).toContain('$appPath = Join-Path $installDir \'EVB Viewer.exe\'');
        expect(installedNsisStep).toContain('(Join-Path $installDir \'d3dcompiler_47.dll\')');
        expect(installedNsisStep).toContain('(Join-Path $installDir \'ffmpeg.dll\')');
        expect(installedNsisStep).toContain('(Join-Path $installDir \'libEGL.dll\')');
        expect(installedNsisStep).toContain('(Join-Path $installDir \'libGLESv2.dll\')');
        const installerStartIndex = installedNsisStep.indexOf('$install = Start-Process');
        const launcherTimeoutIndex = installedNsisStep.indexOf('if (-not $install.WaitForExit(120000))');
        const installerLaunch = installedNsisStep.slice(installerStartIndex, launcherTimeoutIndex);
        const launcherDiagnosticsIndex = installedNsisStep.indexOf('Write-InstallerDiagnostics', launcherTimeoutIndex);
        const launcherStopIndex = installedNsisStep.indexOf('Stop-Process -Id $install.Id', launcherTimeoutIndex);
        const launcherErrorIndex = installedNsisStep.indexOf('NSIS installer launcher did not exit before the deadline.');
        const runtimeTimeoutIndex = installedNsisStep.indexOf('if ($missingRuntimePaths.Count -gt 0)');
        const runtimeDiagnosticsIndex = installedNsisStep.indexOf(
            'Write-InstallerDiagnostics',
            runtimeTimeoutIndex,
        );
        const runtimeErrorIndex = installedNsisStep.indexOf(
            'Installed EVB Viewer runtime did not become ready before the deadline.',
        );
        expect(installedNsisStep.indexOf('$installStartedAt = Get-Date')).toBeLessThan(installerStartIndex);
        expect(installerLaunch).not.toContain('-Wait');
        expect(installerStartIndex).toBeLessThan(launcherTimeoutIndex);
        expect(launcherTimeoutIndex).toBeLessThan(launcherDiagnosticsIndex);
        expect(launcherDiagnosticsIndex).toBeLessThan(launcherStopIndex);
        expect(launcherStopIndex).toBeLessThan(launcherErrorIndex);
        expect(runtimeTimeoutIndex).toBeLessThan(runtimeDiagnosticsIndex);
        expect(runtimeDiagnosticsIndex).toBeLessThan(runtimeErrorIndex);
        expect(launcherErrorIndex).toBeLessThan(
            installedNsisStep.indexOf('if ($install.ExitCode -ne 0)'),
        );
        expect(installedNsisStep).toContain('$installDeadline = $installStartedAt.AddMinutes(15)');
        expect(installedNsisStep).toContain('while ($missingRuntimePaths.Count -gt 0 -and (Get-Date) -lt $installDeadline)');
        expect(installedNsisStep).toContain('NSIS extraction progress:');
        expect(installedNsisStep).toContain(
            'Join-Path $env:RUNNER_TEMP "evb-viewer-nsis-$env:EVB_RELEASE_TARGET_ARCH-',
        );
        expect(installedNsisStep).toContain(
            'throw \'Installed EVB Viewer runtime did not become ready before the deadline.\'',
        );
        expect(installedNsisStep).toContain('Get-Command Get-MpThreatDetection -ErrorAction SilentlyContinue');
        expect(installedNsisStep).toContain('Get-MpThreatDetection -ErrorAction SilentlyContinue');
        expect(installedNsisStep).toContain('Get-CimInstance Win32_Process -ErrorAction SilentlyContinue');
        expect(installedNsisStep).toContain('LogName = \'Microsoft-Windows-Windows Defender/Operational\'');
        expect(installedNsisStep).toContain('$app = Get-Item $appPath');
        expect(installedNsisStep).not.toContain('Get-ChildItem "$env:LOCALAPPDATA\\Programs"');
        expect(installedNsisStep).toContain('$uninstallDeadline = (Get-Date).AddMinutes(3)');
        expect(installedNsisStep).toContain('if (Test-Path $appPath)');
        expect(installedNsisStep).toContain('throw \'NSIS uninstall left the EVB Viewer executable installed.\'');
        expect(workflow).toContain('name: Enforce Linux glibc 2.35 compatibility baseline');
        expect(workflow).toContain('run: node scripts/release/assert-linux-glibc-baseline.mjs release 2.35');
        expect(workflow).toContain('ubuntu@sha256:2edbbc5dc405e9612ba3584ce95480277e3eb374407b5505fe26f17df77c7dbc');
        expect(workflow).toContain('--env EVB_HOST_UID="$(id -u)"');
        expect(workflow).toContain('chown -R "$EVB_HOST_UID:$EVB_HOST_GID" resources');
        for (const privilegedBuildWorkflow of [
            workflow,
            macIntelWorkflow,
            win7Workflow,
        ]) {
            expect(privilegedBuildWorkflow).toContain('persist-credentials: false');
        }
        expect(macIntelWorkflow).toContain('name: Verify packaged macOS Intel core PDF journey');
        expect(win7Workflow).toContain('name: Verify packaged Windows 7 core PDF journey');
        expect(coreBuildWorkflow).not.toContain('windows-11-arm');
        expect(coreBuildWorkflow).toContain('uses: ./.github/workflows/build-target.yml');
        expect(coreBuildWorkflow).toContain('artifact_group: dist-mac-arm64');
        expect(coreBuildWorkflow).toContain('artifact_group: dist-linux-x64');
        expect(coreBuildWorkflow).toContain('artifact_group: dist-linux-arm64');
        expect(coreBuildWorkflow).toContain('artifact_group: dist-win-x64');
        const supplementalWindowsArm = workflowJob(supplementalWorkflow, 'build_win_arm64');
        expect(supplementalWindowsArm).toContain('uses: ./.github/workflows/build-target.yml');
        expect(supplementalWindowsArm).toContain('os: windows-11-arm');
        expect(supplementalWindowsArm).toContain('platform: win');
        expect(supplementalWindowsArm).toContain('arch: arm64');
        expect(supplementalWindowsArm).toContain('artifact_group: supplemental-win-arm64');
        expect(supplementalWindowsArm).not.toContain('advisory:');
        expect(releaseWorkflow).not.toContain('build_win_arm64:');
        expect(releaseWorkflow).not.toContain('build_mac_intel:');
        // Runner provisioning has one owner: the setup-release-env composite
        // action. MSYS2 install, export, and tool verification live there and
        // must have completed before the Windows bundle step runs.
        const setupAction = await readProjectFile('.github/actions/setup-release-env/action.yml');
        expect(setupAction).toContain(
            'uses: msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
        );
        expect(setupAction).toContain('msystem: CLANGARM64');
        expect(setupAction).toContain('msys2_root="$(cygpath -u "$MSYS2_LOCATION")"');
        expect(setupAction).toContain('"$tool_path" --version');
        expect(workflow).toContain('uses: ./.github/actions/setup-release-env');
        expect(workflow).toContain('needs-msys2: ${{ inputs.platform == \'win\' && inputs.arch == \'arm64\' }}');
        const setupEnvIndex = workflow.indexOf('uses: ./.github/actions/setup-release-env');
        const windowsBundleIndex = workflow.indexOf('name: Bundle native tools (Windows)');
        expect(setupEnvIndex).toBeGreaterThanOrEqual(0);
        expect(windowsBundleIndex).toBeGreaterThanOrEqual(0);
        expect(setupEnvIndex).toBeLessThan(windowsBundleIndex);
        expect(workflow).toContain(
            'run: bash scripts/verify-packaged-native-tools.sh "$EVB_RELEASE_TARGET_PLATFORM" "$EVB_RELEASE_TARGET_ARCH"',
        );
        expect(workflow).toContain('name: Verify packaged app contents');
        expect(workflow).toContain('unpacked_dir="win-arm64-unpacked"');
        expect(workflow).toContain('"release/${unpacked_dir}/resources/app.asar"');
        expect(workflow).toContain('pnpm run test:packaged-core-pdf-smoke -- --executable "release/mac-arm64/EVB Viewer.app/Contents/MacOS/EVB Viewer"');
        expect(workflow).toContain('name: Verify signed bundle through LaunchServices');
        expect(workflow).toContain('if: runner.os == \'macOS\' && env.MAC_EXPECT_DEVELOPER_ID == \'true\'');
        expect(workflow).toContain(
            'bash scripts/verify-macos-launchservices-startup.sh "$EVB_RELEASE_TARGET_PLATFORM" "$EVB_RELEASE_TARGET_ARCH"',
        );
        expect(workflow).toContain('name: Upload macOS LaunchServices diagnostics');
        expect(workflow).toContain('.devkit/test/macos-launchservices-startup/**');
        expect(macSigningScript).toContain('if [ "${CI:-}" = "true" ]; then');
        expect(macSigningScript).toContain('::error::$message');
        expect(macSigningScript).toContain('Partial macOS signing credentials detected; set both CSC_LINK and CSC_KEY_PASSWORD or neither');
        expect(macSigningScript).toContain('Partial APPLE_API_* secrets detected; set APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER or none of them');
        expect(macCertificateImportScript).toContain('security create-keychain');
        expect(macCertificateImportScript).toContain('security import "$certificate_path"');
        expect(macCertificateImportScript).toContain('security set-key-partition-list');
        expect(macCertificateImportScript).toContain('Developer ID Application');

        const releaseCredentials = workflowJob(releaseWorkflow, 'release_credentials');
        expect(releaseCredentials).toContain('Validate public release credentials');
        expect(releaseCredentials).toContain('environment: release');
        expect(releaseCredentials).toContain('direct-download Windows installers will be unsigned');
        expect(releaseCredentials).toContain('unsigned or unnotarized macOS artifacts cannot be promoted');
        expect(releaseCredentials).not.toContain('PARTNER_CLIENT_SECRET');
        expect(releaseCredentials).not.toContain('submit_store=');
        expect(workflowJob(releaseWorkflow, 'build_artifacts')).toContain('- release_credentials');

        const packagedScanCleanupVerifier = workflowJob(releaseWorkflow, 'verify_packaged_scan_cleanup');
        const publish = workflowJob(releaseWorkflow, 'publish');
        expect(packagedScanCleanupVerifier).toContain('runs-on: macos-14');
        expect(packagedScanCleanupVerifier).toContain('name: Resolve required packaged scan-cleanup fixture');
        expect(packagedScanCleanupVerifier).toContain('getPackagedScanCleanupFixture');
        expect(packagedScanCleanupVerifier).toContain('name: Download macOS arm64 package');
        expect(packagedScanCleanupVerifier).toContain('PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES: ${{ steps.fixture.outputs.expected_pages }}');
        expect(packagedScanCleanupVerifier).toContain('--expected-pages "$PACKAGED_SCAN_CLEANUP_EXPECTED_PAGES"');
        expect(packagedScanCleanupVerifier).toContain('--scale-only');
        expect(packagedScanCleanupVerifier).toContain('name: Upload packaged scan-cleanup verifier evidence');
        const publishNeeds = /\n {4}needs:\n((?: {6}- .+\n)+)/u.exec(publish)?.[1] ?? '';
        // Advisory evidence, not a publish gate: the toolbar contract it
        // exercised is pinned continuously by the blocking electron smoke
        // lane, and this packaged job only annotates and uploads evidence.
        expect(publishNeeds).not.toContain('- verify_packaged_scan_cleanup');
        expect(packagedScanCleanupVerifier).toContain('continue-on-error: true');
    });

    it('keeps release quality gates from requiring pre-bundle host Linux resources', async () => {
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const prepareJob = workflowJob(releaseWorkflow, 'prepare');

        expect(releaseWorkflow).not.toContain('tags:');
        expect(releaseWorkflow).toContain('workflow_dispatch:');
        expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
        expect(releaseWorkflow).toContain('target_ref:');
        expect(prepareJob).toContain('Stable public release tag must be exactly vMAJOR.MINOR.PATCH.');
        expect(prepareJob).toContain('if: ${{ github.ref == \'refs/heads/main\' }}');
        expect(prepareJob).toContain('WORKFLOW_SHA: ${{ github.workflow_sha }}');
        expect(prepareJob).toContain('git merge-base --is-ancestor "$WORKFLOW_SHA" refs/remotes/origin/main');
        expect(releaseWorkflow).toContain('git rev-parse --verify "${DISPATCH_TARGET_REF}^{commit}"');
        expect(releaseWorkflow).toContain('"repos/${GITHUB_REPOSITORY}/commits/${DISPATCH_TARGET_REF}"');
        // The target detach happens only after ancestry and exact-SHA CI
        // vouched for the operator-supplied ref.
        expect(workflowJob(releaseWorkflow, 'prepare')).toContain(
            'git checkout --detach "${{ steps.target.outputs.target_sha }}"',
        );
        expect(prepareJob).toContain('git merge-base --is-ancestor "$TARGET_SHA" refs/remotes/origin/main');
        // The cutter owns the tag; the workflow only verifies that it exists
        // at the target and never creates or repairs it.
        expect(prepareJob).toContain('Tag $RELEASE_TAG does not exist on origin.');
        expect(prepareJob).toContain('Tag $RELEASE_TAG points at $tag_sha, not requested target $target_sha.');
        expect(prepareJob).not.toContain('continuing for release repair');
        expect(releaseWorkflow).not.toContain('git tag ');
        expect(releaseWorkflow).not.toContain('git push');
        // The CI wait lives in a dependency-free, unit-tested script (issue
        // #109); prepare calls it from the trusted dispatch-ref checkout.
        expect(prepareJob).toContain('node scripts/release/wait-for-exact-sha-ci.mjs "$TARGET_SHA"');
        const waitScript = await readProjectFile('scripts/release/wait-for-exact-sha-ci.mjs');
        expect(waitScript).toContain('/runs?head_sha=${targetSha}&branch=main&per_page=20');
        expect(waitScript).toContain('select(.name == "gates_ok")');
        const releaseShared = await readProjectFile('scripts/release/shared.mjs');
        expect(releaseShared).not.toMatch(/from ['"]es-toolkit\//u);
        // Policy, not a literal: the completion budget must stay ahead of the
        // slowest blocking CI job's declared timeout plus a queueing margin,
        // so growing CI can never silently outlive the release wait again.
        const ciJobs = parseWorkflowJobs(await readProjectFile('.github/workflows/ci.yml'));
        // Duration budgets for every blocking lane, pinned at roughly twice
        // each lane's measured post-#109 duration. timeout-minutes IS the
        // duration budget: a gate addition that pushes a lane past it fails
        // the commit that introduced it, and raising a budget is a deliberate
        // edit here - which also feeds the release wait-budget assertion
        // below, so CI growth can never again silently outrun the release.
        // Measured baselines: cold-cache maxima from the 2026-08-24 runs
        // right after the #109 split; remeasure before judging a trip stale.
        const blockingLaneTimeoutBudgetMinutes: Record<string, number> = {
            commit_attribution: 5, // measured <1m
            gates_ok: 5, // measured <1m
            pr_browser_integration: 10, // measured 1.9m
            pr_changed_areas: 5, // measured <1m
            pr_electron_blocking_smoke: 30, // measured 4.0m; Electron boot variance
            pr_electron_native_save_reopen: 35, // native mutation plus fresh Electron process
            pr_landing_quality: 15, // measured ~7m
            pr_native_build_safety: 35, // measured 18.9m cold-cache
            pr_native_pdf_integration: 25, // tiny native/qpdf/copyFileAtomic fixture
            // Calls build-target.yml, whose one timeout is shared with every
            // release target; remote source-map processing needs a bounded
            // margin after the Linux x64 package smoke.
            pr_packaged_linux: 60,
            pr_quality: 20, // measured 13.4m
            pr_rust_tests_arm64: 20, // measured 9.6m
            pr_scan_cleanup_heavy: 25, // measured 10.1m cold-cache
            pr_scan_cleanup_oracles: 15, // measured 3.2m
        };
        // Blocking = what actually gates the release: gates_ok plus its
        // needs graph. Derived, not name-matched, so a newly wired blocking
        // lane cannot dodge its budget by not starting with pr_.
        const gatesOkNeeds = (ciJobs['gates_ok'] as Record<string, unknown>).needs;
        expect(Array.isArray(gatesOkNeeds)).toBe(true);
        const blockingJobNames = [
            ...(gatesOkNeeds as string[]),
            'gates_ok',
        ].sort();
        expect(blockingJobNames).toEqual(Object.keys(blockingLaneTimeoutBudgetMinutes).sort());
        // A job that calls a reusable workflow cannot declare its own
        // timeout; the called workflow's single job owns it.
        const resolveBlockingJob = async (jobName: string) => {
            const job = ciJobs[jobName] as Record<string, unknown>;
            if (typeof job.uses !== 'string') {
                return job;
            }
            expect(job.uses, `${jobName} must call a checked-in workflow`).toMatch(/^\.\/\.github\/workflows\/[\w-]+\.yml$/u);
            const calledJobs = Object.values(parseWorkflowJobs(await readProjectFile(job.uses.slice(2))));
            expect(calledJobs, `${job.uses} must define exactly one job`).toHaveLength(1);
            return calledJobs[0] as Record<string, unknown>;
        };
        const blockingTimeoutMinutes = await Promise.all(blockingJobNames.map(async (jobName) => {
            const timeout = (await resolveBlockingJob(jobName))['timeout-minutes'];
            expect(
                Number.isInteger(timeout) && (timeout as number) > 0,
                `${jobName} must declare a positive integer timeout-minutes`,
            ).toBe(true);
            expect(timeout as number, `${jobName} timeout-minutes exceeds its pinned duration budget`)
                .toBeLessThanOrEqual(blockingLaneTimeoutBudgetMinutes[jobName] ?? 0);
            return timeout as number;
        }));
        const completionBudgetMatch = /EXACT_SHA_CI_COMPLETION_TIMEOUT_MS = (\d+) \* 60_000/u.exec(waitScript);
        expect(completionBudgetMatch).not.toBeNull();
        // The 10-minute margin covers runner queueing before the slowest
        // lane starts plus the gates_ok aggregation tail; a lane's own
        // timeout-minutes clock only starts once its runner is assigned.
        expect(Number(completionBudgetMatch?.[1]))
            .toBeGreaterThanOrEqual(Math.max(...blockingTimeoutMinutes) + 10);
        // Push CI's gates_ok (hard-required by prepare) is the single
        // validation authority; the release workflow never reruns the
        // release:verify:checks list.
        expect(releaseWorkflow).not.toContain('run: pnpm run release:verify:checks');
        expect(releaseWorkflow).not.toContain('\n  quality:\n');
        for (const removedJob of [
            'build_win_arm64',
            'build_mac_intel',
            'attach_win_arm64',
            'attach_mac_intel',
            'publish_store',
            'submit_store',
            'report_store_deferred',
        ]) {
            expect(parseWorkflowJobs(releaseWorkflow)[removedJob], `release.yml still owns ${removedJob}`).toBeUndefined();
        }

        const publishJob = workflowJob(releaseWorkflow, 'publish');
        expect(publishJob).toContain('environment: release');
        expect(publishJob).toContain('uses: ./.github/actions/setup-release-env');
        expect(publishJob.indexOf('name: Setup release environment')).toBeLessThan(
            publishJob.indexOf('name: Download release artifacts'),
        );
        // The draft binds to the tag the cutter pushed. A --target would make
        // GitHub re-check the workflows scope against the main tip and fail
        // with HTTP 403 once a workflow change landed after the release commit.
        expect(publishJob).toContain('gh release create "$RELEASE_TAG" artifacts/* --draft --generate-notes\n');
        expect(publishJob).not.toContain('--target "$TARGET_SHA"');
        expect(publishJob).toContain('gh release download "$RELEASE_TAG" --dir downloaded-assets');
        expect(publishJob).toContain('release-checksums.mjs verify downloaded-assets');
        expect(publishJob).not.toContain('gh release edit "$RELEASE_TAG" --draft=false');

        const releaseJobs = parseWorkflowJobs(releaseWorkflow);
        expect(releaseJobs.chain?.needs).toEqual([
            'prepare',
            'publish',
        ]);
        const chainJob = workflowJob(releaseWorkflow, 'chain');
        expect(chainJob).toContain('uses: ./.github/workflows/publish-chain.yml');
        expect(chainJob).toContain('contents: write');
        expect(chainJob).toContain('attestations: write');
        expect(chainJob).toContain('id-token: write');
        expect(chainJob).toContain('drill: false');
        expect(chainJob).toContain('secrets: inherit');
        const dispatchJob = workflowJob(releaseWorkflow, 'dispatch_supplemental');
        expect(dispatchJob).toContain('actions: write');
        expect(dispatchJob).toContain('gh workflow run release-supplemental.yml');
        expect(dispatchJob).toContain('--ref "$WORKFLOW_REF"');
        expect(dispatchJob).toContain('-f tag="$TAG"');
        expect(dispatchJob).toContain('-f workflow_sha="$WORKFLOW_SHA"');
        expect(dispatchJob).toContain('if: ${{ !cancelled() && needs.chain.result == \'success\' }}');
        const completionJob = workflowJob(releaseWorkflow, 'release_complete');
        expect(completionJob).toContain('if: ${{ always() }}');
        expect(completionJob).toContain('Public release: $PUBLIC_URL');
        expect(completionJob).toContain('Mirror channel: \\`$MIRROR_CHANNEL\\`');
        expect(completionJob).toContain('Supplemental workflow: $SUPPLEMENTAL_RUN_URL');
        expect(completionJob).toContain('PUBLISH_RESULT');
        expect(completionJob).toContain('CHAIN_RESULT');
        expect(completionJob).toContain('DISPATCH_RESULT');
        expectAcyclicNeedsGraph(releaseWorkflow, 'release.yml');

        const publishChainWorkflow = await readProjectFile('.github/workflows/publish-chain.yml');
        const publishChainJobs = parseWorkflowJobs(publishChainWorkflow);
        expectAcyclicNeedsGraph(publishChainWorkflow, 'publish-chain.yml');
        expect(publishChainWorkflow).toContain('workflow_call:');
        expect(publishChainWorkflow).toContain('artifact_name_prefix:');
        expect(publishChainWorkflow).toContain('mirror_prefix:');
        expect(publishChainWorkflow).toContain('channel_key:');
        expect(publishChainWorkflow).toContain('value: ${{ jobs.promote.outputs.released }}');
        expect(publishChainJobs.finalize?.needs).toBeUndefined();
        expect(publishChainJobs.stage_mirror?.needs).toBe('finalize');
        expect(publishChainJobs.promote?.needs).toBe('stage_mirror');
        for (const jobName of [
            'finalize',
            'stage_mirror',
            'promote',
        ]) {
            const job = workflowJob(publishChainWorkflow, jobName);
            expect(job, `publish-chain.yml ${jobName} must use the release environment`).toContain('environment: release');
            expect(job, `publish-chain.yml ${jobName} must check out its trusted revision`).toContain(
                'uses: actions/checkout@',
            );
            expect(job).toContain('ref: ${{ inputs.workflow_sha }}');
            expect(job).toContain('uses: ./.github/actions/setup-release-env');
        }
        // A stalled mirror upload once held the global release concurrency
        // group for half an hour before an operator cancelled it; without a
        // job timeout GitHub would have let it run for six. Every chain job
        // therefore declares a budget above its measured duration.
        expect(workflowJob(publishChainWorkflow, 'finalize')).toContain('timeout-minutes: 20');
        expect(workflowJob(publishChainWorkflow, 'stage_mirror')).toContain('timeout-minutes: 40');
        // Promote's activation loop is bounded to three 600 s attempts plus
        // pauses, so its job budget must exceed that window.
        expect(workflowJob(publishChainWorkflow, 'promote')).toContain('timeout-minutes: 40');
        expect(workflowJob(publishChainWorkflow, 'promote')).toContain('timeout 600s node scripts/release/publish-release-mirror.mjs');
        const finalizeJob = workflowJob(publishChainWorkflow, 'finalize');
        expect(finalizeJob).toContain('pattern: ${{ inputs.artifact_name_prefix }}*');
        expect(finalizeJob).toContain('release-checksums.mjs generate artifacts');
        expect(finalizeJob).toContain('release-checksums.mjs verify artifacts');
        expect(finalizeJob).toContain('ensure-github-release-assets.mjs');
        expect(finalizeJob).toContain('if: ${{ !inputs.drill }}');
        const stageMirrorJob = workflowJob(publishChainWorkflow, 'stage_mirror');
        expect(stageMirrorJob).toContain('pnpm install --frozen-lockfile --ignore-scripts');
        expect(stageMirrorJob).toContain('publish-release-mirror.mjs');
        expect(stageMirrorJob).toContain('--stage');
        expect(stageMirrorJob).toContain('MIRROR_RELEASE_PREFIX: ${{ inputs.mirror_prefix }}');
        expect(stageMirrorJob).toContain('MIRROR_CHANNEL_KEY: ${{ inputs.channel_key }}');
        const promoteJob = workflowJob(publishChainWorkflow, 'promote');
        expect(promoteJob).toContain('pnpm install --frozen-lockfile --ignore-scripts');
        expect(promoteJob).toContain('for attempt in 1 2 3; do');
        expect(promoteJob).toContain('gh release edit "$RELEASE_TAG" --draft=false');
        expect(promoteJob).toContain('if: ${{ !inputs.drill }}');
        expect(promoteJob).toContain('if: ${{ inputs.drill }}');
        expect(promoteJob).toContain('gh release view "$RELEASE_TAG" --json isDraft,assets');
        expectScriptJobsHaveCheckout(publishChainWorkflow, 'publish-chain.yml');

        const supplementalWorkflow = await readProjectFile('.github/workflows/release-supplemental.yml');
        expectAcyclicNeedsGraph(supplementalWorkflow, 'release-supplemental.yml');
        expectScriptJobsHaveCheckout(supplementalWorkflow, 'release-supplemental.yml');
        expect(supplementalWorkflow).toContain('workflow_dispatch:');
        expect(supplementalWorkflow).toContain('workflow_call:');
        expect(supplementalWorkflow).toContain('group: release-supplemental-${{ inputs.tag }}');
        for (const jobName of [
            'resolve',
            'release_credentials',
            'build_win_arm64',
            'build_mac_intel',
            'publish_store',
            'attach_win_arm64',
            'attach_mac_intel',
            'mirror_supplemental',
            'summary',
        ]) {
            expect(parseWorkflowJobs(supplementalWorkflow)[jobName], `missing supplemental job ${jobName}`).toBeDefined();
        }
        expect(workflowJob(supplementalWorkflow, 'resolve')).toContain('gh release view "$TAG" --json isDraft');
        expect(workflowJob(supplementalWorkflow, 'resolve')).toContain('git rev-parse --verify "$TAG^{commit}"');
        for (const jobName of [
            'attach_win_arm64',
            'attach_mac_intel',
        ]) {
            const job = workflowJob(supplementalWorkflow, jobName);
            expect(job).toContain('if: ${{ !cancelled()');
            expect(job).toContain('uses: actions/checkout@');
            expect(job).toContain('ensure-github-release-assets.mjs');
        }
        // A re-dispatch must reuse attached assets: builds are not
        // byte-reproducible and the immutable-asset check rejects fresh bytes.
        const supplementalResolve = workflowJob(supplementalWorkflow, 'resolve');
        expect(supplementalResolve).toContain('existing_mac_x64=$existing_mac_x64');
        expect(supplementalResolve).toContain('existing_win_arm64=$existing_win_arm64');
        expect(supplementalResolve).toContain('holds only part of the Windows ARM64 pair');
        expect(supplementalResolve).toContain('existing_mac_x64: ${{ steps.resolve.outputs.existing_mac_x64 }}');
        expect(supplementalResolve).toContain('existing_win_arm64: ${{ steps.resolve.outputs.existing_win_arm64 }}');
        expect(workflowJob(supplementalWorkflow, 'build_mac_intel')).toContain('needs.resolve.outputs.existing_mac_x64 != \'true\'');
        expect(workflowJob(supplementalWorkflow, 'build_win_arm64')).toContain('needs.resolve.outputs.existing_win_arm64 != \'true\'');
        expect(workflowJob(supplementalWorkflow, 'attach_mac_intel')).toContain('needs.resolve.outputs.existing_mac_x64 == \'true\'');
        expect(workflowJob(supplementalWorkflow, 'attach_win_arm64')).toContain('needs.resolve.outputs.existing_win_arm64 == \'true\'');
        expect(workflowJob(supplementalWorkflow, 'summary')).toContain('$GITHUB_STEP_SUMMARY');
        // Supplemental bytes reach the mirror only after they are attached,
        // and only as plain objects: the immutable manifest and the stable
        // channel belong to the promoted core release.
        const mirrorSupplementalJob = workflowJob(supplementalWorkflow, 'mirror_supplemental');
        expect(mirrorSupplementalJob).toContain('environment: release');
        // The drill supplements a draft release, whose assets GitHub hides
        // from a token that cannot write contents.
        expect(mirrorSupplementalJob).toContain('contents: write');
        expect(mirrorSupplementalJob).toContain('- attach_win_arm64');
        expect(mirrorSupplementalJob).toContain('- attach_mac_intel');
        expect(mirrorSupplementalJob).toContain('MIRROR_RELEASE_PREFIX: ${{ inputs.mirror_prefix }}');
        expect(mirrorSupplementalJob).toContain('MIRROR_CHANNEL_KEY: ${{ inputs.channel_key }}');
        expect(mirrorSupplementalJob).toContain('node scripts/release/publish-release-mirror.mjs supplemental "${args[@]}"');

        const drillWorkflow = await readProjectFile('.github/workflows/release-drill.yml');
        expectAcyclicNeedsGraph(drillWorkflow, 'release-drill.yml');
        expectScriptJobsHaveCheckout(drillWorkflow, 'release-drill.yml');
        expect(drillWorkflow).toContain('- cron: \'17 3 * * *\'');
        expect(drillWorkflow).toContain('group: release-drill');
        expect(drillWorkflow).toContain('make-drill-release-assets.mjs');
        expect(drillWorkflow).toContain('gh release create "$DRILL_TAG" "${core_assets[@]}" --draft --prerelease --notes "publish-chain drill"');
        expect(workflowJob(drillWorkflow, 'chain')).toContain('drill: true');
        expect(workflowJob(drillWorkflow, 'chain')).toContain('artifact_name_prefix: drill-dist-');
        expect(workflowJob(drillWorkflow, 'chain')).toContain('mirror_prefix: evb-viewer/drill/${{ github.run_id }}/releases/');
        expect(workflowJob(drillWorkflow, 'chain')).toContain('channel_key: evb-viewer/drill/${{ github.run_id }}/channels/stable.json');
        const supplementalDrillJob = workflowJob(drillWorkflow, 'supplemental_drill');
        expect(supplementalDrillJob).toContain('actions: read');
        expect(supplementalDrillJob).toContain('contents: write');
        expect(supplementalDrillJob).toContain('drill: true');
        const supplementalRedispatchDrillJob = workflowJob(drillWorkflow, 'supplemental_redispatch_drill');
        expect(supplementalRedispatchDrillJob).toContain('needs: supplemental_drill');
        expect(supplementalRedispatchDrillJob).toContain('drill: true');
        // The drill mirrors its supplemental stubs into the run's own prefix,
        // after the chain has staged the core objects they sit beside.
        expect(supplementalDrillJob).toContain('- chain');
        for (const job of [
            supplementalDrillJob,
            supplementalRedispatchDrillJob,
        ]) {
            expect(job).toContain('mirror_prefix: evb-viewer/drill/${{ github.run_id }}/releases/');
            expect(job).toContain('channel_key: evb-viewer/drill/${{ github.run_id }}/channels/stable.json');
        }
        const cleanupJob = workflowJob(drillWorkflow, 'cleanup');
        expect(cleanupJob).toContain('- supplemental_redispatch_drill');
        expect(cleanupJob).toContain('if: ${{ always() }}');
        expect(cleanupJob).toContain('gh release delete "$DRILL_TAG" --yes');
        expect(cleanupJob).toContain('publish-release-mirror.mjs cleanup "$DRILL_PREFIX"');
        expect(cleanupJob).toContain('evb-viewer/drill/');

        const artifactWorkflow = await readProjectFile('.github/workflows/release-artifacts.yml');
        expect(parseWorkflowTriggers(artifactWorkflow)).toHaveProperty('schedule');
        expect(artifactWorkflow).toContain('- cron: \'10 4 * * *\'');
        expect(workflowJob(artifactWorkflow, 'freshness')).toContain('"$age_seconds" -gt 86400');
        expect(workflowJob(artifactWorkflow, 'prepare')).toContain('always()');
        // The schedule carries no inputs. Until the prepare job resolved the
        // main tip itself, every scheduled canary failed on the missing
        // target_ref and the daily packaging proof never ran.
        expect(workflowJob(artifactWorkflow, 'prepare')).toContain('[ -z "$DISPATCH_TARGET_REF" ] && [ "$EVENT_NAME" = \'schedule\' ]');
        expect(workflowJob(artifactWorkflow, 'prepare')).toContain('DISPATCH_TARGET_REF="$(git rev-parse refs/remotes/origin/main)"');
        // Electron 22 cannot load the ESM main bundle, so the never-published
        // Windows 7 lane fails its packaged smoke on every run. It must not
        // turn the whole canary red and mask the lanes that do publish.
        // A reusable-workflow call job cannot carry continue-on-error itself;
        // GitHub refuses to parse the caller. The called job holds it.
        expect(workflowJob(artifactWorkflow, 'build_win7_legacy')).not.toContain('continue-on-error:');
        const win7Workflow = await readProjectFile('.github/workflows/build-win7-legacy.yml');
        expect(workflowJob(win7Workflow, 'build_win7_legacy')).toContain('continue-on-error: true');
    });

    it('proves the packaged Linux journey on push CI before any release cut', async () => {
        // v0.1.447 and v0.1.448 both failed on all four platforms from
        // verifier-only mistakes that no lane had executed before the cut.
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const buildWorkflow = await readProjectFile('.github/workflows/build-target.yml');
        const packagedLinux = workflowJob(workflow, 'pr_packaged_linux');

        expect(packagedLinux).toContain('needs.pr_changed_areas.outputs.packaged_smoke == \'true\'');
        expect(packagedLinux).toContain('uses: ./.github/workflows/build-target.yml');
        expect(packagedLinux).toContain('os: ubuntu-22.04');
        expect(packagedLinux).toContain('platform: linux');
        expect(packagedLinux).toContain('arch: x64');
        expect(packagedLinux).toContain('upload_artifacts: false');
        expect(packagedLinux).not.toContain('secrets:');
        expect(buildWorkflow).toContain('if: ${{ inputs.upload_artifacts }}');
        const gatesOkJob = workflowJob(workflow, 'gates_ok');
        expect(gatesOkJob).toContain('- pr_packaged_linux');
        expect(gatesOkJob).toContain('[\'pr_packaged_linux\', process.env.PACKAGED_SMOKE_CHANGED],');
        const packagedSmokePaths = getCiChangedAreaPolicy().packagedSmoke?.paths ?? [];
        for (const proofPath of [
            'scripts/release/verifyPackagedCorePdfSmoke.ts',
            'electron-builder.yml',
            '.github/workflows/build-target.yml',
            'package.json',
            'pnpm-lock.yaml',
            'tests/e2e/electron/helpers/**',
        ]) {
            expect(packagedSmokePaths).toContain(proofPath);
        }
    });

    it('keeps packaged annotation persistence on the strict pointer and keyboard path', async () => {
        const packagedSmoke = await readProjectFile('scripts/release/verifyPackagedCorePdfSmoke.ts');
        const packagedDiagnostics = await readProjectFile('scripts/release/verifyPackagedDiagnosticsSmoke.ts');
        const packagedScanCleanup = await readProjectFile('scripts/release/verifyPackagedScanCleanup.ts');

        expect(packagedSmoke).toContain('createCanonicalTextBoxWithPointer(');
        expect(packagedSmoke).not.toContain('createFreeTextAnnotation(page,');
        for (const verifier of [
            packagedSmoke,
            packagedDiagnostics,
            packagedScanCleanup,
        ]) {
            expect(verifier).toContain('EVB_AUTOMATION_HIDE_WINDOW: \'1\'');
            expect(verifier).toContain('EVB_AUTOMATION_NO_FOCUS: \'1\'');
            expect(verifier).toContain('preparePackagedAutomationLaunch');
            expect(verifier).toContain('workDirectory');
            expect(verifier).toContain('launch.executablePath');
        }
        expect(packagedSmoke).toContain('assertPathAbsent(workDirectory, \'temporary smoke directory\')');
        expect(packagedSmoke).toContain('did not exit after cleanup');
    });

    it('keeps Partner Center submission out of the release workflows', async () => {
        for (const workflowPath of [
            '.github/workflows/release.yml',
            '.github/workflows/release-supplemental.yml',
            '.github/workflows/store-appx.yml',
        ]) {
            const workflow = await readProjectFile(workflowPath);
            expect(workflow, workflowPath).not.toContain('PARTNER_');
            expect(workflow, workflowPath).not.toContain('submit_store');
            expect(workflow, workflowPath).not.toContain('submit-store-appx');
        }
    });

    it('keeps local distribution and cold lint fail-closed within supported resources', async () => {
        const packageJson = JSON.parse(await readProjectFile('package.json')) as {scripts: Record<string, string>};
        const validationGates = await readProjectFile('scripts/validation-gates.mjs');

        expect(packageJson.scripts.dist).toMatch(/^node scripts\/check-dev-environment\.mjs --strict &&/u);
        expect(validationGates).toContain('parsePositiveInteger(process.env.EVB_ESLINT_WORKERS, 1)');
        expect(validationGates).not.toContain('parsePositiveInteger(process.env.EVB_ESLINT_WORKERS, 4)');
    });

    it('pins every external action in privileged release workflows to an immutable commit', async () => {
        for (const workflowPath of [
            '.github/workflows/release.yml',
            '.github/workflows/publish-chain.yml',
            '.github/workflows/release-supplemental.yml',
            '.github/workflows/release-drill.yml',
            '.github/workflows/release-artifacts.yml',
            '.github/workflows/dependency-audit.yml',
            '.github/workflows/build.yml',
            '.github/workflows/build-target.yml',
            '.github/workflows/build-mac-intel.yml',
            '.github/workflows/build-win7-legacy.yml',
            '.github/workflows/store-appx.yml',
            '.github/actions/setup-release-env/action.yml',
        ]) {
            const workflow = await readProjectFile(workflowPath);
            const externalUses = [...workflow.matchAll(/^\s*uses:\s+([^./][^@\s]+)@([^\s#]+)/gmu)];
            for (const match of externalUses) {
                expect(match[2], `${workflowPath}: ${match[0]}`).toMatch(/^[0-9a-f]{40}$/u);
            }
        }
    });

    it('keeps artifact-only release builds reusable and non-publishing', async () => {
        const workflow = await readProjectFile('.github/workflows/release-artifacts.yml');
        const qualityJob = workflowJob(workflow, 'quality');

        expect(workflow).toContain('name: Build Release Artifacts');
        expect(workflow).toContain('workflow_dispatch:');
        expect(workflow).toContain('target_ref:');
        expect(workflow).toContain('permissions:\n  contents: read');
        expect(workflow).not.toContain('contents: write');
        expect(workflow).toContain('git rev-parse --verify "${DISPATCH_TARGET_REF}^{commit}"');
        expect(workflow).toContain('"repos/${GITHUB_REPOSITORY}/commits/${DISPATCH_TARGET_REF}"');
        expect(qualityJob).toContain('run: pnpm run release:verify:checks');
        expect(qualityJob).not.toContain('pnpm --dir landing install');
        expect(qualityJob).toContain('persist-credentials: false');
        expect(workflowJob(workflow, 'prepare')).toContain('persist-credentials: false');
        expect(qualityJob).toContain('uses: ./.github/actions/setup-release-env');
        expect(qualityJob).toContain('needs-playwright-chromium: \'true\'');
        expect(qualityJob).toContain('apt-packages: poppler-utils');
        expect(qualityJob).toContain('pip-packages: Pillow==11.3.0');
        // Quality reruns the release checks only for commits push CI never
        // vouched for; a green exact-SHA gates_ok run skips it.
        expect(qualityJob).toContain('if: ${{ needs.prepare.outputs.require_quality == \'true\' }}');
        expect(workflowJob(workflow, 'prepare')).toContain('name: Resolve validation authority');
        expect(workflowJob(workflow, 'prepare')).toContain('select(.name == "gates_ok")');
        // The runs/jobs API lookup needs this scope; without it the lookup
        // always falls back to running the quality job.
        expect(workflowJob(workflow, 'prepare')).toContain('actions: read');
        expect(workflowJob(workflow, 'build_artifacts'))
            .toContain('needs.quality.result != \'failure\' && needs.quality.result != \'cancelled\'');
        expect(workflowJob(workflow, 'build_artifacts')).toContain('uses: ./.github/workflows/build.yml');
        const windowsArmJob = workflowJob(workflow, 'build_win_arm64');
        expect(windowsArmJob).toContain('uses: ./.github/workflows/build-target.yml');
        expect(windowsArmJob).toContain('artifact_group: supplemental-win-arm64');
        expect(windowsArmJob).not.toContain('advisory:');
        expect(workflowJob(workflow, 'build_mac_intel')).toContain('uses: ./.github/workflows/build-mac-intel.yml');
        expect(workflowJob(workflow, 'build_win7_legacy')).toContain('uses: ./.github/workflows/build-win7-legacy.yml');
        expect(workflowJob(workflow, 'build_store')).toContain('uses: ./.github/workflows/store-appx.yml');
        expect(workflowJob(workflow, 'build_store')).not.toContain('submit:');
        expect(workflowJob(workflow, 'build_artifacts')).not.toContain('release_environment: release');
        expect(workflowJob(workflow, 'build_mac_intel')).not.toContain('release_environment: release');
        expect(workflow).not.toContain('secrets: inherit');
        expect(workflow).not.toContain('gh release create');
        expect(workflow).not.toContain('gh release upload');
        expect(workflow).not.toContain('Package and Submit Microsoft Store AppX');
        const summarizeJob = workflowJob(workflow, 'summarize');
        expect(summarizeJob).toContain('#artifacts');
        expect(summarizeJob).toContain('supplemental-win-arm64\\` ($BUILD_WIN_ARM64_RESULT)');
    });

    it('keeps release cutting dispatch-based instead of tag-push based', async () => {
        const releaseScript = await readProjectFile('scripts/release/cut-release.mjs');

        expect(releaseScript).toContain('`release: ${version} [skip ci]`');
        expect(releaseScript).toContain('\'workflow\'');
        expect(releaseScript).toContain('\'run\'');
        expect(releaseScript).toContain('\'release.yml\'');
        expect(releaseScript).toContain('`target_ref=${targetSha}`');
        expect(releaseScript).toContain('waitForWorkflowRunStart');
        expect(releaseScript).not.toContain('wait-for-github-release.mjs');
        expect(releaseScript).not.toContain('refs/tags/${tag}');
        expect(releaseScript).not.toContain('\'tag\',\n            tag');
        expect(releaseScript).not.toContain('\'--atomic\'');
        // The tag push is a precondition the shared helper owns, not the
        // trigger: the cutter still dispatches release.yml explicitly.
        expect(releaseScript).toContain('pushReleaseTagFn({');
        const sharedScript = await readProjectFile('scripts/release/shared.mjs');
        expect(sharedScript).toContain('export function pushReleaseTag(');
        expect(sharedScript).toContain('`refs/tags/${tag}`,\n    ], {stdio: \'inherit\'});');
    });

    it('keeps release credentials reachable only through the gated reusable release path', async () => {
        const storeWorkflow = await readProjectFile('.github/workflows/store-appx.yml');
        const buildWorkflow = await readProjectFile('.github/workflows/build-target.yml');
        const macIntelWorkflow = await readProjectFile('.github/workflows/build-mac-intel.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const supplementalWorkflow = await readProjectFile('.github/workflows/release-supplemental.yml');

        expect(storeWorkflow).toContain('workflow_call:');
        expect(storeWorkflow).not.toContain('workflow_dispatch:');
        const storeWorkflowCall = parseWorkflowTriggers(storeWorkflow).workflow_call;
        expect(isRecord(storeWorkflowCall)).toBe(true);
        expect(isRecord(storeWorkflowCall) ? storeWorkflowCall.secrets : undefined).toEqual({
            SENTRY_AUTH_TOKEN: {required: false},
            SENTRY_VERIFICATION_TOKEN: {required: false},
            SENTRY_ORG: {required: false},
            SENTRY_DESKTOP_PROJECT: {required: false},
            SENTRY_DESKTOP_DSN: {required: false},
        });
        expect(workflowJob(buildWorkflow, 'build')).toContain('environment: ${{ inputs.release_environment }}');
        expect(workflowJob(macIntelWorkflow, 'build_mac_intel'))
            .toContain('environment: ${{ inputs.release_environment }}');
        expect(buildWorkflow).toContain('default: artifact-build');
        expect(macIntelWorkflow).toContain('default: artifact-build');
        expect(workflowJob(releaseWorkflow, 'build_artifacts')).toContain('release_environment: release');
        expect(workflowJob(supplementalWorkflow, 'build_mac_intel')).toContain('release_environment: release');
        expect(parseWorkflowJobs(supplementalWorkflow).publish_store).toMatchObject({
            uses: './.github/workflows/store-appx.yml',
            secrets: {
                SENTRY_AUTH_TOKEN: '${{ secrets.SENTRY_AUTH_TOKEN }}',
                SENTRY_VERIFICATION_TOKEN: '${{ secrets.SENTRY_VERIFICATION_TOKEN }}',
                SENTRY_ORG: '${{ secrets.SENTRY_ORG }}',
                SENTRY_DESKTOP_PROJECT: '${{ secrets.SENTRY_DESKTOP_PROJECT }}',
                SENTRY_DESKTOP_DSN: '${{ secrets.SENTRY_DESKTOP_DSN }}',
            },
        });
        expect(workflowJob(supplementalWorkflow, 'publish_store')).not.toContain('secrets: inherit');
    });

    it('keeps the heavier deterministic checks available by manual dispatch', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const buildWorkflow = await readProjectFile('.github/workflows/build-target.yml');
        const nvmrc = await readProjectFile('.nvmrc');
        const rustToolchain = await readProjectFile('rust-toolchain.toml');

        expect(workflow).not.toContain('github.event_name == \'schedule\'');
        expect(workflow).toContain('name: Manual Maintenance Gates');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: rustup target add wasm32-unknown-unknown');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:wasm:strict');
        expectManualQualitySteps(workflowJob(workflow, 'nightly_maintenance'), [
            'pnpm run lint',
            'pnpm run check:static:assets',
            'pnpm run typecheck',
            'pnpm run build:strict:no-wasm-check',
        ]);
        expect(workflow).toContain('run: pnpm run test:rust');
        // The real-corpus suite is manual-only: two blocking days, ~18
        // minutes per native push, zero catches (anti-accretion rule).
        expect(workflowJob(workflow, 'nightly_maintenance'))
            .toContain('run: node scripts/run-native-corpus-tests.mjs');
        expect(workflowJob(workflow, 'pr_scan_cleanup_heavy'))
            .not.toContain('run: node scripts/run-native-corpus-tests.mjs');
        expect(workflowJob(workflow, 'pr_scan_cleanup_heavy'))
            .toContain('run: pnpm run test:scan-cleanup:canonical-identity');
        // Push-lane rust caches are accelerators; manual maintenance stays cache-cold.
        expect(workflowJob(workflow, 'pr_native_build_safety')).toContain('name: Restore Rust build caches');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('name: Restore Rust build caches');
        // The parallel heavy lane must stay wired into the aggregate gate.
        const gatesOkJob = workflowJob(workflow, 'gates_ok');
        expect(gatesOkJob).toContain('- pr_scan_cleanup_heavy');
        expect(gatesOkJob).toContain('[\'pr_scan_cleanup_heavy\', process.env.NATIVE_OR_BUILD_CHANGED],');
        const rustFuzz = workflowJob(workflow, 'nightly_rust_fuzz');
        expect(rustFuzz).toContain('cargo install cargo-fuzz --version 0.13.1 --locked');
        expect(rustFuzz).toContain('for target in decode roundtrip; do');
        expect(rustFuzz).toContain('cargo +nightly fuzz run "$target" --fuzz-dir native/jbig2-codec/fuzz -- -max_total_time=15');
        expect(workflow).toContain('run: pnpm run test:coverage');
        expect(workflow).not.toContain('nightly_scan_cleanup_regress');
        expect(workflow).not.toContain('EVB_SCAN_CLEANUP_REGRESS_MANIFEST');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:static:assets');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run check:production-dependency-audit');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('pnpm --dir landing install');
        expect(workflowJob(workflow, 'nightly_maintenance')).not.toContain('playwright install');
        expect(workflowJob(workflow, 'manual_quality')).not.toContain('run: pnpm run check:production-dependency-audit');
        expect(nvmrc.trim()).toBe('24.11.1');
        expect(workflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(buildWorkflow).toContain('NODE_VERSION: \'24.11.1\'');
        expect(rustToolchain).toContain('channel = "1.89.0"');
        expect(rustToolchain).toContain('profile = "minimal"');
        // Rust target provisioning moved into the shared setup action; the
        // build matrix passes the wasm target through its inputs.
        expect(buildWorkflow).toContain('wasm32-unknown-unknown');
        expect(await readProjectFile('.github/actions/setup-release-env/action.yml'))
            .toContain('run: rustup target add ${{ inputs.rust-targets }}');
    });

    it('reports every quality gate even after an earlier gate fails', async () => {
        // A job stops at its first failing step, so a single broken gate used to
        // hide every later one and leave the expensive checks unrun for days.
        // Each gate must therefore survive an earlier failure while still failing
        // the job. Provisioning is the exception: a gate cannot mean anything
        // without the tools it drives, and letting the rest run after a failed
        // dependency or Rust setup reports gates as broken when only the runner was.
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const jobs = parseWorkflowJobs(workflow);
        const gateCondition = '${{ !cancelled() && steps.setup.outcome == \'success\' }}';

        // Naming the gates each lane owes is what keeps the rest of this test
        // from passing vacuously. Every selector below is built from whatever
        // the workflow happens to contain, and the regression being pinned --
        // gates that stop reporting -- is precisely the one that empties them.
        const rustProvisioning = 'rustup target add wasm32-unknown-unknown';
        const requiredGates = {
            pr_quality: {
                provisioning: 'python3 -m pip install --disable-pip-version-check Pillow==11.3.0',
                gates: [
                    'pnpm run generate:build-artifacts',
                    'pnpm run lint --changed --base="$base_sha"',
                    'pnpm run typecheck',
                    'pnpm run test:unit',
                    'pnpm run check:drizzle-schema',
                    'pnpm run check:electron-builder:asar-unpack',
                    'pnpm run check:static:assets',
                ],
            },
            manual_quality: {
                provisioning: rustProvisioning,
                gates: [
                    'pnpm run check:wasm:strict',
                    'pnpm run lint:clean',
                    'pnpm run check:static:assets',
                    'pnpm run typecheck:clean',
                    'pnpm run build:strict:no-wasm-check',
                ],
            },
            nightly_maintenance: {
                provisioning: rustProvisioning,
                gates: [
                    'pnpm run check:production-dependency-audit',
                    'pnpm run check:wasm:strict',
                    'pnpm run fallow',
                    'pnpm run fallow:dupes',
                    'pnpm run check:static:reports',
                    'pnpm run check:static:assets',
                    'pnpm run typecheck',
                    'pnpm run typecheck:coverage',
                    'pnpm run build:strict:no-wasm-check',
                    'pnpm run test:rust',
                    'node scripts/run-native-corpus-tests.mjs',
                    'pnpm run test:coverage',
                    'pnpm run test:ocr:native-smoke:required',
                    'pnpm run test:ocr:quality:required',
                ],
            },
        };

        for (const [
            jobName,
            {
                provisioning,
                gates,
            },
        ] of Object.entries(requiredGates)) {
            const job = jobs[jobName];
            const steps = job?.steps ?? [];
            expect(steps.length, `${jobName} must declare steps`).toBeGreaterThan(0);

            // Anchoring the split on the provisioning command, not on the marker
            // alone, is what stops it from sliding down the job: carried to the
            // last step, `id: setup` leaves nothing after it to require a guard.
            const setupIndex = steps.findIndex(step => step.id === 'setup');
            expect(
                steps[setupIndex]?.run?.trim(),
                `${jobName} must mark its last provisioning step, not a later gate`,
            ).toBe(provisioning);

            // Keying on the final provisioning step is what makes an earlier
            // provisioning failure skip every gate: GitHub skips the remaining
            // unconditional setup, so this step reports 'skipped', not 'success'.
            const conditionalSetup = steps
                .slice(0, setupIndex + 1)
                .filter(step => step.if !== undefined)
                .map(step => step.name);
            expect(conditionalSetup, `${jobName} provisioning must stay unconditional so a broken runner aborts`).toEqual([]);

            const gateSteps = steps.slice(setupIndex + 1);
            const abortingGates = gateSteps
                .filter(step => step.if !== gateCondition)
                .map(step => step.name);
            expect(abortingGates, `${jobName} gates that would skip the rest of the job`).toEqual([]);

            const gateCommands = gateSteps.flatMap(step => runCommandLines(step));
            for (const gate of gates) {
                expect(gateCommands, `${jobName} must still report ${gate} after an earlier gate fails`).toContain(gate);
            }

            // Surviving an earlier gate's failure must not become surviving your
            // own. An advisory gate reports the lane green while the check it
            // performs is broken, which is the state this job exists to expose.
            expect(job?.['continue-on-error'], `${jobName} must fail when one of its gates fails`).not.toBe(true);
            const advisoryGates = gateSteps
                .filter(step => step['continue-on-error'] === true)
                .map(step => step.name);
            expect(advisoryGates, `${jobName} gates that would report a broken check as success`).toEqual([]);
        }
    });

    it('keeps stable Electron desktop automation blocking and quarantined diagnostics advisory', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const artifactAction = await readProjectFile('.github/actions/upload-electron-e2e-artifacts/action.yml');
        const releaseWorkflow = await readProjectFile('.github/workflows/release.yml');
        const packageJson = await readProjectFile('package.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('name: Manual Electron E2E Regression');
        expect(workflow).not.toContain('name: Manual Electron E2E Smoke');
        expect(workflow).toContain('runs-on: macos-14');
        expect(workflow).toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).not.toContain('EVB_E2E_REQUIRE_DJVU_FIXTURE');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).toContain('run: pnpm run test:e2e:electron:regression');
        expectNoExactRunStep(workflowJob(workflow, 'nightly_electron_e2e_regression'), 'pnpm run test:e2e:electron');
        expect(workflow).toContain('name: Manual Electron E2E Rapid Navigation');
        expect(workflowJob(workflow, 'nightly_electron_e2e_regression')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_rapid_navigation')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_rapid_navigation')).not.toContain('continue-on-error: true');
        expect(workflow).toContain('name: Manual Electron E2E Large PDF');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).toContain('run: pnpm run check:electron:install');
        expect(workflowJob(workflow, 'nightly_electron_e2e_large_pdf')).not.toContain('continue-on-error: true');
        expect(packageJson).toContain('"test:e2e:electron:large": "pnpm run build:pdf-page-ops');
        expect(packageJson).toContain('EVB_PDF_PAGE_OPS_ENABLE=1 EVB_E2E_REQUIRE_LARGE_PDF_FIXTURE=1 bash scripts/test-electron-e2e-headless.sh --no-build e2e-large-pdf --reporter verbose');
        expect(workflow).toContain('name: Manual Electron E2E Quarantine');
        expect(workflowJob(workflow, 'nightly_electron_e2e_quarantine')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toContain('run: pnpm run test:e2e:electron:quarantine');
        expect(workflow).toContain('name: Manual Electron E2E Visible Window');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('runs-on: macos-14');
        expect(workflowJob(workflow, 'nightly_electron_e2e_visible_window')).toContain('run: pnpm run test:e2e:electron:visible-window');
        for (const jobName of [
            'pr_electron_blocking_smoke',
            'nightly_electron_e2e_regression',
            'nightly_electron_e2e_save_pipeline',
            'nightly_electron_e2e_rapid_navigation',
            'nightly_electron_e2e_large_pdf',
            'nightly_electron_e2e_quarantine',
        ]) {
            const ordinaryJob = workflowJob(workflow, jobName);
            expect(ordinaryJob).not.toContain('test:e2e:electron:visible-window');
            expect(ordinaryJob).not.toContain('e2e-visible-window');
            expect(ordinaryJob).not.toContain('visibleWindowLifecycle.e2e.test.ts');
        }
        const validationGates = await readProjectFile('scripts/validation-gates.mjs');
        expect(validationGates).not.toContain('test:e2e:electron:visible-window');
        expect(validationGates).not.toContain('e2e-visible-window');
        for (const jobName of [
            'nightly_electron_e2e_regression',
            'nightly_electron_e2e_save_pipeline',
            'nightly_electron_e2e_rapid_navigation',
            'nightly_electron_e2e_large_pdf',
            'nightly_electron_e2e_visible_window',
        ]) {
            expect(workflowJob(workflow, jobName)).not.toContain('continue-on-error: true');
        }
        expect(workflowJob(workflow, 'nightly_electron_e2e_quarantine')).not.toContain('continue-on-error: true');
        expect(workflowJob(workflow, 'nightly_pdf_tabs_diagnostics')).toContain('continue-on-error: true');
        expect(packageJson).toContain('"test:e2e:electron:visible-window": "pnpm run build:electron && vitest run --project e2e-visible-window --reporter verbose"');
        expect(sharedVitestConfig).toContain('electronE2EVisibleWindow: \'e2e-visible-window\'');
        expect(workflow).toContain('EVB_E2E_PRESERVE_ARTIFACTS: \'1\'');
        for (const jobName of [
            'pr_electron_blocking_smoke',
            'nightly_electron_e2e_regression',
            'nightly_electron_e2e_rapid_navigation',
            'nightly_electron_e2e_large_pdf',
            'nightly_electron_e2e_quarantine',
            'nightly_electron_e2e_visible_window',
        ]) {
            const job = workflowJob(workflow, jobName);
            expect(job).toContain('if: ${{ always() }}');
            expect(job).toContain('uses: ./.github/actions/upload-electron-e2e-artifacts');
        }
        expect(artifactAction).toContain('uses: actions/upload-artifact@v7');
        expect(artifactAction).toContain('include-hidden-files: true');
        expect(artifactAction).toContain('.devkit/sessions/e2e-*/screenshots/**');
        expect(artifactAction).toContain('.devkit/test/electron-e2e-artifacts/**');
        expect(artifactAction).toContain('.devkit/scratch/dev-server-logs/e2e-*/**');
        expect(artifactAction).not.toContain('electron-user-data');
        expect(workflow).toContain('name: Manual PDF Tab Diagnostics');
        expect(workflowJob(workflow, 'nightly_pdf_tabs_diagnostics')).toContain('run: pnpm run check:electron:install');
        expect(workflow).toMatch(/nightly_pdf_tabs_diagnostics:[\s\S]*if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}[\s\S]*continue-on-error: true[\s\S]*run: pnpm run diag:pdf-tabs:ci/u);
        expect(workflow).toContain('run: pnpm run diag:pdf-tabs:ci');
        // Both Electron lanes exercise scan cleanup, which measures its matched
        // page canvas with evb-pdf-page-ops and assembles a lossless run with
        // it: they build every native tool that work needs through the shared
        // e2e native build and run with the tool enabled, on the project the
        // lane owns.
        const packageScripts = JSON.parse(packageJson).scripts as Record<string, string>;

        expect(packageScripts['build:native:e2e']).toContain('pdf-page-ops');
        for (const [
            script,
            project,
        ] of [
                [
                    'test:e2e:electron:regression',
                    'e2e-regression',
                ],
                [
                    'test:e2e:electron:quarantine',
                    'e2e-quarantine',
                ],
            ]) {
            const command = packageScripts[script!]!;

            for (const required of [
                'pnpm run build:native:e2e',
                'pnpm run build:electron',
                'EVB_PDF_PAGE_OPS_ENABLE=1',
                `--no-build ${project!}`,
            ]) {
                if (script! === 'test:e2e:electron:quarantine') {
                    expect(command, `${script!} must use the fail-closed quarantine wrapper`)
                        .toContain('scripts/ci/runElectronQuarantine.ts');
                    continue;
                }
                expect(command, `${script!} is missing ${required}`).toContain(required);
            }
        }
        expect(packageScripts['test:e2e:electron:quarantine']).toContain('scripts/ci/runElectronQuarantine.ts');
        expect(packageScripts['test:e2e:electron:quarantine']).not.toContain('--passWithNoTests');
        // The matched page canvas is a whole-app contract — geometry measured
        // in the main process, a rectangle presented by the renderer, and an
        // assembled PDF whose pages carry it — so it is proved by running the
        // real app rather than by any unit layer. It lives in the isolated
        // quarantine inventory as an operator-only diagnostic. It is excluded
        // from the ordinary lane because it skips without a supplied PDF.
        const matchedCanvasSpec = 'tests/e2e/electron/quarantine/scanCleanupMatchedCanvas.e2e.test.ts';

        expect(await readProjectFile(matchedCanvasSpec))
            .toContain('describe(\'scan cleanup matched page canvas\'');
        expect(sharedVitestConfig)
            .toContain('const electronE2EQuarantineTestFiles = [\'tests/e2e/electron/quarantine/**/*.e2e.test.ts\']');
        expect(sharedVitestConfig)
            .toContain('electronE2EQuarantineOperatorDiagnosticFiles');
        expect(sharedVitestConfig)
            .toContain(matchedCanvasSpec);
        expect(packageJson).not.toContain('"test:e2e:electron:smoke:no-build"');
        expect(sharedVitestConfig).toContain('condition: /\\[INFRA\\]/u');
        expect(sharedVitestConfig).toContain('count: 2');
        expect(sharedVitestConfig).toContain('electronE2ERegression: \'e2e-regression\'');
        expect(sharedVitestConfig).not.toContain('electronE2ESmoke: \'e2e-smoke\'');
        expect(releaseWorkflow).not.toContain('test:e2e:electron');
        expect(releaseWorkflow).not.toContain('diag:pdf-tabs');
    });

    it('keeps coverage config wired to an actual gate and free of stale path overrides', async () => {
        const workflow = await readProjectFile('.github/workflows/ci.yml');
        const packageJson = await readProjectFile('package.json');
        const vitestConfig = await readProjectFile('vitest.config.ts');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(workflow).toContain('run: pnpm run test:coverage');
        const qualityGates = workflowJob(workflow, 'pr_quality');
        expect(qualityGates).toContain('run: pnpm run test:unit');
        expectNoExactRunStep(qualityGates, 'pnpm run test:coverage');
        expect(qualityGates).not.toContain('Scan-cleanup line budget');
        expect(qualityGates).not.toContain('EVB_SCAN_CLEANUP_BASE_REF');
        expectNoExactRunStep(workflowJob(workflow, 'manual_quality'), 'pnpm run test:unit');
        expectNoExactRunStep(workflowJob(workflow, 'nightly_maintenance'), 'pnpm run test:unit');
        expect(workflowJob(workflow, 'nightly_maintenance')).toContain('run: pnpm run test:coverage');
        expect(packageJson).toContain('"test:coverage": "vitest run --coverage --project unit-core --project unit-app --project unit-electron --project unit-scripts --project unit-policy --project unit-static-architecture --project unit-landing && pnpm exec tsx scripts/checkCoverageRatchet.ts && pnpm exec tsx scripts/checkZeroExecutionCoverage.ts"');
        expect(packageJson).not.toContain('"test:coverage:run"');
        expect(packageJson).not.toContain('"check:coverage:zero-execution"');
        expect(packageJson).not.toContain('"check:coverage:ratchet"');
        expect(vitestConfig).toContain('provider: \'v8\'');
        expect(vitestConfig).toContain('include: [');
        expect(vitestConfig).toContain('\'app/**/*.{ts,vue}\'');
        expect(vitestConfig).toContain('\'electron/**/*.ts\'');
        expect(vitestConfig).toContain('\'packages/**/*.ts\'');
        expect(vitestConfig).toContain('\'json-summary\'');
        expect(vitestConfig).toContain('slowTestThreshold: unitSlowTestThresholdMs');
        expect(sharedVitestConfig).toContain('unitSlowTestThresholdMs = 300');
        expect(vitestConfig).not.toContain('explicitImportOnlyFiles');
        expect(vitestConfig).not.toContain('app/composables/page/**/*.ts');
        expect(existsSync(path.join(process.cwd(), 'coverage-baseline.json'))).toBe(true);
    });

    it('keeps real-browser tests in their dedicated project', async () => {
        const packageJson = await readProjectFile('package.json');
        const sharedVitestConfig = await readProjectFile('vitest.shared.config.ts');

        expect(packageJson).toContain('"test:integration:browser": "vitest run --project browser-integration"');
        expect(sharedVitestConfig).toContain('tests/integration/browser/**/*.test.ts');
        expect(sharedVitestConfig).toContain('browserIntegration: \'browser-integration\'');
        expect(existsSync(path.join(process.cwd(), 'tests/integration/browser/realIndexedDbMigration.test.ts'))).toBe(true);
    });

    it('keeps module-owned composable tests out of legacy app composables paths', async () => {
        const legacyComposablesRoot = path.join(process.cwd(), 'tests/unit/app/composables');
        const legacyTests = await collectTestFiles(legacyComposablesRoot);
        const misplacedSubjects: string[] = [];
        const moduleImportPattern = /(?:from\s+|import\(\s*)['"](@app\/modules\/(?:pdf-viewer|workspace-shell)\/[^'"]+)['"]/g;

        for (const testFile of legacyTests) {
            const content = await readFile(testFile, 'utf8');
            const testStem = path.basename(testFile, '.test.ts');

            for (const match of content.matchAll(moduleImportPattern)) {
                const moduleSpecifier = match[1];

                if (moduleSpecifier === undefined) {
                    continue;
                }

                const moduleStem = path.basename(moduleSpecifier).replace(/\.[cm]?[jt]sx?$/, '');

                if (testStem.startsWith(moduleStem)) {
                    const relativeTestFile = path.relative(process.cwd(), testFile).split(path.sep).join('/');
                    misplacedSubjects.push(`${relativeTestFile} imports ${moduleSpecifier}`);
                }
            }
        }

        expect(misplacedSubjects).toEqual([]);
    });
});
