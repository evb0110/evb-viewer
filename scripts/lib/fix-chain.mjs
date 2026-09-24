// A file that keeps taking fixes has a design problem, and each extra fence,
// flag, timer or retry makes the next fix more likely. After three fix commits
// touch one product file within seven days, the next fix to that file must
// remove lines from it or be a revert; it may not grow it. The rule is in
// docs/internal/agents/fix-evidence.md ("Fix chains").
//
// A commit may override the rule only with the owner's words in a
// `Fix-Chain-Override:` trailer. The pre-push hook and the CI publication-policy
// job run this through `check-publication-policy.mjs`.

import {spawnSync} from 'node:child_process';

export const FIX_CHAIN_OVERRIDE_TRAILER = 'Fix-Chain-Override';
export const FIX_CHAIN_WINDOW_DAYS = 7;
export const FIX_CHAIN_LIMIT = 3;

const OVERRIDE_PATTERN = /^Fix-Chain-Override:[ \t]*(\S.*)$/imu;
const FIX_SUBJECT_PATTERN = /^(?:fix(?:\([^)]*\))?!?:|fix\b)/iu;
const REVERT_SUBJECT_PATTERN = /^(?:revert(?:\([^)]*\))?!?:|revert\b)/iu;

// Product code only. Tests, docs, tooling and the nine locale catalogs change
// alongside most fixes without being the thing that keeps breaking.
const PRODUCT_PATH_PATTERN = /^(?:app|electron|packages|native|server|landing)\//u;
const EXCLUDED_PATH_PATTERN = /^(?:packages\/i18n-app\/messages\/|landing\/app\/locales\/)|\/tests?\/|_tests?\.rs$|\.(?:test|spec)\.[cm]?[jt]s$/u;

/** @typedef {{matches: string[], subject: string}} IViolation */
/** @typedef {{added: number, deleted: number, path: string}} INumstatEntry */

/** @param {string[]} arguments_ @param {string} cwd @returns {string} */
function git(arguments_, cwd) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(`git ${arguments_.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout;
}

/** @param {string} subject @returns {boolean} */
export function isFixSubject(subject) {
    return FIX_SUBJECT_PATTERN.test(subject.trim()) && !REVERT_SUBJECT_PATTERN.test(subject.trim());
}

/** @param {string} path @returns {boolean} */
export function isFixChainProductPath(path) {
    return PRODUCT_PATH_PATTERN.test(path) && !EXCLUDED_PATH_PATTERN.test(path);
}

/** @param {string} message @returns {string | null} */
export function readFixChainOverride(message) {
    return OVERRIDE_PATTERN.exec(message)?.[1]?.trim() ?? null;
}

/** @param {string} output @returns {INumstatEntry[]} */
function parseNumstat(output) {
    return output
        .split('\0')
        .filter(Boolean)
        .flatMap((record) => {
            const [
                added,
                deleted,
                ...pathParts
            ] = record.replace(/^\n/u, '').split('\t');
            const path = pathParts.join('\t');
            // Binary files report "-"; they are never fences.
            if (!path || added === '-' || deleted === '-') {
                return [];
            }
            return [{
                added: Number(added),
                deleted: Number(deleted),
                path,
            }];
        });
}

/**
 * Counts fix commits that touched `path` in the window before `commit`,
 * excluding `commit` itself.
 * @param {string} commit @param {string} path @param {number} commitTime @param {string} cwd @returns {string[]}
 */
function priorFixCommits(commit, path, commitTime, cwd) {
    const since = new Date((commitTime - (FIX_CHAIN_WINDOW_DAYS * 24 * 60 * 60)) * 1000).toISOString();
    const output = git([
        'log',
        '--no-merges',
        `--since=${since}`,
        '--format=%H%x09%s',
        `${commit}^`,
        '--',
        path,
    ], cwd);
    return output
        .split('\n')
        .filter(Boolean)
        .map(line => line.split('\t'))
        .filter(([
            , subject,
        ]) => subject !== undefined && isFixSubject(subject))
        .map(([oid]) => oid ?? '');
}

/** @param {string} commit @param {string} cwd @returns {IViolation[]} */
function findCommitFixChainViolations(commit, cwd) {
    const [
        header,
        ...messageLines
    ] = git([
        'log',
        '-1',
        '--format=%P%x09%ct%x09%s%n%B',
        commit,
    ], cwd).split('\n');
    const [
        parents = '',
        committedAt = '0',
        subject = '',
    ] = (header ?? '').split('\t');
    const parentList = parents.trim().split(' ').filter(Boolean);
    // Root commits have no history to chain from; merges introduce nothing.
    if (parentList.length !== 1 || !isFixSubject(subject)) {
        return [];
    }
    if (readFixChainOverride(messageLines.join('\n')) !== null) {
        return [];
    }
    const grown = parseNumstat(git([
        'diff-tree',
        '--no-commit-id',
        '--no-renames',
        '--numstat',
        '-z',
        commit,
    ], cwd)).filter(entry => isFixChainProductPath(entry.path) && entry.added > entry.deleted);

    /** @type {string[]} */
    const matches = [];
    for (const entry of grown) {
        const prior = priorFixCommits(commit, entry.path, Number(committedAt), cwd);
        if (prior.length >= FIX_CHAIN_LIMIT) {
            matches.push(
                `${entry.path} grows by ${entry.added - entry.deleted} lines after ${prior.length} fix commits in `
                + `${FIX_CHAIN_WINDOW_DAYS} days (${prior.slice(0, 5).map(oid => oid.slice(0, 9)).join(', ')})`,
            );
        }
    }
    return matches.length > 0 ? [{
        matches,
        subject: commit,
    }] : [];
}

/** @param {string[]} commits @param {string} cwd @returns {IViolation[]} */
export function findFixChainViolations(commits, cwd) {
    return commits.flatMap(commit => findCommitFixChainViolations(commit, cwd));
}

/** @returns {string} */
export function describeFixChainRule() {
    return `A fix to a file that already took ${FIX_CHAIN_LIMIT} fix commits in ${FIX_CHAIN_WINDOW_DAYS} days must `
        + 'shrink that file or revert: delete the redundant state or path instead of adding another fence, flag, '
        + `timer or retry. Only the owner can waive this, quoted in a \`${FIX_CHAIN_OVERRIDE_TRAILER}:\` trailer.`;
}
