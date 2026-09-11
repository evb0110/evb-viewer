import { getCliErrorMessage } from '../lib/cli-error.mjs';
import { execFileSync } from 'node:child_process';
import {
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG_PATTERN } from './releaseTag.mjs';

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARABLE_SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/u;

/** @typedef {'patch' | 'minor' | 'major'} TReleaseLevel */
/** @typedef {(command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => string} TCommandRunner */
/** @typedef {{branch: string, ref: string, remote: string}} IUpstream */
/** @typedef {{context?: string, ignoredPathPrefixes?: string[], runCommand?: TCommandRunner}} IChangedFileAssertionOptions */
/** @typedef {{readVersionFn?: () => string, stderr?: NodeJS.WriteStream, writeVersionFn?: (version: string) => void}} IRestoreVersionOptions */
/** @typedef {{attempts?: number, delayMs?: number, runCommand?: TCommandRunner, sleepFn?: (milliseconds: number) => Promise<void>, stderr?: NodeJS.WriteStream}} IRetryOptions */

// The exact-SHA wait script imports this module before release jobs install
// project dependencies. Keep these small helpers local so that safety checks
// remain runnable from the workflow's dependency-free preparation job.
/** @param {string[]} values */
function compact(values) {
    return values.filter(Boolean);
}

/** @param {string[]} values @param {string[]} excludedValues */
function difference(values, excludedValues) {
    const excluded = new Set(excludedValues);
    return values.filter(value => !excluded.has(value));
}

/** @param {number} milliseconds */
function delay(milliseconds) {
    return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

export const VALID_RELEASE_LEVELS = new Set([
    'patch',
    'minor',
    'major',
]);

export const MAIN_APP_RELEASE_IGNORED_PATH_PREFIXES = Object.freeze(['landing']);

/** @param {unknown} versionRange @param {string} [context] */
export function parsePinnedNodeMajor(versionRange, context = 'Release') {
    const match = String(versionRange ?? '').trim().match(/^(\d+)\.x$/);

    if (match?.[1] == null) {
        throw new Error(
            `${context} requires package.json engines.node to use a pinned "<major>.x" range. `
            + `Received "${versionRange ?? ''}".`,
        );
    }

    return Number.parseInt(match[1], 10);
}

/** @param {number} expectedMajor @param {string} [context] */
export function assertNodeMajor(expectedMajor, context = 'Release') {
    const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

    if (currentMajor === expectedMajor) {
        return;
    }

    throw new Error(
        `${context} requires Node ${expectedMajor}.x (latest LTS). `
        + `Current runtime is ${process.version}. `
        + 'Switch to the version declared in .nvmrc before continuing.',
    );
}

/** @param {string} [context] */
export function assertNodeProjectBaseline(context = 'Release') {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const expectedMajor = parsePinnedNodeMajor(packageJson.engines?.node, context);

    assertNodeMajor(expectedMajor, context);
}

const TRANSIENT_GITHUB_AUTH_ERROR_PATTERNS = [
    /Timeout trying to log in/i,
    /keyring/i,
    /context deadline exceeded/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /TLS handshake timeout/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

/** @param {unknown} error */
export function isTransientGitHubAuthError(error) {
    const message = errorMessage(error);

    return TRANSIENT_GITHUB_AUTH_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * @param {string} [context]
 * @param {IRetryOptions} [options]
 */
export async function assertGitHubCliReady(context = 'Release', {
    attempts = 3,
    delayMs = 5_000,
    runCommand = run,
    sleepFn = sleep,
    stderr = process.stderr,
} = {}) {
    let finalTransientError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            runCommand('gh', [
                'auth',
                'status',
            ]);
            return;
        } catch (error) {
            const isTransient = isTransientGitHubAuthError(error);
            if (attempt < attempts && isTransient) {
                finalTransientError = error;
                stderr.write(
                    'Transient GitHub CLI auth check failure '
                    + `(attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s.\n`,
                );
                await sleepFn(delayMs);
                continue;
            }

            finalTransientError = isTransient ? error : null;
            break;
        }
    }

    if (finalTransientError) {
        try {
            const login = runCommand('gh', [
                'api',
                'graphql',
                '--field',
                'query=query { viewer { login } }',
                '--jq',
                '.data.viewer.login',
            ]);
            if (!String(login).trim()) {
                throw new Error('Authenticated GraphQL viewer login was empty');
            }
            stderr.write(
                'GitHub CLI auth status remained unavailable; authenticated GraphQL fallback succeeded.\n',
            );
            return;
        } catch {
            // Report the standard actionable authentication error below.
        }
    }

    throw new Error(
        `${context} requires an authenticated GitHub CLI session so this command `
        + 'can dispatch the GitHub workflow. '
        + 'Run `gh auth status` / `gh auth login`.',
    );
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 */
export function run(command, args, options = {}) {
    const output = execFileSync(command, args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
        ...options,
    });

    if (output == null) {
        return '';
    }

    return String(output).trim();
}

export const sleep = delay;

const errorMessage = getCliErrorMessage;
export { errorMessage };

/** @param {unknown} error */
export function getExitStatus(error) {
    if (
        error
        && typeof error === 'object'
        && 'status' in error
        && typeof error.status === 'number'
    ) {
        return error.status;
    }

    return undefined;
}

const TRANSIENT_REMOTE_GIT_ERROR_PATTERNS = [
    /Recv failure/i,
    /connection reset/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EAI_AGAIN/i,
    /TLS handshake timeout/i,
    /Could not resolve host/i,
    /Failed to connect/i,
    /502 Bad Gateway/i,
    /503 Service Unavailable/i,
    /504 Gateway Timeout/i,
];

/** @param {unknown} error */
export function isTransientRemoteGitError(error) {
    const message = errorMessage(error);

    return TRANSIENT_REMOTE_GIT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

/** @param {{ignoredPathPrefixes?: string[], runCommand?: TCommandRunner}} [options] */
export function assertCleanWorktree({
    ignoredPathPrefixes = [],
    runCommand = run,
} = {}) {
    const changedFiles = listChangedFiles({
        ignoredPathPrefixes,
        runCommand,
    });
    if (changedFiles.length > 0) {
        throw new Error('Release requires a clean worktree');
    }
}

/** @param {string} [context] @param {{runCommand?: TCommandRunner}} [options] */
export function requireNamedBranch(context = 'Release', {runCommand = run} = {}) {
    const branch = runCommand('git', [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]);
    if (branch === 'HEAD') {
        throw new Error(`${context} requires a named branch, not detached HEAD`);
    }

    return branch;
}

/** @returns {string} */
export function readVersion() {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
}

/** @param {string} version */
export function writeVersion(version) {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    packageJson.version = version;
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

/**
 * @param {string} expectedVersion
 * @param {IRestoreVersionOptions} [options]
 */
export function restoreVersionIfChanged(
    expectedVersion,
    {
        readVersionFn = readVersion,
        stderr = process.stderr,
        writeVersionFn = writeVersion,
    } = {},
) {
    const actualVersion = readVersionFn();
    if (actualVersion === expectedVersion) {
        return false;
    }

    stderr.write(
        `Release verification changed package.json version from ${expectedVersion} to ${actualVersion}; `
        + `restoring ${expectedVersion} before committing.\n`,
    );
    writeVersionFn(expectedVersion);
    return true;
}

/** @param {string} version @param {TReleaseLevel} level */
export function bumpVersion(version, level) {
    const match = version.match(SEMVER_PATTERN);
    if (!match) {
        throw new Error(`Expected package.json version to be x.y.z, received "${version}"`);
    }

    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);

    if (level === 'patch') {
        return `${major}.${minor}.${patch + 1}`;
    }

    if (level === 'minor') {
        return `${major}.${minor + 1}.0`;
    }

    if (level === 'major') {
        return `${major + 1}.0.0`;
    }

    throw new Error(`Unsupported release level "${level}"`);
}

/** @param {string} version @returns {{core: number[], prerelease: string[]}} */
function parseComparableSemVer(version) {
    const match = version.match(COMPARABLE_SEMVER_PATTERN);
    if (!match) {
        throw new Error(`Expected a SemVer release version, received "${version}"`);
    }

    return {
        core: [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
        ],
        prerelease: match[4]?.split('.') ?? [],
    };
}

/** @param {{core: number[], prerelease: string[]}} left @param {{core: number[], prerelease: string[]}} right */
function compareComparableSemVer(left, right) {
    for (let index = 0; index < left.core.length; index += 1) {
        const comparison = (left.core[index] ?? 0) - (right.core[index] ?? 0);
        if (comparison !== 0) {
            return comparison;
        }
    }

    if (left.prerelease.length === 0 || right.prerelease.length === 0) {
        return left.prerelease.length === right.prerelease.length
            ? 0
            : left.prerelease.length === 0 ? 1 : -1;
    }

    const identifierCount = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < identifierCount; index += 1) {
        const leftIdentifier = left.prerelease[index];
        const rightIdentifier = right.prerelease[index];
        if (leftIdentifier === undefined || rightIdentifier === undefined) {
            return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
        }

        const leftNumeric = /^\d+$/u.test(leftIdentifier);
        const rightNumeric = /^\d+$/u.test(rightIdentifier);
        if (leftNumeric && rightNumeric) {
            const comparison = Number(leftIdentifier) - Number(rightIdentifier);
            if (comparison !== 0) {
                return comparison;
            }
        } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? -1 : 1;
        } else if (leftIdentifier !== rightIdentifier) {
            return leftIdentifier < rightIdentifier ? -1 : 1;
        }
    }

    return 0;
}

/** @param {string} tag @returns {string} */
function releaseTagVersion(tag) {
    return tag.slice(1);
}

/**
 * Rejects a candidate whose package version is lower than any valid release
 * tag reachable from that candidate, including tags reached through either
 * merge parent. The fetch and shallow-history checks are deliberately part of
 * this assertion so missing ancestry cannot be treated as proof of safety.
 *
 * @param {string} candidateVersion
 * @param {string} candidateSha
 * @param {{remote?: string, runCommand?: TCommandRunner}} [options]
 */
export function assertVersionNotBehindAncestorRelease(candidateVersion, candidateSha, {
    remote = 'origin',
    runCommand = run,
} = {}) {
    if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
        throw new Error(`Release candidate SHA must be exact, received "${candidateSha}"`);
    }

    const candidate = parseComparableSemVer(candidateVersion);
    const shallow = runCommand('git', [
        'rev-parse',
        '--is-shallow-repository',
    ]).trim();
    runCommand('git', shallow === 'true'
        ? [
            'fetch',
            '--unshallow',
            '--tags',
            remote,
        ]
        : [
            'fetch',
            '--tags',
            remote,
        ], {stdio: 'inherit'});
    if (runCommand('git', [
        'rev-parse',
        '--is-shallow-repository',
    ]).trim() === 'true') {
        throw new Error(
            `Release candidate ${candidateSha} still has incomplete shallow history after fetching; `
            + 'refusing to prove ancestral release versions.',
        );
    }

    const tags = runCommand('git', [
        'for-each-ref',
        '--merged',
        candidateSha,
        '--format=%(refname:strip=2)',
        'refs/tags',
    ])
        .split('\n')
        .map(tag => tag.trim())
        .filter(tag => RELEASE_TAG_PATTERN.test(tag));

    let greatestTag = null;
    for (const tag of tags) {
        if (greatestTag === null
            || compareComparableSemVer(
                parseComparableSemVer(releaseTagVersion(tag)),
                parseComparableSemVer(releaseTagVersion(greatestTag)),
            ) > 0) {
            greatestTag = tag;
        }
    }

    if (greatestTag === null) {
        return;
    }

    const greatestVersion = parseComparableSemVer(releaseTagVersion(greatestTag));
    if (compareComparableSemVer(candidate, greatestVersion) >= 0) {
        return;
    }

    let tagSha = 'unresolved';
    try {
        tagSha = runCommand('git', [
            'rev-list',
            '-n',
            '1',
            `refs/tags/${greatestTag}`,
        ]).trim() || tagSha;
    } catch {
        // The version violation is already established. Keep the diagnostic
        // useful without allowing a missing tag object to weaken the refusal.
    }

    throw new Error(
        `Release candidate ${candidateSha} package.json version ${candidateVersion} is lower than `
        + `reachable release tag ${greatestTag} (${tagSha}). Refusing the release until the manifest `
        + 'preserves the latest ancestral release version.',
    );
}

/** @param {string} [context] @param {{runCommand?: TCommandRunner}} [options] */
export function getUpstream(context = 'Release', {runCommand = run} = {}) {
    try {
        const upstream = runCommand('git', [
            'rev-parse',
            '--abbrev-ref',
            '--symbolic-full-name',
            '@{upstream}',
        ]);
        const separatorIndex = upstream.indexOf('/');
        if (separatorIndex <= 0 || separatorIndex === upstream.length - 1) {
            throw new Error(`Unsupported upstream ref "${upstream}"`);
        }

        return {
            branch: upstream.slice(separatorIndex + 1),
            ref: upstream,
            remote: upstream.slice(0, separatorIndex),
        };
    } catch (error) {
        throw new Error(
            `${context} requires the current branch to track a remote branch (${errorMessage(error)})`,
        );
    }
}

/** @param {string} branch @param {string} context */
function assertReleaseMainBranchName(branch, context) {
    if (branch !== 'main') {
        throw new Error(`${context} requires the current branch to be main, received "${branch}"`);
    }
}

/** @param {IUpstream} upstream @param {string} context */
function assertReleaseMainUpstream(upstream, context) {
    if (
        upstream.branch !== 'main'
        || upstream.ref !== 'origin/main'
        || upstream.remote !== 'origin'
    ) {
        throw new Error(
            `${context} requires main to track origin/main, received "${upstream.ref}"`,
        );
    }

    return upstream;
}

/**
 * @param {string} [context]
 * @param {{readBranch?: (context: string) => string, readUpstream?: (context: string) => IUpstream, runCommand?: TCommandRunner}} [options]
 */
export function getReleaseMainUpstream(context = 'Release', {
    readBranch,
    readUpstream,
    runCommand = run,
} = {}) {
    const branch = (readBranch ?? (contextName => requireNamedBranch(contextName, {runCommand})))(context);
    assertReleaseMainBranchName(branch, context);

    return assertReleaseMainUpstream(
        (readUpstream ?? (contextName => getUpstream(contextName, {runCommand})))(context),
        context,
    );
}

/** @param {IUpstream} upstream @param {{runCommand?: TCommandRunner}} [options] */
export function fetchReleaseMain(upstream, {runCommand = run} = {}) {
    runCommand('git', [
        'fetch',
        '--no-tags',
        upstream.remote,
        `+refs/heads/${upstream.branch}:refs/remotes/${upstream.remote}/${upstream.branch}`,
    ], {stdio: 'inherit'});
}

/** @param {string} commitSha @param {{runCommand?: TCommandRunner, fetchParent?: boolean}} [options] */
export function getCommitParentSha(commitSha, {
    runCommand = run,
    fetchParent = true,
} = {}) {
    try {
        return runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `${commitSha}^`,
        ]);
    } catch (error) {
        if (!fetchParent) {
            throw error;
        }

        runCommand('git', [
            'fetch',
            '--depth=2',
            'origin',
            commitSha,
        ], {stdio: 'inherit'});

        return runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `${commitSha}^`,
        ]);
    }
}

/** @param {string} parentSha @param {string} commitSha @param {{runCommand?: TCommandRunner}} [options] */
export function isVersionOnlyPackageCommit(parentSha, commitSha, {runCommand = run} = {}) {
    const numstat = runCommand('git', [
        'diff',
        '--numstat',
        parentSha,
        commitSha,
    ]).trim();
    if (!/^1\s+1\s+package\.json$/u.test(numstat)) {
        return false;
    }

    const diff = runCommand('git', [
        'diff',
        '-U0',
        parentSha,
        commitSha,
        '--',
        'package.json',
    ]);
    const removedLines = diff
        .split('\n')
        .filter(line => line.startsWith('-') && !line.startsWith('---'));
    const addedLines = diff
        .split('\n')
        .filter(line => line.startsWith('+') && !line.startsWith('+++'));
    const removedVersion = removedLines[0] ?? '';
    const addedVersion = addedLines[0] ?? '';

    return removedLines.length === 1
        && addedLines.length === 1
        && /^-\s*"version"\s*:\s*"[^"]+"\s*,?$/u.test(removedVersion)
        && /^\+\s*"version"\s*:\s*"[^"]+"\s*,?$/u.test(addedVersion);
}

/** @param {string} parentSha @param {string} commitSha @param {{context?: string, runCommand?: TCommandRunner}} [options] */
export function assertVersionOnlyPackageCommit(parentSha, commitSha, {
    context = 'Release',
    runCommand = run,
} = {}) {
    if (isVersionOnlyPackageCommit(parentSha, commitSha, {runCommand})) {
        return;
    }

    throw new Error(
        `${context} commit ${commitSha} must change only the package.json version line from ${parentSha}.`,
    );
}

// Resolved from this module, so the gate does not depend on the caller's cwd.
export const PUBLICATION_POLICY_SCRIPT = fileURLToPath(
    new URL('../check-commit-attribution.mjs', import.meta.url),
);

/**
 * Arguments for the publication policy scan over everything a push would make
 * public. `--pushed-range` falls back to the full history of the head when the
 * before SHA is empty or unreachable, which is the fail-closed direction. For a
 * release push, an unreachable before SHA is rejected earlier
 * (`assertUpstreamBeforeShaPresent`) so the widened scan cannot be mistaken for
 * a clean gate over a stale checkout.
 */
/** @param {string} beforeSha @param {string} headSha */
export function getPublicationPolicyCheckArgs(beforeSha, headSha) {
    return [
        PUBLICATION_POLICY_SCRIPT,
        '--pushed-range',
        beforeSha,
        headSha,
    ];
}

// The remote's live advertisement, not a tracking ref: a tracking ref can be
// stale in either direction, and the range to scan has to start where the branch
// actually is on the remote. A branch the remote does not have yet advertises
// nothing, so the before SHA is empty and the scan widens to the head's full
// history; an unreachable remote makes `ls-remote` fail and aborts the push.
/** @param {IUpstream} upstream @param {TCommandRunner} runCommand */
function readUpstreamBeforeSha({
    branch,
    remote,
}, runCommand) {
    const output = runCommand('git', [
        'ls-remote',
        remote,
        `refs/heads/${branch}`,
    ]);

    return output.split('\n')[0]?.split(/\s+/u)[0]?.trim() ?? '';
}

/** @param {string} oid @param {TCommandRunner} runCommand */
function hasLocalCommit(oid, runCommand) {
    try {
        runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `${oid}^{commit}`,
        ]);
        return true;
    } catch {
        return false;
    }
}

/**
 * A commit the remote advertises but this checkout does not contain means the
 * checkout is stale: someone else pushed since the last fetch. The scan itself
 * would still run — it cannot exclude an object it does not have, so it widens
 * to the head's whole history and reports every artifact any historical commit
 * ever touched, which reads as a policy failure rather than as "fetch first".
 *
 * Fail closed here instead, before the scan, with the remedy named. Fetching is
 * deliberately left to the operator: a release must publish the history the
 * operator verified, not one this script silently moved underneath them.
 */
/** @param {string} beforeSha @param {IUpstream} upstream @param {TCommandRunner} runCommand */
export function assertUpstreamBeforeShaPresent(beforeSha, {
    branch,
    remote,
}, runCommand) {
    // A branch the remote does not have yet advertises nothing; the scan then
    // covers the head's full history, which is correct for a new branch.
    if (!beforeSha || hasLocalCommit(beforeSha, runCommand)) {
        return;
    }

    throw new Error(
        `Release cannot verify what this push would publish: ${remote}/${branch} is at ${beforeSha}, `
        + 'which is missing from this checkout, so the publication scan has no starting point. '
        + `Run \`git fetch ${remote} ${branch}\`, reconcile HEAD with the fetched tip, and retry.`,
    );
}

/**
 * The single publication gate: scans the range this push would make public, then
 * pushes `HEAD` to the upstream branch. Returns the pushed SHA so callers can
 * dispatch a workflow against exactly what was published.
 *
 * Every release entry point runs with `HUSKY=0`, so the pre-push hook never sees
 * these pushes, and the version-bump commit `cut-release` creates carries
 * `[skip ci]`, so the CI attribution job does not see it either. This scan is
 * therefore the only check standing between the local branch and the public one.
 * A failing scan throws out of here, so the push — and any dispatch a caller
 * would run afterwards — cannot happen.
 */
/** @param {{targetSha?: string, upstream: IUpstream}} options @param {{runCommand?: TCommandRunner}} [runOptions] */
export function pushReleaseBranch({
    targetSha: requestedTargetSha,
    upstream,
}, {runCommand = run} = {}) {
    const targetSha = requestedTargetSha ?? runCommand('git', [
        'rev-parse',
        'HEAD',
    ]);

    const beforeSha = readUpstreamBeforeSha(upstream, runCommand);
    assertUpstreamBeforeShaPresent(beforeSha, upstream, runCommand);

    runCommand(
        'node',
        getPublicationPolicyCheckArgs(beforeSha, targetSha),
        {stdio: 'inherit'},
    );

    runCommand('git', [
        'push',
        upstream.remote,
        `${requestedTargetSha ?? 'HEAD'}:${requestedTargetSha ? `refs/heads/${upstream.branch}` : upstream.branch}`,
    ], {stdio: 'inherit'});

    return targetSha;
}

/** @param {string} ancestorSha @param {string} descendantRef @param {{runCommand?: TCommandRunner}} [options] */
export function isAncestorCommit(ancestorSha, descendantRef, {runCommand = run} = {}) {
    try {
        runCommand('git', [
            'merge-base',
            '--is-ancestor',
            ancestorSha,
            descendantRef,
        ]);
        return true;
    } catch (error) {
        // Exit 1 means "not an ancestor"; 128 means the object is not in this
        // checkout, which is equally "not on that line of history" here.
        if ([
            1,
            128,
        ].includes(getExitStatus(error) ?? -1)) {
            return false;
        }
        throw error;
    }
}

/** @param {string} commitSha @param {{runCommand?: TCommandRunner}} [options] @returns {string} */
export function readPackageJsonAt(commitSha, {runCommand = run} = {}) {
    return runCommand('git', [
        'show',
        `${commitSha}:package.json`,
    ]);
}

/** @param {string} commitSha @param {{runCommand?: TCommandRunner}} [options] @returns {string} */
export function readVersionAt(commitSha, {runCommand = run} = {}) {
    const version = JSON.parse(readPackageJsonAt(commitSha, {runCommand})).version;
    if (typeof version !== 'string') {
        throw new Error(`package.json at ${commitSha} has no string version`);
    }
    return version;
}

const PACKAGE_VERSION_LINE_PATTERN = /^(\s*"version"\s*:\s*")([^"]+)(",?)$/mu;

/**
 * Writes a commit whose only change from `parentSha` is the package.json
 * version line, without touching the checkout: the release candidate is an
 * arbitrary commit on main, not necessarily HEAD, and the operator's working
 * tree must stay theirs. A temporary index under .git keeps `read-tree` and
 * `write-tree` away from the real one.
 */
/** @param {{parentSha: string, subject: string, version: string}} input @param {{runCommand?: TCommandRunner}} [options] @returns {string} */
export function createVersionOnlyCommit({
    parentSha,
    subject,
    version,
}, {runCommand = run} = {}) {
    const packageJson = `${readPackageJsonAt(parentSha, {runCommand})}\n`;
    const matches = packageJson.match(new RegExp(PACKAGE_VERSION_LINE_PATTERN.source, 'gmu')) ?? [];
    if (matches.length !== 1) {
        throw new Error(`package.json at ${parentSha} must contain exactly one version line, found ${matches.length}`);
    }
    const bumped = packageJson.replace(PACKAGE_VERSION_LINE_PATTERN, `$1${version}$3`);
    if (bumped === packageJson) {
        throw new Error(`package.json at ${parentSha} already carries version ${version}`);
    }

    const blobSha = runCommand('git', [
        'hash-object',
        '-w',
        '--stdin',
    ], {
        input: bumped,
        stdio: [
            'pipe',
            'pipe',
            'pipe',
        ],
    });
    const gitDirectory = resolve(process.cwd(), runCommand('git', [
        'rev-parse',
        '--git-dir',
    ]));
    const indexPath = resolve(gitDirectory, `release-cut-${process.pid}.index`);
    const env = {
        ...process.env,
        GIT_INDEX_FILE: indexPath,
    };
    try {
        runCommand('git', [
            'read-tree',
            parentSha,
        ], {env});
        runCommand('git', [
            'update-index',
            '--cacheinfo',
            `100644,${blobSha},package.json`,
        ], {env});
        const treeSha = runCommand('git', ['write-tree'], {env});
        return runCommand('git', [
            'commit-tree',
            treeSha,
            '-p',
            parentSha,
            '-m',
            subject,
        ]);
    } finally {
        rmSync(indexPath, {force: true});
    }
}

/** @param {string} left @param {string} right @returns {number} */
export function compareReleaseVersions(left, right) {
    return compareComparableSemVer(parseComparableSemVer(left), parseComparableSemVer(right));
}

/**
 * The newest release tag this checkout knows. Callers fetch tags first; the
 * cutter does so through `assertVersionNotBehindAncestorRelease`.
 */
/** @param {{runCommand?: TCommandRunner}} [options] @returns {{tag: string, version: string} | null} */
export function readGreatestReleaseTag({runCommand = run} = {}) {
    const tags = runCommand('git', [
        'for-each-ref',
        '--format=%(refname:strip=2)',
        'refs/tags',
    ])
        .split('\n')
        .map(tag => tag.trim())
        .filter(tag => RELEASE_TAG_PATTERN.test(tag));
    let greatest = null;
    for (const tag of tags) {
        if (greatest === null || compareReleaseVersions(releaseTagVersion(tag), greatest.version) > 0) {
            greatest = {
                tag,
                version: releaseTagVersion(tag),
            };
        }
    }
    return greatest;
}

/** @param {string} tag @param {TCommandRunner} runCommand */
function readLocalTagCommitSha(tag, runCommand) {
    try {
        return runCommand('git', [
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/tags/${tag}^{commit}`,
        ]);
    } catch (error) {
        if (getExitStatus(error) === 1) {
            return null;
        }
        throw error;
    }
}

/** @param {string} tag @param {string} remote @param {TCommandRunner} runCommand */
function readRemoteTagCommitSha(tag, remote, runCommand) {
    const tagRef = `refs/tags/${tag}`;
    const entries = runCommand('git', [
        'ls-remote',
        '--tags',
        remote,
        tagRef,
    ])
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [
                sha,
                ref,
            ] = line.split('\t');
            return [
                sha ?? '',
                ref ?? '',
            ];
        });
    const peeled = entries.find(([
        ,
        ref,
    ]) => ref === `${tagRef}^{}`);
    const plain = entries.find(([
        ,
        ref,
    ]) => ref === tagRef);

    return (peeled ?? plain)?.[0] ?? null;
}

/**
 * Makes `refs/tags/<tag>` exist on the release remote at `targetSha` with the
 * developer's credentials. The release workflow cannot create that tag: the
 * built-in token needs the `workflows` scope to point a new ref at a commit
 * that is behind the main tip in `.github/workflows/`, and GitHub never grants
 * that scope to GITHUB_TOKEN. A tag that already points at the target is the
 * resume case and is reused; a tag that points elsewhere is a conflict and
 * stops the release before anything is dispatched.
 */
/** @param {{tag: string, targetSha: string, upstream: IUpstream}} options @param {{runCommand?: TCommandRunner}} [runOptions] */
export function pushReleaseTag({
    tag,
    targetSha,
    upstream,
}, {runCommand = run} = {}) {
    const localSha = readLocalTagCommitSha(tag, runCommand);
    if (localSha !== null && localSha !== targetSha) {
        throw new Error(
            `Local tag ${tag} points at ${localSha}, not release target ${targetSha}; `
            + 'delete it before retrying.',
        );
    }

    const remoteSha = readRemoteTagCommitSha(tag, upstream.remote, runCommand);
    if (remoteSha === targetSha) {
        return;
    }
    if (remoteSha !== null) {
        throw new Error(
            `Tag ${tag} on ${upstream.remote} points at ${remoteSha}, not release target ${targetSha}.`,
        );
    }

    if (localSha === null) {
        runCommand('git', [
            'tag',
            tag,
            targetSha,
        ]);
    }

    runCommand('git', [
        'push',
        upstream.remote,
        `refs/tags/${tag}`,
    ], {stdio: 'inherit'});
}

/** @param {string} filePath */
function normalizeGitPath(filePath) {
    return filePath.replaceAll('\\', '/');
}

/** @param {string[]} ignoredPathPrefixes */
function normalizeIgnoredPathPrefixes(ignoredPathPrefixes) {
    return compact(ignoredPathPrefixes.map(prefix => normalizeGitPath(prefix).replace(/\/+$/u, '')));
}

/** @param {string[]} files @param {string[]} [ignoredPathPrefixes] */
export function filterIgnoredFiles(files, ignoredPathPrefixes = []) {
    const ignoredPrefixes = normalizeIgnoredPathPrefixes(ignoredPathPrefixes);

    if (ignoredPrefixes.length === 0) {
        return files;
    }

    return files.filter((file) => {
        const normalizedFile = normalizeGitPath(file);
        return !ignoredPrefixes.some(prefix => (
            normalizedFile === prefix
            || normalizedFile.startsWith(`${prefix}/`)
        ));
    });
}

/** @param {{ignoredPathPrefixes?: string[], runCommand?: TCommandRunner}} [options] */
export function listChangedFiles({
    ignoredPathPrefixes = [],
    runCommand = run,
} = {}) {
    const trackedOutput = runCommand('git', [
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
    ]);
    const stagedOutput = runCommand('git', [
        'diff',
        '--cached',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
    ]);
    const untrackedOutput = runCommand('git', [
        'ls-files',
        '--others',
        '--exclude-standard',
    ]);

    const files = new Set();

    for (const output of [
        trackedOutput,
        stagedOutput,
        untrackedOutput,
    ]) {
        if (output.length === 0) {
            continue;
        }

        for (const normalizedFile of compact(output.split('\n').map(file => file.trim()))) {
            files.add(normalizedFile);
        }
    }

    return filterIgnoredFiles(Array.from(files), ignoredPathPrefixes);
}

/** @param {string | IChangedFileAssertionOptions} contextOrOptions */
function normalizeChangedFileAssertionOptions(contextOrOptions) {
    if (typeof contextOrOptions === 'string') {
        return {
            context: contextOrOptions,
            ignoredPathPrefixes: [],
            runCommand: run,
        };
    }

    return {
        context: contextOrOptions?.context ?? 'Release',
        ignoredPathPrefixes: contextOrOptions?.ignoredPathPrefixes ?? [],
        runCommand: contextOrOptions?.runCommand ?? run,
    };
}

/** @param {string[]} expectedFiles @param {string | IChangedFileAssertionOptions} [contextOrOptions] */
export function assertChangedFilesMatch(expectedFiles, contextOrOptions = 'Release') {
    const {
        context,
        ignoredPathPrefixes,
        runCommand,
    } = normalizeChangedFileAssertionOptions(contextOrOptions);
    const changedFiles = listChangedFiles({
        ignoredPathPrefixes,
        runCommand,
    });
    const unexpected = difference(changedFiles, expectedFiles);
    const missing = difference(expectedFiles, changedFiles);

    if (unexpected.length === 0 && missing.length === 0) {
        return;
    }

    const details = compact([
        unexpected.length > 0
            ? `unexpected changes: ${unexpected.join(', ')}`
            : '',
        missing.length > 0
            ? `missing changes: ${missing.join(', ')}`
            : '',
    ]).join('; ');

    throw new Error(
        `${context} verification must leave only the expected release file set changed (${expectedFiles.join(', ')}); ${details}`,
    );
}

/** @param {string[]} files @param {{runCommand?: TCommandRunner}} [options] */
export function stageFiles(files, {runCommand = run} = {}) {
    if (files.length === 0) {
        throw new Error('Version bump did not produce any file changes');
    }

    runCommand('git', [
        'add',
        '--',
        ...files,
    ], {stdio: 'inherit'});
}

/** @param {string} tag @param {string} remote @param {IRetryOptions} [options] */
export async function assertTagAbsent(tag, remote, {
    attempts = 3,
    delayMs = 5_000,
    runCommand = run,
    sleepFn = sleep,
    stderr = process.stderr,
} = {}) {
    const localStatus = (() => {
        try {
            runCommand('git', [
                'rev-parse',
                '--verify',
                `refs/tags/${tag}`,
            ]);
            return 0;
        } catch (error) {
            const status = getExitStatus(error);
            if (status === 128) {
                return status;
            }
            throw error;
        }
    })();

    if (localStatus === 0) {
        throw new Error(`Tag ${tag} already exists locally`);
    }

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            runCommand('git', [
                'ls-remote',
                '--exit-code',
                '--tags',
                remote,
                `refs/tags/${tag}`,
            ]);
            throw new Error(`Tag ${tag} already exists on ${remote}`);
        } catch (error) {
            const status = getExitStatus(error);
            if (status === 2) {
                return;
            }

            if (attempt < attempts && isTransientRemoteGitError(error)) {
                stderr.write(
                    `Transient remote tag check failure for ${tag} `
                    + `(attempt ${attempt}/${attempts}); retrying in ${delayMs / 1000}s.\n`,
                );
                await sleepFn(delayMs);
                continue;
            }

            throw error;
        }
    }
}
