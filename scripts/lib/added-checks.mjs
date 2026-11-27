// New check infrastructure (a workflow, job, action, hook, CI script, lint
// rule, vitest project, package.json check script, or gate policy entry) is a
// deliberate decision the owner makes, not a by-product of a task, so a commit
// that adds one must quote the owner's request in an `Adds-Checks:` trailer. A
// test file in an existing lane and edits or deletions of existing checks need
// no trailer.
//
// The same trailer covers flake tolerance: a retry, a wall-clock sleep, a
// raised timeout, or a step allowed to fail hides a defect instead of fixing
// it, and each one made CI slower and less trustworthy in the past. Fix the
// flake or delete the check; tolerating it needs the user's words too.
//
// The commit-msg hook, the pre-push hook, and the CI publication-policy job all run
// this through `check-publication-policy.mjs`.

import {spawnSync} from 'node:child_process';

/** @typedef {{file: RegExp, label: string, pattern: RegExp}} IAddedCheckLinePattern */
/** @typedef {{label: string, pattern: RegExp}} IAddedCheckFilePattern */
/** @typedef {{path: string, status: string}} INameStatusEntry */
/** @typedef {{body: string, committedAt: number, oid: string, parents: string[], subject: string}} ICommitMetadata */
/** @typedef {(path: string) => string[]} TReadAddedLines */

const ADDS_CHECKS_TRAILER = 'Adds-Checks';

const TRAILER_PATTERN = /^Adds-Checks:[ \t]*(\S.*)$/imu;

// Infrastructure files whose creation is itself a new check.
/** @type {IAddedCheckFilePattern[]} */
const ADDED_CHECK_FILE_PATTERNS = [
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

const TEST_FILE_PATTERN = /^tests\/.*\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/su;
const ELECTRON_E2E_LANE_PATH_PATTERN = /^tests\/e2e\/electron\/(nightly\/[^/]+|[^/]+)\//u;
const NON_LANE_ELECTRON_E2E_DIRS = new Set([
    'helpers',
    'nightly',
]);
const VITEST_CONFIG_PATTERN = /^vitest[A-Za-z.-]*\.config\.[cm]?[jt]s$/u;
const WORKFLOW_PATTERN = /^\.github\/workflows\/.*\.ya?ml$/su;

// Lines that make a check tolerate its own failures instead of catching a
// defect. Matched only on added lines, so removing one never needs a trailer.
/** @type {IAddedCheckLinePattern[]} */
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
/** @type {IAddedCheckLinePattern[]} */
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
        file: /^oxlint-plugin-invariants\.mjs$/u,
        label: 'new custom lint rule',
        pattern: /^\s*'[a-z-]+': [A-Za-z]+Rule,?$/u,
    },
    {
        file: /^\.oxlintrc\.json$/u,
        label: 'newly enabled lint rule',
        pattern: /^\s*"[a-z][a-z0-9/-]*":\s*(?:"error"|\[)/u,
    },
    {
        file: /^scripts\/release\/policy\.mjs$/u,
        label: 'new gate policy entry',
        pattern: /^\s*id: '/u,
    },
    ...FLAKE_TOLERANCE_LINE_PATTERNS,
];

/** @param {string} message @returns {string | null} */
export function readAddsChecksTrailer(message) {
    return TRAILER_PATTERN.exec(message)?.[1]?.trim() ?? null;
}

/** @param {INameStatusEntry[]} entries `git diff --name-status` rows @param {TReadAddedLines} readAddedLines returns the `+` lines of a unified diff for one path, without the leading `+` @returns {string[]} */
export function findAddedChecks(entries, readAddedLines) {
    /** @type {string[]} */
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

/** @param {string[]} added @returns {string[]} */
export function describeMissingTrailer(added) {
    return [
        `commit adds check infrastructure or flake tolerance without an \`${ADDS_CHECKS_TRAILER}:\` trailer: ${added.join('; ')}`,
        `Add \`${ADDS_CHECKS_TRAILER}: <the user's words that asked for this>\` to the message, `
        + 'or drop the new check infrastructure. A retry, sleep, raised timeout, or allowed failure hides a defect: '
        + 'fix the flake or delete the check instead. A test file in an existing lane and edits or deletions of existing checks need no trailer.',
    ];
}

/** @param {string} output @returns {INameStatusEntry[]} */
function parseNameStatus(output) {
    const fields = output.split('\0').filter(Boolean);
    /** @type {INameStatusEntry[]} */
    const entries = [];
    for (let index = 0; index < fields.length; index += 2) {
        const statusField = fields[index];
        const path = fields[index + 1];
        if (statusField === undefined || path === undefined) {
            throw new Error('Malformed git name-status output');
        }
        const status = statusField[0];
        if (status === undefined) {
            throw new Error('Malformed git name-status output');
        }
        // Renames and copies carry two paths; the destination is the new file.
        if (status === 'R' || status === 'C') {
            const destination = fields[index + 2];
            if (destination === undefined) {
                throw new Error('Malformed git name-status output');
            }
            entries.push({
                path: destination,
                status: 'A',
            });
            index += 1;
        } else {
            entries.push({
                path,
                status,
            });
        }
    }
    return entries;
}

const JSON_KEY_PATTERN = /^\s*("[^"]+"):/u;

// A new value under a JSON key the same diff removes (a package.json script
// whose command changed) edits an existing check rather than adding one.
/** @param {string[]} lines @returns {string[]} */
function addedLinesOf(lines) {
    const removedKeys = new Set(lines
        .filter(line => line.startsWith('-') && !line.startsWith('---'))
        .map(line => JSON_KEY_PATTERN.exec(line.slice(1))?.[1] ?? ''));
    return lines
        .filter(line => line.startsWith('+') && !line.startsWith('+++'))
        .map(line => line.slice(1))
        .filter(line => !removedKeys.has(JSON_KEY_PATTERN.exec(line)?.[1] ?? '\0'));
}

/** @param {string} escaped @returns {string} */
function unquoteGitPath(escaped) {
    /** @type {number[]} */
    const bytes = [];
    /** @type {Record<string, number>} */
    const simpleEscapes = {
        '"': 0x22,
        '\\': 0x5c,
        a: 0x07,
        b: 0x08,
        f: 0x0c,
        n: 0x0a,
        r: 0x0d,
        t: 0x09,
        v: 0x0b,
    };
    for (let index = 0; index < escaped.length; ) {
        const char = escaped[index];
        if (char !== '\\' || index + 1 >= escaped.length) {
            const codePoint = escaped.codePointAt(index);
            if (codePoint === undefined) {
                break;
            }
            bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
            index += codePoint > 0xffff ? 2 : 1;
            continue;
        }
        const next = escaped[index + 1] ?? '';
        const mapped = simpleEscapes[next];
        if (mapped !== undefined) {
            bytes.push(mapped);
            index += 2;
            continue;
        }
        const octal = escaped.slice(index + 1, index + 4);
        if (/^[0-7]{3}$/u.test(octal)) {
            bytes.push(Number.parseInt(octal, 8));
            index += 4;
            continue;
        }
        const codePoint = escaped.codePointAt(index + 1);
        if (codePoint === undefined) {
            break;
        }
        bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
        index += 1 + (codePoint > 0xffff ? 2 : 1);
    }
    return Buffer.from(bytes).toString('utf8');
}

/** @param {string} rawHeader @returns {string} */
function parseDiffDestinationPath(rawHeader) {
    const trimmed = rawHeader.replace(/\t$/u, '');
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        const unquoted = unquoteGitPath(trimmed.slice(1, -1));
        return unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
    }
    return trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}

/** @param {string} diff @returns {Map<string, string[]>} */
function parseAddedLinesByPath(diff) {
    /** @type {Map<string, string[]>} */
    const rawDiffByPath = new Map();
    /** @type {string | null} */
    let currentPath = null;
    let inHunk = false;

    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git ')) {
            currentPath = null;
            inHunk = false;
            continue;
        }
        if (!inHunk && (line.startsWith('+++ b/') || line.startsWith('+++ "b/'))) {
            currentPath = parseDiffDestinationPath(line.slice('+++ '.length));
            if (!rawDiffByPath.has(currentPath)) {
                rawDiffByPath.set(currentPath, []);
            }
            continue;
        }
        if (line.startsWith('@@ ')) {
            inHunk = true;
            continue;
        }
        if (inHunk && currentPath !== null) {
            rawDiffByPath.get(currentPath)?.push(line);
        }
    }

    /** @type {Map<string, string[]>} */
    const addedByPath = new Map();
    for (const [
        filePath,
        lines,
    ] of rawDiffByPath) {
        addedByPath.set(filePath, addedLinesOf(lines));
    }
    return addedByPath;
}

/** @param {INameStatusEntry[]} entries @returns {string[]} */
function selectLineRulePaths(entries) {
    return entries
        .filter(({
            path,
            status,
        }) => status !== 'D'
            && !(status === 'A' && ADDED_CHECK_FILE_PATTERNS.some(rule => rule.pattern.test(path)))
            && ADDED_CHECK_LINE_PATTERNS.some(rule => rule.file.test(path)))
        .map(({path}) => path);
}

/** @param {string[]} arguments_ @param {string} cwd @param {string} [input] @returns {string | null} */
function git(arguments_, cwd, input) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : null;
}

/** @param {string[]} arguments_ @param {string} cwd @param {string} [input] @returns {string} */
function gitOrThrow(arguments_, cwd, input) {
    const result = spawnSync('git', arguments_, {
        cwd,
        encoding: 'utf8',
        input,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`git ${arguments_.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout;
}

/**
 * Reads parents, commit timestamp, subject, and full commit message for every
 * commit in one `git log --no-walk --stdin` call, shared with `fix-chain.mjs`.
 * @param {string[]} commits @param {string} cwd @returns {Map<string, ICommitMetadata>}
 */
export function readCommitMetadata(commits, cwd) {
    /** @type {Map<string, ICommitMetadata>} */
    const metadata = new Map();
    if (commits.length === 0) {
        return metadata;
    }
    const output = gitOrThrow([
        'log',
        '--no-walk=unsorted',
        '--stdin',
        '-z',
        '--format=%H%x09%P%x09%ct%x09%s%n%B',
    ], cwd, `${commits.join('\n')}\n`);
    for (const record of output.split('\0')) {
        if (record.length === 0) {
            continue;
        }
        const newline = record.indexOf('\n');
        const header = newline === -1 ? record : record.slice(0, newline);
        const body = newline === -1 ? '' : record.slice(newline + 1);
        const [
            oid = '',
            parentsField = '',
            committedAtField = '0',
            ...subjectParts
        ] = header.split('\t');
        if (!oid) {
            continue;
        }
        metadata.set(oid, {
            body,
            committedAt: Number(committedAtField),
            oid,
            parents: parentsField.trim().split(' ').filter(Boolean),
            subject: subjectParts.join('\t'),
        });
    }
    for (const commit of commits) {
        if (!metadata.has(commit)) {
            throw new Error(`Missing commit metadata for ${commit}`);
        }
    }
    return metadata;
}

/** @param {INameStatusEntry[]} entries @param {string | null} baseRevision @param {string} cwd @returns {string[]} */
function findNewElectronE2ELanes(entries, baseRevision, cwd) {
    /** @type {Set<string>} */
    const candidateLanes = new Set();
    for (const {
        path,
        status,
    } of entries) {
        if (status !== 'A') {
            continue;
        }
        const match = ELECTRON_E2E_LANE_PATH_PATTERN.exec(path);
        const lane = match?.[1];
        if (lane && !NON_LANE_ELECTRON_E2E_DIRS.has(lane)) {
            candidateLanes.add(lane);
        }
    }
    if (candidateLanes.size === 0) {
        return [];
    }
    /** @type {string[]} */
    const found = [];
    for (const lane of [...candidateLanes].sort()) {
        const laneDir = `tests/e2e/electron/${lane}`;
        const existingTree = baseRevision === null
            ? ''
            : (git([
                'ls-tree',
                baseRevision,
                '--',
                laneDir,
            ], cwd) ?? '');
        const hasExistingTree = existingTree
            .split('\n')
            .some(line => /^\d+\s+tree\s+/u.test(line));
        if (!hasExistingTree) {
            found.push(`new Electron E2E lane: ${laneDir}`);
        }
    }
    return found;
}

/** @param {string} cwd @param {string[]} base @returns {string[]} */
function findStagedAddedChecksAgainst(cwd, base) {
    const names = git([
        'diff',
        '--cached',
        '--name-status',
        '-z',
        '--no-renames',
        ...base,
    ], cwd);
    if (names === null) {
        return [];
    }
    const entries = parseNameStatus(names);
    const baseRef = base[0] ?? 'HEAD';
    const hasBaseRevision = git([
        'rev-parse',
        '-q',
        '--verify',
        `${baseRef}^{tree}`,
    ], cwd) !== null;
    const lineRulePaths = selectLineRulePaths(entries);
    const addedByPath = lineRulePaths.length === 0
        ? new Map()
        : parseAddedLinesByPath(gitOrThrow([
            '-c',
            'core.quotePath=false',
            '-c',
            'diff.noprefix=false',
            '-c',
            'diff.mnemonicPrefix=false',
            'diff',
            '--cached',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '-U0',
            '--no-renames',
            ...base,
            '--',
            ...lineRulePaths,
        ], cwd));
    return [
        ...findNewElectronE2ELanes(entries, hasBaseRevision ? baseRef : null, cwd),
        ...findAddedChecks(entries, path => addedByPath.get(path) ?? []),
    ];
}

// A merge commit only adds what neither parent already had, so a check that
// arrives with the merged branch is not charged to the merge.
/** @param {string} cwd @returns {string[]} */
export function findStagedAddedChecks(cwd) {
    const againstHead = findStagedAddedChecksAgainst(cwd, []);
    if (git([
        'rev-parse',
        '-q',
        '--verify',
        'MERGE_HEAD',
    ], cwd) === null) {
        return againstHead;
    }
    const againstMergeHead = new Set(findStagedAddedChecksAgainst(cwd, ['MERGE_HEAD']));
    return againstHead.filter(check => againstMergeHead.has(check));
}

/** @param {string} commit @param {string | null} parent @param {string} cwd @returns {string[]} */
function findCommitAddedChecks(commit, parent, cwd) {
    const names = gitOrThrow([
        'diff-tree',
        '--no-commit-id',
        '-r',
        '--root',
        '--name-status',
        '-z',
        '--no-renames',
        commit,
    ], cwd);
    const entries = parseNameStatus(names);
    const lineRulePaths = selectLineRulePaths(entries);
    const addedByPath = lineRulePaths.length === 0
        ? new Map()
        : parseAddedLinesByPath(gitOrThrow([
            '-c',
            'core.quotePath=false',
            '-c',
            'diff.noprefix=false',
            '-c',
            'diff.mnemonicPrefix=false',
            'diff-tree',
            '--no-commit-id',
            '--root',
            '-r',
            '-p',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '-U0',
            '--no-renames',
            commit,
            '--',
            ...lineRulePaths,
        ], cwd));
    return [
        ...findNewElectronE2ELanes(entries, parent, cwd),
        ...findAddedChecks(entries, path => addedByPath.get(path) ?? []),
    ];
}

/** @param {string[]} commits @param {string} cwd @param {Map<string, ICommitMetadata>} [commitMetadata] @returns {{matches: string[], subject: string}[]} */
export function findAddedCheckViolations(commits, cwd, commitMetadata = readCommitMetadata(commits, cwd)) {
    return commits.flatMap((commit) => {
        const metadata = commitMetadata.get(commit);
        if (!metadata) {
            throw new Error(`Missing commit metadata for ${commit}`);
        }
        // A merge introduces nothing of its own; its parents were checked.
        if (metadata.parents.length > 1) {
            return [];
        }
        if (readAddsChecksTrailer(metadata.body) !== null) {
            return [];
        }
        const added = findCommitAddedChecks(commit, metadata.parents[0] ?? null, cwd);
        return added.length > 0 ? [{
            matches: describeMissingTrailer(added),
            subject: commit,
        }] : [];
    });
}
