#!/usr/bin/env node
 
import { getCliErrorMessage } from './lib/cli-error.mjs';
import {spawn} from 'node:child_process';
import {
    access,
    mkdir,
    readFile,
    readdir,
    stat,
    writeFile,
} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {createHash} from 'node:crypto';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultManifestPath = join(projectRoot, '.devkit', 'scan-cleanup-regress.json');
const defaultModeMatrixConfigPath = join(
    projectRoot,
    'scripts/diagnostics/rome-mode-matrix-corpus-config.json',
);
const defaultExpectedPath = join(
    projectRoot,
    'scripts/diagnostics/scan-cleanup-corpus-expected-results.json',
);
const wordLossAuditPath = join(
    projectRoot,
    'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs',
);
const headerPages = [
    46,
    49,
    52,
    56,
];
const requiredCorpusNames = [
    'acceptance2',
    'regress',
    'canvas-trio',
    'headers2',
];

function usage() {
    return `Usage: pnpm scan-cleanup:regress [--full] [options]

Runs the standing scan-cleanup verification net without launching Electron:
the acceptance2, regress, canvas-trio, and headers2 corpus harnesses; parity
CLI conversions with fail-closed word-loss audits; and the Rome header render
checks for source pages 46, 49, 52, and 56.

Options:
  --manifest <path>  Machine-local manifest (default: .devkit/scan-cleanup-regress.json)
  --work-dir <path>  Retain all command evidence below this directory
  --full             Add the release-only fullbook corpus gate
  --help             Show this message

The manifest supplies private fixture paths. The fullbook corpus is deliberately
excluded unless --full is present, so nightly runs stay below the 30-minute budget.`;
}

function parseArgs(argv) {
    const parsed = {
        full: false,
        manifest: defaultManifestPath,
        workDir: join(projectRoot, '.devkit', `scan-cleanup-regress-${Date.now()}`),
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--full') {
            parsed.full = true;
        } else if (argument === '--help' || argument === '-h') {
            console.log(usage());
            return null;
        } else if (argument === '--manifest' || argument === '--work-dir') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`Missing value for ${argument}`);
            }
            parsed[argument === '--manifest' ? 'manifest' : 'workDir'] = resolve(value);
            index += 1;
        } else if (argument !== '--') {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return parsed;
}

function expandEnvironmentValue(value, env, label) {
    if (typeof value !== 'string') {
        return value;
    }
    const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u.exec(value);
    if (!match) {
        return value;
    }
    if (!env[match[1]]) {
        throw new Error(`Missing required environment variable ${match[1]} for ${label}`);
    }
    return env[match[1]];
}

function configuredPath(value, env, label) {
    const expanded = expandEnvironmentValue(value, env, label);
    if (typeof expanded !== 'string' || expanded === '') {
        throw new Error(`Missing path for ${label}`);
    }
    return isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
}

function parsePageSelector(value, label) {
    if (Array.isArray(value)) {
        if (
            value.length === 0
            || value.some(page => !Number.isSafeInteger(page) || page < 1)
            || new Set(value).size !== value.length
        ) {
            throw new Error(`Invalid pages for ${label}`);
        }
        return [...value];
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`Missing pages for ${label}`);
    }
    const pages = value.split(',').flatMap(part => {
        const trimmed = part.trim();
        if (trimmed === '') {
            return [];
        }
        const range = /^(\d+)-(\d+)$/u.exec(trimmed);
        if (!range) {
            const page = Number(trimmed);
            if (!Number.isSafeInteger(page) || page < 1) throw new Error(`Invalid pages for ${label}`);
            return [page];
        }
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
            throw new Error(`Invalid pages for ${label}`);
        }
        return Array.from({length: to - from + 1}, (_, index) => from + index);
    });
    if (pages.length === 0 || new Set(pages).size !== pages.length) {
        throw new Error(`Invalid pages for ${label}`);
    }
    return pages;
}

async function readableFile(filePath) {
    try {
        await access(filePath, fsConstants.R_OK);
        return (await stat(filePath)).isFile();
    } catch {
        return false;
    }
}

async function readJson(filePath, label) {
    if (!await readableFile(filePath)) {
        throw new Error(`${label} is missing or unreadable: ${filePath}`);
    }
    try {
        return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`Could not parse ${label} ${filePath}: ${getCliErrorMessage(error)}`);
    }
}

function runProcess(command, args, options = {}) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? projectRoot,
            env: options.env ?? process.env,
            stdio: options.capture ? [
                'ignore',
                'pipe',
                'pipe',
            ] : 'inherit',
        });
        let stdout = '';
        let stderr = '';
        if (options.capture) {
            child.stdout?.setEncoding('utf8');
            child.stderr?.setEncoding('utf8');
            child.stdout?.on('data', chunk => { stdout += chunk; });
            child.stderr?.on('data', chunk => { stderr += chunk; });
        }
        child.once('error', reject);
        child.once('exit', code => resolveRun({
            code: code ?? 1,
            stderr,
            stdout,
        }));
    });
}

async function runChecked(command, args, options = {}) {
    const result = await runProcess(command, args, options);
    if (result.code !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with status ${String(result.code)}`);
    }
    return result;
}

function corpusEntry(manifest, name) {
    const entry = manifest.corpora?.[name];
    if (typeof entry === 'string') {
        return {config: entry};
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        return entry;
    }
    throw new Error(`Manifest is missing required corpus entry "${name}"`);
}

function cliEntry(manifest, name) {
    const entry = manifest.cli?.[name] ?? manifest.corpora?.[name]?.cli;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Manifest is missing required CLI fixture entry "${name}"`);
    }
    return entry;
}

async function runCorpus({
    entry,
    env,
    name,
    workDir,
    allowMissingExpectations = false,
}) {
    const configPath = configuredPath(entry.config, env, `${name} corpus config`);
    const expectedPath = configuredPath(entry.expected ?? defaultExpectedPath, env, `${name} expected results`);
    const args = [
        'run',
        'diag:scan-cleanup-corpus-verify',
        '--',
        '--config',
        configPath,
        '--expected',
        expectedPath,
        '--work-dir',
        join(workDir, name),
        '--keep-artifacts',
    ];
    if (allowMissingExpectations) args.push('--allow-missing-expectations');
    await runChecked('pnpm', args, {env});
}

function cliPages(entry, name, env) {
    const value = entry.pages ?? entry.pageRange;
    if (entry.pagesEnv) {
        return parsePageSelector(env[entry.pagesEnv], `${name} pages`);
    }
    if (entry.pageRange && !Array.isArray(entry.pageRange)) {
        const from = entry.pageRange.from;
        const to = entry.pageRange.to;
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
            throw new Error(`Invalid pageRange for ${name}`);
        }
        return Array.from({length: to - from + 1}, (_, index) => from + index);
    }
    return value === undefined ? undefined : parsePageSelector(value, `${name} pages`);
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
}

function assertOnlyKeys(value, allowedKeys, label) {
    assertObject(value, label);
    const unexpected = Object.keys(value).filter(key => !allowedKeys.has(key));
    if (unexpected.length > 0) {
        throw new Error(`${label} contains unknown field(s): ${unexpected.join(', ')}`);
    }
}

export function parseWordLossBaseline(value, name, pages) {
    if (value === undefined) {
        return null;
    }
    assertOnlyKeys(value, new Set(['inventedInk']), `${name} word-loss baseline`);
    const inventedInk = value.inventedInk;
    assertObject(inventedInk, `${name} word-loss invented-ink baseline`);
    const entries = Object.entries(inventedInk);
    if (entries.length === 0) {
        throw new Error(`${name} word-loss invented-ink baseline must name at least one page`);
    }
    const baseline = {};
    for (const [
        pageKey,
        cap,
    ] of entries) {
        if (!/^[1-9]\d*$/u.test(pageKey) || String(Number(pageKey)) !== pageKey) {
            throw new Error(`${name} word-loss baseline page "${pageKey}" is not canonical`);
        }
        const page = Number(pageKey);
        if (!Number.isSafeInteger(page) || (pages !== undefined && !pages.includes(page))) {
            throw new Error(`${name} word-loss baseline page ${pageKey} is outside the selected pages`);
        }
        assertOnlyKeys(
            cap,
            new Set([
                'maxComponents',
                'maxFraction',
                'reason',
            ]),
            `${name} word-loss baseline page ${pageKey}`,
        );
        if (!Number.isSafeInteger(cap.maxComponents) || cap.maxComponents < 0) {
            throw new Error(`${name} word-loss baseline page ${pageKey} has invalid maxComponents`);
        }
        if (!Number.isFinite(cap.maxFraction) || cap.maxFraction < 0 || cap.maxFraction > 1) {
            throw new Error(`${name} word-loss baseline page ${pageKey} has invalid maxFraction`);
        }
        if (typeof cap.reason !== 'string' || cap.reason.trim() === '') {
            throw new Error(`${name} word-loss baseline page ${pageKey} must document its reason`);
        }
        baseline[page] = {
            maxComponents: cap.maxComponents,
            maxFraction: cap.maxFraction,
            reason: cap.reason.trim(),
        };
    }
    return baseline;
}

export function wordLossFailOn(baseline) {
    return baseline === null ? 'any' : 'none';
}

function sortedPageList(value, label) {
    if (
        !Array.isArray(value)
        || value.some(page => !Number.isSafeInteger(page) || page < 1)
        || new Set(value).size !== value.length
    ) {
        throw new Error(`${label} must be a unique positive-integer page list`);
    }
    return [...value].sort((left, right) => left - right);
}

function assertSamePages(actual, expected, label) {
    const normalized = sortedPageList(actual, label);
    if (JSON.stringify(normalized) !== JSON.stringify(expected)) {
        throw new Error(`${label} disagrees with the page rows`);
    }
}

export function validateWordLossReport(report, name, pages, baseline) {
    if (report.stampVerification?.status !== 'valid') {
        throw new Error(`${name} word-loss report does not contain a valid provenance stamp`);
    }
    const pageRows = Array.isArray(report.pages) ? report.pages : [];
    const selected = pages === undefined
        ? pageRows
        : pageRows.filter(page => pages.includes(page.page));
    if (selected.length === 0) {
        throw new Error(`${name} word-loss report did not contain an audited page row`);
    }
    if (
        report.summary?.auditCoverageComplete !== true
        || !Number.isSafeInteger(report.summary?.expectedOutputPages)
        || report.summary.expectedOutputPages < 1
        || report.summary.analyzedOutputPages !== report.summary.expectedOutputPages
        || selected.some(page => page.status !== 'analyzed')
    ) {
        throw new Error(`${name} word-loss report has incomplete analyzed output coverage`);
    }
    if (pages !== undefined) {
        assertSamePages(selected.map(row => row.page), [...pages].sort((a, b) => a - b), `${name} selected page coverage`);
    }
    if (
        report.summary?.suppressedCount !== 0
        || !Array.isArray(report.summary?.suppressedPages)
        || report.summary.suppressedPages.length > 0
        || selected.some(page => page.comparisonSuppressed !== undefined)
    ) {
        throw new Error(`${name} word-loss report has suppressed text-loss comparisons`);
    }
    if (baseline === null) {
        const badRows = selected.filter(page => (
            page.flagged === true
            || page.silhouetteFlagged === true
        ));
        const summaryFlagged = Number(report.summary?.flaggedCount ?? 0);
        const summarySilhouette = Number(
            report.summary?.silhouetteCount
                ?? report.summary?.silhouettePages?.length
                ?? 0,
        );
        if (
            badRows.length > 0
            || summaryFlagged > 0
            || summarySilhouette > 0
        ) {
            throw new Error(`${name} word-loss report flagged or lost content on ${String(badRows.length || summaryFlagged || summarySilhouette)} page(s)`);
        }
        return;
    }

    const rowPages = pageRows.map(row => row.page);
    if (
        rowPages.some(page => !Number.isSafeInteger(page) || page < 1)
        || new Set(rowPages).size !== rowPages.length
    ) {
        throw new Error(`${name} word-loss report has invalid or duplicate page rows`);
    }
    const flaggedPages = [];
    const inventedPages = [];
    const silhouettePages = [];
    const errorPages = [];
    for (const row of pageRows) {
        const lossFlagged = row.lossFlagged === true;
        const inventedFlagged = row.inventedFlagged === true;
        const silhouetteFlagged = row.silhouetteFlagged === true;
        const flagged = lossFlagged || inventedFlagged || silhouetteFlagged;
        if ((row.flagged === true) !== flagged) {
            throw new Error(`${name} word-loss report page ${String(row.page)} has inconsistent flag fields`);
        }
        if (row.status === 'error') errorPages.push(row.page);
        if (flagged) flaggedPages.push(row.page);
        if (inventedFlagged) inventedPages.push(row.page);
        if (silhouetteFlagged) silhouettePages.push(row.page);
        if (lossFlagged || silhouetteFlagged) {
            throw new Error(`${name} word-loss baseline cannot suppress text-loss or silhouette flags on page ${String(row.page)}`);
        }
        const cap = baseline[row.page];
        if (inventedFlagged && cap === undefined) {
            throw new Error(`${name} word-loss report has an unbaselined invented-ink flag on page ${String(row.page)}`);
        }
        if (cap !== undefined) {
            if (row.status !== 'analyzed') {
                throw new Error(`${name} word-loss baseline page ${String(row.page)} was not analyzed`);
            }
            if (!Number.isSafeInteger(row.inventedCount) || row.inventedCount < 0) {
                throw new Error(`${name} word-loss report page ${String(row.page)} has invalid inventedCount`);
            }
            if (!Number.isFinite(row.inventedInkFraction) || row.inventedInkFraction < 0) {
                throw new Error(`${name} word-loss report page ${String(row.page)} has invalid inventedInkFraction`);
            }
            if (
                row.inventedCount > cap.maxComponents
                || row.inventedInkFraction > cap.maxFraction
            ) {
                throw new Error(`${name} word-loss report page ${String(row.page)} exceeds its invented-ink baseline`);
            }
        }
    }
    if (errorPages.length > 0) {
        throw new Error(`${name} word-loss report contains error page(s): ${errorPages.join(', ')}`);
    }
    for (const page of Object.keys(baseline).map(Number)) {
        if (!pageRows.some(row => row.page === page)) {
            throw new Error(`${name} word-loss baseline page ${String(page)} is missing from the report`);
        }
    }
    flaggedPages.sort((left, right) => left - right);
    inventedPages.sort((left, right) => left - right);
    silhouettePages.sort((left, right) => left - right);
    errorPages.sort((left, right) => left - right);
    assertSamePages(report.summary?.flaggedPages, flaggedPages, `${name} summary flaggedPages`);
    assertSamePages(report.summary?.inventedPages, inventedPages, `${name} summary inventedPages`);
    assertSamePages(report.summary?.silhouettePages, silhouettePages, `${name} summary silhouettePages`);
    assertSamePages(report.summary?.errorPages, errorPages, `${name} summary errorPages`);
    if (report.summary?.flaggedCount !== flaggedPages.length) {
        throw new Error(`${name} summary flaggedCount disagrees with the page rows`);
    }
}

function conversionArgs(source, output, pages) {
    return [
        '--import',
        'tsx',
        'scripts/scan-cleanup-convert.ts',
        '--source',
        source,
        '--out',
        output,
        ...(pages === undefined ? [] : [
            '--pages',
            pages.join(','),
        ]),
        '--parity',
    ];
}

async function runCliConversion({
    entry,
    env,
    name,
    outputRoot,
    pages,
}) {
    const source = configuredPath(entry.source, env, `${name} source PDF`);
    if (!await readableFile(source)) throw new Error(`${name} source PDF is missing: ${source}`);
    const output = join(outputRoot, `${name}.cleaned.pdf`);
    await mkdir(outputRoot, {recursive: true});
    await runChecked(process.execPath, conversionArgs(source, output, pages), {env});
    return {
        cleaned: output,
        source,
    };
}

async function runWordLossAudit({
    cleaned,
    env,
    name,
    outputRoot,
    source,
    pages,
    wordLossBaseline,
}) {
    const baseline = parseWordLossBaseline(wordLossBaseline, name, pages);
    const reportPath = join(outputRoot, `${name}.word-loss.json`);
    const args = [
        wordLossAuditPath,
        '--source',
        source,
        '--cleaned',
        cleaned,
        '--mapping',
        `${cleaned}.summary.json`,
        '--out',
        reportPath,
        '--fail-on',
        wordLossFailOn(baseline),
        '--verify-stamp',
        '--workers',
        '1',
        ...(pages === undefined ? [] : [
            '--from',
            String(Math.min(...pages)),
            '--to',
            String(Math.max(...pages)),
        ]),
    ];
    await runChecked(process.execPath, args, {env});
    await assertWordLossReport(reportPath, name, pages, baseline);
    return reportPath;
}

async function assertWordLossReport(reportPath, name, pages, baseline) {
    const report = await readJson(reportPath, `${name} word-loss report`);
    // The audit is the classification authority: it weighs raw lost
    // components against reliability, dust, and severity before flagging.
    // Re-asserting raw lostCount here rejected pages the audit itself
    // classifies clean, and the wrapper's own pinned baselines carry such
    // sub-threshold counts.
    validateWordLossReport(report, name, pages, baseline);
}

async function renderHeaderPages({
    cleaned,
    env,
    outputRoot,
    source,
}) {
    const summary = await readJson(`${cleaned}.summary.json`, 'Rome header conversion summary');
    const mapping = summary.sourcePageToOutputPages;
    if (!Array.isArray(mapping) && (!mapping || typeof mapping !== 'object')) {
        throw new Error('Rome header conversion summary has no sourcePageToOutputPages mapping');
    }
    await mkdir(outputRoot, {recursive: true});
    const pdftoppm = env.EVB_PDFTOPPM_PATH ?? 'pdftoppm';
    for (const sourcePage of headerPages) {
        const outputPages = Array.isArray(mapping)
            ? mapping.find(record => record.sourcePage === sourcePage)?.outputPages
            : mapping[String(sourcePage)];
        if (!Array.isArray(outputPages) || outputPages.length === 0) {
            throw new Error(`Rome header conversion has no output page for source page ${String(sourcePage)}`);
        }
        for (const outputPage of outputPages) {
            const pageRoot = join(outputRoot, `source-${String(sourcePage)}-output-${String(outputPage)}`);
            await runChecked(pdftoppm, [
                '-r',
                '150',
                '-f',
                String(outputPage),
                '-l',
                String(outputPage),
                '-png',
                cleaned,
                pageRoot,
            ], {env});
            const rendered = (await readdir(outputRoot)).filter(name => name.startsWith(`${basename(pageRoot)}-`));
            if (rendered.length === 0) throw new Error(`pdftoppm did not render Rome source page ${String(sourcePage)}`);
        }
    }
    if (!await readableFile(source)) throw new Error(`Rome source PDF disappeared during header render: ${source}`);
}

async function runStep(results, label, action) {
    const startedAt = Date.now();
    process.stdout.write(`\n[scan-cleanup:regress] ${label}\n`);
    try {
        const value = await action();
        results.push({
            details: value?.details ?? '',
            elapsedMs: Date.now() - startedAt,
            label,
            status: 'PASS',
        });
        return value;
    } catch (error) {
        const message = getCliErrorMessage(error);
        process.stderr.write(`[scan-cleanup:regress] ${label}: ${message}\n`);
        results.push({
            details: message,
            elapsedMs: Date.now() - startedAt,
            label,
            status: 'FAIL',
        });
        return null;
    }
}

async function collectLevel3StreamHashes(pdfPath, outputRoot) {
    const streamRoot = join(outputRoot, 'level-3-streams');
    await mkdir(streamRoot, {recursive: true});
    const prefix = join(streamRoot, 'stream');
    await runChecked(process.env.EVB_PDFIMAGES_PATH ?? 'pdfimages', [
        '-all',
        pdfPath,
        prefix,
    ]);
    const names = (await readdir(streamRoot)).filter(name => name.startsWith('stream-')).sort();
    const records = await Promise.all(names.map(async name => {
        const bytes = await readFile(join(streamRoot, name));
        return {
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        };
    }));
    return records.sort((left, right) => `${left.sha256}:${String(left.bytes)}`.localeCompare(`${right.sha256}:${String(right.bytes)}`));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args === null) {
        return;
    }
    const results = [];
    await mkdir(args.workDir, {recursive: true});
    const manifest = await runStep(results, 'load regress manifest', () => readJson(args.manifest, 'scan-cleanup regress manifest'));
    if (manifest === null) {
        await writeSummary(args.workDir, results);
        process.exitCode = 1;
        return;
    }
    const env = {
        ...process.env,
        ...(manifest.environment && typeof manifest.environment === 'object' ? manifest.environment : {}),
    };

    for (const name of requiredCorpusNames) {
        const entry = await runStep(results, `corpus harness: ${name}`, () => corpusEntry(manifest, name));
        if (entry !== null) {
            await runStep(results, `corpus verification: ${name}`, () => runCorpus({
                entry,
                env,
                name,
                workDir: args.workDir,
            }));
        }
    }

    const modeMatrixEntry = await runStep(results, 'load Rome mode-matrix config', () => ({
        config: manifest.modeMatrix?.config ?? defaultModeMatrixConfigPath,
        expected: manifest.modeMatrix?.expected ?? defaultExpectedPath,
    }));
    if (modeMatrixEntry !== null) {
        await runStep(results, 'corpus verification: mode matrix (17 cases)', () => runCorpus({
            allowMissingExpectations: true,
            entry: modeMatrixEntry,
            env,
            name: 'rome-mode-matrix',
            workDir: args.workDir,
        }));
    }

    for (const name of [
        'acceptance2',
        'linguae-layouts',
    ]) {
        const entry = await runStep(results, `load CLI fixture: ${name}`, () => cliEntry(manifest, name));
        if (entry === null) continue;
        const pages = await runStep(results, `resolve CLI pages: ${name}`, () => cliPages(entry, name, env));
        if (pages === null && entry.pages !== undefined) continue;
        const converted = await runStep(results, `CLI parity conversion: ${name}`, () => runCliConversion({
            entry,
            env,
            name,
            outputRoot: join(args.workDir, 'cli'),
            pages,
        }));
        if (converted !== null) {
            await runStep(results, `CLI word-loss audit: ${name}`, () => runWordLossAudit({
                ...converted,
                env,
                name,
                outputRoot: join(args.workDir, 'cli'),
                pages,
                wordLossBaseline: entry.wordLossBaseline,
            }));
        }
    }

    const romeEntry = await runStep(results, 'load Rome header fixture', () => manifest.rome);
    if (romeEntry !== null) {
        const source = await runStep(results, 'resolve Rome source PDF', () => configuredPath(romeEntry.source, env, 'Rome source PDF'));
        if (source !== null) {
            const pages = headerPages;
            const converted = await runStep(results, 'CLI parity conversion: Rome headers 46/49/52/56', () => runCliConversion({
                entry: {source},
                env,
                name: 'rome-headers',
                outputRoot: join(args.workDir, 'rome'),
                pages,
            }));
            if (converted !== null) {
                await runStep(results, 'Rome headers rendered at 150 dpi', () => renderHeaderPages({
                    ...converted,
                    env,
                    outputRoot: join(args.workDir, 'rome', 'rendered-150dpi'),
                }));
                for (const page of headerPages) {
                    await runStep(results, `Rome header word-loss audit: source page ${String(page)}`, () => runWordLossAudit({
                        ...converted,
                        env,
                        name: `rome-header-${String(page)}`,
                        outputRoot: join(args.workDir, 'rome'),
                        pages: [page],
                    }));
                }
            }
        }
    }

    const uniformityEntry = manifest.uniformity;
    if (uniformityEntry?.appOutput && uniformityEntry?.cliOutput) {
        await runStep(results, 'uniformity fixture Level-3 stream hash helper', async () => {
            const appHashes = await collectLevel3StreamHashes(
                configuredPath(uniformityEntry.appOutput, env, 'uniformity app output'),
                join(args.workDir, 'uniformity', 'app'),
            );
            const cliHashes = await collectLevel3StreamHashes(
                configuredPath(uniformityEntry.cliOutput, env, 'uniformity CLI output'),
                join(args.workDir, 'uniformity', 'cli'),
            );
            if (JSON.stringify(appHashes) !== JSON.stringify(cliHashes)) {
                throw new Error('Uniformity app and CLI Level-3 stream hashes differ');
            }
        });
    }

    if (args.full) {
        const fullbookEntry = await runStep(results, 'load release fullbook fixture', () => corpusEntry(manifest, 'fullbook'));
        if (fullbookEntry !== null) {
            await runStep(results, 'release fullbook corpus verification', () => runCorpus({
                entry: fullbookEntry,
                env,
                name: 'fullbook',
                workDir: args.workDir,
            }));
        }
    }

    await writeSummary(args.workDir, results);
    const failed = results.filter(result => result.status === 'FAIL');
    process.stdout.write(`\n${formatSummary(results)}\n`);
    if (failed.length > 0) process.exitCode = 1;
}

async function writeSummary(workDir, results) {
    await writeFile(
        join(workDir, 'regress-summary.json'),
        `${JSON.stringify({
            generatedAt: new Date().toISOString(),
            results,
        }, null, 2)}\n`,
    );
}

function formatSummary(results) {
    const rows = [
        [
            'Gate',
            'Status',
            'Time',
            'Details',
        ],
        ...results.map(result => [
            result.label,
            result.status,
            `${String(result.elapsedMs)}ms`,
            result.details,
        ]),
    ];
    const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
    return rows.map((row, index) => row.map((value, column) => value.padEnd(widths[column])).join(' | ')
        + (index === 0 ? `\n${widths.map(width => '-'.repeat(width)).join('-|-')}` : '')).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch(error => {
        console.error(`[scan-cleanup:regress] FATAL: ${getCliErrorMessage(error)}`);
        process.exitCode = 1;
    });
}
