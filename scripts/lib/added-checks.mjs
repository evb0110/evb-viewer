// Every automated contributor tends to leave a new test, job, or gate behind
// on every commit, so the suite grew from 210 to 1,379 test files in four
// months while CI stayed red most of the time. A new check is a deliberate
// decision the user made, not a by-product of a task, so a commit that adds
// one must say who asked for it in an `Adds-Checks:` trailer. Deleting or
// editing an existing check never needs the trailer.
//
// The same trailer covers flake tolerance: a retry, a wall-clock sleep, a
// raised timeout, or a step allowed to fail hides a defect instead of fixing
// it, and each one made CI slower and less trustworthy in the past. Fix the
// flake or delete the check; tolerating it needs the user's words too.
//
// The commit-msg hook, the pre-push hook, and the CI publication-policy job all run
// this through `check-publication-policy.mjs`.

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

const TEST_FILE_PATTERN = /^tests\/.*\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/u;
const VITEST_CONFIG_PATTERN = /^vitest[A-Za-z.-]*\.config\.[cm]?[jt]s$/u;
const WORKFLOW_PATTERN = /^\.github\/workflows\/.*\.ya?ml$/u;

// Lines that make a check tolerate its own failures instead of catching a
// defect. Matched only on added lines, so removing one never needs a trailer.
const FLAKE_TOLERANCE_LINE_PATTERNS = [
    {
        file: TEST_FILE_PATTERN,
        label: 'wall-clock sleep in a test',
        pattern: /\bsetTimeout\(\s*(?:resolve|res|r|done)\b|\bawait\s+(?:sleep|delay|wait|pause)\(\s*\d/u,
    },
    {
        file: TEST_FILE_PATTERN,
        label: 'test retry',
        pattern: /\bretry:\s*[1-9]|\.retry\(\s*[1-9]/u,
    },
    {
        file: TEST_FILE_PATTERN,
        label: 'test timeout override',
        pattern: /\b(?:testTimeout|hookTimeout):\s*\d|^\s*\},?\s*\d{1,3}(?:_\d{3})+\);?\s*$|^\s*\},?\s*\d{4,}\);?\s*$/u,
    },
    {
        // CI retries an Electron E2E failure whose message carries this
        // marker, so tagging a new failure with it buys silent reruns.
        file: /^tests\//u,
        label: 'infrastructure retry marker',
        pattern: /\[INFRA\]/u,
    },
    {
        file: VITEST_CONFIG_PATTERN,
        label: 'test retry',
        pattern: /\bretry:\s*(?!0\b)\S/u,
    },
    {
        file: VITEST_CONFIG_PATTERN,
        label: 'test timeout raised',
        pattern: /\b(?:testTimeout|hookTimeout|teardownTimeout):\s*\d/u,
    },
    {
        file: WORKFLOW_PATTERN,
        label: 'step allowed to fail',
        pattern: /^\s*continue-on-error:\s*(?!false\b)\S/u,
    },
    {
        file: WORKFLOW_PATTERN,
        label: 'retried step',
        pattern: /run-with-retries|nick-fields\/retry|Wandalen\/wretry/u,
    },
    {
        file: WORKFLOW_PATTERN,
        label: 'job timeout changed',
        pattern: /^\s*timeout-minutes:/u,
    },
];

// Lines whose addition to an existing file registers a new check.
const ADDED_CHECK_LINE_PATTERNS = [
    {
        file: WORKFLOW_PATTERN,
        label: 'new workflow job or trigger',
        pattern: /^ {2}[A-Za-z0-9_-]+:[ \t]*$/u,
    },
    {
        file: /^package\.json$/u,
        label: 'new check script',
        pattern: /^\s*"(?:test|check|validate|verify|gate|audit)[A-Za-z0-9:-]*":\s*"/u,
    },
    {
        file: VITEST_CONFIG_PATTERN,
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
    ...FLAKE_TOLERANCE_LINE_PATTERNS,
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
        `commit adds checks or flake tolerance without an \`${ADDS_CHECKS_TRAILER}:\` trailer: ${added.join('; ')}`,
        `Add \`${ADDS_CHECKS_TRAILER}: <the user's words that asked for this>\` to the message, `
        + 'or drop the new check. A retry, sleep, raised timeout, or allowed failure hides a defect: '
        + 'fix the flake or delete the check instead. Deleting or editing an existing check needs no trailer.',
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
