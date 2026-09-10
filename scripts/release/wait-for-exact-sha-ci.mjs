// Waits for the exact-SHA push CI run of a release target to reach a
// successful terminal state with a green gates_ok aggregate.
//
// Dependency-free on purpose: the release workflow's prepare job runs this
// before any dependency install, from the trusted dispatch-ref checkout.
// Issue #109: the previous inline loop gave CI a fixed 45-minute budget that
// was calibrated to a ~33-minute CI and silently fell behind as blocking
// lanes grew, failing releases seconds before gates_ok completed and
// reporting real late CI failures as timeouts. The budgets here are policy:
// tests/unit/scripts/waitForExactShaCi.test.ts asserts the completion budget
// stays ahead of the blocking CI job timeouts declared in ci.yml.
import { getCliErrorMessage } from '../lib/cli-error.mjs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
    getCommitParentSha,
    isVersionOnlyPackageCommit,
} from './shared.mjs';

/** @typedef {{conclusion?: string | null, event?: string, head_branch?: string, head_sha?: string, html_url?: string, id: number, run_number?: number, status?: string}} IWorkflowRun */
/** @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => string} TCommandRunner */
/** @typedef {{write: (chunk: string) => unknown}} IWritable */
/** @typedef {{appearanceTimeoutMs?: number | undefined, completionTimeoutMs?: number | undefined, pollIntervalMs?: number | undefined, nowFn?: (() => number) | undefined, sleepFn?: (milliseconds: number) => Promise<unknown>, runCommand?: TCommandRunner | undefined, stderr?: IWritable | undefined}} IWaitOptions */

// Release commits use [skip ci], so the target may have no push run. The
// short window leaves enough time for an ordinary run to appear before the
// verified-by-parent path takes over.
export const EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS = 60_000;
// Must cover the slowest blocking CI job's declared timeout (currently 60
// minutes) plus runner queueing and the gates_ok aggregation tail.
export const EXACT_SHA_CI_COMPLETION_TIMEOUT_MS = 75 * 60_000;
export const EXACT_SHA_CI_POLL_INTERVAL_MS = 30_000;

// Exported for its own contract test: every caller in this module invokes
// the runner as (command, args), so the default adapter must too.
/** @param {string} command @param {string[]} args @param {import('node:child_process').ExecFileSyncOptions} [options] @returns {string} */
export function defaultCommandRunner(command, args, options = {}) {
    const output = execFileSync(command, args, {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        ...options,
    });

    return output == null ? '' : String(output).trim();
}

// Every push to main runs ci.yml and only push runs carry a gates_ok verdict
// (workflow_dispatch routes to the manual lanes). Require both explicitly so a
// future trigger change cannot widen what a release trusts. The API always
// supplies event; accepting an omitted value keeps the helper usable with the
// small unit-test fixtures.
/** @param {IWorkflowRun | null | undefined} runInfo @returns {runInfo is IWorkflowRun} */
function isMainPushRun(runInfo) {
    if (!runInfo) {
        return false;
    }
    return runInfo.head_branch === 'main'
        && (!runInfo.event || runInfo.event === 'push');
}

/** @param {string} targetSha @param {TCommandRunner} [runCommand] @returns {IWorkflowRun | null} */
export function findLatestMatchingRun(targetSha, runCommand = defaultCommandRunner) {
    const payload = runCommand('gh', [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&branch=main&per_page=20`,
    ]);
    const workflowRuns = JSON.parse(payload)?.workflow_runs;
    if (!Array.isArray(workflowRuns)) {
        return null;
    }
    return workflowRuns
        .filter(runInfo => isMainPushRun(runInfo) && runInfo.head_sha === targetSha)
        .sort((left, right) => (left.run_number ?? 0) - (right.run_number ?? 0))
        .at(-1) ?? null;
}

/**
 * A cancelled main push run (stopped by hand, or by a concurrency policy)
 * is not a verdict, so the newer run that contains the commit stands in for
 * it. Returns the newest later main push run whose head contains targetSha,
 * or null.
 */
/** @param {string} targetSha @param {IWorkflowRun} cancelledRun @param {TCommandRunner} [runCommand] @returns {IWorkflowRun | null} */
export function findSupersedingRun(targetSha, cancelledRun, runCommand = defaultCommandRunner) {
    const payload = runCommand('gh', [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        'repos/{owner}/{repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=20',
    ]);
    const workflowRuns = JSON.parse(payload)?.workflow_runs;
    if (!Array.isArray(workflowRuns)) {
        return null;
    }
    const candidates = workflowRuns
        .filter(runInfo => isMainPushRun(runInfo)
            && runInfo.head_sha !== targetSha
            && (runInfo.run_number ?? 0) > (cancelledRun.run_number ?? 0))
        .sort((left, right) => (right.run_number ?? 0) - (left.run_number ?? 0));
    for (const candidate of candidates) {
        // "ahead" means the candidate head descends from the target.
        const status = runCommand('gh', [
            'api',
            '-H',
            'Accept: application/vnd.github+json',
            `repos/{owner}/{repo}/compare/${targetSha}...${candidate.head_sha}`,
            '--jq',
            '.status',
        ]).trim();
        if (status === 'ahead') {
            return candidate;
        }
    }
    return null;
}

/** @param {number} runId @param {TCommandRunner} [runCommand] @returns {string | undefined} */
export function readGatesOkConclusion(runId, runCommand = defaultCommandRunner) {
    return runCommand('gh', [
        'api',
        '--paginate',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/runs/${runId}/jobs?per_page=100`,
        '--jq',
        '.jobs[] | select(.name == "gates_ok") | .conclusion',
    ]).split('\n').filter(Boolean).at(-1);
}

/** @param {IWorkflowRun} runInfo @returns {string} */
function describeRun(runInfo) {
    return `run ${runInfo.id} (${runInfo.html_url ?? 'no url'})`;
}

/** @param {string} targetSha @param {unknown} error @returns {string} */
function describeParentVerificationFailure(targetSha, error) {
    return `No accepted CI run appeared for exact target ${targetSha} within 1 minute; verified-by-parent acceptance failed: ${
        getCliErrorMessage(error)}`;
}

/** @param {string} targetSha @param {TCommandRunner} runCommand @returns {{id: number, parentSha: string, url: string, verifiedByParent: true}} */
function verifyByParent(targetSha, runCommand) {
    let parentSha;
    try {
        parentSha = getCommitParentSha(targetSha, {runCommand});
    } catch (error) {
        throw new Error(
            `Could not inspect the parent of release target ${targetSha}: ${
                getCliErrorMessage(error)}`,
        );
    }

    if (!isVersionOnlyPackageCommit(parentSha, targetSha, {runCommand})) {
        throw new Error(
            `Release target ${targetSha} is not a version-only package.json commit; `
            + 'run CI for the target before releasing.',
        );
    }

    const parentRun = findLatestMatchingRun(parentSha, runCommand);
    if (!parentRun) {
        throw new Error(
            `No CI run appeared for release parent ${parentSha}. Every push to main runs ci.yml; `
            + 'check the Actions page for that commit before releasing.',
        );
    }
    if (parentRun.status !== 'completed') {
        throw new Error(
            `Release parent ${parentSha} has ${describeRun(parentRun)} in ${parentRun.status} state; `
            + 'wait for it to finish.',
        );
    }
    let acceptedRun = parentRun;
    if (parentRun.conclusion === 'cancelled') {
        // A push after the version commit cancels the parent's run. The
        // newer run's tree contains the parent, so its verdict stands in;
        // otherwise `gh run rerun <id>` restores an exact verdict.
        acceptedRun = verifySupersedingRun(parentSha, parentRun, runCommand);
    } else if (parentRun.conclusion !== 'success') {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(parentRun)} concluded '${parentRun.conclusion}'. `
            + 'Fix the failure with a new green commit and version.',
        );
    }

    let gatesConclusion;
    try {
        gatesConclusion = readGatesOkConclusion(acceptedRun.id, runCommand);
    } catch (error) {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(parentRun)} succeeded but the gates_ok lookup failed: ${
                getCliErrorMessage(error)}`,
        );
    }
    if (gatesConclusion !== 'success') {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(acceptedRun)} did not contain a successful gates_ok `
            + `aggregate (saw '${gatesConclusion ?? 'no gates_ok job'}').`,
        );
    }

    return {
        id: acceptedRun.id,
        parentSha,
        url: acceptedRun.html_url ?? '',
        verifiedByParent: true,
        ...(acceptedRun === parentRun ? {} : {supersededBy: acceptedRun.head_sha}),
    };
}

/** @param {string} parentSha @param {IWorkflowRun} cancelledRun @param {TCommandRunner} runCommand @returns {IWorkflowRun} */
function verifySupersedingRun(parentSha, cancelledRun, runCommand) {
    const rerunHint = `re-run it with \`gh run rerun ${cancelledRun.id}\` and dispatch the release again`;
    const superseding = findSupersedingRun(parentSha, cancelledRun, runCommand);
    if (!superseding) {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(cancelledRun)} was cancelled and no newer main push run `
            + `contains it; ${rerunHint}.`,
        );
    }
    if (superseding.status !== 'completed') {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(cancelledRun)} was cancelled by a newer push; its `
            + `superseding ${describeRun(superseding)} is still ${superseding.status}. Wait for it, or ${rerunHint}.`,
        );
    }
    if (superseding.conclusion !== 'success') {
        throw new Error(
            `Release parent ${parentSha} ${describeRun(cancelledRun)} was cancelled by a newer push and its `
            + `superseding ${describeRun(superseding)} concluded '${superseding.conclusion}'. `
            + 'Fix the failure with a new green commit and version.',
        );
    }
    return superseding;
}

/**
 * Resolves with {id, url} once the exact-SHA push CI run concludes
 * successfully with a green gates_ok. Throws distinct errors for: no run
 * appearing, a known run exceeding the completion deadline, a cancelled run
 * (main moved on), a failed run (with its actual conclusion, promptly), and
 * a missing/failed gates_ok. A cancelled parent run is accepted through the
 * newer green run that contains it (see findSupersedingRun).
 * A poll always immediately precedes a deadline decision, so a run that
 * turns terminal at the boundary is still observed.
 */
/** @param {string} targetSha @param {IWaitOptions} [options] @returns {Promise<{id: number, url: string}>} */
export async function waitForExactShaCiGates(targetSha, {
    appearanceTimeoutMs = EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS,
    completionTimeoutMs = EXACT_SHA_CI_COMPLETION_TIMEOUT_MS,
    pollIntervalMs = EXACT_SHA_CI_POLL_INTERVAL_MS,
    nowFn = Date.now,
    sleepFn = milliseconds => delay(milliseconds),
    runCommand = defaultCommandRunner,
    // Only .write is part of the contract; keep the option narrow so test
    // harnesses can satisfy it without impersonating process.stderr.
    stderr = {write: chunk => process.stderr.write(chunk)},
} = {}) {
    const startedAt = nowFn();
    let knownRun = null;

    while (true) {
        try {
            const latestRun = findLatestMatchingRun(targetSha, runCommand);
            if (latestRun) {
                knownRun = latestRun;
            }
        } catch (error) {
            // Transient API failures must not abort the wait; the deadlines
            // below keep the loop bounded and fail-closed.
            stderr.write(`Transient CI lookup failure for ${targetSha}; retrying: ${
                error instanceof Error ? getCliErrorMessage(error).split('\n')[0] : String(error)}\n`);
        }

        if (knownRun && knownRun.status === 'completed') {
            if (knownRun.conclusion === 'cancelled') {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} for ${targetSha} was cancelled, so it has no `
                    + 'verdict. Release from the current main tip, or re-run it with '
                    + `\`gh run rerun ${knownRun.id}\`.`,
                );
            }
            if (knownRun.conclusion !== 'success') {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} for ${targetSha} concluded '${knownRun.conclusion}'.`,
                );
            }
            let gatesConclusion;
            try {
                gatesConclusion = readGatesOkConclusion(knownRun.id, runCommand);
            } catch (error) {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} succeeded but the gates_ok lookup failed: ${
                        error instanceof Error ? getCliErrorMessage(error).split('\n')[0] : String(error)}`,
                );
            }
            if (gatesConclusion !== 'success') {
                throw new Error(
                    `Exact-SHA CI ${describeRun(knownRun)} did not contain a successful gates_ok aggregate `
                    + `(saw '${gatesConclusion ?? 'no gates_ok job'}').`,
                );
            }
            return {
                id: knownRun.id,
                url: knownRun.html_url ?? '',
            };
        }

        const elapsedMs = nowFn() - startedAt;
        if (!knownRun && elapsedMs >= appearanceTimeoutMs) {
            try {
                return verifyByParent(targetSha, runCommand);
            } catch (error) {
                throw new Error(describeParentVerificationFailure(targetSha, error));
            }
        }
        if (knownRun && elapsedMs >= completionTimeoutMs) {
            throw new Error(
                `Exact-SHA CI ${describeRun(knownRun)} did not reach a terminal state within `
                + `${Math.round(completionTimeoutMs / 60_000)} minutes; the wait budget must stay `
                + 'ahead of the blocking CI job timeouts (see issue #109).',
            );
        }

        stderr.write(knownRun
            ? `Waiting for exact-SHA push CI ${describeRun(knownRun)} (status: ${knownRun.status}, `
                + `${Math.round(elapsedMs / 60_000)}m elapsed).\n`
            : `Waiting for a push CI run to appear for ${targetSha} (${Math.round(elapsedMs / 1_000)}s elapsed).\n`);
        await sleepFn(pollIntervalMs);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const targetSha = process.argv[2];
    if (typeof targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(targetSha)) {
        process.stderr.write('Usage: wait-for-exact-sha-ci.mjs <40-char target sha>\n');
        process.exit(1);
    }
    waitForExactShaCiGates(targetSha)
        .then(({id}) => {
            process.stdout.write(`::notice::Release target ${targetSha} passed exact-SHA CI run ${id}.\n`);
        })
        .catch((error) => {
            process.stderr.write(`::error::${getCliErrorMessage(error)}\n`);
            process.exit(1);
        });
}
