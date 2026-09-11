import { getCliErrorMessage } from '../lib/cli-error.mjs';
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
    assertCleanWorktree,
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
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
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
const CARRY_VERSION_ATTEMPTS = 5;
const CARRY_VERSION_RETRY_DELAY_MS = 3_000;
const PUSH_RACE_ERROR_PATTERN = /non-fast-forward|fetch first|\[rejected\]|stale info|missing from this checkout/iu;

/** @typedef {'patch' | 'minor' | 'major'} TReleaseLevel */
/** @typedef {{branch: string, ref: string, remote: string}} IUpstream */
/** @typedef {import('./wait-for-exact-sha-ci.mjs').IWorkflowRun} ICiRun */
/** @typedef {{run: ICiRun, sha: string}} IReleaseCandidate */
/** @typedef {{candidateSha: string, currentVersion: string, nextVersion: string, upstream: IUpstream}} IReleaseCutPlan */
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
 *   assertArtifactCanaryGreenFn?: (upstream: IUpstream) => void,
 *   assertCleanWorktreeFn?: (options: {ignoredPathPrefixes: string[]}) => void,
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
 *   publishOptions?: object,
 *   publishReleaseCommitFn?: typeof publishReleaseCommit,
 *   readGreatestReleaseTagFn?: () => {tag: string, version: string} | null,
 *   readReleaseFn?: (tag: string) => IGitHubRelease | null,
 *   readVersionAtFn?: (sha: string) => string,
 *   runCommand?: TCommandRunner,
 *   selectReleaseCandidateFn?: (upstream: IUpstream) => IReleaseCandidate,
 *   stderr?: IWritable,
 * }} IReleaseOptions */

/** @param {string | undefined} value @returns {value is TReleaseLevel} */
function isReleaseLevel(value) {
    return value !== undefined && VALID_RELEASE_LEVELS.has(value);
}

/** @param {string[]} argv @returns {{level: TReleaseLevel | null, resume: boolean}} */
export function parseCutReleaseArgs(argv) {
    const knownFlags = new Set(['--resume']);
    const unknownFlags = argv.filter(arg => arg.startsWith('--') && !knownFlags.has(arg));
    if (unknownFlags.length > 0) {
        throw new Error(`Unknown release option(s): ${unknownFlags.join(', ')}`);
    }

    const resume = argv.includes('--resume');
    const positional = argv.filter(arg => !arg.startsWith('--'));

    if (resume) {
        if (positional.length > 0) {
            throw new Error('Release resume does not accept a release level. Run `pnpm run release:resume`.');
        }

        return {
            level: null,
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
        level,
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

/**
 * Push CI proves packaging on Linux only. The artifact canary builds the same
 * macOS and Windows matrix the release runs, so a red canary means the next
 * release fails at that platform step; refuse the cut here instead.
 */
/** @param {IUpstream} upstream @param {TCommandRunner} runCommand */
function assertArtifactCanaryGreen(upstream, runCommand) {
    const latest = listWorkflowRuns(ARTIFACT_CANARY_WORKFLOW_FILE, {runCommand})
        .find(runInfo => runInfo.headBranch === upstream.branch);
    if (!latest) {
        return;
    }
    const target = latest.headSha ?? 'an unknown commit';
    if (latest.status !== 'completed') {
        throw new Error(
            `The artifact canary (${ARTIFACT_CANARY_WORKFLOW_FILE}) is still running for ${target}. `
            + `Wait for it and cut again. Inspect: ${latest.url}`,
        );
    }
    if (latest.conclusion !== 'success') {
        throw new Error(
            `The latest artifact canary (${ARTIFACT_CANARY_WORKFLOW_FILE}) concluded `
            + `'${latest.conclusion}' for ${target}. The release builds the same platform matrix, `
            + 'so fix the cause, push, run `pnpm run release:artifacts` from the fixed main tip, '
            + `and cut once it passes. Inspect: ${latest.url}`,
        );
    }
}

/**
 * The newest commit on main whose own push CI run succeeded with a green
 * gates_ok aggregate. This is what the release is built from. Main itself
 * has no owner of green: with dozens of pushes a day the tip is usually
 * unverified, and a cutter that insists on releasing the tip loses the race
 * against the next push. A verified ancestor is always available and never
 * moves.
 */
/** @param {IUpstream} upstream @param {{isAncestorFn?: (ancestorSha: string, descendantRef: string) => boolean, listRunsFn?: (runCommand: TCommandRunner) => ICiRun[], readGatesFn?: (runId: number, runCommand: TCommandRunner) => string | undefined, runCommand?: TCommandRunner}} [options] @returns {IReleaseCandidate} */
export function selectReleaseCandidate(upstream, {
    isAncestorFn,
    listRunsFn = listSuccessfulMainPushRuns,
    readGatesFn = readGatesOkConclusion,
    runCommand = run,
} = {}) {
    const isAncestor = isAncestorFn ?? (
        (ancestorSha, descendantRef) => isAncestorCommit(ancestorSha, descendantRef, {runCommand})
    );
    const runs = listRunsFn(runCommand);
    const rejected = [];
    for (const runInfo of runs) {
        const sha = runInfo.head_sha;
        if (!sha) {
            continue;
        }
        if (!isAncestor(sha, upstream.ref)) {
            rejected.push(`${sha.slice(0, 9)} is not on ${upstream.ref}`);
            continue;
        }
        const gates = readGatesFn(runInfo.id, runCommand);
        if (gates !== 'success') {
            rejected.push(`${sha.slice(0, 9)} gates_ok '${gates ?? 'missing'}' (${runInfo.html_url ?? `run ${runInfo.id}`})`);
            continue;
        }
        return {
            run: runInfo,
            sha,
        };
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

// Both entry points share the same first checks, in an order that answers
// the cheapest question first: branch and upstream (two local git reads)
// before the network round trip to `gh auth status` and the worktree scan.
/** @param {IReleaseOptions} options @param {string} context */
async function assertReleaseEntryPreconditions(options, context) {
    const runCommand = options.runCommand ?? run;
    const assertNodeBaselineFn = options.assertNodeBaselineFn ?? assertNodeProjectBaseline;
    const assertGitHubCliReadyFn = options.assertGitHubCliReadyFn ?? assertGitHubCliReady;
    const assertCleanWorktreeFn = options.assertCleanWorktreeFn ?? (
        worktreeOptions => assertCleanWorktree({
            ...worktreeOptions,
            runCommand,
        })
    );
    const getUpstreamFn = options.getUpstreamFn ?? (
        context => getReleaseMainUpstream(context, {runCommand})
    );

    assertNodeBaselineFn(context);
    const upstream = getUpstreamFn(context);
    await assertGitHubCliReadyFn(context, {runCommand});
    assertCleanWorktreeFn({ignoredPathPrefixes: [...MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES]});

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
    const selectReleaseCandidateFn = options.selectReleaseCandidateFn ?? (
        upstream => selectReleaseCandidate(upstream, {
            isAncestorFn,
            runCommand,
        })
    );
    const readVersionAtFn = options.readVersionAtFn ?? (sha => readVersionAt(sha, {runCommand}));
    const assertVersionNotBehindAncestorFn = options.assertVersionNotBehindAncestorFn ?? (
        (version, sha, ancestorOptions) => assertVersionNotBehindAncestorRelease(version, sha, ancestorOptions)
    );
    const readGreatestReleaseTagFn = options.readGreatestReleaseTagFn ?? (() => readGreatestReleaseTag({runCommand}));
    const assertArtifactCanaryGreenFn = options.assertArtifactCanaryGreenFn ?? (
        upstream => assertArtifactCanaryGreen(upstream, runCommand)
    );
    const assertCurrentReleaseIsNotDraftFn = options.assertCurrentReleaseIsNotDraftFn ?? (
        tag => assertCurrentReleaseIsNotDraft(tag, runCommand)
    );
    const assertTagAbsentFn = options.assertTagAbsentFn ?? (
        (tag, remote) => assertTagAbsent(tag, remote, {runCommand})
    );

    fetchReleaseMainFn(upstream);
    const candidate = selectReleaseCandidateFn(upstream);
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
    assertArtifactCanaryGreenFn(upstream);
    const nextVersion = bumpVersion(currentVersion, options.level ?? 'patch');
    const nextTag = `v${nextVersion}`;

    assertCurrentReleaseIsNotDraftFn(`v${currentVersion}`);
    await assertTagAbsentFn(nextTag, upstream.remote);

    return {
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
 * The operator's checkout was clean and on main; catching it up to the tip
 * that now carries the version is the ordinary `git pull` they would run
 * next. A checkout with unpushed commits is left alone and told so.
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
/** @param {IReleaseOptions} [options] @returns {Promise<void>} */
export async function resumeRelease(options = {}) {
    const context = options.context ?? 'Release resume';
    const {
        runCommand,
        upstream,
    } = await assertReleaseEntryPreconditions(options, context);
    const fetchReleaseMainFn = options.fetchReleaseMainFn ?? (
        upstream => fetchReleaseMain(upstream, {runCommand})
    );
    const fetchReleaseTagsFn = options.fetchReleaseTagsFn ?? (upstream => fetchReleaseTags(upstream, runCommand));
    const readGreatestReleaseTagFn = options.readGreatestReleaseTagFn ?? (() => readGreatestReleaseTag({runCommand}));
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
    const fastForwardLocalMainFn = options.fastForwardLocalMainFn ?? (
        upstream => fastForwardLocalMain(upstream, {runCommand})
    );
    const stderr = options.stderr ?? process.stderr;

    fetchReleaseMainFn(upstream);
    fetchReleaseTagsFn(upstream);
    const newest = readGreatestReleaseTagFn();
    if (!newest) {
        throw new Error(`Release resume found no release tag on ${upstream.remote}; run \`pnpm run release:cut\` instead.`);
    }
    const {
        tag,
        version,
    } = newest;
    const targetSha = runCommand('git', [
        'rev-parse',
        '--verify',
        `refs/tags/${tag}^{commit}`,
    ]);
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
    fastForwardLocalMainFn(upstream);
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
    const fastForwardLocalMainFn = options.fastForwardLocalMainFn ?? (
        upstream => fastForwardLocalMain(upstream, {runCommand})
    );
    const stderr = options.stderr ?? process.stderr;
    const tag = `v${plan.nextVersion}`;
    const subject = `release: ${plan.nextVersion} [skip ci]`;

    stderr.write(`Cutting ${tag} from ${plan.candidateSha} (newest green commit on ${plan.upstream.ref}).\n`);
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
    fastForwardLocalMainFn(plan.upstream);
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
    await cutRelease(args.level);
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
