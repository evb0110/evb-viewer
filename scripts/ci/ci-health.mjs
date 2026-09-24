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
// The second mode answers one commit's question instead of the trend:
//
//        node scripts/ci/ci-health.mjs --sha <rev> [--json]
//        node scripts/ci/ci-health.mjs --attribute        (rev: origin/main)
//
// The third mode measures the verdict itself, which is the metric the tier
// split is judged by:
//
//        node scripts/ci/ci-health.mjs --verdict-times [--days 7] [--json]
//
// It prints the required verdict's per-job result for that commit
// and marks every failure NEW or INHERITED, with the first bad SHA per failing
// job. Run it before diagnosing a red main: an INHERITED failure belongs to
// another commit and re-diagnosing it costs a turn for nothing.
//
// Needs an authenticated `gh`. It only reads the Actions API; it is not a
// CI job and produces no verdict.

import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

/** @typedef {{id: number, run_number: number, run_attempt?: number, head_sha: string, status: string, conclusion: string | null, created_at: string, updated_at?: string, html_url?: string}} IRun */
/** @typedef {{finishedMs: number, minutes: number, red: boolean, sha: string, startedMs: number}} IVerdict */
/** @typedef {{candidates: number, from: string, hoursWithoutGreenShare: number | null, longestRedStreak: number, medianMinutes: number | null, p90Minutes: number | null, redShare: number | null, to: string, withoutVerdict: number}} IVerdictWindow */
/** @typedef {{id: number, name: string, conclusion: string | null, started_at?: string | null, completed_at?: string | null, steps?: {name: string, conclusion: string | null}[]}} IJob */
/** @typedef {{run: IRun, job: IJob, verdict: 'red' | 'green'}} IJobVerdict */
/** @typedef {{name: string, state: 'streak' | 'flapping', firstRed: {sha: string, subject: string, runNumber: number, date: string}, olderThanWindow: boolean, redRuns: number, greenRuns: number, evidence: {lines: string[], more: number, unavailable: boolean}}} IAttribution */
/** @typedef {IAttribution & {firstRedRunId: number, firstRedJobId: number}} IRawAttribution */
/** @typedef {{sha: string, subject: string, runNumber: number, date: string}} IFirstBad */
/** @typedef {{name: string, conclusion: string | null | undefined, attribution: 'NEW' | 'INHERITED' | 'UNDETERMINED' | null, firstBad: IFirstBad | null, olderThanWindow: boolean, candidates?: string[], lastGood?: string | null, firstBadCandidates?: string[]}} IShaJobVerdict */
/** @typedef {{tier: string, workflow: string, found: boolean, run: IRun | null, jobs: IShaJobVerdict[]}} IShaTier */

// The workflow a commit is judged by: the one required verdict that branch
// protection and the release cutter read. Nightly is deliberately absent: it
// is not about a commit.
export const TIER_WORKFLOWS = [{
    tier: 'required',
    workflow: 'ci.yml',
}];

const {values: options} = parseArgs({options: {
    attribute: {
        default: false,
        type: 'boolean',
    },
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
    sha: {
        default: '',
        type: 'string',
    },
    'verdict-times': {
        default: false,
        type: 'boolean',
    },
    workflow: {
        default: 'ci.yml',
        type: 'string',
    },
}});

// A read of the Actions API that dies in the network is worth asking again; a
// read the API answered with an error is not. This is a reporting client, not
// a check, so a bounded re-read hides no defect.
const NETWORK_FAILURE = /TLS handshake timeout|connection reset|i\/o timeout|EOF|timeout awaiting|temporary failure|could not resolve host|HTTP 50[234]/iu;
const NETWORK_ATTEMPTS = 4;

/** @param {unknown} error @returns {string} */
export function describeGhFailure(error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '';
    const message = error instanceof Error ? error.message : String(error);
    return (stderr.trim() || message).split('\n')[0];
}

/** @param {unknown} error @returns {boolean} */
export function isNetworkFailure(error) {
    return NETWORK_FAILURE.test(describeGhFailure(error));
}

/** @param {string[]} args @param {boolean} [quiet=false] @returns {string} */
function gh(args, quiet = false) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return execFileSync('gh', args, {
                encoding: 'utf8',
                maxBuffer: 256 * 1024 * 1024,
                stdio: [
                    'ignore',
                    'pipe',
                    'pipe',
                ],
            });
        } catch (error) {
            if (attempt >= NETWORK_ATTEMPTS || !isNetworkFailure(error)) {
                if (!quiet) {
                    process.stderr.write(`${describeGhFailure(error)}\n`);
                }
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_500 * attempt);
        }
    }
}

/** @param {string[]} args @returns {string | null} */
function ghOptional(args) {
    try {
        return gh(args, true);
    } catch {
        return null;
    }
}

/** @template T @param {string} endpoint @param {string} jq @param {boolean} [quiet=false] @returns {T[]} */
function ghLines(endpoint, jq, quiet = false) {
    return gh([
        'api',
        '--paginate',
        '-H',
        'Accept: application/vnd.github+json',
        endpoint,
        '--jq',
        jq,
    ], quiet)
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

/**
 * One commit's verdict in one tier. `INHERITED` means the job was already
 * failing on the previous run of that tier that produced a verdict for it, so
 * this commit did not cause it. `firstBad` walks the consecutive red streak
 * back to the run that started it. `NEW` needs a green verdict on the run
 * directly before this one. When runs in between were superseded or skipped the
 * job, the break is somewhere in that range and the answer is `UNDETERMINED`
 * with its candidates: naming this commit would blame whichever push happened
 * to finish first. The same holds for the start of an inherited streak: when
 * superseded runs sit between its first red verdict and the green before it,
 * `firstBadCandidates` lists that range instead of trusting the first red.
 *
 * @param {{run: IRun, jobs: IJob[]}[]} inspected
 * @param {string} sha
 * @returns {{found: boolean, run: IRun | null, jobs: IShaJobVerdict[]}}
 */
export function classifyShaJobs(inspected, sha) {
    const chronological = [...inspected].sort(compareInspectedRuns);
    const targetIndex = chronological.findLastIndex(entry => entry.run.head_sha.startsWith(sha));
    const target = chronological[targetIndex];
    if (!target) {
        return {
            found: false,
            jobs: [],
            run: null,
        };
    }
    const earlier = chronological.slice(0, targetIndex);

    return {
        found: true,
        run: target.run,
        jobs: target.jobs
            // gates_ok only restates the other jobs; the run conclusion
            // already carries the aggregate, and listing it would name the
            // aggregate as a thing the commit broke.
            .filter(job => job.name !== 'gates_ok')
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((job) => {
                if (job.conclusion !== 'failure') {
                    return {
                        attribution: null,
                        conclusion: job.conclusion,
                        firstBad: null,
                        name: job.name,
                        olderThanWindow: false,
                    };
                }
                // A skipped or cancelled job proves nothing either way, so the
                // streak only looks at runs that reached a verdict for it.
                const history = earlier
                    .map(entry => ({
                        entry,
                        verdict: entry.jobs.find(candidate => candidate.name === job.name)?.conclusion,
                    }))
                    .filter(item => item.verdict === 'failure' || item.verdict === 'success');
                let index = history.length - 1;
                let firstBad = target;
                while (index >= 0 && history[index].verdict === 'failure') {
                    firstBad = history[index].entry;
                    index -= 1;
                }
                const lastVerdict = history.at(-1);
                const inherited = lastVerdict?.verdict === 'failure';
                const greenBeforeStreak = index >= 0 ? history[index].entry : null;
                const unjudgedBeforeStreak = greenBeforeStreak
                    ? chronological.slice(
                        chronological.indexOf(greenBeforeStreak) + 1,
                        chronological.indexOf(firstBad),
                    )
                    : [];
                const streakRange = inherited && unjudgedBeforeStreak.length > 0 && greenBeforeStreak
                    ? {
                        firstBadCandidates: [
                            ...unjudgedBeforeStreak.map(entry => entry.run.head_sha.slice(0, 10)),
                            firstBad.run.head_sha.slice(0, 10),
                        ],
                        lastGood: greenBeforeStreak.run.head_sha.slice(0, 10),
                    }
                    : {};
                // Runs after the last verdict that never judged this job.
                const unjudged = lastVerdict
                    ? earlier.slice(earlier.indexOf(lastVerdict.entry) + 1)
                    : earlier;
                const undetermined = !inherited && unjudged.length > 0;

                return {
                    attribution: inherited
                        ? 'INHERITED'
                        : undetermined
                            ? 'UNDETERMINED'
                            : 'NEW',
                    ...(undetermined
                        ? {
                            candidates: [
                                ...unjudged.map(entry => entry.run.head_sha.slice(0, 10)),
                                target.run.head_sha.slice(0, 10),
                            ],
                            lastGood: lastVerdict ? lastVerdict.entry.run.head_sha.slice(0, 10) : null,
                        }
                        : streakRange),
                    conclusion: job.conclusion,
                    firstBad: {
                        date: runDate(firstBad.run.created_at),
                        runNumber: firstBad.run.run_number,
                        sha: firstBad.run.head_sha.slice(0, 10),
                        subject: gitSubject(firstBad.run.head_sha),
                    },
                    name: job.name,
                    olderThanWindow: index < 0 && firstBad.run.id === chronological[0]?.run.id,
                };
            }),
    };
}

/** @param {IShaTier[]} tiers @param {string} sha @returns {string} */
export function formatShaReport(tiers, sha) {
    const lines = [`CI attribution for ${sha.slice(0, 10)}: ${gitSubject(sha)}`];
    /** @type {string[]} */
    const newFailures = [];
    /** @type {string[]} */
    const inheritedFailures = [];
    /** @type {string[]} */
    const undeterminedFailures = [];

    for (const tier of tiers) {
        if (!tier.found || !tier.run) {
            lines.push(`  ${tier.tier} (${tier.workflow}): no run for this commit`);
            continue;
        }
        const state = tier.run.status === 'completed' ? tier.run.conclusion ?? 'unknown' : tier.run.status;
        const superseded = state === 'cancelled' ? ' (superseded, not a verdict)' : '';
        lines.push(`  ${tier.tier} (${tier.workflow}) run ${tier.run.id}: ${state}${superseded}`);
        const failed = tier.jobs.filter(job => job.conclusion === 'failure');
        for (const job of failed) {
            if (job.attribution === 'UNDETERMINED') {
                undeterminedFailures.push(job.name);
                const candidates = job.candidates ?? [];
                lines.push(
                    `    UNDETERMINED ${job.name}: last green ${job.lastGood ?? 'not in the inspected window'}; `
                    + `${candidates.length - 1} run(s) in between gave no verdict for it; `
                    + `the break is in one of ${candidates.join(', ')}`,
                );
                continue;
            }
            (job.attribution === 'NEW' ? newFailures : inheritedFailures).push(job.name);
            if (job.firstBadCandidates) {
                lines.push(
                    `    ${job.attribution} ${job.name}: broke in one of ${job.firstBadCandidates.join(', ')} `
                    + `(last green ${job.lastGood}; the runs before the first red run `
                    + `#${job.firstBad?.runNumber} were superseded)`,
                );
                continue;
            }
            const since = job.olderThanWindow ? 'first bad at or before' : 'first bad';
            lines.push(
                `    ${job.attribution} ${job.name}: ${since} ${job.firstBad?.sha} `
                + `(run #${job.firstBad?.runNumber}, ${job.firstBad?.date}) ${job.firstBad?.subject}`,
            );
        }
        const passed = tier.jobs.filter(job => job.conclusion === 'success').length;
        const other = tier.jobs.length - passed - failed.length;
        lines.push(`    ${passed} passed, ${failed.length} failed, ${other} skipped or cancelled`);
    }

    if (newFailures.length > 0) {
        lines.push(`verdict: this commit broke ${newFailures.join(', ')}`);
    }
    if (undeterminedFailures.length > 0) {
        lines.push(
            `verdict: ${undeterminedFailures.join(', ')} broke somewhere in the listed range; `
            + 'earlier runs were superseded, so bisect the candidates before blaming this commit',
        );
    }
    if (newFailures.length === 0 && undeterminedFailures.length === 0) {
        lines.push(inheritedFailures.length > 0
            ? `verdict: every failure is inherited; do not re-diagnose ${inheritedFailures.join(', ')}`
            : 'verdict: no failing job attributable to this commit');
    }
    return `${lines.join('\n')}\n`;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * A run only carries a verdict when it completed with success or failure. A
 * cancelled run proves nothing, so it is counted separately rather than
 * averaged into the time it took to say nothing.
 *
 * @param {IRun} run @returns {IVerdict | null}
 */
function toVerdict(run) {
    if (run.status !== 'completed' || (run.conclusion !== 'success' && run.conclusion !== 'failure')) {
        return null;
    }
    const startedMs = Date.parse(run.created_at);
    const finishedMs = Date.parse(run.updated_at ?? run.created_at);
    if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs) || finishedMs < startedMs) {
        return null;
    }
    return {
        finishedMs,
        minutes: (finishedMs - startedMs) / 60_000,
        red: run.conclusion === 'failure',
        sha: run.head_sha,
        startedMs,
    };
}

/** @param {number[]} values @param {number} fraction @returns {number | null} */
function nearestRank(values, fraction) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? null;
}

/**
 * Hours main spent without a green required verdict. An hour is judged by the
 * newest verdict that had landed by its end, so verdicts from before the
 * window still colour its first hours. An hour with no verdict behind it at
 * all is unknown, not red, and leaves the denominator.
 *
 * @param {IVerdict[]} chronological @param {number} fromMs @param {number} toMs
 * @returns {number | null}
 */
function hoursWithoutGreenShare(chronological, fromMs, toMs) {
    let known = 0;
    let withoutGreen = 0;
    for (let hourEnd = fromMs + HOUR_MS; hourEnd <= toMs; hourEnd += HOUR_MS) {
        const latest = chronological.filter(verdict => verdict.finishedMs <= hourEnd).at(-1);
        if (!latest) {
            continue;
        }
        known += 1;
        if (latest.red) {
            withoutGreen += 1;
        }
    }
    return known === 0 ? null : withoutGreen / known;
}

/**
 * One window's verdict metrics. Each candidate counts once, through the first
 * verdict its SHA reached: that is the wait the pusher actually paid, and a
 * rerun hours later would otherwise be reported as a slow verdict. Hour
 * coverage uses every verdict, because a rerun that turns green does restore
 * main.
 *
 * @param {IVerdict[]} chronological every verdict, oldest first
 * @param {number} fromMs @param {number} toMs @param {number} cancelled
 * @returns {IVerdictWindow}
 */
function summarizeVerdictWindow(chronological, fromMs, toMs, cancelled) {
    /** @type {Map<string, IVerdict>} */
    const firstBySha = new Map();
    for (const verdict of chronological) {
        if (verdict.startedMs >= fromMs && verdict.startedMs < toMs && !firstBySha.has(verdict.sha)) {
            firstBySha.set(verdict.sha, verdict);
        }
    }
    const candidates = [...firstBySha.values()];
    const minutes = candidates.map(verdict => verdict.minutes);
    const reds = candidates.filter(verdict => verdict.red).length;

    let longestRedStreak = 0;
    let currentStreak = 0;
    for (const verdict of candidates) {
        currentStreak = verdict.red ? currentStreak + 1 : 0;
        longestRedStreak = Math.max(longestRedStreak, currentStreak);
    }

    return {
        candidates: candidates.length,
        from: new Date(fromMs).toISOString().slice(0, 16),
        hoursWithoutGreenShare: hoursWithoutGreenShare(chronological, fromMs, toMs),
        longestRedStreak,
        medianMinutes: nearestRank(minutes, 0.5),
        p90Minutes: nearestRank(minutes, 0.9),
        redShare: candidates.length === 0 ? null : reds / candidates.length,
        to: new Date(toMs).toISOString().slice(0, 16),
        withoutVerdict: cancelled,
    };
}

/**
 * Median and p90 time from a pushed candidate to a trustworthy required
 * verdict, with the previous equal window beside it so the trend is visible.
 * Both timestamps come from the run itself, so nothing has to be recorded by
 * hand.
 *
 * @param {IRun[]} runs push runs covering twice the window, any order
 * @param {{days: number, now: number}} scope
 * @returns {{current: IVerdictWindow, previous: IVerdictWindow}}
 */
export function summarizeVerdictTimes(runs, {
    days, now,
}) {
    const windowMs = days * 24 * HOUR_MS;
    const currentFromMs = now - windowMs;
    const previousFromMs = currentFromMs - windowMs;
    const chronological = runs
        .map(toVerdict)
        .filter(verdict => verdict !== null)
        .sort((left, right) => left.finishedMs - right.finishedMs);
    /** @param {number} fromMs @param {number} toMs */
    const cancelledIn = (fromMs, toMs) => runs.filter((run) => {
        const startedMs = Date.parse(run.created_at);
        return run.status === 'completed'
            && run.conclusion === 'cancelled'
            && Number.isFinite(startedMs)
            && startedMs >= fromMs
            && startedMs < toMs;
    }).length;

    return {
        current: summarizeVerdictWindow(
            chronological,
            currentFromMs,
            now,
            cancelledIn(currentFromMs, now),
        ),
        previous: summarizeVerdictWindow(
            chronological,
            previousFromMs,
            currentFromMs,
            cancelledIn(previousFromMs, currentFromMs),
        ),
    };
}

/** @param {number | null} value @param {string} suffix @returns {string} */
function formatMetric(value, suffix) {
    return value === null ? 'n/a' : `${value.toFixed(1)}${suffix}`;
}

/** @param {number | null} share @returns {string} */
function formatShare(share) {
    return share === null ? 'n/a' : `${Math.round(share * 100)}%`;
}

/** @param {{current: IVerdictWindow, previous: IVerdictWindow}} windows @param {{branch: string, workflow: string}} scope @returns {string} */
export function formatVerdictTimesReport(windows, scope) {
    const rows = [
        {
            label: 'current',
            window: windows.current,
        },
        {
            label: 'previous',
            window: windows.previous,
        },
    ].map(({
        label, window,
    }) => ({
        cells: [
            String(window.candidates).padStart(4),
            formatMetric(window.medianMinutes, 'm').padStart(7),
            formatMetric(window.p90Minutes, 'm').padStart(7),
            formatShare(window.redShare).padStart(5),
            formatShare(window.hoursWithoutGreenShare).padStart(8),
            String(window.longestRedStreak).padStart(6),
            String(window.withoutVerdict).padStart(10),
        ],
        scope: `${label.padEnd(8)} ${window.from}..${window.to}`,
    }));
    const scopeWidth = Math.max(6, ...rows.map(row => row.scope.length));
    const lines = [
        `Verdict times: ${scope.workflow} push runs on ${scope.branch}`,
        `  ${'window'.padEnd(scopeWidth)}  cand   median      p90    red  no-green  streak  no-verdict`,
        ...rows.map(row => `  ${row.scope.padEnd(scopeWidth)}  ${row.cells.join('  ')}`),
        '  median and p90 are minutes from push to the completed required verdict; no-green is the share',
        '  of hours whose newest verdict was red; no-verdict counts cancelled runs, which prove nothing.',
    ];
    return `${lines.join('\n')}\n`;
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

/** @param {string} workflow @param {number} days @param {number} limit @param {boolean} [quiet=false] @returns {IRun[]} */
function listPushRuns(workflow, days, limit, quiet = false) {
    return ghLines(
        `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?branch=${options.branch}`
        + `&event=push&per_page=100&created=>=${sinceDate(days)}`,
        '.workflow_runs[] | {id, run_number, run_attempt, head_sha, status, conclusion, created_at, updated_at, html_url}',
        quiet,
    ).slice(0, limit);
}

/** @param {IRun} run @returns {{run: IRun, jobs: IJob[]}} */
function withJobs(run) {
    return {
        jobs: /** @type {IJob[]} */ (ghLines(
            `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
            '.jobs[] | {id, name, conclusion, started_at, completed_at, steps: [.steps[] | {name, conclusion}]}',
        )),
        run,
    };
}

/** @param {string} rev @returns {string} */
function resolveRevision(rev) {
    try {
        return execFileSync('git', [
            'rev-parse',
            rev,
        ], {
            encoding: 'utf8',
            stdio: [
                'ignore',
                'pipe',
                'ignore',
            ],
        }).trim();
    } catch {
        // Already a SHA, or a revision this checkout does not know. The run
        // lookup is a prefix match, so hand it through unchanged.
        return rev;
    }
}

function reportSha() {
    const days = Number(options.days);
    const limit = Number(options.limit);
    const jobsToInspect = Number(options.jobs);
    const sha = resolveRevision(options.sha || `${options.branch === 'main' ? 'origin/main' : options.branch}`);
    /** @type {IShaTier[]} */
    const tiers = TIER_WORKFLOWS.map(({
        tier, workflow,
    }) => {
        // A tier whose workflow file does not exist on the branch being asked
        // about reports nothing rather than aborting the other tier's answer.
        // Anything else, a network error above all, has to surface: silently
        // reading it as "no run" would report a green commit for an outage.
        let runs = [];
        try {
            runs = listPushRuns(workflow, days, limit, true);
        } catch (error) {
            const message = String(/** @type {{stderr?: unknown}} */ (error)?.stderr ?? '');
            if (!message.includes('HTTP 404')) {
                throw error;
            }
            return {
                found: false,
                jobs: [],
                run: null,
                tier,
                workflow,
            };
        }
        const newestFirst = runs
            .filter(run => run.status === 'completed')
            .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id);
        const targetPosition = Math.max(0, newestFirst.findIndex(run => run.head_sha.startsWith(sha)));
        const window = newestFirst.slice(targetPosition, targetPosition + jobsToInspect).map(withJobs);
        return {
            ...classifyShaJobs(window, sha),
            tier,
            workflow,
        };
    });

    if (options.json) {
        process.stdout.write(`${JSON.stringify({
            sha,
            subject: gitSubject(sha),
            tiers,
            newFailures: tiers.flatMap(tier => tier.jobs
                .filter(job => job.attribution === 'NEW')
                .map(job => job.name)),
            inheritedFailures: tiers.flatMap(tier => tier.jobs
                .filter(job => job.attribution === 'INHERITED')
                .map(job => job.name)),
            undeterminedFailures: tiers.flatMap(tier => tier.jobs
                .filter(job => job.attribution === 'UNDETERMINED')
                .map(job => job.name)),
        }, null, 2)}\n`);
        return;
    }
    process.stdout.write(formatShaReport(tiers, sha));
}

function reportVerdictTimes() {
    const days = Number(options.days);
    // Both windows come from one fetch, so the previous window is measured the
    // same way the current one is.
    const runs = listPushRuns(options.workflow, days * 2, Number(options.limit) * 2);
    const windows = summarizeVerdictTimes(runs, {
        days,
        now: Date.now(),
    });
    if (options.json) {
        process.stdout.write(`${JSON.stringify({
            branch: options.branch,
            days,
            workflow: options.workflow,
            ...windows,
        }, null, 2)}\n`);
        return;
    }
    process.stdout.write(formatVerdictTimesReport(windows, {
        branch: options.branch,
        workflow: options.workflow,
    }));
}

function main() {
    if (options['verdict-times']) {
        reportVerdictTimes();
        return;
    }
    if (options.attribute || options.sha) {
        reportSha();
        return;
    }
    const days = Number(options.days);
    const limit = Number(options.limit);
    const jobsToInspect = Number(options.jobs);
    const runs = listPushRuns(options.workflow, days, limit);
    const inspected = runs
        .filter(run => run.status === 'completed' && run.conclusion !== 'cancelled')
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id)
        .slice(0, jobsToInspect)
        .map(withJobs);
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

// The classification helpers are unit tested against recorded API shapes, so
// importing this module must not reach the network.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        main();
    } catch (error) {
        // An agent reads this output to decide what to do next; one line it can
        // act on beats a stack trace through the API wrapper.
        process.stderr.write(isNetworkFailure(error)
            ? `ci-health: the GitHub API was unreachable after ${NETWORK_ATTEMPTS} attempts; nothing was read. Run it again.\n`
            : `ci-health: ${describeGhFailure(error)}\n`);
        process.exitCode = 2;
    }
}
