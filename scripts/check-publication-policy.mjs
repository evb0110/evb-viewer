import { getCliErrorMessage } from './lib/cli-error.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {describeForbiddenArtifactPath} from './lib/local-artifact-policy.mjs';
import {
    describeMissingTrailer,
    findAddedCheckViolations,
    findStagedAddedChecks,
    readAddsChecksTrailer,
} from './lib/added-checks.mjs';

const ZERO_OID = '0'.repeat(40);
const OID_PATTERN = /^[0-9a-f]{40,64}$/u;
const PUBLISHABLE_REF_PREFIXES = [
    'refs/heads/',
    'refs/tags/',
];

// Keep each `git` invocation well inside the platform argument limit while
// still batching a full-history scan into a handful of processes.
const COMMIT_BATCH_SIZE = 400;

function runGit(arguments_, cwd = process.cwd(), input) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        input,
        maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

function tryGit(arguments_, cwd) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout : null;
}

function batches(items) {
    const result = [];
    for (let index = 0; index < items.length; index += COMMIT_BATCH_SIZE) {
        result.push(items.slice(index, index + COMMIT_BATCH_SIZE));
    }
    return result;
}

export function parsePrePushUpdates(input) {
    return input
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
            const fields = line.trim().split(/\s+/u);
            if (fields.length !== 4) {
                throw new Error(`Invalid pre-push update: ${line}`);
            }
            const [
                localRef,
                localOid,
                remoteRef,
                remoteOid,
            ] = fields;
            return {
                localOid,
                localRef,
                remoteOid,
                remoteRef,
            };
        });
}

function listCommits(arguments_, cwd) {
    return runGit([
        'rev-list',
        '--reverse',
        ...arguments_,
    ], cwd)
        .split('\n')
        .filter(Boolean);
}

function commitExists(revision, cwd) {
    return tryGit([
        'rev-parse',
        '--quiet',
        '--verify',
        `${revision}^{commit}`,
    ], cwd) !== null;
}

/**
 * Reads the remote's live ref advertisement. Stale `refs/remotes/*` are not
 * authoritative: they can name commits the remote never received, or miss
 * commits another push has since published.
 */
export function readAdvertisedOids(remoteTargets, cwd = process.cwd()) {
    const errors = [];

    for (const target of remoteTargets.filter(Boolean)) {
        const output = tryGit([
            'ls-remote',
            '--heads',
            '--tags',
            target,
        ], cwd);
        if (output === null) {
            errors.push(target);
            continue;
        }
        // `<oid>\t<ref>` plus a peeled `<oid>\t<ref>^{}` line per annotated tag.
        return output
            .split('\n')
            .map(line => line.split('\t')[0]?.trim() ?? '')
            .filter(oid => OID_PATTERN.test(oid));
    }

    throw new Error(
        `Cannot read the remote ref advertisement (${errors.join(', ') || 'no remote given'}); `
        + 'refusing to push without knowing what is already public.',
    );
}

/**
 * Commits already advertised by the remote are public and need no rescan.
 * Advertised objects missing locally simply cannot narrow the scan, which
 * widens it — the fail-closed direction.
 *
 * Each exclusion is spelled `^<oid>`. A repeated `--not` would *toggle* the
 * sense of everything that follows it, so `--not A --not B` excludes A and then
 * adds B back as a positive tip, dragging already-public history into the scan.
 */
function publicExclusions(advertisedOids, cwd) {
    return [...new Set(advertisedOids)]
        .filter(oid => commitExists(oid, cwd))
        .map(oid => `^${oid}`);
}

/**
 * Reads the annotated tag object a pushed tag ref points at, if there is one. A
 * lightweight tag names a commit directly and carries no text of its own.
 *
 * Release tags are created server-side by the release workflow and never travel
 * through this hook; a hand-made annotated tag push does, and its message and
 * tagger identity appear nowhere in the commit graph.
 *
 * This project publishes tags of commits only. Git does permit a tag of a tag,
 * but rather than walking a chain that would never exist here, a nested tag is
 * reported (`nested: true`) so the push fails closed with a clear reason instead
 * of the inner objects being silently skipped.
 */
function readPushedTagObject(oid, cwd) {
    if (tryGit([
        'cat-file',
        '-t',
        oid,
    ], cwd)?.trim() !== 'tag') {
        return null;
    }

    const content = runGit([
        'cat-file',
        'tag',
        oid,
    ], cwd);

    return {
        content,
        nested: /^type tag$/mu.test(content),
        oid,
    };
}

/**
 * Resolves a pre-push stdin payload into everything that would become public:
 * the commits the remote does not already advertise, plus the annotated tag
 * objects themselves, whose messages and tagger identities never appear in the
 * commit graph.
 */
export function collectPrePushWork(input, remoteTargets, cwd = process.cwd()) {
    const updates = parsePrePushUpdates(input);
    const rejectedRefs = [];
    const nestedTagRefs = [];
    const localOids = [];

    for (const update of updates) {
        if (update.localOid === ZERO_OID) {
            // Deleting a ref publishes nothing.
            continue;
        }
        if (!PUBLISHABLE_REF_PREFIXES.some(prefix => update.remoteRef.startsWith(prefix))) {
            rejectedRefs.push(update.remoteRef);
            continue;
        }
        localOids.push(update.localOid);
        if (!update.remoteRef.startsWith('refs/tags/')) {
            continue;
        }
        const tagObject = readPushedTagObject(update.localOid, cwd);
        if (!tagObject) {
            continue;
        }
        if (tagObject.nested) {
            nestedTagRefs.push(update.remoteRef);
        }
    }

    return {
        commits: localOids.length === 0 ? [] : listCommits([
            ...localOids,
            ...publicExclusions(readAdvertisedOids(remoteTargets, cwd), cwd),
        ], cwd),
        nestedTagRefs,
        rejectedRefs,
    };
}

/**
 * Resolves the commits a push made public for CI.
 *
 * A one-time force rewrite leaves `before` pointing at an object this checkout
 * no longer contains, and unrelated histories share no merge base. Both cases
 * fall back to the complete history of the pushed head rather than erroring or
 * silently checking nothing.
 */
export function collectPushedRangeCommits(beforeOid, headOid, cwd = process.cwd()) {
    const hasUsableBefore = Boolean(beforeOid)
        && beforeOid !== ZERO_OID
        && commitExists(beforeOid, cwd)
        && tryGit([
            'merge-base',
            beforeOid,
            headOid,
        ], cwd) !== null;

    return listCommits(hasUsableBefore ? [`${beforeOid}..${headOid}`] : [headOid], cwd);
}

/**
 * Groups `git diff-tree --stdin -z` output back into per-commit path lists.
 *
 * `-z` is required: the default output quotes and escapes any path outside the
 * printable ASCII range, so `docs/тест/AGENTS.md` would arrive as
 * `"docs/\321\202\320\265\321\201\321\202/AGENTS.md"` and its basename would no
 * longer match. `-z` also emits paths containing newlines verbatim.
 */
export function parseDiffTreeRecords(output, requestedCommits) {
    const requested = new Set(requestedCommits);
    const records = [];

    for (const token of output.split('\0')) {
        if (token.length === 0) {
            continue;
        }
        if (requested.has(token)) {
            records.push({
                commit: token,
                paths: [],
            });
            continue;
        }
        records.at(-1)?.paths.push(token);
    }

    return records;
}

function readCommitPaths(commits, cwd) {
    return batches(commits).flatMap(batch => parseDiffTreeRecords(runGit([
        'diff-tree',
        '--stdin',
        '-r',
        '-z',
        '--name-only',
        '--no-renames',
        // Include the initial commit of a resurrected or orphan history.
        '--root',
        '--diff-merges=first-parent',
        // Deletions are the remedy, not the offense: only paths a commit adds
        // or updates keep the artifact reachable in the published history.
        '--diff-filter=d',
    ], cwd, `${batch.join('\n')}\n`), batch));
}

export function findHistoryArtifactViolations(commits, cwd = process.cwd()) {
    if (commits.length === 0) {
        return [];
    }
    return readCommitPaths(commits, cwd).flatMap(({
        commit,
        paths,
    }) => {
        const matches = [...new Set(paths
            .map(path => describeForbiddenArtifactPath(path))
            .filter(Boolean))];
        return matches.length > 0 ? [{
            matches,
            subject: commit,
        }] : [];
    });
}

function mergeViolations(violationGroups) {
    const matchesBySubject = new Map();

    for (const {
        matches,
        subject,
    } of violationGroups.flat()) {
        matchesBySubject.set(subject, [...new Set([
            ...matchesBySubject.get(subject) ?? [],
            ...matches,
        ])]);
    }

    return [...matchesBySubject].map(([
        subject,
        matches,
    ]) => ({
        matches,
        subject,
    }));
}

export function findPushPolicyViolations(commits, cwd = process.cwd(), {
    nestedTagRefs = [],
    rejectedRefs = [],
} = {}) {
    return mergeViolations([
        rejectedRefs.map(ref => ({
            matches: ['destination outside refs/heads/* and refs/tags/*'],
            subject: ref,
        })),
        nestedTagRefs.map(ref => ({
            matches: ['tag object points at another tag; this project publishes tags of commits only'],
            subject: ref,
        })),
        findHistoryArtifactViolations(commits, cwd),
        findAddedCheckViolations(commits, cwd),
    ]);
}

function rejectViolations(violations) {
    if (violations.length === 0) {
        return;
    }
    console.error('Push blocked: local-only artifacts, unexplained new checks, or ref destinations were found.');
    for (const {
        matches,
        subject,
    } of violations) {
        console.error(`  ${subject}: ${matches.join(', ')}`);
    }
    console.error(
        'Remove the local-only artifact from every listed object (rewriting the affected '
        + 'history, not only the tip), and retry.',
    );
    process.exitCode = 1;
}

function readOptionValues(arguments_, option) {
    const values = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] === option) {
            const value = arguments_[index + 1];
            if (!value) {
                throw new Error(`${option} requires a value`);
            }
            values.push(value);
            index += 1;
        } else if (arguments_[index].startsWith(`${option}=`)) {
            values.push(arguments_[index].slice(option.length + 1));
        }
    }
    return values;
}

// `git diff --cached` compares against the empty tree when HEAD is unborn, so
// the very first commit of a repository is checked like any other.
export function findStagedArtifactViolations(cwd = process.cwd()) {
    const output = runGit([
        'diff',
        '--cached',
        '--name-only',
        '-z',
        '--no-renames',
        '--diff-filter=d',
    ], cwd);

    return output
        .split('\0')
        .filter(Boolean)
        .map(path => describeForbiddenArtifactPath(path))
        .filter(Boolean);
}

function runStagedCheck(cwd) {
    const matches = [...new Set(findStagedArtifactViolations(cwd))];
    if (matches.length === 0) {
        return;
    }
    console.error('Commit blocked: staged local-only artifacts must never enter the history.');
    for (const match of matches) {
        console.error(`  ${match}`);
    }
    console.error('Unstage the file (`git restore --staged <path>`); it is ignored for a reason.');
    process.exitCode = 1;
}

export function main(arguments_ = process.argv.slice(2), cwd = process.cwd()) {
    const messageFiles = readOptionValues(arguments_, '--message-file');
    const stagedIndex = arguments_.indexOf('--staged');
    const prePushIndex = arguments_.indexOf('--pre-push');
    const pushedRangeIndex = arguments_.indexOf('--pushed-range');
    const modeCount = [
        messageFiles.length > 0,
        stagedIndex !== -1,
        prePushIndex !== -1,
        pushedRangeIndex !== -1,
    ].filter(Boolean).length;

    if (modeCount !== 1) {
        throw new Error(
            'Usage: check-publication-policy.mjs (--message-file <path> | --staged '
            + '| --pushed-range <before> <head> | --pre-push <remote> [<url>])',
        );
    }

    if (messageFiles.length > 0) {
        if (messageFiles.length !== 1) {
            throw new Error('--message-file accepts one path');
        }
        const message = readFileSync(messageFiles[0], 'utf8');
        const added = readAddsChecksTrailer(message) === null ? findStagedAddedChecks(cwd) : [];
        if (added.length > 0) {
            console.error(`Commit blocked: ${describeMissingTrailer(added).join('\n  ')}`);
            process.exitCode = 1;
        }
        return;
    }

    if (stagedIndex !== -1) {
        runStagedCheck(cwd);
        return;
    }

    if (pushedRangeIndex !== -1) {
        const headOid = arguments_[pushedRangeIndex + 2];
        if (!headOid) {
            throw new Error('--pushed-range requires the before and head revisions');
        }
        rejectViolations(findPushPolicyViolations(
            collectPushedRangeCommits(arguments_[pushedRangeIndex + 1], headOid, cwd),
            cwd,
        ));
        return;
    }

    const remoteName = arguments_[prePushIndex + 1];
    if (!remoteName) {
        throw new Error('--pre-push requires the remote name');
    }
    const work = collectPrePushWork(readFileSync(0, 'utf8'), [
        remoteName,
        arguments_[prePushIndex + 2],
    ], cwd);
    rejectViolations(findPushPolicyViolations(work.commits, cwd, work));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(getCliErrorMessage(error));
        process.exitCode = 1;
    }
}
