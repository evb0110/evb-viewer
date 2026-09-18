import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {
    existsSync,
    mkdirSync,
} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {formatArtifactGroupList} from './artifact-groups.mjs';
import {
    listSuccessfulMainPushRuns,
    readGatesOkConclusion,
} from './wait-for-exact-sha-ci.mjs';
import {
    findWorkflowRun,
    getRepositoryUrlFromRunUrl,
    getRunArtifactsUrl,
    listWorkflowRuns,
    readWorkflowStartTimeoutMs,
    waitForWorkflowRunStart,
} from './github-workflow-run.mjs';
import {
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertVersionNotBehindAncestorRelease,
    assertTagAbsent,
    assertVersionOnlyPackageCommit,
    bumpVersion,
    compareReleaseVersions,
    createVersionOnlyCommit,
    errorMessage,
    fetchReleaseMain,
    getCommitParentSha,
    getExitStatus,
    getPublicationPolicyCheckArgs,
    getReleaseMainUpstream,
    isAncestorCommit,
    pushReleaseBranch,
    pushReleaseTag,
    readGreatestReleaseTag,
    readVersionAt,
    run,
    sleep,
    VALID_RELEASE_LEVELS,
} from './shared.mjs';

const WORKFLOW_HANDOFF_POLL_INTERVAL_MS = 5_000;
const ARTIFACT_CANARY_WORKFLOW_FILE = 'release-artifacts.yml';
// The extended push tier. gates_ok no longer aggregates the Electron
// end-to-end suites, browser integration, native save or the packaged Linux
// proof; they run here, so a candidate needs a completed successful run of
// this workflow for its own SHA on top of a green gates_ok. Lanes the
// changed-area classifier skipped inside that run count as success, exactly as
// they do for gates_ok. Its runs are listed generously because supersession
// cancels many of them.
const EXTENDED_CI_WORKFLOW_FILE = 'ci-extended.yml';
const EXTENDED_CI_RUN_LIST_LIMIT = 100;
const CARRY_VERSION_ATTEMPTS = 5;
const CARRY_VERSION_RETRY_DELAY_MS = 3_000;
const PUSH_RACE_ERROR_PATTERN = /non-fast-forward|fetch first|\[rejected\]|stale info|missing from this checkout/iu;
const RELEASE_WORKTREE_DIRECTORY = '.devkit/release';

/** @typedef {'mandatory' | 'advisory'} TArtifactEvidencePolicy */
/** @typedef {{conclusion?: string | null, createdAt?: string, databaseId?: number, headBranch?: string, headSha?: string, head_branch?: string, head_sha?: string, html_url?: string, id?: number, status?: string, url?: string}} IArtifactCanaryRun */
/** @typedef {{state: 'satisfied' | 'missing' | 'running' | 'failed', run?: IArtifactCanaryRun}} IArtifactCanaryEvidence */

/** @typedef {'patch' | 'minor' | 'major'} TReleaseLevel */
/** @typedef {{branch: string, ref: string, remote: string}} IUpstream */
/** @typedef {import('./wait-for-exact-sha-ci.mjs').IWorkflowRun} ICiRun */
/** @typedef {{run: ICiRun, sha: string}} IReleaseCandidate */
/** @typedef {{candidateCiRunId: number, candidateCiRunUrl: string, candidateSha: string, currentVersion: string, nextVersion: string, upstream: IUpstream}} IReleaseCutPlan */
/** @typedef {{isDraft: boolean, publishedAt: string | null, tagName: string, assets: unknown[]}} IGitHubRelease */
/** @typedef {{status?: string, conclusion?: string | null, url: string}} IWorkflowRun */
/** @typedef {{write: (chunk: string) => unknown}} IWritable */
/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {{branch: string, tag: string, targetSha: string}} IReleaseDispatch */
/** @typedef {{dispatchStartedAt: string, tag: string, targetSha: string}} IReleaseHandoff */
/** @typedef {{parentSha: string, tag: string, targetSha: string, upstream: IUpstream}} IReleaseCommitInput */
/** @typedef {{parentSha: string, subject: string, version: string}} IVersionCommitInput */
/** @typedef {{releaseParentSha: string, releaseSha: string, subject: string, tag: string, upstream: IUpstream, version: string}} ICarryVersionInput */
/** @typedef {{carried: boolean, sha: string}} ICarryVersionResult */
/** @typedef {{dispatchWorkflow?: (dispatch: IReleaseDispatch, runCommand: TCommandRunner) => void, printHandoff?: (handoff: IReleaseHandoff) => Promise<void>, pushReleaseTag?: typeof pushReleaseTag, runCommand?: TCommandRunner, scanPublication?: (parentSha: string, targetSha: string, runCommand: TCommandRunner) => void}} IPublishReleaseOptions */
/** @typedef {{attempts?: number, createCommitFn?: (input: IVersionCommitInput) => string, pushBranchFn?: typeof pushReleaseBranch, runCommand?: TCommandRunner, sleepFn?: (milliseconds: number) => Promise<void>, stderr?: IWritable}} ICarryVersionOptions */
/** @typedef {{nowFn?: () => number, readHandoffTimeoutMs?: () => number, sleepFn?: (milliseconds: number) => Promise<void>, stdout?: IWritable, waitForRun?: typeof waitForWorkflowRunStart}} IReleaseHandoffOptions */
/** @typedef {{
 *   artifactEvidence?: TArtifactEvidencePolicy | undefined,
 *   assertArtifactCanaryGreenFn?: (candidateSha: string, upstream: IUpstream, options?: {policy?: TArtifactEvidencePolicy, stderr?: IWritable | undefined}) => IArtifactCanaryEvidence,
 *   assertExtendedCiGreenFn?: (candidateSha: string, upstream: IUpstream, options?: {stderr?: IWritable | undefined}) => IArtifactCanaryEvidence,
 *   assertCurrentReleaseIsNotDraftFn?: (tag: string) => void,
 *   assertGitHubCliReadyFn?: (context: string, options?: object) => Promise<void>,
 *   assertNodeBaselineFn?: (context: string) => void,
 *   assertTagAbsentFn?: (tag: string, remote: string) => Promise<void>,
 *   assertVersionNotBehindAncestorFn?: (version: string, sha: string, options: {remote: string, runCommand: TCommandRunner}) => void,
 *   carryVersionToMainFn?: (input: ICarryVersionInput, options?: ICarryVersionOptions) => Promise<ICarryVersionResult>,
 *   context?: string,
 *   createReleaseCommitFn?: (input: IVersionCommitInput) => string,
 *   fastForwardLocalMainFn?: (upstream: IUpstream) => void,
 *   fetchReleaseMainFn?: (upstream: IUpstream) => void,
 *   fetchReleaseTagsFn?: (upstream: IUpstream) => void,
 *   findActiveReleaseRunFn?: (tag: string) => import('./github-workflow-run.mjs').IWorkflowRun | null,
 *   getUpstreamFn?: (context: string) => IUpstream,
 *   isAncestorFn?: (ancestorSha: string, descendantRef: string) => boolean,
 *   level?: TReleaseLevel,
 *   releaseWorktreeFn?: (options: {candidateSha: string, operation: () => Promise<unknown>}) => Promise<unknown>,
 *   requiredCommits?: string[],
 *   requireCommits?: string[],
 *   updateLocalMain?: boolean,
 *   publishOptions?: object,
 *   publishReleaseCommitFn?: typeof publishReleaseCommit,
 *   readGreatestReleaseTagFn?: () => {tag: string, version: string} | null,
 *   readReleaseFn?: (tag: string) => IGitHubRelease | null,
 *   readVersionAtFn?: (sha: string) => string,
 *   runCommand?: TCommandRunner,
 *   selectReleaseCandidateFn?: (upstream: IUpstream, options?: {requiredCommits?: string[]}) => IReleaseCandidate,
 *   stderr?: IWritable,
 * }} IReleaseOptions */

/** @param {string | undefined} value @returns {value is TReleaseLevel} */
function isReleaseLevel(value) {
    return value !== undefined && VALID_RELEASE_LEVELS.has(value);
}

export const ARTIFACT_EVIDENCE_POLICIES = new Set([
    'mandatory',
    'advisory',
]);

/** @param {string | undefined} value @returns {value is TArtifactEvidencePolicy} */
function isArtifactEvidencePolicy(value) {
    return value !== undefined && ARTIFACT_EVIDENCE_POLICIES.has(value);
}

/** @param {string[]} argv @returns {{artifactEvidence?: TArtifactEvidencePolicy | undefined, level: TReleaseLevel | null, requiredCommits: string[], resume: boolean}} */
export function parseCutReleaseArgs(argv) {
    const positional = [];
    const requiredCommits = [];
    let artifactEvidence;
    let resume = false;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index] ?? '';
        if (argument === '--resume') {
            resume = true;
            continue;
        }

        if (argument === '--require-commit') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--require-commit requires a commit SHA or ref.');
            }
            requiredCommits.push(value);
            index += 1;
            continue;
        }

        if (argument.startsWith('--require-commit=')) {
            const value = argument.slice('--require-commit='.length);
            if (!value) {
                throw new Error('--require-commit requires a commit SHA or ref.');
            }
            requiredCommits.push(value);
            continue;
        }

        let artifactEvidenceValue;
        if (argument === '--artifact-evidence') {
            artifactEvidenceValue = argv[index + 1];
            if (!artifactEvidenceValue || artifactEvidenceValue.startsWith('--')) {
                throw new Error('--artifact-evidence requires "mandatory" or "advisory".');
            }
            index += 1;
        } else if (argument.startsWith('--artifact-evidence=')) {
            artifactEvidenceValue = argument.slice('--artifact-evidence='.length);
        }
        if (artifactEvidenceValue !== undefined) {
            if (!isArtifactEvidencePolicy(artifactEvidenceValue)) {
                throw new Error(
                    `--artifact-evidence must be one of: ${Array.from(ARTIFACT_EVIDENCE_POLICIES).join(', ')}`,
                );
            }
            artifactEvidence = artifactEvidenceValue;
            continue;
        }

        if (argument.startsWith('--')) {
            throw new Error(`Unknown release option(s): ${argument}`);
        }

        positional.push(argument);
    }

    if (resume) {
        if (positional.length > 0) {
            throw new Error('Release resume does not accept a release level. Run `pnpm run release:resume`.');
        }
        if (requiredCommits.length > 0 || artifactEvidence !== undefined) {
            throw new Error('Release resume does not accept candidate or artifact-evidence options.');
        }

        return {
            artifactEvidence,
            level: null,
            requiredCommits,
            resume,
        };
    }

    const [
        level,
        ...extraArgs
    ] = positional;
    if (extraArgs.length > 0) {
        throw new Error(`Unexpected release argument(s): ${extraArgs.join(', ')}`);
    }

    if (!isReleaseLevel(level)) {
        throw new Error(
            `Expected release level to be one of: ${Array.from(VALID_RELEASE_LEVELS).join(', ')}`,
        );
    }

    return {
        artifactEvidence,
        level,
        requiredCommits,
        resume,
    };
}

/** @param {string} tag */
function getReleaseWorkflowDisplayTitles(tag) {
    return [
        `Release ${tag}`,
        `Release (${tag})`,
    ];
}

/** @param {IReleaseDispatch} dispatch */
export function getReleaseWorkflowDispatchArgs({
    branch,
    tag,
    targetSha,
}) {
    return [
        'workflow',
        'run',
        'release.yml',
        '--ref',
        branch,
        '--field',
        `tag=${tag}`,
        '--field',
        `target_ref=${targetSha}`,
    ];
}

/** @param {IReleaseDispatch} dispatch @param {TCommandRunner} [runCommand] */
function dispatchReleaseWorkflow({
    branch,
    tag,
    targetSha,
}, runCommand = run) {
    const dispatchOutput = runCommand('gh', getReleaseWorkflowDispatchArgs({
        branch,
        tag,
        targetSha,
    }));
    if (dispatchOutput.length > 0) {
        process.stdout.write(`${dispatchOutput}\n`);
    }
}

/** @param {unknown} error */
function isMissingReleaseError(error) {
    const status = getExitStatus(error);
    const message = errorMessage(error);

    return status === 1 && (
        message.length === 0
        || /not found|does not exist|could not find|HTTP 404/iu.test(message)
    );
}

/** @param {string} tag @param {{runCommand?: TCommandRunner}} [options] @returns {IGitHubRelease | null} */
export function readGitHubRelease(tag, {runCommand = run} = {}) {
    try {
        const payload = runCommand('gh', [
            'release',
            'view',
            tag,
            '--json',
            'isDraft,publishedAt,assets,tagName',
        ]);
        const release = JSON.parse(payload);

        return {
            assets: Array.isArray(release.assets) ? release.assets : [],
            isDraft: release.isDraft === true,
            publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : null,
            tagName: typeof release.tagName === 'string' ? release.tagName : tag,
        };
    } catch (error) {
        if (isMissingReleaseError(error)) {
            return null;
        }

        throw error;
    }
}

/** @param {string} tag @param {TCommandRunner} runCommand */
function assertCurrentReleaseIsNotDraft(tag, runCommand) {
    const release = readGitHubRelease(tag, {runCommand});
    if (release?.isDraft) {
        throw new Error(
            `Release ${tag} is still a draft. Run \`pnpm run release:resume\` or `
            + `\`pnpm run release:status ${tag}\` before cutting another version.`,
        );
    }
}

/** @param {TReleaseLevel} level @param {TArtifactEvidencePolicy | undefined} [requestedPolicy] @returns {TArtifactEvidencePolicy} */
export function getArtifactEvidencePolicy(level, requestedPolicy) {
    if (requestedPolicy !== undefined && !isArtifactEvidencePolicy(requestedPolicy)) {
        throw new Error(`Unsupported artifact evidence policy "${requestedPolicy}"`);
    }

    return requestedPolicy ?? (level === 'patch' ? 'mandatory' : 'advisory');
}

/** @param {IArtifactCanaryRun} runInfo @returns {string} */
function getWorkflowRunSha(runInfo) {
    return runInfo.headSha ?? runInfo.head_sha ?? '';
}

/** @param {IArtifactCanaryRun} runInfo @returns {number} */
function getWorkflowRunId(runInfo) {
    return runInfo.databaseId ?? runInfo.id ?? 0;
}

/** @param {IArtifactCanaryRun} runInfo @returns {string} */
function getWorkflowRunUrl(runInfo) {
    return runInfo.url ?? runInfo.html_url ?? `run ${getWorkflowRunId(runInfo)}`;
}

/** @param {IArtifactCanaryRun} runInfo @returns {number} */
function getWorkflowRunSortKey(runInfo) {
    const createdAt = Date.parse(String(runInfo.createdAt ?? ''));
    return Number.isFinite(createdAt) ? createdAt : getWorkflowRunId(runInfo);
}

/** @param {IArtifactCanaryRun[]} runs @param {string} candidateSha @returns {IArtifactCanaryRun | null} */
function findCandidateWorkflowRun(runs, candidateSha) {
    return runs
        .filter(runInfo => getWorkflowRunSha(runInfo) === candidateSha)
        .sort((left, right) => getWorkflowRunSortKey(left) - getWorkflowRunSortKey(right))
        .at(-1) ?? null;
}

/** @param {IArtifactCanaryRun} runInfo @returns {string} */
function describeWorkflowRun(runInfo) {
    return `run ${getWorkflowRunId(runInfo)} (${getWorkflowRunUrl(runInfo)})`;
}

/** @param {IArtifactCanaryRun | null} runInfo @returns {boolean} */
function isSatisfiedWorkflowRun(runInfo) {
    return runInfo?.status === 'completed' && runInfo.conclusion === 'success';
}

/**
 * Answers "does this commit have a completed successful run of this workflow"
 * for candidate selection. The run list is fetched once per cut and shared
 * across every candidate the selection considers.
 */
/** @param {string} workflowFile @param {TCommandRunner} runCommand @param {number} [limit] @returns {(sha: string) => boolean} */
export function createWorkflowEvidenceLookup(workflowFile, runCommand, limit = 20) {
    /** @type {IArtifactCanaryRun[] | undefined} */
    let runs;
    return sha => {
        runs ??= /** @type {IArtifactCanaryRun[]} */ (listWorkflowRuns(workflowFile, {
            limit,
            runCommand,
        }));
        return isSatisfiedWorkflowRun(findCandidateWorkflowRun(runs, sha));
    };
}

/** @param {TCommandRunner} runCommand @returns {(sha: string) => boolean} */
export function createArtifactEvidenceLookup(runCommand) {
    return createWorkflowEvidenceLookup(ARTIFACT_CANARY_WORKFLOW_FILE, runCommand);
}

/** @param {TCommandRunner} runCommand @returns {(sha: string) => boolean} */
export function createExtendedCiEvidenceLookup(runCommand) {
    return createWorkflowEvidenceLookup(EXTENDED_CI_WORKFLOW_FILE, runCommand, EXTENDED_CI_RUN_LIST_LIMIT);
}

/**
 * Push CI proves packaging on Linux only. Artifact evidence is deliberately
 * exact-SHA: this repository does not publish a separately verifiable
 * packaging-input tree hash, so a canary for another commit is not reusable.
 * Patch releases require a successful candidate canary unless the operator
 * explicitly selects the advisory policy.
 */
/** @param {string} candidateSha @param {IUpstream} upstream @param {TCommandRunner} runCommand @param {{policy?: TArtifactEvidencePolicy, stderr?: IWritable | undefined}} [options] @returns {IArtifactCanaryEvidence} */
export function assertArtifactCanaryGreen(candidateSha, upstream, runCommand, {
    policy = 'mandatory',
    stderr = {write: chunk => process.stderr.write(chunk)},
} = {}) {
    if (!isArtifactEvidencePolicy(policy)) {
        throw new Error(`Unsupported artifact evidence policy "${policy}"`);
    }
    const runs = /** @type {IArtifactCanaryRun[]} */ (listWorkflowRuns(ARTIFACT_CANARY_WORKFLOW_FILE, {runCommand}));
    const matching = findCandidateWorkflowRun(runs, candidateSha);
    if (matching && isSatisfiedWorkflowRun(matching)) {
        stderr.write(
            `Artifact canary satisfied for candidate ${candidateSha}: ${describeWorkflowRun(matching)}.\n`,
        );
        return {
            run: matching,
            state: 'satisfied',
        };
    }

    /** @type {'missing' | 'running' | 'failed'} */
    let state = 'missing';
    let detail = `no ${ARTIFACT_CANARY_WORKFLOW_FILE} run has head_sha ${candidateSha} on ${upstream.ref}`;
    if (matching) {
        state = matching.status === 'completed' ? 'failed' : 'running';
        detail = `${describeWorkflowRun(matching)} is ${matching.status ?? 'in an unknown state'}`
            + (matching.status === 'completed' ? ` with conclusion '${matching.conclusion ?? 'missing'}'` : '');
    }

    const evidence = matching
        ? {
            run: matching,
            state,
        }
        : {state};
    const nextAction = state === 'missing'
        ? ` Next action: dispatch the canary for this candidate with \`gh workflow run ${ARTIFACT_CANARY_WORKFLOW_FILE} --ref ${upstream.branch} --field target_ref=${candidateSha}\` and rerun once it is green.`
        : state === 'running'
            ? ' Next action: wait for that run to finish, then rerun.'
            : ' Next action: fix the platform failure in that run, push, dispatch a new canary for the new candidate, and rerun.';
    const policySuffix = policy === 'mandatory'
        ? ' Pass --artifact-evidence=advisory to make this check non-blocking.'
        : ' This advisory result does not block the cut.';
    const message = `Artifact canary failed for candidate ${candidateSha}: ${detail}.`
        + ' Only a successful canary whose head_sha equals the candidate is accepted.'
        + nextAction
        + policySuffix;
    if (policy === 'mandatory') {
        throw new Error(message);
    }
    stderr.write(`${message}\n`);

    return evidence;
}

/**
 * The extended tier is not optional evidence: it holds the only Electron
 * end-to-end, browser integration, native save and packaged Linux proofs the
 * repository has, and `cancel-in-progress` means many commits carry a
 * cancelled run rather than a verdict. A cancelled run is repaired by rerunning
 * it, which keeps the same head SHA, so the message hands back that command
 * the way the artifact canary hands back its dispatch command.
 */
/** @param {string} candidateSha @param {IUpstream} upstream @param {TCommandRunner} runCommand @param {{stderr?: IWritable | undefined}} [options] @returns {IArtifactCanaryEvidence} */
export function assertExtendedCiGreen(candidateSha, upstream, runCommand, {stderr = {write: chunk => process.stderr.write(chunk)}} = {}) {
    const runs = /** @type {IArtifactCanaryRun[]} */ (listWorkflowRuns(EXTENDED_CI_WORKFLOW_FILE, {
        limit: EXTENDED_CI_RUN_LIST_LIMIT,
        runCommand,
    }));
    const matching = findCandidateWorkflowRun(runs, candidateSha);
    if (matching && isSatisfiedWorkflowRun(matching)) {
        stderr.write(
            `Extended CI satisfied for candidate ${candidateSha}: ${describeWorkflowRun(matching)}.\n`,
        );
        return {
            run: matching,
            state: 'satisfied',
        };
    }

    /** @type {'missing' | 'running' | 'failed'} */
    let state = 'missing';
    let detail = `no ${EXTENDED_CI_WORKFLOW_FILE} run has head_sha ${candidateSha}`;
    if (matching) {
        state = matching.status === 'completed' ? 'failed' : 'running';
        detail = `${describeWorkflowRun(matching)} is ${matching.status ?? 'in an unknown state'}`
            + (matching.status === 'completed' ? ` with conclusion '${matching.conclusion ?? 'missing'}'` : '');
    }

    const nextAction = state === 'missing'
        ? ` Next action: dispatch one with \`gh workflow run ${EXTENDED_CI_WORKFLOW_FILE} --ref ${upstream.branch}\``
            + ` while ${candidateSha} is the tip of ${upstream.branch}, or cut a newer candidate that has one.`
        : state === 'running'
            ? ' Next action: wait for that run to finish, then rerun the cut.'
            : matching?.conclusion === 'cancelled'
                ? ' Next action: a newer push superseded it, so it carries no verdict; re-run it with '
                    + `\`gh run rerun ${getWorkflowRunId(matching)}\` and rerun the cut once it is green.`
                : ' Next action: fix that failure with a new commit and cut from the new candidate.';
    throw new Error(
        `Extended CI evidence missing for candidate ${candidateSha}: ${detail}.`
        + ` Only a completed successful ${EXTENDED_CI_WORKFLOW_FILE} run whose head_sha equals the candidate is`
        + ' accepted; it carries the Electron end-to-end, browser integration, native save and packaged Linux'
        + ' proofs that gates_ok does not.'
        + nextAction,
    );
}

/**
 * The newest commit on main whose own push CI run succeeded with a green
 * gates_ok aggregate. This is what the release is built from. Main itself
 * has no owner of green: with dozens of pushes a day the tip is usually
 * unverified, and a cutter that insists on releasing the tip loses the race
 * against the next push. A verified ancestor is always available and never
 * moves.
 *
 * Evidence lookups narrow the choice further to the newest green commit that
 * also has the proofs gates_ok does not contain: `hasExtendedCiFn` for the
 * extended push tier, and `hasArtifactEvidenceFn` for the exact-SHA artifact
 * canary when artifact evidence is mandatory. The release ships what was
 * fully proved, not whatever landed since. Only when no green commit has all
 * of it does the newest green commit come back, so the checks below can name
 * it and the command that would qualify it.
 */
/** @param {IUpstream} upstream @param {{hasArtifactEvidenceFn?: (sha: string) => boolean, hasExtendedCiFn?: (sha: string) => boolean, isAncestorFn?: (ancestorSha: string, descendantRef: string) => boolean, listRunsFn?: (runCommand: TCommandRunner) => ICiRun[], readGatesFn?: (runId: number, runCommand: TCommandRunner) => string | undefined, requiredCommits?: string[], runCommand?: TCommandRunner}} [options] @returns {IReleaseCandidate} */
export function selectReleaseCandidate(upstream, {
    hasArtifactEvidenceFn,
    hasExtendedCiFn,
    isAncestorFn,
    listRunsFn = listSuccessfulMainPushRuns,
    readGatesFn = readGatesOkConclusion,
    requiredCommits = [],
    runCommand = run,
} = {}) {
    const isAncestor = isAncestorFn ?? (
        (ancestorSha, descendantRef) => isAncestorCommit(ancestorSha, descendantRef, {runCommand})
    );
    /** @param {string} sha */
    const containsRequiredCommits = sha => requiredCommits.every(requiredCommit => isAncestor(requiredCommit, sha));
    const runs = listRunsFn(runCommand);
    /** @type {string[]} */
    const rejected = [];
    /**
     * Green runs on main missing some release evidence, newest first. Their
     * gates are read only when no fully evidenced commit qualifies.
     * @type {ICiRun[]}
     */
    const untestedRuns = [];
    /** @type {IReleaseCandidate[]} */
    const greenCandidates = [];

    /** @param {ICiRun} runInfo @returns {IReleaseCandidate | null} */
    const qualifyGreen = runInfo => {
        const sha = runInfo.head_sha ?? '';
        const gates = readGatesFn(runInfo.id, runCommand);
        if (gates !== 'success') {
            rejected.push(`${sha.slice(0, 9)} gates_ok '${gates ?? 'missing'}' (${runInfo.html_url ?? `run ${runInfo.id}`})`);
            return null;
        }

        return {
            run: runInfo,
            sha,
        };
    };

    for (const runInfo of runs) {
        const sha = runInfo.head_sha;
        if (!sha) {
            continue;
        }
        if (!isAncestor(sha, upstream.ref)) {
            rejected.push(`${sha.slice(0, 9)} is not on ${upstream.ref}`);
            continue;
        }
        if (hasExtendedCiFn && !hasExtendedCiFn(sha)) {
            untestedRuns.push(runInfo);
            continue;
        }
        if (hasArtifactEvidenceFn && !hasArtifactEvidenceFn(sha)) {
            untestedRuns.push(runInfo);
            continue;
        }
        const candidate = qualifyGreen(runInfo);
        if (!candidate) {
            continue;
        }
        greenCandidates.push(candidate);
        if (requiredCommits.length === 0) {
            return candidate;
        }
        if (greenCandidates.length === 1 && containsRequiredCommits(sha)) {
            return candidate;
        }
        // A newer green candidate was already selected but did not contain
        // the required commits. Report that mismatch instead of silently
        // cutting the older candidate that does.
    }

    const untestedCandidates = untestedRuns
        .map(runInfo => qualifyGreen(runInfo))
        .filter(candidate => candidate !== null);
    const newestUntestedWithRequired = untestedCandidates.find(candidate => containsRequiredCommits(candidate.sha));

    if (greenCandidates.length > 0) {
        const selected = greenCandidates.at(0);
        if (!selected) {
            throw new Error('No green release candidate remained after required-commit evaluation.');
        }
        const selectedMissing = requiredCommits.filter(requiredCommit => (
            !isAncestor(requiredCommit, selected.sha)
        ));
        const matching = greenCandidates.find(candidate => containsRequiredCommits(candidate.sha));
        const selectedRun = `ci.yml run ${selected.run.id} (${selected.run.html_url ?? `run ${selected.run.id}`})`;
        const missingText = selectedMissing.join(', ');
        const alternative = matching
            ? ` Newest green candidate containing every required commit is ${matching.sha} `
                + `(ci.yml run ${matching.run.id}, ${matching.run.html_url ?? `run ${matching.run.id}`}), `
                + 'but the selected newest green candidate is not that commit.'
            : newestUntestedWithRequired
                ? ` No green candidate with the required ${EXTENDED_CI_WORKFLOW_FILE} and `
                    + `${ARTIFACT_CANARY_WORKFLOW_FILE} evidence contains every required commit yet. The newest `
                    + `green candidate that does is ${newestUntestedWithRequired.sha} `
                    + `(ci.yml run ${newestUntestedWithRequired.run.id}); the evidence check below names what it `
                    + 'is missing and the command that qualifies it.'
                : ' No green candidate in the available CI history contains every required commit yet.';
        throw new Error(
            `Selected green release candidate ${selected.sha} (${selectedRun}) does not contain required commit(s): `
            + `${missingText}.${alternative}`,
        );
    }

    if (newestUntestedWithRequired) {
        // No green commit has every piece of evidence. Hand back the newest
        // green commit so the evidence checks name it and their commands.
        return newestUntestedWithRequired;
    }

    if (untestedCandidates.length > 0) {
        throw new Error(
            `Selected green release candidate ${untestedCandidates[0]?.sha} does not contain required commit(s): `
            + `${requiredCommits.join(', ')}. No green candidate in the available CI history contains every `
            + 'required commit yet.',
        );
    }

    throw new Error(
        `No commit on ${upstream.ref} has a successful ci.yml push run with a green gates_ok among the newest `
        + `${runs.length} successful runs. Fix main or wait for its CI, then cut again.`
        + (rejected.length > 0 ? ` Rejected: ${rejected.join('; ')}.` : ''),
    );
}

/**
 * A release must ship something newer than the last one. The last release's
 * base is its tag commit when the cutter pushed that commit to main, and the
 * tag commit's parent when the release was pinned to an older candidate.
 */
/** @param {string} candidateSha @param {{tag: string}} previousRelease @param {IUpstream} upstream @param {{isAncestorFn: (ancestorSha: string, descendantRef: string) => boolean, runCommand: TCommandRunner}} options */
function assertCandidateSucceedsRelease(candidateSha, previousRelease, upstream, {
    isAncestorFn,
    runCommand,
}) {
    let tagSha;
    try {
        tagSha = runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/tags/${previousRelease.tag}^{commit}`,
        ]);
    } catch (error) {
        if (getExitStatus(error) === 1) {
            return;
        }
        throw error;
    }
    const baseSha = isAncestorFn(tagSha, upstream.ref)
        ? tagSha
        : getCommitParentSha(tagSha, {
            fetchParent: false,
            runCommand,
        });
    if (baseSha === candidateSha || !isAncestorFn(baseSha, candidateSha)) {
        throw new Error(
            `Release candidate ${candidateSha} is not newer than ${previousRelease.tag} (built from ${baseSha}). `
            + `No green commit on ${upstream.ref} has landed since that release; nothing to cut.`,
        );
    }
}

// Both entry points share the same first checks. Release operations resolve the
// canonical main upstream without inspecting the caller's branch or worktree;
// the actual mutation happens only in the owned detached worktree below.
/** @param {IReleaseOptions} options @param {string} context */
async function assertReleaseEntryPreconditions(options, context) {
    const runCommand = options.runCommand ?? run;
    const assertNodeBaselineFn = options.assertNodeBaselineFn ?? assertNodeProjectBaseline;
    const assertGitHubCliReadyFn = options.assertGitHubCliReadyFn ?? assertGitHubCliReady;
    const getUpstreamFn = options.getUpstreamFn ?? (
        context => getReleaseMainUpstream(context, {
            requireCurrentBranch: false,
            runCommand,
        })
    );

    assertNodeBaselineFn(context);
    const upstream = getUpstreamFn(context);
    await assertGitHubCliReadyFn(context, {runCommand});

    return {
        runCommand,
        upstream,
    };
}

/**
 * Decides what the next release is built from without waiting on anything:
 * every answer is a lookup against finished CI, so the same call serves the
 * preflight and the cut.
 */
/** @param {IReleaseOptions} [options] @returns {Promise<IReleaseCutPlan>} */
export async function assertReleaseCutPreconditions(options = {}) {
    const context = options.context ?? 'Release cut';
    const level = options.level ?? 'patch';
    const requiredCommits = options.requiredCommits ?? options.requireCommits ?? [];
    const {
        runCommand,
        upstream,
    } = await assertReleaseEntryPreconditions(options, context);
    const fetchReleaseMainFn = options.fetchReleaseMainFn ?? (
        upstream => fetchReleaseMain(upstream, {runCommand})
    );
    const isAncestorFn = options.isAncestorFn ?? (
        (ancestorSha, descendantRef) => isAncestorCommit(ancestorSha, descendantRef, {runCommand})
    );
    const artifactEvidencePolicy = getArtifactEvidencePolicy(level, options.artifactEvidence);
    const selectReleaseCandidateFn = options.selectReleaseCandidateFn ?? (
        upstream => selectReleaseCandidate(upstream, {
            ...artifactEvidencePolicy === 'mandatory'
                ? {hasArtifactEvidenceFn: createArtifactEvidenceLookup(runCommand)}
                : {},
            hasExtendedCiFn: createExtendedCiEvidenceLookup(runCommand),
            isAncestorFn,
            runCommand,
            requiredCommits,
        })
    );
    const readVersionAtFn = options.readVersionAtFn ?? (sha => readVersionAt(sha, {runCommand}));
    const assertVersionNotBehindAncestorFn = options.assertVersionNotBehindAncestorFn ?? (
        (version, sha, ancestorOptions) => assertVersionNotBehindAncestorRelease(version, sha, ancestorOptions)
    );
    const readGreatestReleaseTagFn = options.readGreatestReleaseTagFn ?? (() => readGreatestReleaseTag({runCommand}));
    const assertArtifactCanaryGreenFn = options.assertArtifactCanaryGreenFn ?? (
        (candidateSha, upstream, artifactOptions) => assertArtifactCanaryGreen(
            candidateSha,
            upstream,
            runCommand,
            artifactOptions,
        )
    );
    const assertExtendedCiGreenFn = options.assertExtendedCiGreenFn ?? (
        (candidateSha, upstream, extendedOptions) => assertExtendedCiGreen(
            candidateSha,
            upstream,
            runCommand,
            extendedOptions,
        )
    );
    const assertCurrentReleaseIsNotDraftFn = options.assertCurrentReleaseIsNotDraftFn ?? (
        tag => assertCurrentReleaseIsNotDraft(tag, runCommand)
    );
    const assertTagAbsentFn = options.assertTagAbsentFn ?? (
        (tag, remote) => assertTagAbsent(tag, remote, {runCommand})
    );

    fetchReleaseMainFn(upstream);
    const candidate = selectReleaseCandidateFn(upstream, {requiredCommits});
    const candidateVersion = readVersionAtFn(candidate.sha);
    // Fetches tags (and unshallows) as a side effect; the tag reads below rely on it.
    assertVersionNotBehindAncestorFn(candidateVersion, candidate.sha, {
        remote: upstream.remote,
        runCommand,
    });
    const previousRelease = readGreatestReleaseTagFn();
    // The candidate can predate the last release's version carry to main, so
    // its package.json alone would repeat a released version.
    const currentVersion = previousRelease && compareReleaseVersions(previousRelease.version, candidateVersion) > 0
        ? previousRelease.version
        : candidateVersion;
    if (previousRelease) {
        assertCandidateSucceedsRelease(candidate.sha, previousRelease, upstream, {
            isAncestorFn,
            runCommand,
        });
    }
    const artifactEvidenceOptions = options.stderr === undefined
        ? {policy: artifactEvidencePolicy}
        : {
            policy: artifactEvidencePolicy,
            stderr: options.stderr,
        };
    assertExtendedCiGreenFn(
        candidate.sha,
        upstream,
        options.stderr === undefined ? {} : {stderr: options.stderr},
    );
    assertArtifactCanaryGreenFn(candidate.sha, upstream, artifactEvidenceOptions);
    const nextVersion = bumpVersion(currentVersion, level);
    const nextTag = `v${nextVersion}`;

    assertCurrentReleaseIsNotDraftFn(`v${currentVersion}`);
    await assertTagAbsentFn(nextTag, upstream.remote);

    return {
        candidateCiRunId: candidate.run.id,
        candidateCiRunUrl: candidate.run.html_url ?? `run ${candidate.run.id}`,
        candidateSha: candidate.sha,
        currentVersion,
        nextVersion,
        upstream,
    };
}

/** @param {string} parentSha @param {string} targetSha @param {TCommandRunner} runCommand */
function scanReleaseCommitPublication(parentSha, targetSha, runCommand) {
    runCommand('node', getPublicationPolicyCheckArgs(parentSha, targetSha), {stdio: 'inherit'});
}

/**
 * Publishes the release commit by pushing the release tag at it and
 * dispatching the release workflow against exactly that SHA. The commit
 * hangs off its verified parent on main; the tag is what makes it public,
 * so the publication policy scan covers that one commit first and a failing
 * scan leaves the tag and the dispatch undone. The tag is pushed here
 * because the workflow's own token cannot create it once a later commit
 * changed `.github/workflows/` on main.
 */
/** @param {IReleaseCommitInput} input @param {IPublishReleaseOptions} [options] @returns {Promise<string>} */
export async function publishReleaseCommit({
    parentSha,
    tag,
    targetSha,
    upstream,
}, {
    dispatchWorkflow = dispatchReleaseWorkflow,
    printHandoff = printReleaseWorkflowHandoff,
    pushReleaseTag: pushReleaseTagFn = pushReleaseTag,
    runCommand = run,
    scanPublication = scanReleaseCommitPublication,
} = {}) {
    scanPublication(parentSha, targetSha, runCommand);

    pushReleaseTagFn({
        tag,
        targetSha,
        upstream,
    }, {runCommand});

    const dispatchStartedAt = new Date().toISOString();
    dispatchWorkflow({
        branch: upstream.branch,
        tag,
        targetSha,
    }, runCommand);
    await printHandoff({
        dispatchStartedAt,
        tag,
        targetSha,
    });

    return targetSha;
}

/**
 * Brings the released version to main so the next cut and every reader of
 * package.json agree with the newest tag. When main still sits at the
 * release parent, the release commit itself fast-forwards main, exactly as
 * before pinning. When main moved on, a fresh version-only commit on the
 * current tip carries the number instead. A push that loses to another
 * writer is retried from the new tip; the release is already tagged and
 * dispatched by now, so losing every retry leaves main behind by one
 * version line and nothing else.
 */
/** @param {ICarryVersionInput} input @param {ICarryVersionOptions} [options] @returns {Promise<ICarryVersionResult>} */
export async function carryVersionToMain({
    releaseParentSha,
    releaseSha,
    subject,
    tag,
    upstream,
    version,
}, {
    attempts = CARRY_VERSION_ATTEMPTS,
    createCommitFn,
    pushBranchFn = pushReleaseBranch,
    runCommand = run,
    sleepFn = sleep,
    stderr = process.stderr,
} = {}) {
    const createCommit = createCommitFn ?? (input => createVersionOnlyCommit(input, {runCommand}));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        fetchReleaseMain(upstream, {runCommand});
        const tipSha = runCommand('git', [
            'rev-parse',
            upstream.ref,
        ]);
        if (compareReleaseVersions(readVersionAt(tipSha, {runCommand}), version) >= 0) {
            return {
                carried: false,
                sha: tipSha,
            };
        }
        const carrySha = tipSha === releaseParentSha
            ? releaseSha
            : createCommit({
                parentSha: tipSha,
                subject,
                version,
            });
        try {
            pushBranchFn({
                targetSha: carrySha,
                upstream,
            }, {runCommand});
            return {
                carried: true,
                sha: carrySha,
            };
        } catch (error) {
            const message = errorMessage(error);
            if (attempt < attempts && PUSH_RACE_ERROR_PATTERN.test(message)) {
                stderr.write(
                    `Carrying version ${version} to ${upstream.ref} lost a push race `
                    + `(attempt ${attempt}/${attempts}); refetching and retrying.\n`,
                );
                await sleepFn(CARRY_VERSION_RETRY_DELAY_MS);
                continue;
            }
            throw new Error(
                `Release ${tag} is tagged and dispatched, but carrying version ${version} to ${upstream.ref} failed: `
                + `${message.split('\n')[0]}. Run \`pnpm run release:resume\` to retry the carry; the next cut reads `
                + 'the newest tag, so a stale package.json on main cannot reuse the version.',
            );
        }
    }
    throw new Error(`Carrying version ${version} to ${upstream.ref} did not finish within ${attempts} attempts.`);
}

/**
 * Optional local convenience helper. Release entry points do not call this by
 * default because the caller's branch and worktree belong to the operator.
 * An explicit caller may use it after the release-owned worktree succeeds.
 */
/** @param {IUpstream} upstream @param {{runCommand?: TCommandRunner, stderr?: IWritable}} [options] */
export function fastForwardLocalMain(upstream, {
    runCommand = run,
    stderr = process.stderr,
} = {}) {
    try {
        runCommand('git', [
            'merge',
            '--ff-only',
            upstream.ref,
        ], {stdio: 'inherit'});
    } catch (error) {
        stderr.write(
            `Local ${upstream.branch} was not fast-forwarded to ${upstream.ref}: `
            + `${errorMessage(error).split('\n')[0]}. Reconcile it with \`git pull --ff-only\` when convenient.\n`,
        );
    }
}

/** @param {TCommandRunner} runCommand @returns {string} */
function getRepositoryRoot(runCommand) {
    return path.resolve(runCommand('git', [
        'rev-parse',
        '--show-toplevel',
    ]));
}

/**
 * Runs a release mutation in a detached worktree owned by this release
 * attempt. A failed attempt retains the worktree for inspection; a successful
 * attempt unregisters and removes exactly that worktree. The caller's cwd and
 * branch are restored before either outcome is reported.
 */
/** @param {{candidateSha: string, operation: () => Promise<unknown>, runCommand?: TCommandRunner, stderr?: IWritable | undefined}} options @returns {Promise<unknown>} */
async function runInReleaseWorktree({
    candidateSha,
    operation,
    runCommand = run,
    stderr = process.stderr,
}) {
    const callerCwd = process.cwd();
    const releaseRoot = path.join(getRepositoryRoot(runCommand), RELEASE_WORKTREE_DIRECTORY);
    mkdirSync(releaseRoot, {recursive: true});
    const worktreePath = path.join(
        releaseRoot,
        `candidate-${candidateSha.slice(0, 12)}-${process.pid}-${Date.now()}`,
    );
    if (existsSync(worktreePath)) {
        throw new Error(`Release worktree path already exists: ${worktreePath}`);
    }

    runCommand('git', [
        'worktree',
        'add',
        '--detach',
        worktreePath,
        candidateSha,
    ], {stdio: 'inherit'});

    let completed = false;
    try {
        process.chdir(worktreePath);
        const result = await operation();
        completed = true;
        return result;
    } finally {
        process.chdir(callerCwd);
        if (completed) {
            runCommand('git', [
                'worktree',
                'remove',
                '--force',
                worktreePath,
            ], {stdio: 'inherit'});
        } else {
            stderr.write(
                `Release attempt failed; retaining its detached worktree at ${worktreePath} for inspection.\n`,
            );
        }
    }
}

/** @param {IReleaseOptions} options @param {string} context @param {TCommandRunner} runCommand @returns {IUpstream} */
function getReleaseUpstream(options, context, runCommand) {
    const getUpstreamFn = options.getUpstreamFn ?? (
        contextName => getReleaseMainUpstream(contextName, {
            requireCurrentBranch: false,
            runCommand,
        })
    );
    return getUpstreamFn(context);
}

/** @param {{runUrl: string, tag: string}} options */
function getReleaseUrl({
    runUrl,
    tag,
}) {
    const repositoryUrl = getRepositoryUrlFromRunUrl(runUrl);

    if (!repositoryUrl) {
        return '';
    }

    return `${repositoryUrl}/releases/tag/${encodeURIComponent(tag)}`;
}

/** @param {IReleaseHandoff} handoff @param {IReleaseHandoffOptions} [options] @returns {Promise<void>} */
export async function printReleaseWorkflowHandoff({
    dispatchStartedAt,
    tag,
    targetSha,
}, {
    nowFn = Date.now,
    readHandoffTimeoutMs = readWorkflowStartTimeoutMs,
    sleepFn = runSleep,
    stdout = process.stdout,
    waitForRun = waitForWorkflowRunStart,
} = {}) {
    const handoffDeadline = nowFn() + readHandoffTimeoutMs();
    let runInfo;

    // The workflow is dispatched with `--ref main`, so the run's head SHA is
    // the main tip, not the release commit. The run name `Release <tag>` and
    // the dispatch time identify it; matching on the head SHA never succeeds.
    while (true) {
        runInfo = await waitForRun({
            createdAfter: dispatchStartedAt,
            displayTitles: getReleaseWorkflowDisplayTitles(tag),
            label: `Release workflow for ${tag}`,
            workflow: 'Release',
        });
        if (runInfo.status === 'completed' && runInfo.conclusion != null) {
            if (runInfo.conclusion !== 'success') {
                throw new Error(
                    `Release workflow for ${tag} concluded as ${runInfo.conclusion} before handoff: ${runInfo.url}`,
                );
            }

            break;
        }
        if (runInfo.status === 'in_progress') {
            break;
        }
        if (nowFn() >= handoffDeadline) {
            throw new Error(
                `Timed out while waiting for release workflow ${tag} to start or conclude.`,
            );
        }

        await sleepFn(WORKFLOW_HANDOFF_POLL_INTERVAL_MS);
    }

    const releaseUrl = getReleaseUrl({
        runUrl: runInfo.url,
        tag,
    });

    stdout.write(`Release ${tag} queued for commit ${targetSha}.\n`);
    stdout.write(`GitHub Actions run: ${runInfo.url}\n`);
    stdout.write(`Actions artifacts, as they upload: ${getRunArtifactsUrl(runInfo.url)}\n`);
    if (releaseUrl) {
        stdout.write(`GitHub Release, after publish: ${releaseUrl}\n`);
    }
    stdout.write(`Expected artifact groups: ${formatArtifactGroupList()}\n`);
    stdout.write(`Check status: pnpm run release:status ${tag}\n`);
}

/**
 * A queued or running release for the tag. Dispatching a second run while
 * one is still going would publish the same tag twice, serialized by the
 * workflow's concurrency group rather than rejected.
 * @param {string} tag @param {{runCommand: TCommandRunner}} options
 */
function findActiveReleaseRun(tag, {runCommand}) {
    const runInfo = findWorkflowRun({
        displayTitles: getReleaseWorkflowDisplayTitles(tag),
        runCommand,
        workflow: 'Release',
    });

    return runInfo && runInfo.status !== 'completed' ? runInfo : null;
}

/** @param {number} milliseconds */
function runSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** @param {IUpstream} upstream @param {TCommandRunner} runCommand */
function fetchReleaseTags(upstream, runCommand) {
    runCommand('git', [
        'fetch',
        '--tags',
        upstream.remote,
    ], {stdio: 'inherit'});
}

/**
 * Repairs the newest release: pushes its tag if the cutter died before the
 * push, redispatches the workflow while the release is still a draft or
 * missing, and carries the version to main if that push lost every retry.
 * Nothing here needs the checkout to sit on any particular commit.
 */
/** @param {IReleaseOptions} options @param {IUpstream} upstream @param {{tag: string, version: string}} newest @param {string} targetSha @returns {Promise<void>} */
async function resumeReleaseInWorktree(options, upstream, newest, targetSha) {
    const context = options.context ?? 'Release resume';
    const worktreeOptions = {
        ...options,
        fetchReleaseMainFn: () => undefined,
        fetchReleaseTagsFn: () => undefined,
        getUpstreamFn: () => upstream,
    };
    const {runCommand} = await assertReleaseEntryPreconditions(worktreeOptions, context);
    const isAncestorFn = options.isAncestorFn ?? (
        (ancestorSha, descendantRef) => isAncestorCommit(ancestorSha, descendantRef, {runCommand})
    );
    const readReleaseFn = options.readReleaseFn ?? (
        tag => readGitHubRelease(tag, {runCommand})
    );
    const findActiveReleaseRunFn = options.findActiveReleaseRunFn ?? (
        tag => findActiveReleaseRun(tag, {runCommand})
    );
    const publishReleaseCommitFn = options.publishReleaseCommitFn ?? publishReleaseCommit;
    const carryVersionToMainFn = options.carryVersionToMainFn ?? carryVersionToMain;
    const stderr = options.stderr ?? process.stderr;

    const {
        tag,
        version,
    } = newest;
    const parentSha = getCommitParentSha(targetSha, {
        fetchParent: false,
        runCommand,
    });
    assertVersionOnlyPackageCommit(parentSha, targetSha, {
        context: 'Release resume',
        runCommand,
    });
    if (!isAncestorFn(parentSha, upstream.ref)) {
        throw new Error(
            `Release resume requires the parent ${parentSha} of ${tag} to be on ${upstream.ref}.`,
        );
    }

    const release = readReleaseFn(tag);
    const isPublic = release !== null && !release.isDraft;
    const activeRun = isPublic ? null : findActiveReleaseRunFn(tag);
    if (isPublic) {
        stderr.write(`Release ${tag} is already public; checking that ${upstream.ref} carries ${version}.\n`);
    } else if (activeRun) {
        stderr.write(
            `Release ${tag} already has a ${activeRun.status} workflow run; not dispatching another: ${activeRun.url}\n`,
        );
    } else {
        await publishReleaseCommitFn({
            parentSha,
            tag,
            targetSha,
            upstream,
        }, {
            ...options.publishOptions,
            runCommand,
        });
    }
    const carry = await carryVersionToMainFn({
        releaseParentSha: parentSha,
        releaseSha: targetSha,
        subject: `release: ${version} [skip ci]`,
        tag,
        upstream,
        version,
    }, {runCommand});
    if (isPublic && !carry.carried) {
        throw new Error(
            `Release ${tag} is already public and ${upstream.ref} carries ${version}. `
            + `Run \`pnpm run release:status ${tag}\` to inspect it.`,
        );
    }
}

/** @param {IReleaseOptions} [options] @returns {Promise<void>} */
export async function resumeRelease(options = {}) {
    const runCommand = options.runCommand ?? run;
    const context = options.context ?? 'Release resume';
    const upstream = getReleaseUpstream(options, context, runCommand);
    const fetchReleaseMainFn = options.fetchReleaseMainFn ?? (
        upstreamRef => fetchReleaseMain(upstreamRef, {runCommand})
    );
    const fetchReleaseTagsFn = options.fetchReleaseTagsFn ?? (
        upstreamRef => fetchReleaseTags(upstreamRef, runCommand)
    );
    const readGreatestReleaseTagFn = options.readGreatestReleaseTagFn ?? (
        () => readGreatestReleaseTag({runCommand})
    );

    fetchReleaseMainFn(upstream);
    fetchReleaseTagsFn(upstream);
    const newest = readGreatestReleaseTagFn();
    if (!newest) {
        throw new Error(`Release resume found no release tag on ${upstream.remote}; run \`pnpm run release:cut\` instead.`);
    }
    const targetSha = runCommand('git', [
        'rev-parse',
        '--verify',
        `refs/tags/${newest.tag}^{commit}`,
    ]);
    const releaseWorktreeFn = options.releaseWorktreeFn ?? (
        worktreeOptions => runInReleaseWorktree({
            ...worktreeOptions,
            runCommand,
            stderr: options.stderr ?? process.stderr,
        })
    );

    await releaseWorktreeFn({
        candidateSha: targetSha,
        operation: () => resumeReleaseInWorktree(options, upstream, newest, targetSha),
    });
    if (options.updateLocalMain === true) {
        const fastForwardLocalMainFn = options.fastForwardLocalMainFn ?? (
            upstreamRef => fastForwardLocalMain(upstreamRef, {runCommand})
        );
        fastForwardLocalMainFn(upstream);
    }
}

/** @param {TReleaseLevel} level @param {IReleaseOptions} [options] @returns {Promise<void>} */
export async function cutRelease(level, options = {}) {
    const plan = await assertReleaseCutPreconditions({
        ...options,
        level,
    });
    const runCommand = options.runCommand ?? run;
    const createReleaseCommitFn = options.createReleaseCommitFn ?? (
        input => createVersionOnlyCommit(input, {runCommand})
    );
    const publishReleaseCommitFn = options.publishReleaseCommitFn ?? publishReleaseCommit;
    const carryVersionToMainFn = options.carryVersionToMainFn ?? carryVersionToMain;
    const stderr = options.stderr ?? process.stderr;
    const tag = `v${plan.nextVersion}`;
    const subject = `release: ${plan.nextVersion} [skip ci]`;

    stderr.write(
        `Cutting ${tag} from candidate ${plan.candidateSha} `
        + `(ci.yml run ${plan.candidateCiRunId}: ${plan.candidateCiRunUrl}; newest green commit on ${plan.upstream.ref}).\n`,
    );
    const releaseWorktreeFn = options.releaseWorktreeFn ?? (
        worktreeOptions => runInReleaseWorktree({
            ...worktreeOptions,
            runCommand,
            stderr,
        })
    );

    await releaseWorktreeFn({
        candidateSha: plan.candidateSha,
        operation: async () => {
            const releaseSha = createReleaseCommitFn({
                parentSha: plan.candidateSha,
                subject,
                version: plan.nextVersion,
            });
            await publishReleaseCommitFn({
                parentSha: plan.candidateSha,
                tag,
                targetSha: releaseSha,
                upstream: plan.upstream,
            }, {
                ...options.publishOptions,
                runCommand,
            });
            await carryVersionToMainFn({
                releaseParentSha: plan.candidateSha,
                releaseSha,
                subject,
                tag,
                upstream: plan.upstream,
                version: plan.nextVersion,
            }, {runCommand});
        },
    });
    if (options.updateLocalMain === true) {
        const fastForwardLocalMainFn = options.fastForwardLocalMainFn ?? (
            upstream => fastForwardLocalMain(upstream, {runCommand})
        );
        fastForwardLocalMainFn(plan.upstream);
    }
}

/** @returns {Promise<void>} */
async function main() {
    const args = parseCutReleaseArgs(process.argv.slice(2));
    if (args.resume) {
        await resumeRelease();
        return;
    }

    if (args.level === null) {
        throw new Error('Release level is required unless --resume is used');
    }
    await cutRelease(args.level, {
        artifactEvidence: args.artifactEvidence,
        requiredCommits: args.requiredCommits,
    });
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    main().catch((error) => {
        const message = getCliErrorMessage(error);
        process.stderr.write(`${message}\n`);
        process.exit(1);
    });
}
