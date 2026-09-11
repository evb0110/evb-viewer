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
    readdir,
    readFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
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
    'continue-on-error'?: boolean | string;
    env?: Record<string, unknown>;
    if?: string;
    run?: string;
    uses?: string;
}

interface IWorkflowJob {
    'continue-on-error'?: boolean;
    environment?: string;
    if?: string;
    needs?: string | string[];
    steps?: IWorkflowStep[];
    uses?: string;
    with?: Record<string, unknown>;
}

interface IWorkflowDocument {
    jobs?: Record<string, IWorkflowJob>;
    name?: string;
}

interface IWorkflowSource {
    filePath: string;
    source: string;
}

async function readProjectFile(filePath: string) {
    return readFile(path.join(process.cwd(), filePath), 'utf8');
}

function parseWorkflow(source: string) {
    return getStaticYAMLValue(parseYAML(source)) as IWorkflowDocument;
}

function parseWorkflowJobs(source: string) {
    const jobs = parseWorkflow(source).jobs;
    if (jobs === undefined) {
        throw new Error('Workflow must contain a jobs mapping.');
    }
    return jobs;
}

function workflowNeeds(job: IWorkflowJob) {
    if (job.needs === undefined) {
        return [];
    }
    return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function runsForPullRequestOrPush(condition: string | undefined) {
    return condition?.includes('github.event_name == \'pull_request\'') === true
        && condition.includes('github.event_name == \'push\'');
}

function runShell(script: string, env: Record<string, string>, shell = '/bin/sh') {
    return spawnSync(shell, [
        '-c',
        script,
    ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
            ...process.env,
            ...env,
        },
    });
}

async function readWorkflowSources() {
    const directory = path.join(process.cwd(), '.github/workflows');
    const entries = await readdir(directory, {withFileTypes: true});
    return Promise.all(
        entries
            .filter(entry => entry.isFile() && /\.ya?ml$/u.test(entry.name))
            .map(async entry => {
                const filePath = path.join(directory, entry.name);
                const source = await readFile(filePath, 'utf8');
                return {
                    filePath,
                    jobs: parseWorkflowJobs(source),
                    source,
                };
            }),
    );
}

async function collectReleaseWorkflowSources() {
    const workflowSources = await readWorkflowSources();
    const roots = workflowSources.filter(({source}) => {
        const name = parseWorkflow(source).name ?? '';
        return /release|publish[- ]chain/iu.test(name)
            || source.includes('check:production-dependency-audit');
    });
    const pending = roots.map(({filePath}) => filePath);
    const visited = new Set<string>();
    const sources: IWorkflowSource[] = [];

    while (pending.length > 0) {
        const filePath = pending.pop();
        if (filePath === undefined || visited.has(filePath)) {
            continue;
        }
        visited.add(filePath);

        const source = await readFile(filePath, 'utf8');
        sources.push({
            filePath,
            source,
        });

        for (const match of source.matchAll(/^\s*uses:\s+(\.\/\.github\/(?:workflows|actions)\/[^@\s#]+)/gmu)) {
            const localPath = match[1];
            if (localPath !== undefined) {
                pending.push(path.resolve(
                    process.cwd(),
                    localPath.includes('/actions/') ? path.join(localPath, 'action.yml') : localPath,
                ));
            }
        }
    }

    return sources;
}

function runLintFallback(script: string, scenario: {
    eventName: string;
    gitVerifyExit: number;
    prBaseSha: string;
    pushBeforeSha: string;
}) {
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
            script,
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

        return {
            calls: existsSync(callsPath)
                ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean)
                : [],
            result,
        };
    } finally {
        rmSync(workdir, {
            force: true,
            recursive: true,
        });
    }
}

describe('CI topology policy', () => {
    it('aggregates required PR and push jobs and enforces failure and skip results', async () => {
        const jobs = parseWorkflowJobs(await readProjectFile('.github/workflows/ci.yml'));
        const gatesOk = jobs.gates_ok;
        if (gatesOk === undefined) {
            throw new Error('CI workflow must define gates_ok.');
        }

        const needs = workflowNeeds(gatesOk);
        const requiredJobs = Object.entries(jobs)
            .filter(([
                jobName,
                job,
            ]) => jobName !== 'gates_ok'
                && job['continue-on-error'] !== true
                && runsForPullRequestOrPush(job.if))
            .map(([jobName]) => jobName);

        expect(new Set(needs)).toEqual(new Set(requiredJobs));
        expect(needs).toHaveLength(new Set(needs).size);

        const gateStep = gatesOk.steps?.find(step => step.run?.includes('JSON.parse(process.env.NEEDS_JSON)'));
        if (gateStep?.run === undefined) {
            throw new Error('gates_ok must execute its needs aggregation.');
        }

        const configuredGateEnv = Object.fromEntries(
            Object.keys(gateStep.env ?? {}).map(key => [
                key,
                'false',
            ]),
        );
        const executeGate = (states: Record<string, {result: string}>, env = configuredGateEnv) => runShell(
            gateStep.run!,
            {
                ...env,
                NEEDS_JSON: JSON.stringify(states),
            },
        );
        const allPassed = Object.fromEntries(needs.map(jobName => [
            jobName,
            {result: 'success'},
        ]));
        expect(executeGate(allPassed).status).toBe(0);

        const failedJob = requiredJobs[0];
        if (failedJob === undefined) {
            throw new Error('CI workflow must have a required PR or push job.');
        }
        const failed = executeGate({
            ...allPassed,
            [failedJob]: {result: 'failure'},
        });
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain(`${failedJob}: failure`);

        const skippableMatch = /\[['"]([^'"]+)['"],\s*process\.env\.([A-Z0-9_]+)\]/u.exec(gateStep.run);
        if (skippableMatch === null || skippableMatch[1] === undefined || skippableMatch[2] === undefined) {
            throw new Error('gates_ok must declare its affected-job skip policy.');
        }
        const skippedJob = skippableMatch[1];
        const skipFlag = skippableMatch[2];
        expect(needs).toContain(skippedJob);

        const skipped = {
            ...allPassed,
            [skippedJob]: {result: 'skipped'},
        };
        expect(executeGate(skipped, {
            ...configuredGateEnv,
            [skipFlag]: 'false',
        }).status).toBe(0);

        const unexpectedlySkipped = executeGate(skipped, {
            ...configuredGateEnv,
            [skipFlag]: 'true',
        });
        expect(unexpectedlySkipped.status).not.toBe(0);
        expect(unexpectedlySkipped.stderr).toContain(`${skippedJob}: skipped`);
    });

    it('keeps release signing credentials behind the gated release build path', async () => {
        const workflows = await readWorkflowSources();
        const credentialWorkflows = workflows.filter(({jobs}) => jobs.release_credentials !== undefined);
        expect(credentialWorkflows.length).toBeGreaterThan(0);

        const completeCredentials = {
            APPLE_API_ISSUER: 'issuer',
            APPLE_API_KEY: 'key',
            APPLE_API_KEY_ID: 'key-id',
            CSC_KEY_PASSWORD: 'password',
            CSC_LINK: 'certificate',
            WIN_CSC_KEY_PASSWORD: '',
            WIN_CSC_LINK: '',
        };

        for (const {
            filePath, jobs,
        } of credentialWorkflows) {
            const credentialJob = jobs.release_credentials;
            if (credentialJob === undefined) {
                throw new Error('Credential workflow disappeared while checking it.');
            }
            expect(credentialJob.environment, filePath).toBe('release');

            const credentialStep = credentialJob.steps?.find(step => step.run?.includes('APPLE_API_ISSUER'));
            if (credentialStep?.run === undefined) {
                throw new Error(`${filePath} must validate release credentials in a shell step.`);
            }

            const missingApple = runShell(credentialStep.run, {
                ...completeCredentials,
                APPLE_API_ISSUER: '',
                APPLE_API_KEY: '',
                APPLE_API_KEY_ID: '',
                CSC_KEY_PASSWORD: '',
                CSC_LINK: '',
            }, '/bin/bash');
            expect(missingApple.status, filePath).not.toBe(0);

            expect(runShell(credentialStep.run, completeCredentials, '/bin/bash').status, filePath).toBe(0);

            const partialWindows = runShell(credentialStep.run, {
                ...completeCredentials,
                WIN_CSC_LINK: 'certificate',
            }, '/bin/bash');
            expect(partialWindows.status, filePath).not.toBe(0);

            const releaseBuilds = Object.entries(jobs).filter(([
                , job,
            ]) =>
                job.uses?.startsWith('./.github/workflows/') === true
                && job.with?.release_environment === 'release',
            );
            expect(releaseBuilds.length, filePath).toBeGreaterThan(0);
            for (const [
                jobName,
                job,
            ] of releaseBuilds) {
                expect(workflowNeeds(job), `${filePath}: ${jobName}`).toContain('release_credentials');
            }
        }
    });

    it('pins external actions in release workflow dependencies to immutable commits', async () => {
        const sources = await collectReleaseWorkflowSources();
        expect(sources.length).toBeGreaterThan(0);

        for (const {
            filePath, source,
        } of sources) {
            const relativePath = path.relative(process.cwd(), filePath);
            for (const match of source.matchAll(/^\s*uses:\s+([^./\s][^@\s]*)@([^\s#]+)/gmu)) {
                const action = match[1];
                const revision = match[2];
                expect(revision, `${relativePath}: ${action}`).toMatch(/^[0-9a-f]{40}$/u);
            }
        }
    });

    it('requires the installed Windows journey for every release architecture', async () => {
        const jobs = parseWorkflowJobs(await readProjectFile('.github/workflows/build-target.yml'));
        const buildJob = jobs.build;
        if (buildJob === undefined) {
            throw new Error('build-target workflow must define its build job.');
        }

        const installedJourney = buildJob.steps?.find(step => step.run?.includes('NSIS installer was not produced.'));
        if (installedJourney === undefined) {
            throw new Error('Windows release builds must define the installed NSIS journey.');
        }

        expect(installedJourney['continue-on-error']).toBeUndefined();

        const readinessStep = buildJob.steps?.find(step => step.id === 'artifact_status');
        if (readinessStep === undefined) {
            throw new Error('build-target workflow must define its artifact readiness step.');
        }
        expect(readinessStep.run).toContain('steps.upload_artifacts.outcome == \'success\'');
        expect(readinessStep.run).toContain('runner.os != \'Windows\' || steps.nsis_journey.outcome == \'success\'');
        expect(readinessStep.run).not.toContain('ARM64 NSIS outcome is advisory');
    });

    it('runs changed lint only for a valid base and falls back to full lint otherwise', async () => {
        const jobs = parseWorkflowJobs(await readProjectFile('.github/workflows/ci.yml'));
        const lintScript = jobs.pr_quality?.steps?.find(step =>
            step.run?.includes('git rev-parse --verify')
            && step.run?.includes('pnpm run lint --changed'),
        )?.run;
        if (lintScript === undefined) {
            throw new Error('pr_quality must define its lint base fallback.');
        }

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
        ];

        for (const scenario of scenarios) {
            const {
                calls, result,
            } = runLintFallback(lintScript, scenario);
            expect(result.status, scenario.eventName).toBe(0);
            expect(calls, scenario.eventName).toEqual([scenario.expectedCommand]);
        }
    });

    it('re-reads GitHub promotion state after a lost edit response', async () => {
        const source = await readProjectFile('.github/workflows/publish-chain.yml');
        const promotionStart = source.indexOf('      - name: Promote verified GitHub draft');
        const promotionEnd = source.indexOf('      - name: Assert drill release remains a draft');
        expect(promotionStart).toBeGreaterThanOrEqual(0);
        expect(promotionEnd).toBeGreaterThan(promotionStart);

        const promotionStep = source.slice(promotionStart, promotionEnd);
        expect(promotionStep).toContain('gh release edit "$RELEASE_TAG" --draft=false');
        expect(promotionStep).toContain('gh release view "$RELEASE_TAG" --json isDraft,targetCommitish');
        expect(promotionStep).toContain('[ "$(jq -r \'.isDraft\' <<< "$release_json")" = \'false\' ]');
        expect(promotionStep).toContain('outcome is unresolved');
        expect(promotionStep).toContain('remains a draft');
    });
});
