#!/usr/bin/env node
// Reports what main-branch CI has been doing lately: how many push runs
// failed, how many were cancelled without a verdict, which jobs and steps
// fail most, which runs flipped from red to green on a rerun (the flake
// signal), which jobs take longest, and which commit first made a failing job
// red. The report also names that first red commit for each currently failing
// job. Read it before adding a retry, a sleep, or a timeout, and read it again
// after removing a check.
//
// Usage: node scripts/ci/ci-health.mjs [--days 7] [--limit 300] [--jobs 40]
//        [--workflow ci.yml] [--branch main] [--json]
//
// Needs an authenticated `gh`. It only reads the Actions API; it is not a
// CI job and produces no verdict.

import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';

/** @typedef {{id: number, run_number: number, run_attempt?: number, head_sha: string, status: string, conclusion: string | null, created_at: string, html_url?: string}} IRun */
/** @typedef {{id: number, name: string, conclusion: string | null, started_at?: string | null, completed_at?: string | null, steps?: {name: string, conclusion: string | null}[]}} IJob */
/** @typedef {{run: IRun, job: IJob, verdict: 'red' | 'green'}} IJobVerdict */
/** @typedef {{name: string, state: 'streak' | 'flapping', firstRed: {sha: string, subject: string, runNumber: number, date: string}, olderThanWindow: boolean, redRuns: number, greenRuns: number, evidence: {lines: string[], more: number, unavailable: boolean}}} IAttribution */
/** @typedef {IAttribution & {firstRedRunId: number, firstRedJobId: number}} IRawAttribution */

const {values: options} = parseArgs({options: {
    branch: {
        default: 'main',
        type: 'string',
    },
    days: {
        default: '7',
        type: 'string',
    },
    jobs: {
        default: '40',
        type: 'string',
    },
    json: {
        default: false,
        type: 'boolean',
    },
    limit: {
        default: '300',
        type: 'string',
    },
    workflow: {
        default: 'ci.yml',
        type: 'string',
    },
}});

/** @param {string[]} args @param {boolean} [quiet=false] @returns {string} */
function gh(args, quiet = false) {
    return execFileSync('gh', args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: [
            'ignore',
            'pipe',
            quiet ? 'pipe' : 'inherit',
        ],
    });
}

/** @param {string[]} args @returns {string | null} */
function ghOptional(args) {
    try {
        return gh(args, true);
    } catch {
        return null;
    }
}

/** @template T @param {string} endpoint @param {string} jq @returns {T[]} */
function ghLines(endpoint, jq) {
    return gh([
        'api',
        '--paginate',
        '-H',
        'Accept: application/vnd.github+json',
        endpoint,
        '--jq',
        jq,
    ])
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

/** @param {number} days @returns {string} */
function sinceDate(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const subjects = new Map();

/** @param {string} sha @returns {string} */
function gitSubject(sha) {
    const cached = subjects.get(sha);
    if (cached) {
        return cached;
    }
    let subject = '(not in local history)';
    try {
        const output = execFileSync('git', [
            'log',
            '-1',
            '--format=%s',
            sha,
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
        if (output) {
            subject = output;
        }
    } catch {
        // The API may report a commit that this checkout does not contain.
    }
    subjects.set(sha, subject);
    return subject;
}

/** @param {string} createdAt @returns {string} */
function runDate(createdAt) {
    return createdAt.slice(0, 10);
}

/** @param {{run: IRun, jobs: IJob[]}} left @param {{run: IRun, jobs: IJob[]}} right @returns {number} */
function compareInspectedRuns(left, right) {
    const byCreatedAt = Date.parse(left.run.created_at) - Date.parse(right.run.created_at);
    return byCreatedAt || left.run.id - right.run.id;
}

/** @param {string} line @returns {boolean} */
function isFailureEvidence(line) {
    return /\bFAIL\s+(?:\|[^|]+\|\s+)?\S.*\s+>\s+.+/.test(line)
        || line.includes('×')
        || /\S+:\d+:\d+\s+error\b/.test(line)
        || /\berror TS\b/.test(line);
}

// `gh run view --log-failed` prefixes every line with the job name, the step
// name, and an ISO timestamp, separated by tabs and a space.
/** @param {string} line @returns {string} */
function logMessage(line) {
    const message = line.slice(line.lastIndexOf('\t') + 1);
    return message.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '').trim();
}

/** @param {string} log @returns {{lines: string[], more: number, unavailable: boolean}} */
function extractFailureEvidence(log) {
    const ansiPattern = new RegExp(
        `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
        'g',
    );
    const messages = log
        .replace(ansiPattern, '')
        .replace(/\^\[\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .map(logMessage)
        .filter(Boolean);
    const testMatches = messages.filter(isFailureEvidence);
    const matches = testMatches.length > 0
        ? testMatches
        : messages
            .filter(line => line.startsWith('##[error]'))
            .map(line => line.slice('##[error]'.length));
    return {
        lines: matches.slice(0, 8),
        more: Math.max(0, matches.length - 8),
        unavailable: false,
    };
}

/** @param {number} runId @param {number} jobId @returns {{lines: string[], more: number, unavailable: boolean}} */
function failureEvidence(runId, jobId) {
    const log = ghOptional([
        'run',
        'view',
        String(runId),
        '--log-failed',
        '--job',
        String(jobId),
    ]);
    return log === null
        ? {
            lines: [],
            more: 0,
            unavailable: true,
        }
        : extractFailureEvidence(log);
}

/** @param {IRun[]} runs */
export function summarizeRuns(runs) {
    const byConclusion = new Map();
    const bySha = new Map();
    for (const run of runs) {
        const key = run.status === 'completed' ? run.conclusion ?? 'unknown' : run.status;
        byConclusion.set(key, (byConclusion.get(key) ?? 0) + 1);
        const attempts = bySha.get(run.head_sha) ?? [];
        attempts.push(run);
        bySha.set(run.head_sha, attempts);
    }
    const reruns = [];
    for (const [
        sha,
        attempts,
    ] of bySha) {
        const retried = attempts.filter(run => (run.run_attempt ?? 1) > 1);
        if (attempts.length < 2 && retried.length === 0) {
            continue;
        }
        const conclusions = new Set(attempts.map(run => run.conclusion).filter(Boolean));
        reruns.push({
            flipped: conclusions.has('failure') && conclusions.has('success'),
            sha,
        });
    }
    return {
        byConclusion: Object.fromEntries([...byConclusion].sort((left, right) => right[1] - left[1])),
        flippedShas: reruns.filter(entry => entry.flipped).map(entry => entry.sha),
        rerunShas: reruns.map(entry => entry.sha),
        total: runs.length,
    };
}

/** @param {{run: IRun, jobs: IJob[]}[]} inspected */
export function summarizeJobs(inspected) {
    const failures = new Map();
    const durations = new Map();
    for (const {jobs} of inspected) {
        for (const job of jobs) {
            // gates_ok only aggregates the other jobs; counting it hides nothing.
            if (job.name === 'gates_ok') {
                continue;
            }
            if (job.conclusion === 'failure') {
                const entry = failures.get(job.name) ?? {
                    count: 0,
                    steps: new Map(),
                };
                entry.count += 1;
                for (const step of job.steps ?? []) {
                    if (step.conclusion === 'failure') {
                        entry.steps.set(step.name, (entry.steps.get(step.name) ?? 0) + 1);
                    }
                }
                failures.set(job.name, entry);
            }
            if (job.conclusion === 'success' && job.started_at && job.completed_at) {
                const minutes = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000;
                durations.set(job.name, [
                    ...durations.get(job.name) ?? [],
                    minutes,
                ]);
            }
        }
    }
    const median = values => {
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.floor(sorted.length / 2)];
    };
    return {
        failingJobs: [...failures]
            .sort((left, right) => right[1].count - left[1].count)
            .map(([
                name,
                entry,
            ]) => ({
                count: entry.count,
                name,
                steps: [...entry.steps]
                    .sort((left, right) => right[1] - left[1])
                    .map(([
                        step,
                        count,
                    ]) => ({
                        count,
                        step,
                    })),
            })),
        inspectedRuns: inspected.length,
        slowestJobs: [...durations]
            .map(([
                name,
                values,
            ]) => ({
                medianMinutes: median(values),
                name,
                samples: values.length,
            }))
            .sort((left, right) => right.medianMinutes - left.medianMinutes)
            .slice(0, 8),
    };
}

/** @param {{run: IRun, jobs: IJob[]}[]} inspected @returns {IRawAttribution[]} */
export function summarizeAttribution(inspected) {
    const chronological = [...inspected].sort(compareInspectedRuns);
    const current = chronological[chronological.length - 1];
    if (!current) {
        return [];
    }
    /** @type {Map<string, IJobVerdict[]>} */
    const verdictsByName = new Map();
    for (const inspectedRun of chronological) {
        for (const job of inspectedRun.jobs) {
            if (job.name === 'gates_ok') {
                continue;
            }
            const verdict = job.conclusion === 'failure'
                ? 'red'
                : job.conclusion === 'success'
                    ? 'green'
                    : null;
            if (!verdict) {
                continue;
            }
            const verdicts = verdictsByName.get(job.name) ?? [];
            verdicts.push({
                job,
                run: inspectedRun.run,
                verdict,
            });
            verdictsByName.set(job.name, verdicts);
        }
    }
    return current.jobs
        .filter(job => job.name !== 'gates_ok' && job.conclusion === 'failure')
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(job => {
            const verdicts = verdictsByName.get(job.name) ?? [];
            const firstRedIndex = verdicts.findIndex(entry => entry.verdict === 'red');
            if (firstRedIndex < 0) {
                return [];
            }
            const sinceFirstRed = verdicts.slice(firstRedIndex);
            const redRuns = sinceFirstRed.filter(entry => entry.verdict === 'red').length;
            const greenRuns = sinceFirstRed.filter(entry => entry.verdict === 'green').length;
            const firstRed = verdicts[firstRedIndex];
            return [{
                name: job.name,
                state: greenRuns === 0 ? 'streak' : 'flapping',
                firstRed: {
                    date: runDate(firstRed.run.created_at),
                    runNumber: firstRed.run.run_number,
                    sha: firstRed.run.head_sha.slice(0, 10),
                    subject: gitSubject(firstRed.run.head_sha),
                },
                firstRedJobId: firstRed.job.id,
                firstRedRunId: firstRed.run.id,
                olderThanWindow: firstRed.run.id === chronological[0].run.id,
                redRuns,
                greenRuns,
                evidence: {
                    lines: [],
                    more: 0,
                    unavailable: false,
                },
            }];
        });
}

/** @param {IRawAttribution[]} attribution @returns {IAttribution[]} */
function loadAttributionEvidence(attribution) {
    return attribution.map(entry => {
        const {
            firstRedJobId,
            firstRedRunId,
            ...reportEntry
        } = entry;
        return {
            ...reportEntry,
            evidence: failureEvidence(firstRedRunId, firstRedJobId),
        };
    });
}

/** @param {number} part @param {number} whole @returns {string} */
function percent(part, whole) {
    return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

/** @param {ReturnType<typeof summarizeRuns>} runs @param {ReturnType<typeof summarizeJobs>} jobs @param {{branch: string, days: number, workflow: string}} scope @param {IAttribution[]} [attribution] */
export function formatReport(runs, jobs, scope, attribution = []) {
    const lines = [`CI health: ${scope.workflow} push runs on ${scope.branch} since ${sinceDate(scope.days)}: ${runs.total} runs`];
    const conclusions = Object.entries(runs.byConclusion).map(([
        conclusion,
        count,
    ]) => {
        const note = conclusion === 'cancelled' ? ' (cancelled without a verdict, not a failure)' : '';
        return `  ${conclusion} ${count} (${percent(count, runs.total)})${note}`;
    });
    lines.push(...conclusions);
    lines.push(
        `  reruns: ${runs.rerunShas.length} commits ran more than once; `
        + `${runs.flippedShas.length} flipped between failure and success (flake signal)`,
    );
    for (const sha of runs.flippedShas.slice(0, 10)) {
        lines.push(`    flipped: ${sha.slice(0, 10)}`);
    }
    lines.push(`Failing jobs in the last ${jobs.inspectedRuns} completed runs:`);
    if (jobs.failingJobs.length === 0) {
        lines.push('  none');
    }
    for (const job of jobs.failingJobs) {
        const steps = job.steps.map(step => `${step.step} ${step.count}`).join(', ');
        lines.push(`  ${job.count.toString().padStart(3)}  ${job.name}${steps ? `  [${steps}]` : ''}`);
    }
    lines.push('Attribution:');
    if (attribution.length === 0) {
        lines.push('  none');
    }
    for (const entry of attribution) {
        const counts = entry.state === 'flapping'
            ? `${entry.redRuns} red, ${entry.greenRuns} green`
            : `${entry.redRuns} red verdict${entry.redRuns === 1 ? '' : 's'}`;
        const since = entry.olderThanWindow ? 'since at least' : 'since';
        lines.push(
            `  ${entry.name}: ${entry.state} ${since} ${entry.firstRed.sha} `
            + `(run #${entry.firstRed.runNumber}, ${entry.firstRed.date}, ${counts}): `
            + entry.firstRed.subject
            + (entry.olderThanWindow ? ' [oldest inspected run; widen --jobs to find the start]' : ''),
        );
        if (entry.evidence.unavailable) {
            lines.push('    log: unavailable');
        } else if (entry.evidence.lines.length === 0) {
            lines.push('    log: no matching failure lines');
        } else {
            lines.push('    log:');
            for (const line of entry.evidence.lines) {
                lines.push(`      ${line}`);
            }
            if (entry.evidence.more > 0) {
                lines.push(`      +${entry.evidence.more} more`);
            }
        }
    }
    lines.push('Slowest green jobs (median minutes):');
    for (const job of jobs.slowestJobs) {
        lines.push(`  ${job.medianMinutes.toFixed(1).padStart(6)}  ${job.name} (${job.samples} runs)`);
    }
    return `${lines.join('\n')}\n`;
}

function main() {
    const days = Number(options.days);
    const limit = Number(options.limit);
    const jobsToInspect = Number(options.jobs);
    /** @type {IRun[]} */
    const runs = ghLines(
        `repos/{owner}/{repo}/actions/workflows/${options.workflow}/runs?branch=${options.branch}`
        + `&event=push&per_page=100&created=>=${sinceDate(days)}`,
        '.workflow_runs[] | {id, run_number, run_attempt, head_sha, status, conclusion, created_at, html_url}',
    ).slice(0, limit);
    const inspected = runs
        .filter(run => run.status === 'completed' && run.conclusion !== 'cancelled')
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id)
        .slice(0, jobsToInspect)
        .map(run => ({
            jobs: /** @type {IJob[]} */ (ghLines(
                `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
                '.jobs[] | {id, name, conclusion, started_at, completed_at, steps: [.steps[] | {name, conclusion}]}',
            )),
            run,
        }));
    const runSummary = summarizeRuns(runs);
    const jobSummary = summarizeJobs(inspected);
    const attribution = loadAttributionEvidence(summarizeAttribution(inspected));
    if (options.json) {
        process.stdout.write(`${JSON.stringify({
            attribution,
            jobs: jobSummary,
            runs: runSummary,
        }, null, 2)}\n`);
        return;
    }
    process.stdout.write(formatReport(runSummary, jobSummary, {
        branch: options.branch,
        days,
        workflow: options.workflow,
    }, attribution));
}

main();
