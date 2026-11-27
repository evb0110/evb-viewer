#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { listRequiredElectronE2ELanes } from '../electron-e2e-lanes.mjs';

const diffNameOnlyArguments = [
    '--no-renames',
    '--name-only',
    '--diff-filter=ACDMRT',
    '-z',
];

export const ALL_GATED_JOBS = Object.freeze([
    'lint',
    'unit',
    'build_wasm',
    'rust',
    'strict_build',
    'native_pdf_integration',
    'windows_atomic_pdf_replacement',
    'browser_integration',
    'scan_cleanup_oracles',
    'landing',
    'electron_e2e',
]);

const CANONICAL_JOB_ORDER = Object.freeze([
    'publication_policy',
    ...ALL_GATED_JOBS,
]);

const PRODUCT_JOBS = Object.freeze([
    'build_wasm',
    'strict_build',
    'electron_e2e',
    'native_pdf_integration',
    'windows_atomic_pdf_replacement',
    'browser_integration',
]);

const STRICT_BUILD_CONSUMERS = Object.freeze([
    'electron_e2e',
    'native_pdf_integration',
    'scan_cleanup_oracles',
]);

const WASM_CONSUMERS = Object.freeze([
    'unit',
    'strict_build',
    'browser_integration',
    'native_pdf_integration',
    'scan_cleanup_oracles',
]);

const DOCS_PATTERNS = Object.freeze([
    'docs/**',
    '**/*.md',
    '.husky/**',
]);

const LANDING_PATTERNS = Object.freeze([
    'landing/**',
    'packages/contracts/**',
    'packages/i18n-core/**',
    'packages/release-selection/**',
]);

const PRODUCT_PATTERNS = Object.freeze([
    'app/**',
    'electron/**',
    'packages/**',
    'server/**',
    'public/**',
    'vendor/**',
    'resources/**',
    'build/**',
    'types/**',
    'nuxt.config.ts',
    'electron-builder.yml',
    'tests/fixtures/**',
    'tests/helpers/**',
    'tests/setup*.ts',
]);

const NATIVE_PATTERNS = Object.freeze([
    'native/**',
    '.cargo/**',
    'rust-toolchain.toml',
    'packages/contracts/**',
    'public/fonts/annotation/**',
    'public/pdf/standard_fonts/**',
    'tests/fixtures/electron/interop/**',
]);

const SCAN_CLEANUP_PATTERNS = Object.freeze([
    'app/modules/scan-cleanup/**',
    'packages/scan-cleanup/**',
    'electron/features/scan-cleanup/**',
    'scripts/scan-cleanup-*',
    'scripts/scanCleanup*.ts',
    'scripts/diagnostics/**',
    'tests/unit/scripts/scanCleanup*.test.ts',
    'tests/unit/electron/scanCleanup*.test.ts',
    'tests/fixtures/release/scan-cleanup-*',
    'tests/fixtures/electron/test-scanned.pdf',
]);

const SCOPED_UNIT_AND_NIGHTLY_PATTERNS = Object.freeze([
    'tests/e2e/electron/nightly/**',
    'tests/unit/**',
]);

const SCOPED_BROWSER_TEST_PATTERNS = Object.freeze(['tests/integration/browser/**']);

const SCOPED_NATIVE_TEST_PATTERNS = Object.freeze(['tests/integration/native/**']);

/** @typedef {{lanes: string[], selected: string[], verifiedTree: boolean}} IChangedAreaSelection */
/** @typedef {{event?: string, lanes?: Array<{directory: string, name: string}>, verifiedTree?: boolean}} IClassifyOptions */

/** @param {string} filePath @returns {string} */
function normalizePath(filePath) {
    return filePath.split(path.sep).join('/').replace(/^\.\//u, '');
}

/** @param {string} filePath @param {string} pattern @returns {boolean} */
export function matchesChangedAreaPattern(filePath, pattern) {
    const normalizedPath = normalizePath(filePath);
    const normalizedPattern = normalizePath(pattern);
    let expression = '^';
    for (let index = 0; index < normalizedPattern.length; index += 1) {
        const character = normalizedPattern[index] ?? '';
        if (character === '*' && normalizedPattern[index + 1] === '*') {
            if (normalizedPattern[index + 2] === '/') {
                expression += '(?:.*/)?';
                index += 2;
                continue;
            }
            expression += '.*';
            index += 1;
            continue;
        }
        if (character === '*') {
            expression += '[^/]*';
            continue;
        }
        expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
    return new RegExp(`${expression}$`, 'u').test(normalizedPath);
}

/** @param {string} file @param {readonly string[]} patterns @returns {boolean} */
function matchesAny(file, patterns) {
    return patterns.some(pattern => matchesChangedAreaPattern(file, pattern));
}

/** @param {string} file @returns {boolean} */
function isDocsPath(file) {
    if (matchesAny(file, DOCS_PATTERNS)) {
        return true;
    }
    return matchesChangedAreaPattern(file, '.github/workflows/**') && file !== '.github/workflows/ci.yml';
}

/** @param {Set<string>} selected @param {readonly string[]} jobs */
function addJobs(selected, jobs) {
    for (const job of jobs) {
        selected.add(job);
    }
}

/** @param {Set<string>} selected @returns {string[]} */
function finalizeSelectedJobs(selected) {
    if (STRICT_BUILD_CONSUMERS.some(job => selected.has(job))) {
        selected.add('strict_build');
    }
    if (WASM_CONSUMERS.some(job => selected.has(job))) {
        selected.add('build_wasm');
    }
    return CANONICAL_JOB_ORDER.filter(job => selected.has(job));
}

/** @param {string[] | null} files @param {IClassifyOptions} [options] @returns {IChangedAreaSelection} */
export function classifyChangedFiles(files, options = {}) {
    const event = options.event ?? '';
    const availableLanes = options.lanes ?? listRequiredElectronE2ELanes();
    const allLaneNames = availableLanes.map(lane => lane.name).sort();
    const includePublicationPolicy = event === 'pull_request' || event === 'push';

    if (event === 'workflow_dispatch') {
        return {
            lanes: allLaneNames,
            selected: [...ALL_GATED_JOBS],
            verifiedTree: false,
        };
    }

    if (options.verifiedTree === true) {
        const selected = new Set([
            'strict_build',
            'electron_e2e',
        ]);
        if (includePublicationPolicy) {
            selected.add('publication_policy');
        }
        return {
            lanes: ['e2e-smoke'],
            selected: finalizeSelectedJobs(selected),
            verifiedTree: true,
        };
    }

    const selectAll = () => {
        const selected = new Set(ALL_GATED_JOBS);
        if (includePublicationPolicy) {
            selected.add('publication_policy');
        }
        return {
            lanes: allLaneNames,
            selected: finalizeSelectedJobs(selected),
            verifiedTree: false,
        };
    };

    if (files === null) {
        return selectAll();
    }

    const normalizedFiles = files.map(normalizePath).filter(Boolean);
    const selected = new Set([
        'lint',
        'unit',
    ]);
    if (includePublicationPolicy) {
        selected.add('publication_policy');
    }
    /** @type {Set<string>} */
    const selectedLanes = new Set();

    for (const file of normalizedFiles) {
        if (isDocsPath(file)) {
            continue;
        }

        let matched = false;

        if (matchesAny(file, LANDING_PATTERNS)) {
            addJobs(selected, [
                'landing',
                'browser_integration',
            ]);
            matched = true;
        }

        if (matchesAny(file, PRODUCT_PATTERNS)) {
            addJobs(selected, PRODUCT_JOBS);
            for (const laneName of allLaneNames) {
                selectedLanes.add(laneName);
            }
            matched = true;
        }

        if (matchesAny(file, NATIVE_PATTERNS)) {
            addJobs(selected, [
                'rust',
                ...PRODUCT_JOBS,
                'scan_cleanup_oracles',
            ]);
            for (const laneName of allLaneNames) {
                selectedLanes.add(laneName);
            }
            matched = true;
        }

        if (matchesAny(file, SCAN_CLEANUP_PATTERNS)) {
            selected.add('scan_cleanup_oracles');
            matched = true;
        }

        if (matchesAny(file, SCOPED_UNIT_AND_NIGHTLY_PATTERNS)) {
            matched = true;
        }

        if (matchesAny(file, SCOPED_BROWSER_TEST_PATTERNS)) {
            addJobs(selected, [
                'build_wasm',
                'browser_integration',
            ]);
            matched = true;
        }

        if (matchesAny(file, SCOPED_NATIVE_TEST_PATTERNS)) {
            addJobs(selected, [
                'build_wasm',
                'strict_build',
                'native_pdf_integration',
                'windows_atomic_pdf_replacement',
            ]);
            matched = true;
        }

        const matchedLane = availableLanes.find(lane => (
            matchesChangedAreaPattern(file, `${lane.directory}/**`)
        ));
        if (matchedLane) {
            addJobs(selected, [
                'strict_build',
                'electron_e2e',
            ]);
            selectedLanes.add(matchedLane.name);
            matched = true;
        }

        if (!matched) {
            return selectAll();
        }
    }

    return {
        lanes: [...selectedLanes].sort(),
        selected: finalizeSelectedJobs(selected),
        verifiedTree: false,
    };
}

/** @param {string[]} argv @param {string} name @returns {string[]} */
function readArgValues(argv, name) {
    const prefix = `--${name}=`;
    return argv.filter(arg => arg.startsWith(prefix)).map(arg => arg.slice(prefix.length));
}

/** @param {string[]} argv @param {string} name @returns {string | undefined} */
function readSingleArg(argv, name) {
    return readArgValues(argv, name).at(-1);
}

/** @param {string[]} arguments_ @returns {string[]} */
function readNullDelimitedGitOutput(arguments_) {
    return execFileSync('git', arguments_, { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
}

/** @param {{base?: string | undefined, head?: string | undefined, includeWorktree?: boolean}} options @returns {string[] | null} */
export function getChangedFiles({
    base,
    head,
    includeWorktree = false,
}) {
    if (!base || !head) {
        throw new Error('Both --base=<sha> and --head=<sha> are required when --file is not provided.');
    }
    try {
        const files = readNullDelimitedGitOutput([
            'diff',
            ...diffNameOnlyArguments,
            `${base}...${head}`,
        ]);
        if (includeWorktree) {
            files.push(...readNullDelimitedGitOutput([
                'diff',
                ...diffNameOnlyArguments,
                'HEAD',
            ]));
            files.push(...readNullDelimitedGitOutput([
                'diff',
                '--cached',
                ...diffNameOnlyArguments,
            ]));
            files.push(...readNullDelimitedGitOutput([
                'ls-files',
                '--others',
                '--exclude-standard',
                '-z',
            ]));
        }
        return [...new Set(files)];
    } catch {
        // A force-push or unresolvable push base leaves no honest diff to
        // classify; returning null fails open and selects every job.
        return null;
    }
}

/** @param {{argv?: string[], outputFile?: string | undefined}} options @returns {IChangedAreaSelection} */
export function runChangedAreaClassifier({
    argv = process.argv.slice(2),
    outputFile = process.env.GITHUB_OUTPUT,
} = {}) {
    const event = readSingleArg(argv, 'event') ?? '';
    const base = readSingleArg(argv, 'base');
    const head = readSingleArg(argv, 'head');
    const includeWorktree = argv.includes('--include-worktree');
    const explicitFiles = readArgValues(argv, 'file');
    const isVerifiedTree = event === 'push'
        && !includeWorktree
        && explicitFiles.length === 0
        && Boolean(base)
        && base === head
        && base !== 'unavailable-push-base';

    /** @type {string[] | null} */
    let files = null;
    if (event !== 'workflow_dispatch' && !isVerifiedTree) {
        files = explicitFiles.length > 0
            ? explicitFiles
            : getChangedFiles({
                base,
                head,
                includeWorktree,
            });
    }

    const selection = classifyChangedFiles(files, {
        event,
        verifiedTree: isVerifiedTree,
    });
    const outputLines = [
        `selected=${JSON.stringify(selection.selected)}`,
        `lanes=${JSON.stringify(selection.lanes)}`,
    ];

    if (outputFile) {
        appendFileSync(outputFile, `${outputLines.join('\n')}\n`);
    }
    process.stdout.write(`${JSON.stringify({
        event: event || undefined,
        files,
        lanes: selection.lanes,
        selected: selection.selected,
        verifiedTree: selection.verifiedTree,
    }, null, 2)}\n`);
    return selection;
}

const isDirectRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
    runChangedAreaClassifier();
}
