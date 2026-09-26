#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
    listSuccessfulMainPushRuns, readGatesOkConclusion,
} from './wait-for-exact-sha-ci.mjs';

/** @type {Set<'patch'|'minor'|'major'>} */
const LEVELS = new Set([
    'patch',
    'minor',
    'major',
]);

/** @param {string} command @param {string[]} args */
export function run(command, args) {
    return String(execFileSync(command, args, {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    })).trim();
}

/** @param {string} tag @returns {number[]} */
export function releaseVersionParts(tag) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(tag);
    if (!match) throw new Error(`Invalid stable release tag: ${tag}`);
    return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
    ];
}

/** @param {number[]} version @param {'patch'|'minor'|'major'} level */
export function bumpReleaseVersion(version, level) {
    const [
        major,
        minor,
        patch,
    ] = version;
    if (major === undefined || minor === undefined || patch === undefined || !LEVELS.has(level)) {
        throw new Error(`Invalid release level: ${level}`);
    }
    return level === 'major' ? `${major + 1}.0.0`
        : level === 'minor' ? `${major}.${minor + 1}.0`
            : `${major}.${minor}.${patch + 1}`;
}

/** @param {{runCommand?: typeof run, listRuns?: typeof listSuccessfulMainPushRuns, gates?: typeof readGatesOkConclusion}} [options] */
export function selectReleaseCandidate({
    runCommand = run,
    listRuns = listSuccessfulMainPushRuns,
    gates = readGatesOkConclusion,
} = {}) {
    const main = runCommand('git', [
        'rev-parse',
        'origin/main',
    ]);
    const tags = runCommand('git', [
        'tag',
        '--list',
        'v[0-9]*',
    ]).split('\n').filter(Boolean)
        .filter(tag => /^v\d+\.\d+\.\d+$/u.test(tag)).sort((a, b) => {
            const x = releaseVersionParts(a); const y = releaseVersionParts(b);
            return (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0);
        });
    const lastTag = tags.at(-1) ?? null;
    const lastTagSha = lastTag ? runCommand('git', [
        'rev-parse',
        `${lastTag}^{commit}`,
    ]) : null;
    for (const runInfo of listRuns(runCommand)) {
        const sha = runInfo.head_sha;
        if (!sha || gates(runInfo.id, runCommand) !== 'success') continue;
        try {
            runCommand('git', [
                'merge-base',
                '--is-ancestor',
                sha,
                main,
            ]);
            if (lastTagSha) runCommand('git', [
                'merge-base',
                '--is-ancestor',
                lastTagSha,
                sha,
            ]);
        } catch {
            continue;
        }
        if (lastTagSha && sha === lastTagSha) continue;
        return {
            sha,
            run: runInfo,
            lastTag,
        };
    }
    throw new Error(`No newer commit on origin/main has a green exact-SHA ci.yml gates_ok verdict${lastTag ? ` after ${lastTag}` : ''}.`);
}

/** @param {'patch'|'minor'|'major'} level @param {{runCommand?: typeof run, listRuns?: typeof listSuccessfulMainPushRuns, gates?: typeof readGatesOkConclusion}} [options] */
export function planRelease(level, {
    runCommand = run, ...candidateOptions
} = {}) {
    if (!LEVELS.has(level)) throw new Error('Expected release level: patch, minor, or major');
    runCommand('git', [
        'fetch',
        '--tags',
        'origin',
        'main',
    ]);
    const {
        sha, run: ciRun, lastTag,
    } = selectReleaseCandidate({
        runCommand,
        ...candidateOptions,
    });
    if (!lastTag) throw new Error('No stable release tag exists to derive the next version from.');
    const current = releaseVersionParts(lastTag);
    return {
        candidateCiRunId: ciRun.id,
        candidateCiRunUrl: ciRun.html_url ?? '',
        candidateSha: sha,
        currentVersion: current.join('.'),
        nextVersion: bumpReleaseVersion(current, level),
        tag: `v${bumpReleaseVersion(current, level)}`,
    };
}

/** @param {string[]} argv @returns {'patch'|'minor'|'major'} */
export function parseCutReleaseArgs(argv) {
    const level = argv[0];
    if (argv.length !== 1 || !LEVELS.has(/** @type {'patch'|'minor'|'major'} */ (level))) throw new Error('Usage: pnpm run release:cut -- <patch|minor|major>');
    return /** @type {'patch'|'minor'|'major'} */ (level);
}

/** @param {string[]} argv */
export async function main(argv = process.argv.slice(2)) {
    const level = parseCutReleaseArgs(argv);
    const plan = planRelease(level);
    run('git', [
        'push',
        'origin',
        `${plan.candidateSha}:refs/tags/${plan.tag}`,
    ]);
    const repo = run('gh', [
        'repo',
        'view',
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
    ]);
    const runUrl = `https://github.com/${repo}/actions/workflows/release.yml`;
    process.stdout.write(`Tagged ${plan.candidateSha} as ${plan.tag}. Release workflow: ${runUrl}\nCI: ${plan.candidateCiRunUrl}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    try { await main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
