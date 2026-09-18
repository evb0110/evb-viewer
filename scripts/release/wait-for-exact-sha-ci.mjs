// Waits for the exact-SHA push CI runs of a release target to reach a
// successful terminal state: ci.yml with a green gates_ok aggregate, and
// ci-extended.yml, which carries the Electron end-to-end suites, browser
// integration, native save and the packaged Linux proof that gates_ok no
// longer contains. Pass --required-only to wait for the required tier alone,
// which is what an agent wants after its own push.
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
/** @typedef {{label: string, requiresGatesOk: boolean, workflow: string}} ICiTier */
/** @typedef {{appearanceTimeoutMs: number, completionTimeoutMs: number, pollIntervalMs: number, nowFn: () => number, sleepFn: (milliseconds: number) => Promise<unknown>, runCommand: TCommandRunner, stderr: IWritable}} ITierWaitContext */
/** @typedef {{appearanceTimeoutMs?: number | undefined, completionTimeoutMs?: number | undefined, pollIntervalMs?: number | undefined, nowFn?: (() => number) | undefined, sleepFn?: (milliseconds: number) => Promise<unknown>, runCommand?: TCommandRunner | undefined, tiers?: readonly ICiTier[] | undefined, stderr?: IWritable | undefined}} IWaitOptions */

// A target that is not a version-only release commit must have its own push
// run; this window covers the API lag between a push and its run listing.
export const EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS = 60_000;
// Must cover the slowest blocking CI job's declared timeout (currently 60
// minutes) plus runner queueing and the gates_ok aggregation tail. Three of
// the blocking jobs are macOS Electron end-to-end suites that start together
// on push to main, so hosted macOS queueing is now on the critical path.
export const EXACT_SHA_CI_COMPLETION_TIMEOUT_MS = 100 * 60_000;
export const EXACT_SHA_CI_POLL_INTERVAL_MS = 30_000;

/**
 * The tiers a release target is judged by. ci-extended.yml has no aggregate
 * job: its run conclusion is the verdict, so a lane the changed-area
 * classifier skipped counts as success there exactly as it does for gates_ok.
 */
/** @type {ICiTier} */
const REQUIRED_CI_TIER = Object.freeze({
    label: 'Exact-SHA CI',
    requiresGatesOk: true,
    workflow: 'ci.yml',
});
/** @type {ICiTier} */
const EXTENDED_CI_TIER = Object.freeze({
    label: 'Exact-SHA extended CI',
    requiresGatesOk: false,
    workflow: 'ci-extended.yml',
});
/** @type {readonly ICiTier[]} */
export const REQUIRED_CI_TIERS = Object.freeze([REQUIRED_CI_TIER]);
/** @type {readonly ICiTier[]} */
export const RELEASE_CI_TIERS = Object.freeze([
    REQUIRED_CI_TIER,
    EXTENDED_CI_TIER,
]);

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

/** @param {string} targetSha @param {TCommandRunner} [runCommand] @param {string} [workflow] @returns {IWorkflowRun | null} */
export function findLatestMatchingRun(targetSha, runCommand = defaultCommandRunner, workflow = 'ci.yml') {
    const payload = runCommand('gh', [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${targetSha}&branch=main&per_page=20`,
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
 * Successful ci.yml push runs on main, newest first. The release cutter
 * walks this list to find the newest verified commit; `status=success` is
 * the API's conclusion filter, so cancelled and failed runs never appear.
 */
/** @param {TCommandRunner} [runCommand] @param {number} [limit] @returns {IWorkflowRun[]} */
export function listSuccessfulMainPushRuns(runCommand = defaultCommandRunner, limit = 30) {
    const payload = runCommand('gh', [
        'api',
        '-H',
        'Accept: application/vnd.github+json',
        `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=${limit}`,
    ]);
    const workflowRuns = JSON.parse(payload)?.workflow_runs;
    if (!Array.isArray(workflowRuns)) {
        throw new Error('Unexpected GitHub API response while listing successful main push runs');
    }
    return workflowRuns
        .filter(runInfo => isMainPushRun(runInfo) && runInfo.conclusion === 'success')
        .sort((left, right) => (right.run_number ?? 0) - (left.run_number ?? 0));
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

/**
 * A release commit changes only the package.json version line over a parent
 * on main and carries [skip ci], so it never has a push run of its own. Its
 * verdict is the parent's push run. Returns the parent SHA when the target
 * is such a commit, null when the target has to prove itself.
 */
/** @param {string} targetSha @param {TCommandRunner} runCommand @returns {string | null} */
function readVersionOnlyParent(targetSha, runCommand) {
    let parentSha;
    try {
        parentSha = getCommitParentSha(targetSha, {runCommand});
    } catch (error) {
        throw new Error(
            `Could not inspect the parent of release target ${targetSha}: ${
                getCliErrorMessage(error)}`,
        );
    }

    return isVersionOnlyPackageCommit(parentSha, targetSha, {runCommand}) ? parentSha : null;
}

/** @param {string} targetSha @param {string} parentSha @param {TCommandRunner} runCommand @param {readonly ICiTier[]} tiers @returns {{id: number, parentSha: string, url: string, verifiedByParent: true}} */
function verifyByParent(targetSha, parentSha, runCommand, tiers) {
    /** @type {IWorkflowRun | null} */
    let requiredRun = null;

    for (const tier of tiers) {
        const parentRun = findLatestMatchingRun(parentSha, runCommand, tier.workflow);
        if (!parentRun) {
            throw new Error(
                `No ${tier.workflow} run appeared for release parent ${parentSha}. Every push to main runs it; `
                + 'check the Actions page for that commit before releasing.',
            );
        }
        if (parentRun.status !== 'completed') {
            throw new Error(
                `Release parent ${parentSha} has ${tier.workflow} ${describeRun(parentRun)} in `
                + `${parentRun.status} state; wait for it to finish.`,
            );
        }
        if (parentRun.conclusion !== 'success') {
            throw new Error(
                `Release parent ${parentSha} ${tier.workflow} ${describeRun(parentRun)} concluded `
                + `'${parentRun.conclusion}'. `
                + (parentRun.conclusion === 'cancelled'
                    ? `A cancelled run has no verdict; re-run it with \`gh run rerun ${parentRun.id}\` and dispatch the release again.`
                    : 'Fix the failure with a new green commit and version.'),
            );
        }

        if (tier.requiresGatesOk) {
            let gatesConclusion;
            try {
                gatesConclusion = readGatesOkConclusion(parentRun.id, runCommand);
            } catch (error) {
                throw new Error(
                    `Release parent ${parentSha} ${describeRun(parentRun)} succeeded but the gates_ok lookup failed: ${
                        getCliErrorMessage(error)}`,
                );
            }
            if (gatesConclusion !== 'success') {
                throw new Error(
                    `Release parent ${parentSha} ${describeRun(parentRun)} did not contain a successful gates_ok `
                    + `aggregate (saw '${gatesConclusion ?? 'no gates_ok job'}').`,
                );
            }
            requiredRun = parentRun;
        }
    }

    if (!requiredRun) {
        throw new Error(`No required CI tier was configured for release parent ${parentSha}.`);
    }

    return {
        id: requiredRun.id,
        parentSha,
        url: requiredRun.html_url ?? '',
        verifiedByParent: true,
    };
}

/**
 * Waits for one tier's exact-SHA push run to reach a successful terminal
 * state. Throws distinct errors for: no run appearing, a known run exceeding
 * the completion deadline, a cancelled run (main moved on or a newer push
 * superseded it), a failed run (with its actual conclusion, promptly), and a
 * missing or failed gates_ok. A poll always immediately precedes a deadline
 * decision, so a run that turns terminal at the boundary is still observed.
 */
/** @param {string} targetSha @param {ICiTier} tier @param {ITierWaitContext} context @returns {Promise<{id: number, url: string}>} */
async function waitForTierRun(targetSha, tier, {
    appearanceTimeoutMs,
    completionTimeoutMs,
    pollIntervalMs,
    nowFn,
    sleepFn,
    runCommand,
    stderr,
}) {
    const startedAt = nowFn();
    let knownRun = null;

    while (true) {
        try {
            const latestRun = findLatestMatchingRun(targetSha, runCommand, tier.workflow);
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
                    `${tier.label} ${describeRun(knownRun)} for ${targetSha} was cancelled, so it has no `
                    + 'verdict. Release from the current main tip, or re-run it with '
                    + `\`gh run rerun ${knownRun.id}\`.`,
                );
            }
            if (knownRun.conclusion !== 'success') {
                throw new Error(
                    `${tier.label} ${describeRun(knownRun)} for ${targetSha} concluded '${knownRun.conclusion}'.`,
                );
            }
            if (tier.requiresGatesOk) {
                let gatesConclusion;
                try {
                    gatesConclusion = readGatesOkConclusion(knownRun.id, runCommand);
                } catch (error) {
                    throw new Error(
                        `${tier.label} ${describeRun(knownRun)} succeeded but the gates_ok lookup failed: ${
                            error instanceof Error ? getCliErrorMessage(error).split('\n')[0] : String(error)}`,
                    );
                }
                if (gatesConclusion !== 'success') {
                    throw new Error(
                        `${tier.label} ${describeRun(knownRun)} did not contain a successful gates_ok aggregate `
                        + `(saw '${gatesConclusion ?? 'no gates_ok job'}').`,
                    );
                }
            }
            return {
                id: knownRun.id,
                url: knownRun.html_url ?? '',
            };
        }

        const elapsedMs = nowFn() - startedAt;
        if (!knownRun && elapsedMs >= appearanceTimeoutMs) {
            throw new Error(
                `No ${tier.workflow} push run appeared for release target ${targetSha} within `
                + `${Math.round(appearanceTimeoutMs / 1_000)}s, and it is not a version-only package.json commit `
                + `whose parent could vouch for it. Every push to main runs ${tier.workflow}; check the Actions `
                + 'page for that commit, or release a version-only commit over a green parent.',
            );
        }
        if (knownRun && elapsedMs >= completionTimeoutMs) {
            throw new Error(
                `${tier.label} ${describeRun(knownRun)} did not reach a terminal state within `
                + `${Math.round(completionTimeoutMs / 60_000)} minutes; the wait budget must stay `
                + 'ahead of the blocking CI job timeouts (see issue #109).',
            );
        }

        stderr.write(knownRun
            ? `Waiting for ${tier.workflow} ${describeRun(knownRun)} (status: ${knownRun.status}, `
                + `${Math.round(elapsedMs / 60_000)}m elapsed).\n`
            : `Waiting for a ${tier.workflow} run to appear for ${targetSha} (${Math.round(elapsedMs / 1_000)}s elapsed).\n`);
        await sleepFn(pollIntervalMs);
    }
}

/**
 * Resolves with {id, url} of the required tier's run once the target is
 * vouched for by every configured tier. A version-only release commit is
 * judged by its parent's runs at once, without waiting for runs that
 * [skip ci] guarantees will never appear. Any other target needs its own
 * exact-SHA push run per tier.
 *
 * The default is both tiers, because the caller that matters is the release
 * workflow and ci-extended.yml now carries proofs the required verdict does
 * not. Pass `tiers: REQUIRED_CI_TIERS` (CLI: --required-only) to ask only
 * whether the pushed commit itself is sound.
 */
/** @param {string} targetSha @param {IWaitOptions} [options] @returns {Promise<{id: number, url: string}>} */
export async function waitForExactShaCiGates(targetSha, {
    appearanceTimeoutMs = EXACT_SHA_CI_APPEARANCE_TIMEOUT_MS,
    completionTimeoutMs = EXACT_SHA_CI_COMPLETION_TIMEOUT_MS,
    pollIntervalMs = EXACT_SHA_CI_POLL_INTERVAL_MS,
    nowFn = Date.now,
    sleepFn = milliseconds => delay(milliseconds),
    runCommand = defaultCommandRunner,
    tiers = RELEASE_CI_TIERS,
    // Only .write is part of the contract; keep the option narrow so test
    // harnesses can satisfy it without impersonating process.stderr.
    stderr = {write: chunk => process.stderr.write(chunk)},
} = {}) {
    const versionOnlyParentSha = readVersionOnlyParent(targetSha, runCommand);
    if (versionOnlyParentSha !== null) {
        return verifyByParent(targetSha, versionOnlyParentSha, runCommand, tiers);
    }

    const context = {
        appearanceTimeoutMs,
        completionTimeoutMs,
        nowFn,
        pollIntervalMs,
        runCommand,
        sleepFn,
        stderr,
    };
    /** @type {{id: number, url: string} | null} */
    let requiredResult = null;
    for (const tier of tiers) {
        const result = await waitForTierRun(targetSha, tier, context);
        if (tier.requiresGatesOk) {
            requiredResult = result;
        }
    }
    if (!requiredResult) {
        throw new Error(`No required CI tier was configured for release target ${targetSha}.`);
    }
    return requiredResult;
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const argv = process.argv.slice(2);
    const requiredOnly = argv.includes('--required-only');
    const targetSha = argv.find(argument => !argument.startsWith('--'));
    if (typeof targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(targetSha)) {
        process.stderr.write('Usage: wait-for-exact-sha-ci.mjs <40-char target sha> [--required-only]\n');
        process.exit(1);
    }
    waitForExactShaCiGates(targetSha, requiredOnly ? {tiers: REQUIRED_CI_TIERS} : {})
        .then(({id}) => {
            process.stdout.write(`::notice::Release target ${targetSha} passed exact-SHA CI run ${id}.\n`);
        })
        .catch((error) => {
            process.stderr.write(`::error::${getCliErrorMessage(error)}\n`);
            process.exit(1);
        });
}
