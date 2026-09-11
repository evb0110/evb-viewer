import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {formatArtifactGroupList} from './artifact-groups.mjs';
import {
    findLatestMatchingRun,
    waitForExactShaCiGates,
} from './wait-for-exact-sha-ci.mjs';
import {
    getRepositoryUrlFromRunUrl,
    getRunArtifactsUrl,
    listWorkflowRuns,
    readWorkflowStartTimeoutMs,
    waitForWorkflowRunStart,
} from './github-workflow-run.mjs';
import {
    assertChangedFilesMatch,
    assertCleanWorktree,
    assertGitHubCliReady,
    assertNodeProjectBaseline,
    assertReleaseMainTip,
    assertVersionNotBehindAncestorRelease,
    assertTagAbsent,
    assertVersionOnlyPackageCommit,
    bumpVersion,
    errorMessage,
    fetchReleaseMain,
    getCommitParentSha,
    getExitStatus,
    getReleaseMainUpstream,
    MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES,
    pushReleaseBranch,
    pushReleaseTag,
    readVersion,
    run,
    stageFiles,
    VALID_RELEASE_LEVELS,
    writeVersion,
} from './shared.mjs';

const WORKFLOW_HANDOFF_POLL_INTERVAL_MS = 5_000;
const ARTIFACT_CANARY_WORKFLOW_FILE = 'release-artifacts.yml';

/** @typedef {'patch' | 'minor' | 'major'} TReleaseLevel */
/** @typedef {{branch: string, ref: string, remote: string}} IUpstream */
/** @typedef {{headSha?: string, status?: string, conclusion?: string | null, html_url?: string, url?: string}} ICiRun */
/** @typedef {{headSha: string, upstreamSha: string}} IReleaseTip */
/** @typedef {{isDraft: boolean, publishedAt: string | null, tagName: string, assets: unknown[]}} IGitHubRelease */
/** @typedef {{status?: string, conclusion?: string | null, url: string}} IWorkflowRun */
/** @typedef {{write: (chunk: string) => unknown}} IWritable */
/** @typedef {(command: string, args: string[], options?: object) => string} TCommandRunner */
/** @typedef {(headSha: string, runCommand: TCommandRunner) => ICiRun | null} TFindCiRun */
/** @typedef {(headSha: string, runCommand: TCommandRunner) => Promise<unknown>} TWaitForCi */
/** @typedef {{branch: string, tag: string, targetSha: string}} IReleaseDispatch */
/** @typedef {{dispatchStartedAt: string, tag: string, targetSha: string}} IReleaseHandoff */
/** @typedef {{tag: string, targetSha?: string | undefined, upstream: IUpstream}} IReleaseCommitInput */
/** @typedef {{dispatchWorkflow?: (dispatch: IReleaseDispatch, runCommand: TCommandRunner) => void, printHandoff?: (handoff: IReleaseHandoff) => Promise<void>, push?: boolean, pushReleaseTag?: typeof pushReleaseTag, runCommand?: TCommandRunner}} IPublishReleaseOptions */
/** @typedef {{nowFn?: () => number, readHandoffTimeoutMs?: () => number, sleepFn?: (milliseconds: number) => Promise<void>, stdout?: IWritable, waitForRun?: typeof waitForWorkflowRunStart}} IReleaseHandoffOptions */
/** @typedef {{
 *   assertArtifactCanaryGreenFn?: (upstream: IUpstream) => void,
 *   assertChangedFilesMatchFn?: (expectedFiles: string[], options?: object) => void,
 *   assertCleanWorktreeFn?: (options: {ignoredPathPrefixes: string[]}) => void,
 *   assertCurrentReleaseIsNotDraftFn?: (tag: string) => void,
 *   assertGitHubCliReadyFn?: (context: string, options?: object) => Promise<void>,
 *   assertMainTipFn?: (upstream: IUpstream) => IReleaseTip | string,
 *   assertNodeBaselineFn?: (context: string) => void,
 *   assertReleaseIsNotDraftFn?: (tag: string) => void,
 *   assertTagAbsentFn?: (tag: string, remote: string) => Promise<void>,
 *   assertVersionNotBehindAncestorFn?: (version: string, sha: string, options: {remote: string, runCommand: TCommandRunner}) => void,
 *   context?: string,
 *   fetchReleaseMainFn?: (upstream: IUpstream) => void,
 *   findCiRunFn?: TFindCiRun,
 *   getUpstreamFn?: (context: string) => IUpstream,
 *   level?: TReleaseLevel,
 *   publishOptions?: object,
 *   publishReleaseCommitFn?: typeof publishReleaseCommit,
 *   readReleaseFn?: (tag: string) => IGitHubRelease | null,
 *   readVersionFn?: () => string,
 *   runCommand?: TCommandRunner,
 *   stageFilesFn?: (files: string[], options?: object) => void,
 *   waitForCiFn?: TWaitForCi,
 *   writeVersionFn?: (version: string) => void,
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

/** @param {{headSha: string, runCommand: TCommandRunner, findCiRunFn: TFindCiRun, waitForCiFn: TWaitForCi}} options */
async function assertHeadCiGreen({
    headSha,
    runCommand,
    findCiRunFn,
    waitForCiFn,
}) {
    const currentRun = findCiRunFn(headSha, runCommand);
    if (currentRun?.status === 'completed' && currentRun.conclusion !== 'success') {
        throw new Error(
            `The ci.yml run for HEAD ${headSha} concluded '${currentRun.conclusion}'. `
            + `Refusing the release. Inspect: ${currentRun.html_url ?? currentRun.url ?? 'no URL'}`,
        );
    }

    await waitForCiFn(headSha, runCommand);
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

/** @param {IReleaseOptions} [options] */
export async function assertReleaseCutPreconditions(options = {}) {
    const context = options.context ?? 'Release cut';
    const {
        runCommand,
        upstream,
    } = await assertReleaseEntryPreconditions(options, context);
    const assertMainTipFn = options.assertMainTipFn ?? (
        upstream => assertReleaseMainTip(upstream, {runCommand})
    );
    const findCiRunFn = options.findCiRunFn ?? (
        (headSha, commandRunner) => findLatestMatchingRun(headSha, commandRunner)
    );
    const waitForCiFn = options.waitForCiFn ?? (
        (headSha, commandRunner) => waitForExactShaCiGates(headSha, {runCommand: commandRunner})
    );
    const assertTagAbsentFn = options.assertTagAbsentFn ?? (
        (tag, remote) => assertTagAbsent(tag, remote, {runCommand})
    );
    const assertCurrentReleaseIsNotDraftFn = options.assertCurrentReleaseIsNotDraftFn ?? (
        tag => assertCurrentReleaseIsNotDraft(tag, runCommand)
    );
    const assertArtifactCanaryGreenFn = options.assertArtifactCanaryGreenFn ?? (
        upstream => assertArtifactCanaryGreen(upstream, runCommand)
    );
    const readVersionFn = options.readVersionFn ?? readVersion;
    const assertVersionNotBehindAncestorFn = options.assertVersionNotBehindAncestorFn ?? (
        (version, sha, ancestorOptions) => assertVersionNotBehindAncestorRelease(version, sha, ancestorOptions)
    );

    const tip = assertMainTipFn(upstream);
    const headSha = typeof tip === 'string' ? tip : tip.headSha;
    if (!headSha) {
        throw new Error('Release main-tip verification did not return a commit SHA');
    }
    const currentVersion = readVersionFn();

    assertVersionNotBehindAncestorFn(currentVersion, headSha, {
        remote: upstream.remote,
        runCommand,
    });

    await assertHeadCiGreen({
        findCiRunFn,
        headSha,
        runCommand,
        waitForCiFn,
    });
    assertArtifactCanaryGreenFn(upstream);
    const nextVersion = bumpVersion(currentVersion, options.level ?? 'patch');
    const nextTag = `v${nextVersion}`;

    assertCurrentReleaseIsNotDraftFn(`v${currentVersion}`);
    await assertTagAbsentFn(nextTag, upstream.remote);

    return {
        currentVersion,
        headSha,
        nextVersion,
        upstream,
    };
}

/**
 * Publishes the release commit, pushes the release tag at that commit, and
 * dispatches the release workflow against exactly that SHA.
 * `pushReleaseBranch` runs the publication policy scan first and throws on a
 * violation, so a failing scan leaves the push, the tag, and the dispatch
 * undone. The tag is pushed here because the workflow's own token cannot
 * create it once a later commit changed `.github/workflows/` on main.
 */
/** @param {IReleaseCommitInput} input @param {IPublishReleaseOptions} [options] @returns {Promise<string>} */
export async function publishReleaseCommit({
    tag,
    targetSha: requestedTargetSha,
    upstream,
}, {
    dispatchWorkflow = dispatchReleaseWorkflow,
    printHandoff = printReleaseWorkflowHandoff,
    push = true,
    pushReleaseTag: pushReleaseTagFn = pushReleaseTag,
    runCommand = run,
} = {}) {
    const targetSha = requestedTargetSha ?? (push
        ? pushReleaseBranch({upstream}, {runCommand})
        : runCommand('git', [
            'rev-parse',
            'HEAD',
        ]));

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

    while (true) {
        runInfo = await waitForRun({
            createdAfter: dispatchStartedAt,
            displayTitles: getReleaseWorkflowDisplayTitles(tag),
            label: `Release workflow for ${tag}`,
            targetSha,
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

/** @param {number} milliseconds */
function runSleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** @param {{currentVersion: string, targetSha: string, upstream: IUpstream, runCommand: TCommandRunner}} options */
function assertReleaseCommitForCurrentVersion({
    currentVersion,
    targetSha,
    upstream,
    runCommand,
}) {
    const parentSha = getCommitParentSha(targetSha, {
        fetchParent: false,
        runCommand,
    });
    assertVersionOnlyPackageCommit(parentSha, targetSha, {
        context: 'Release resume',
        runCommand,
    });

    const subject = runCommand('git', [
        'log',
        '-1',
        '--format=%s',
        targetSha,
    ]);
    const expectedSubject = `release: ${currentVersion} [skip ci]`;
    if (subject !== expectedSubject) {
        throw new Error(
            `Release resume requires HEAD ${targetSha} to have subject "${expectedSubject}", received "${subject}".`,
        );
    }

    try {
        runCommand('git', [
            'merge-base',
            '--is-ancestor',
            targetSha,
            upstream.ref,
        ]);
    } catch (error) {
        throw new Error(
            `Release resume requires commit ${targetSha} to exist on ${upstream.ref}. `
            + `Fetch ${upstream.ref} and retry: ${errorMessage(error)}`,
        );
    }
}

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
    const readVersionFn = options.readVersionFn ?? readVersion;
    const readReleaseFn = options.readReleaseFn ?? (
        tag => readGitHubRelease(tag, {runCommand})
    );
    const publishReleaseCommitFn = options.publishReleaseCommitFn ?? publishReleaseCommit;

    fetchReleaseMainFn(upstream);
    const currentVersion = readVersionFn();
    const tag = `v${currentVersion}`;
    const targetSha = runCommand('git', [
        'rev-parse',
        'HEAD',
    ]);

    assertReleaseCommitForCurrentVersion({
        currentVersion,
        runCommand,
        targetSha,
        upstream,
    });

    const release = readReleaseFn(tag);
    if (release && !release.isDraft) {
        throw new Error(
            `Release ${tag} is already public. Run \`pnpm run release:status ${tag}\` to inspect it.`,
        );
    }
    await publishReleaseCommitFn({
        tag,
        targetSha,
        upstream,
    }, {
        ...options.publishOptions,
        push: false,
        runCommand,
    });
}

/** @param {TReleaseLevel} level @param {IReleaseOptions} [options] @returns {Promise<void>} */
export async function cutRelease(level, options = {}) {
    const preconditions = await assertReleaseCutPreconditions({
        ...options,
        level,
    });
    const runCommand = options.runCommand ?? run;
    const readVersionFn = options.readVersionFn ?? readVersion;
    const writeVersionFn = options.writeVersionFn ?? writeVersion;
    const assertChangedFilesMatchFn = options.assertChangedFilesMatchFn ?? assertChangedFilesMatch;
    const stageFilesFn = options.stageFilesFn ?? stageFiles;
    const publishReleaseCommitFn = options.publishReleaseCommitFn ?? publishReleaseCommit;
    const nextTag = `v${preconditions.nextVersion}`;
    let committed = false;

    writeVersionFn(preconditions.nextVersion);

    try {
        const version = readVersionFn();
        if (version !== preconditions.nextVersion) {
            throw new Error(`Expected bumped version to be ${preconditions.nextVersion}, received ${version}`);
        }

        assertChangedFilesMatchFn(
            ['package.json'],
            {
                ignoredPathPrefixes: [...MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES],
                runCommand,
            },
        );
        stageFilesFn(['package.json'], {runCommand});
        runCommand('git', [
            'commit',
            '-m',
            `release: ${version} [skip ci]`,
            '--',
            'package.json',
        ], {stdio: 'inherit'});
        committed = true;
        await publishReleaseCommitFn({
            tag: nextTag,
            upstream: preconditions.upstream,
        }, {
            ...options.publishOptions,
            runCommand,
        });
    } catch (error) {
        if (!committed) {
            writeVersionFn(preconditions.currentVersion);
            process.stderr.write(
                `Restored package.json version to ${preconditions.currentVersion} after release failure.\n`,
            );
        }
        throw error;
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
