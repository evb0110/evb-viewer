#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

// These files are text inputs, but they are intentionally excluded from the
// production/test line totals. Keep them separate from binary artifacts.
const NON_CODE_TEXT_EXTENSIONS = new Set([
    '.css',
    '.html',
    '.json',
    '.less',
    '.md',
    '.scss',
    '.toml',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
]);

const NON_CODE_TEXT_BASENAMES = new Set([
    '.gitignore',
    '.npmrc',
    '.nvmrc',
    'Cargo.lock',
    'Dockerfile',
    'Makefile',
]);

function compareCodeUnits(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function pathMatchesPrefix(relativePath, prefix) {
    return relativePath === prefix || relativePath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

function findDomainMatch(relativePath) {
    const matches = DOMAIN_MANIFEST.flatMap(domain => domain.prefixes
        .filter(prefix => pathMatchesPrefix(relativePath, prefix))
        .map(prefix => ({
            domain,
            prefix,
        })))
        .sort((left, right) => right.prefix.length - left.prefix.length
            || compareCodeUnits(left.domain.id, right.domain.id)
            || compareCodeUnits(left.prefix, right.prefix));
    return matches[0];
}

const DOMAIN_MANIFEST = Object.freeze([
    {
        id: 'scan-cleanup',
        ownerTickets: [
            '#296',
            '#297',
            '#298',
            '#299',
            '#300',
            '#301',
            '#320',
        ],
        prefixes: [
            'app/modules/scan-cleanup/',
            'electron/features/scan-cleanup/',
            'native/protocol-fixtures/',
            'native/scan-cleanup/',
            'packages/contracts/scan-cleanup/',
            'packages/scan-cleanup/',
        ],
        reservation: 'reserved',
    },
    {
        id: 'workspace-shell',
        ownerTickets: [
            '#306',
            '#307',
            '#308',
            '#309',
            '#310',
            '#311',
        ],
        prefixes: [
            'app/modules/workspace-shell/',
            'app/services/workspace',
            'app/utils/workspace',
        ],
        reservation: 'reserved',
    },
    {
        id: 'viewer-runtime',
        ownerTickets: [
            '#312',
            '#313',
        ],
        prefixes: ['app/modules/pdf-viewer/'],
        reservation: 'reserved',
    },
    {
        id: 'contracts',
        ownerTickets: [
            '#314',
            '#315',
            '#316',
        ],
        prefixes: ['packages/contracts/'],
        reservation: 'reserved',
    },
    {
        id: 'tooling',
        ownerTickets: [
            '#317',
            '#319',
            '#322',
            '#323',
        ],
        prefixes: [
            'eslint-plugin-custom.mjs',
            'eslint.config.mjs',
            'eslint.shared.mjs',
            'scripts/architecture/',
            'scripts/validation-gates.mjs',
            'tests/unit/scripts/',
        ],
        reservation: 'shared-owner',
    },
    {
        id: 'ci',
        ownerTickets: ['#324'],
        prefixes: ['.github/'],
        reservation: 'shared-owner',
    },
    {
        id: 'runtime-binaries',
        ownerTickets: [
            '#325',
            '#326',
        ],
        prefixes: [
            '.gitignore',
            'scripts/bundle-tools-windows.sh',
            'scripts/nativeResourceManifest.ts',
            'scripts/runtimeBinaryArchive.ts',
            'scripts/runRuntimeBinaryArchiveCli.ts',
            'scripts/runtimeBinaryManifest.ts',
            'scripts/validateRuntimeBinaryArchiveMembers.ts',
        ],
        reservation: 'reserved',
    },
    {
        id: 'assistant',
        ownerTickets: [
            '#327',
            '#328',
            '#329',
        ],
        prefixes: [
            'electron/features/agent/',
            'electron/features/assistant/',
            'electron/native-tools/',
        ],
        reservation: 'reserved',
    },
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runGit(root, args, {
    encoding = 'utf8', input,
} = {}) {
    const options = {
        cwd: root,
        input,
        maxBuffer: 128 * 1024 * 1024,
        stdio: [
            input === undefined ? 'ignore' : 'pipe',
            'pipe',
            'pipe',
        ],
    };
    if (encoding !== 'buffer') options.encoding = encoding;
    return execFileSync('git', args, options);
}

function resolveCommit(root, value, label) {
    const resolved = String(runGit(root, [
        'rev-parse',
        '--verify',
        `${value}^{commit}`,
    ])).trim();
    if (!/^[0-9a-f]{40}$/u.test(resolved)) {
        throw new Error(`${label} did not resolve to a full commit id: ${value}`);
    }
    return resolved;
}

export function classifyPath(relativePath) {
    const match = findDomainMatch(relativePath)?.domain;
    if (match) {
        return match;
    }
    return {
        id: 'unassigned',
        ownerTickets: [],
        prefixes: [],
        reservation: 'unassigned',
    };
}

export function parseNulDelimitedRecords(output) {
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output);
    if (buffer.length === 0) {
        return [];
    }
    if (buffer[buffer.length - 1] !== 0) {
        throw new Error('Git output ended without a NUL record terminator.');
    }
    return buffer.toString('utf8').split('\0').filter(Boolean);
}

export function parseTreeEntries(output) {
    return parseNulDelimitedRecords(output).map(record => {
        const separator = record.indexOf('\t');
        if (separator < 0) throw new Error(`Malformed Git tree record: ${record}`);
        const [
            mode,
            type,
            oid,
            size,
        ] = record.slice(0, separator).trim().split(/\s+/u);
        if (type !== 'blob' || !/^[0-9a-f]{40}$/u.test(oid ?? '') || !/^\d+$/u.test(size ?? '')) {
            throw new Error(`Malformed Git tree metadata: ${record}`);
        }
        return {
            mode,
            oid,
            path: record.slice(separator + 1),
            size: Number(size),
        };
    });
}

function parseNumstatCount(value) {
    if (value === '-') {
        return null;
    }
    if (!/^\d+$/u.test(value)) throw new Error(`Malformed Git numstat count: ${value}`);
    return Number(value);
}

export function parseNumstatRecords(output) {
    const records = parseNulDelimitedRecords(output);
    const result = [];
    for (let index = 0; index < records.length; index += 1) {
        const fields = records[index].split('\t');
        if (fields.length !== 3) throw new Error(`Malformed Git numstat record: ${records[index]}`);
        const [
            added,
            deleted,
            firstPath,
        ] = fields;
        if (firstPath.length > 0) {
            result.push({
                additions: parseNumstatCount(added),
                deletions: parseNumstatCount(deleted),
                newPath: firstPath,
                oldPath: firstPath,
            });
            continue;
        }
        const oldPath = records[index + 1];
        const newPath = records[index + 2];
        if (oldPath === undefined || newPath === undefined) {
            throw new Error('Malformed Git rename record.');
        }
        index += 2;
        result.push({
            additions: parseNumstatCount(added),
            deletions: parseNumstatCount(deleted),
            newPath,
            oldPath,
        });
    }
    return result;
}

function isNonCodeTextPath(relativePath) {
    return NON_CODE_TEXT_BASENAMES.has(path.basename(relativePath))
        || NON_CODE_TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function readTree(root, commit) {
    return parseTreeEntries(runGit(root, [
        'ls-tree',
        '-r',
        '-l',
        '-z',
        '--full-name',
        commit,
        '--',
    ], {encoding: 'buffer'}));
}

function emptyDomain() {
    return {
        bytes: 0,
        files: 0,
    };
}

function collectSnapshot(root, commit) {
    const entries = readTree(root, commit);
    const domains = Object.fromEntries(DOMAIN_MANIFEST.map(domain => [
        domain.id,
        {
            ...emptyDomain(),
            ownerTickets: domain.ownerTickets,
            reservation: domain.reservation,
        },
    ]));
    domains.unassigned = {
        ...emptyDomain(),
        ownerTickets: [],
        reservation: 'unassigned',
    };
    const binaryFiles = [];
    const nonCodeFiles = [];
    const unassignedPaths = [];
    const reservedPaths = [];
    const prefixMatchCounts = new Map(DOMAIN_MANIFEST.flatMap(domain => domain.prefixes.map(prefix => [
        `${domain.id}\0${prefix}`,
        {
            domainId: domain.id,
            prefix,
            count: 0,
            ownedCount: 0,
        },
    ])));
    for (const entry of entries) {
        const domainMatch = findDomainMatch(entry.path);
        const domain = domainMatch?.domain ?? classifyPath(entry.path);
        const target = domains[domain.id];
        target.files += 1;
        target.bytes += entry.size;
        if (domain.reservation !== 'unassigned') reservedPaths.push(entry.path);
        if (domain.id === 'unassigned') unassignedPaths.push(entry.path);
        for (const configuredDomain of DOMAIN_MANIFEST) {
            for (const prefix of configuredDomain.prefixes) {
                if (!pathMatchesPrefix(entry.path, prefix)) continue;
                const match = prefixMatchCounts.get(`${configuredDomain.id}\0${prefix}`);
                if (match !== undefined) match.count += 1;
            }
        }
        if (domainMatch !== undefined) {
            const ownedMatch = prefixMatchCounts.get(`${domainMatch.domain.id}\0${domainMatch.prefix}`);
            if (ownedMatch !== undefined) ownedMatch.ownedCount += 1;
        }
        if (isNonCodeTextPath(entry.path)) {
            nonCodeFiles.push({
                bytes: entry.size,
                domain: domain.id,
                gitBlobOid: entry.oid,
                path: entry.path,
            });
        } else {
            binaryFiles.push({
                bytes: entry.size,
                domain: domain.id,
                gitBlobOid: entry.oid,
                path: entry.path,
            });
        }
    }
    for (const target of Object.values(domains)) {
        target.ownerTickets = [...target.ownerTickets].sort();
    }
    return {
        binaryFiles: binaryFiles.sort((left, right) => compareCodeUnits(left.path, right.path)),
        domains,
        nonCodeFiles: nonCodeFiles.sort((left, right) => compareCodeUnits(left.path, right.path)),
        prefixMatches: [...prefixMatchCounts.values()].sort((left, right) => (
            compareCodeUnits(left.domainId, right.domainId)
            || compareCodeUnits(left.prefix, right.prefix)
        )),
        reservedPaths: reservedPaths.sort(compareCodeUnits),
        unassignedPaths: unassignedPaths.sort(compareCodeUnits),
    };
}

function collectCommits(root, base, head) {
    const output = String(runGit(root, [
        'log',
        '--format=%H%x09%s',
        `${base}..${head}`,
        '--',
    ]));
    const commits = output.trim().length === 0
        ? []
        : output.trimEnd().split('\n').map(line => {
            const separator = line.indexOf('\t');
            return {
                sha: line.slice(0, separator),
                title: line.slice(separator + 1),
            };
        });
    return {
        commitCount: commits.length,
        fixTitleCount: commits.filter(commit => /\bfix(?:es|ed)?\b/iu.test(commit.title)).length,
        titles: commits.map(commit => commit.title).sort(compareCodeUnits),
    };
}

function collectDiff(root, base, head) {
    return parseNumstatRecords(runGit(root, [
        'diff',
        '--find-renames',
        '--numstat',
        '-z',
        base,
        head,
        '--',
    ], {encoding: 'buffer'})).map(record => ({
        ...record,
        newDomain: classifyPath(record.newPath).id,
        oldDomain: classifyPath(record.oldPath).id,
    })).sort((left, right) => compareCodeUnits(
        `${left.newPath}\0${left.oldPath}`,
        `${right.newPath}\0${right.oldPath}`,
    ));
}

export function buildProject6ConsolidationReport({
    root = ROOT, base, head,
}) {
    if (base === undefined || head === undefined) {
        throw new Error('Both base and head commit ids are required.');
    }
    const baseCommit = resolveCommit(root, base, 'base');
    const headCommit = resolveCommit(root, head, 'head');
    const baseSnapshot = collectSnapshot(root, baseCommit);
    const headSnapshot = collectSnapshot(root, headCommit);
    const changedFiles = collectDiff(root, baseCommit, headCommit);
    const domains = {};
    for (const id of [
        ...Object.keys(baseSnapshot.domains),
        ...Object.keys(headSnapshot.domains),
    ].sort(compareCodeUnits)) {
        const before = baseSnapshot.domains[id] ?? emptyDomain();
        const after = headSnapshot.domains[id] ?? emptyDomain();
        domains[id] = {
            after,
            before,
            delta: {
                bytes: after.bytes - before.bytes,
                files: after.files - before.files,
            },
        };
    }
    const headBinaryByPath = new Map(headSnapshot.binaryFiles.map(file => [
        file.path,
        file,
    ]));
    const changedBinaryFiles = changedFiles
        .filter(change => headBinaryByPath.has(change.newPath))
        .map(change => headBinaryByPath.get(change.newPath))
        .filter(file => file !== undefined)
        .sort((left, right) => compareCodeUnits(left.path, right.path));
    const headNonCodeByPath = new Map(headSnapshot.nonCodeFiles.map(file => [
        file.path,
        file,
    ]));
    const changedNonCodeFiles = changedFiles
        .filter(change => headNonCodeByPath.has(change.newPath))
        .map(change => headNonCodeByPath.get(change.newPath))
        .filter(file => file !== undefined)
        .sort((left, right) => compareCodeUnits(left.path, right.path));
    return {
        base: baseCommit,
        head: headCommit,
        schemaVersion: 2,
        domains,
        changedFiles,
        binaryFiles: {addedOrChanged: changedBinaryFiles},
        nonCodeFiles: {addedOrChanged: changedNonCodeFiles},
        ownership: {
            baseReservedPaths: baseSnapshot.reservedPaths,
            baseUnassignedPaths: baseSnapshot.unassignedPaths,
            headReservedPaths: headSnapshot.reservedPaths,
            headUnassignedPaths: headSnapshot.unassignedPaths,
            basePrefixMatches: baseSnapshot.prefixMatches,
            headPrefixMatches: headSnapshot.prefixMatches,
        },
        commitTitles: collectCommits(root, baseCommit, headCommit),
    };
}

function formatCount(value) {
    return value === null ? '-' : value.toLocaleString('en-US');
}

export function renderMarkdown(report) {
    const lines = [
        '# Project 6 consolidation report',
        '',
        `Base: \`${report.base}\``,
        `Head: \`${report.head}\``,
        '',
        '| Domain | Files (base → head) | Bytes (base → head) | Reservation |',
        '| --- | ---: | ---: | --- |',
    ];
    for (const [
        id,
        value,
    ] of Object.entries(report.domains).sort(([left], [right]) => compareCodeUnits(left, right))) {
        lines.push(`| ${id} | ${formatCount(value.before.files)} → ${formatCount(value.after.files)} | ${formatCount(value.before.bytes)} → ${formatCount(value.after.bytes)} | ${value.after.reservation ?? value.before.reservation ?? 'unassigned'} |`);
    }
    lines.push('', `Commits: ${report.commitTitles.commitCount}; titles containing a fix verb: ${report.commitTitles.fixTitleCount} (informational only).`, '');
    lines.push('## Changed paths', '');
    if (report.changedFiles.length === 0) lines.push('No changed paths.', '');
    else for (const change of report.changedFiles) {
        const moved = change.oldPath === change.newPath ? '' : ` (moved from \`${change.oldPath}\`)`;
        lines.push(`- \`${change.newPath}\`${moved}: +${formatCount(change.additions)} / -${formatCount(change.deletions)}; domains ${change.oldDomain} → ${change.newDomain}`);
    }
    lines.push('', '## Ownership reconciliation', '');
    lines.push(`- Base reserved paths: ${report.ownership.baseReservedPaths.length}`);
    lines.push(`- Head reserved paths: ${report.ownership.headReservedPaths.length}`);
    lines.push(`- Base unassigned paths: ${report.ownership.baseUnassignedPaths.length}`);
    lines.push(`- Head unassigned paths: ${report.ownership.headUnassignedPaths.length}`);
    lines.push('', 'Head prefix match counts:', '');
    for (const match of report.ownership.headPrefixMatches) {
        lines.push(`- \`${match.domainId}\` / \`${match.prefix}\`: ${formatCount(match.count)} raw matches, ${formatCount(match.ownedCount)} owned paths`);
    }
    const zeroMatchPrefixes = report.ownership.headPrefixMatches.filter(match => match.count === 0);
    const shadowedPrefixes = report.ownership.headPrefixMatches.filter(match => match.count > 0 && match.ownedCount === 0);
    if (zeroMatchPrefixes.length > 0) {
        lines.push('', 'Head prefixes with zero matches:', '');
        for (const match of zeroMatchPrefixes) lines.push(`- \`${match.domainId}\` / \`${match.prefix}\``);
    }
    if (shadowedPrefixes.length > 0) {
        lines.push('', 'Head prefixes fully shadowed by a longer prefix:', '');
        for (const match of shadowedPrefixes) lines.push(`- \`${match.domainId}\` / \`${match.prefix}\`: ${formatCount(match.count)} raw matches, ${formatCount(match.ownedCount)} owned paths`);
    }
    if (report.ownership.headUnassignedPaths.length > 0) {
        lines.push('', 'Head unassigned paths:', '');
        for (const pathValue of report.ownership.headUnassignedPaths) lines.push(`- \`${pathValue}\``);
    }
    lines.push('', '## Non-counted text files', '');
    if (report.nonCodeFiles.addedOrChanged.length === 0) lines.push('No changed non-counted text files.', '');
    else for (const file of report.nonCodeFiles.addedOrChanged) lines.push(`- \`${file.path}\`: ${formatCount(file.bytes)} bytes, Git blob ${file.gitBlobOid}, domain ${file.domain}`);
    lines.push('', '## Binary and fixture inputs', '');
    if (report.binaryFiles.addedOrChanged.length === 0) lines.push('No changed binary files.', '');
    else for (const file of report.binaryFiles.addedOrChanged) lines.push(`- \`${file.path}\`: ${formatCount(file.bytes)} bytes, Git blob ${file.gitBlobOid}, domain ${file.domain}`);
    return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
    const values = {};
    for (const argument of argv) {
        const match = argument.match(/^--([^=]+)=(.*)$/u);
        if (!match) throw new Error(`Expected --name=value, got ${argument}`);
        values[match[1]] = match[2];
    }
    return values;
}

export function runCli(argv = process.argv.slice(2)) {
    const values = parseArgs(argv);
    const report = buildProject6ConsolidationReport({
        base: values.base,
        head: values.head,
        root: values.repo === undefined ? ROOT : path.resolve(values.repo),
    });
    const format = values.format ?? 'json';
    const rendered = format === 'markdown'
        ? renderMarkdown(report)
        : `${JSON.stringify(report, null, 2)}\n`;
    if (values.output === undefined) process.stdout.write(rendered);
    else writeFileSync(path.resolve(values.output), rendered);
    return report;
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) runCli();
