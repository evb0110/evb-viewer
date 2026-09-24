#!/usr/bin/env node

import { getCliErrorMessage } from './lib/cli-error.mjs';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(import.meta.dirname, '..');
const SCENARIOS = [{
    mode: 'native-freetext',
    tier: 'high',
}];

function readOptionValue(argument, value) {
    if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
    }
    return value;
}

export function parseSavePipelineBenchmarkArgs(argv) {
    const options = {
        fixture: null,
        iterations: 10,
        output: null,
        warmups: 5,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = argv[index + 1];
        if (argument === '--') {
            continue;
        }
        if (argument === '--fixture' || argument === '--pdf') {
            options.fixture = readOptionValue(argument, value);
            index += 1;
        } else if (argument === '--iterations') {
            options.iterations = Number(readOptionValue(argument, value));
            index += 1;
        } else if (argument === '--output' || argument === '--out') {
            options.output = readOptionValue(argument, value);
            index += 1;
        } else if (argument === '--warmups') {
            options.warmups = Number(readOptionValue(argument, value));
            index += 1;
        } else if (argument === '--help') {
            return {
                ...options,
                help: true,
            };
        } else {
            throw new Error(`Unknown benchmark option: ${argument}`);
        }
    }
    return {
        ...options,
        help: false,
    };
}

export function validateSavePipelineBenchmarkOptions(options, cwd = process.cwd()) {
    if (!options.fixture) {
        throw new Error('--fixture is required');
    }
    if (!options.output) {
        throw new Error('--output is required');
    }
    if (!Number.isSafeInteger(options.iterations) || options.iterations < 1) {
        throw new Error('--iterations must be a positive integer');
    }
    if (!Number.isSafeInteger(options.warmups) || options.warmups < 1) {
        throw new Error('--warmups must be a positive integer');
    }
    return {
        fixture: resolve(cwd, options.fixture),
        iterations: options.iterations,
        output: resolve(cwd, options.output),
        warmups: options.warmups,
    };
}

function run(command, args, env = process.env) {
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`);
    }
}

function pnpmCommand() {
    return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function hashFile(path) {
    const hash = createHash('sha256');
    await new Promise((resolvePromise, rejectPromise) => {
        const stream = createReadStream(path);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', rejectPromise);
        stream.on('end', resolvePromise);
    });
    return hash.digest('hex');
}

async function runScenario(options, scenario, temporaryDirectory) {
    const outputPath = join(
        temporaryDirectory,
        `${scenario.mode}-${scenario.tier}.json`,
    );
    run(pnpmCommand(), [
        'exec',
        'vitest',
        'run',
        '--project',
        'e2e-save',
        'tests/e2e/electron/save/savePipelineBenchmark.e2e.test.ts',
        '--retry',
        '0',
        '--reporter',
        'verbose',
    ], {
        ...process.env,
        EVB_SAVE_PIPELINE_BENCHMARK_FIXTURE: options.fixture,
        EVB_SAVE_PIPELINE_BENCHMARK_ITERATIONS: String(options.iterations),
        EVB_SAVE_PIPELINE_BENCHMARK_OUTPUT: outputPath,
        EVB_SAVE_PIPELINE_BENCHMARK_TIER: scenario.tier,
        EVB_SAVE_PIPELINE_BENCHMARK_WARMUPS: String(options.warmups),
    });
    return JSON.parse(await readFile(outputPath, 'utf8'));
}

export function normalizeSemanticReopenSummary(summary) {
    if (
        !summary
        || !Number.isSafeInteger(summary.total)
        || summary.total < 0
        || !summary.bySubtype
        || typeof summary.bySubtype !== 'object'
        || Array.isArray(summary.bySubtype)
    ) {
        throw new Error('Invalid semantic reopen summary');
    }
    const subtypeEntries = Object.entries(summary.bySubtype);
    if (subtypeEntries.some(([
        , count,
    ]) => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error('Invalid semantic reopen subtype count');
    }
    const rawTotal = subtypeEntries.reduce((sum, [
        , count,
    ]) => sum + count, 0);
    if (rawTotal !== summary.total) {
        throw new Error('Semantic reopen total does not match subtype counts');
    }
    const bySubtype = Object.fromEntries(
        subtypeEntries
            // A Popup is the structural companion of a user-visible annotation,
            // not an independently authored semantic annotation.
            .filter(([subtype]) => subtype !== 'Popup')
            .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    );
    return {
        total: Object.values(bySubtype).reduce((sum, count) => sum + count, 0),
        bySubtype,
    };
}

function expectedAuthoredFreeTextSummary(sourceSummary) {
    const bySubtype = {
        ...sourceSummary.bySubtype,
        FreeText: (sourceSummary.bySubtype.FreeText ?? 0) + 1,
    };
    return {
        total: sourceSummary.total + 1,
        bySubtype: Object.fromEntries(
            Object.entries(bySubtype)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
        ),
    };
}

export function assertSemanticParity(results) {
    const summaries = results.map((result) => {
        try {
            const source = normalizeSemanticReopenSummary(result.sourceSemanticReopen);
            const output = normalizeSemanticReopenSummary(result.semanticReopen);
            const expected = expectedAuthoredFreeTextSummary(source);
            if (JSON.stringify(output) !== JSON.stringify(expected)) {
                throw new Error('output does not contain exactly one additional FreeText annotation');
            }
            return JSON.stringify(output);
        } catch (error) {
            const reason = getCliErrorMessage(error);
            throw new Error(
                `Save benchmark scenario ${result.scenario ?? '<unknown>'} has missing or invalid semantic reopen evidence: ${reason}`,
            );
        }
    });
    const baseline = summaries[0];
    if (summaries.some(summary => summary !== baseline)) {
        throw new Error('Save benchmark scenarios produced different semantic reopen summaries');
    }
    return baseline ? JSON.parse(baseline) : null;
}

export function buildSavePipelineBenchmarkReport(options, scenarios, meta) {
    return {
        schemaVersion: 1,
        generatedAt: meta.generatedAt,
        fixturePath: options.fixture,
        fixtureBytes: meta.fixtureBytes,
        fixtureSha256: meta.fixtureSha256,
        inputPath: options.fixture,
        outputPath: options.output,
        warmups: options.warmups,
        iterations: options.iterations,
        hostProfile: scenarios[0]?.hostProfile ?? null,
        hostTier: scenarios[0]?.hostProfile?.tier ?? scenarios[0]?.tier ?? null,
        cloneMode: {
            measured: 'auto',
            forcedNoClone: 'unavailable',
        },
        semanticParity: meta.semanticParity ?? null,
        scenarios,
    };
}

export async function runSavePipelineBenchmark(rawOptions) {
    const options = validateSavePipelineBenchmarkOptions(rawOptions);
    const fixtureStat = await stat(options.fixture);
    if (!fixtureStat.isFile() || fixtureStat.size === 0) {
        throw new Error('Benchmark fixture must be a non-empty PDF file');
    }
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'evb-save-pipeline-benchmark-'));
    try {
        run(pnpmCommand(), [
            'run',
            'build:pdf-page-ops',
        ]);
        run(pnpmCommand(), [
            'run',
            'build:electron',
        ]);
        const results = [];
        for (const scenario of SCENARIOS) {
            results.push(await runScenario(options, scenario, temporaryDirectory));
        }
        const semanticParitySummary = assertSemanticParity(results);
        const scenarios = results.map(result => ({
            ...result,
            semanticReopenComparable: normalizeSemanticReopenSummary(result.semanticReopen),
        }));
        const report = buildSavePipelineBenchmarkReport(options, scenarios, {
            fixtureBytes: fixtureStat.size,
            fixtureSha256: await hashFile(options.fixture),
            generatedAt: new Date().toISOString(),
            semanticParity: {
                ignoredSubtypes: ['Popup'],
                summary: semanticParitySummary,
            },
        });
        await mkdir(dirname(options.output), {recursive: true});
        await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return report;
    } finally {
        await rm(temporaryDirectory, {
            force: true,
            recursive: true,
        });
    }
}

function printUsage() {
    process.stdout.write(
        'Usage: node scripts/benchmark-save-pipeline.mjs (--fixture|--pdf) input.pdf --iterations 10 (--output|--out) .devkit/analysis/save-pipeline.json [--warmups 5]\n',
    );
}

const isMain = process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
if (isMain) {
    const options = parseSavePipelineBenchmarkArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
    } else {
        await runSavePipelineBenchmark(options);
    }
}
