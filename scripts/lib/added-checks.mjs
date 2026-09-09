// Every automated contributor tends to leave a new test, job, or gate behind
// on every commit, so the suite grew from 210 to 1,379 test files in four
// months while CI stayed red most of the time. A new check is a deliberate
// decision the user made, not a by-product of a task, so a commit that adds
// one must say who asked for it in an `Adds-Checks:` trailer. Deleting or
// editing an existing check never needs the trailer.
//
// The commit-msg hook, the pre-push hook, and the CI attribution job all run
// this through `check-commit-attribution.mjs`.

import {spawnSync} from 'node:child_process';

export const ADDS_CHECKS_TRAILER = 'Adds-Checks';

const TRAILER_PATTERN = /^Adds-Checks:[ \t]*(\S.*)$/imu;

// Files whose creation is itself a new check.
const ADDED_CHECK_FILE_PATTERNS = [
    {
        label: 'new test file',
        pattern: /^tests\/.*\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/u,
    },
    {
        label: 'new native test',
        pattern: /^native\/.*\/tests\/.*\.rs$/u,
    },
    {
        label: 'new workflow or action',
        pattern: /^\.github\/(?:workflows|actions)\//u,
    },
    {
        label: 'new git hook',
        pattern: /^\.husky\/(?!_\/)/u,
    },
    {
        label: 'new CI script',
        pattern: /^scripts\/ci\//u,
    },
];

// Lines whose addition to an existing file registers a new check.
const ADDED_CHECK_LINE_PATTERNS = [
    {
        file: /^\.github\/workflows\/.*\.ya?ml$/u,
        label: 'new workflow job or trigger',
        pattern: /^ {2}[A-Za-z0-9_-]+:[ \t]*$/u,
    },
    {
        file: /^package\.json$/u,
        label: 'new check script',
        pattern: /^\s*"(?:test|check|validate|verify|gate|audit)[A-Za-z0-9:-]*":\s*"/u,
    },
    {
        file: /^vitest[A-Za-z.-]*\.config\.[cm]?[jt]s$/u,
        label: 'new vitest project',
        pattern: /\bcreate[A-Za-z]*TestProject\(/u,
    },
    {
        file: /^eslint-plugin-custom\.mjs$/u,
        label: 'new custom lint rule',
        pattern: /^\s*'[a-z-]+': [A-Za-z]+Rule,?$/u,
    },
    {
        file: /^eslint\.config\.mjs$/u,
        label: 'newly enabled lint rule',
        pattern: /^\s*'(?:custom\/[a-z-]+|no-restricted-[a-z-]+)':/u,
    },
    {
        file: /^scripts\/release\/policy\.mjs$/u,
        label: 'new gate policy entry',
        pattern: /^\s*id: '/u,
    },
];

export function readAddsChecksTrailer(message) {
    return TRAILER_PATTERN.exec(message)?.[1].trim() ?? null;
}

/**
 * @param {{status: string, path: string}[]} entries `git diff --name-status` rows
 * @param {(path: string) => string} readAddedLines returns the `+` lines of a
 *   unified diff for one path, without the leading `+`
 */
export function findAddedChecks(entries, readAddedLines) {
    const found = [];
    for (const {
        path,
        status,
    } of entries) {
        if (status === 'D') {
            continue;
        }
        if (status === 'A') {
            const rule = ADDED_CHECK_FILE_PATTERNS.find(candidate => candidate.pattern.test(path));
            if (rule) {
                found.push(`${rule.label}: ${path}`);
                continue;
            }
        }
        const lineRules = ADDED_CHECK_LINE_PATTERNS.filter(candidate => candidate.file.test(path));
        if (lineRules.length === 0) {
            continue;
        }
        const addedLines = readAddedLines(path);
        for (const rule of lineRules) {
            const line = addedLines.find(candidate => rule.pattern.test(candidate));
            if (line) {
                found.push(`${rule.label}: ${path} (${line.trim()})`);
            }
        }
    }
    return found;
}

export function describeMissingTrailer(added) {
    return [
        `commit adds checks without an \`${ADDS_CHECKS_TRAILER}:\` trailer: ${added.join('; ')}`,
        `Add \`${ADDS_CHECKS_TRAILER}: <the user's words that asked for this check>\` to the message, `
        + 'or drop the new check. Deleting or editing an existing check needs no trailer.',
    ];
}

function parseNameStatus(output) {
    const fields = output.split('\0').filter(Boolean);
    const entries = [];
    for (let index = 0; index < fields.length; index += 2) {
        const status = fields[index][0];
        // Renames and copies carry two paths; the destination is the new file.
        if (status === 'R' || status === 'C') {
            entries.push({
                path: fields[index + 2],
                status: 'A',
            });
            index += 1;
        } else {
            entries.push({
                path: fields[index + 1],
                status,
            });
        }
    }
    return entries;
}

function addedLinesOf(diff) {
    return diff
        .split('\n')
        .filter(line => line.startsWith('+') && !line.startsWith('+++'))
        .map(line => line.slice(1));
}

function git(arguments_, cwd) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : null;
}

export function findStagedAddedChecks(cwd) {
    const names = git([
        'diff',
        '--cached',
        '--name-status',
        '-z',
        '--no-renames',
    ], cwd);
    if (names === null) {
        return [];
    }
    return findAddedChecks(parseNameStatus(names), path => addedLinesOf(git([
        'diff',
        '--cached',
        '-U0',
        '--',
        path,
    ], cwd) ?? ''));
}

export function findCommitAddedChecks(commit, cwd) {
    const names = git([
        'diff-tree',
        '--no-commit-id',
        '-r',
        '--root',
        '--name-status',
        '-z',
        '--no-renames',
        commit,
    ], cwd);
    if (names === null) {
        return [];
    }
    return findAddedChecks(parseNameStatus(names), path => addedLinesOf(git([
        'diff-tree',
        '--no-commit-id',
        '--root',
        '-p',
        '-U0',
        commit,
        '--',
        path,
    ], cwd) ?? ''));
}

export function findAddedCheckViolations(commits, cwd) {
    return commits.flatMap((commit) => {
        const parents = git([
            'rev-list',
            '--parents',
            '-n',
            '1',
            commit,
        ], cwd);
        // A merge introduces nothing of its own; its parents were checked.
        if (parents === null || parents.trim().split(' ').length > 2) {
            return [];
        }
        const message = git([
            'log',
            '-1',
            '--format=%B',
            commit,
        ], cwd) ?? '';
        if (readAddsChecksTrailer(message) !== null) {
            return [];
        }
        const added = findCommitAddedChecks(commit, cwd);
        return added.length > 0 ? [{
            matches: describeMissingTrailer(added),
            subject: commit,
        }] : [];
    });
}
