#!/usr/bin/env node
// Reports what main-branch CI has been doing lately: how many push runs
// failed, how many were cancelled without a verdict, which jobs and steps
// fail most, which runs flipped from red to green on a rerun (the flake
// signal), and which jobs take longest. Read it before adding a retry,
// a sleep, or a timeout, and read it again after removing a check.
//
// Usage: node scripts/ci/ci-health.mjs [--days 7] [--limit 300] [--jobs 40]
//        [--workflow ci.yml] [--branch main] [--json]
//
// Needs an authenticated `gh`. It only reads the Actions API; it is not a
// CI job and produces no verdict.

import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';

/** @typedef {{id: number, run_number: number, run_attempt?: number, head_sha: string, status: string, conclusion: string | null, created_at: string, html_url?: string}} IRun */
/** @typedef {{name: string, conclusion: string | null, started_at?: string | null, completed_at?: string | null, steps?: {name: string, conclusion: string | null}[]}} IJob */

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

/** @param {string[]} args @returns {string} */
function gh(args) {
    return execFileSync('gh', args, {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: [
            'ignore',
            'pipe',
            'inherit',
        ],
    });
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

/** @param {number} part @param {number} whole @returns {string} */
function percent(part, whole) {
    return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

/** @param {ReturnType<typeof summarizeRuns>} runs @param {ReturnType<typeof summarizeJobs>} jobs @param {{branch: string, days: number, workflow: string}} scope */
export function formatReport(runs, jobs, scope) {
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
        .slice(0, jobsToInspect)
        .map(run => ({
            jobs: /** @type {IJob[]} */ (ghLines(
                `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
                '.jobs[] | {name, conclusion, started_at, completed_at, steps: [.steps[] | {name, conclusion}]}',
            )),
            run,
        }));
    const runSummary = summarizeRuns(runs);
    const jobSummary = summarizeJobs(inspected);
    if (options.json) {
        process.stdout.write(`${JSON.stringify({
            jobs: jobSummary,
            runs: runSummary,
        }, null, 2)}\n`);
        return;
    }
    process.stdout.write(formatReport(runSummary, jobSummary, {
        branch: options.branch,
        days,
        workflow: options.workflow,
    }));
}

main();
