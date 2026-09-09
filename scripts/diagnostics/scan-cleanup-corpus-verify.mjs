#!/usr/bin/env node
import { getCliErrorMessage } from '../lib/cli-error.mjs';
import {createHash} from 'node:crypto';
import {
    access,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    constants as fsConstants,
    createReadStream,
} from 'node:fs';
import {availableParallelism} from 'node:os';
import {
    dirname,
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tsImport} from 'tsx/esm/api';
import {
    assertStagedCargoArtifactFresh,
    collectCargoSourceInputs,
} from '../cargo-artifacts.mjs';
import {
    crossResolutionModeEvidence,
    pagePlanParityFailures,
    resolveFixturePages,
    reusablePagePlan,
} from './scan-cleanup-corpus-plan.mjs';
import {runDiagnosticCommand} from './scan-cleanup-command.mjs';
import {createScanCleanupDiagnosticsManifestScope} from './scan-cleanup-diagnostics-manifest.mjs';
export {resolveFixturePages} from './scan-cleanup-corpus-plan.mjs';

const CORPUS_BINARIZATION_METHODS = new Set([
    'auto',
    'otsu',
    'sauvola',
    'wolf',
]);

/**
 * Resolve the deliberately small set of corpus-level policy overrides. The
 * rest of the corpus policy remains the standing matrix below; keeping this
 * translation here means every manifest still passes through the core
 * effective-options resolver.
 */
export function resolveFixtureOptions(fixture) {
    const optionSources = [
        fixture.options,
        fixture.overrides,
    ].filter(value => value !== undefined);
    if (optionSources.length > 1) {
        throw new Error(`Fixture "${String(fixture.id)}" must use only one of options or overrides`);
    }
    const raw = optionSources[0];
    if (raw === undefined) {
        return {
            ...corpusOptions,
            marginsMm: {...corpusOptions.marginsMm},
            pageOverrides: {},
        };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`Invalid scan-cleanup options for fixture "${String(fixture.id)}"`);
    }
    const unknownKeys = Object.keys(raw).filter(key => ![
        'binarization',
        'cropContent',
    ].includes(key));
    if (unknownKeys.length > 0) {
        throw new Error([
            `Unsupported scan-cleanup fixture override(s) for "${String(fixture.id)}": ${unknownKeys.join(', ')}`,
            'Only binarization and cropContent may vary in the standing corpus matrix.',
        ].join(' '));
    }
    if (raw.binarization !== undefined && !CORPUS_BINARIZATION_METHODS.has(raw.binarization)) {
        throw new Error(`Invalid binarization override for fixture "${String(fixture.id)}"`);
    }
    if (raw.cropContent !== undefined && typeof raw.cropContent !== 'boolean') {
        throw new Error(`Invalid cropContent override for fixture "${String(fixture.id)}"`);
    }
    return {
        ...corpusOptions,
        ...(raw.binarization === undefined ? {} : {binarization: raw.binarization}),
        ...(raw.cropContent === undefined ? {} : {crop: raw.cropContent}),
        marginsMm: {...corpusOptions.marginsMm},
        pageOverrides: {},
    };
}

function expandCorpusEnvironmentValue(value, label, optional = false) {
    if (typeof value !== 'string') {
        return value;
    }
    const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/u.exec(value);
    if (!match) {
        return value;
    }
    const environmentValue = process.env[match[1]];
    if (!environmentValue) {
        if (optional) {
            return join(projectRoot, '.devkit', 'missing-optional-corpus-fixtures', match[1]);
        }
        throw new Error(`Missing required environment variable ${match[1]} for ${label}`);
    }
    return environmentValue;
}

function parseCorpusPageSelector(value, label) {
    const pages = String(value).split(',').flatMap(part => {
        const trimmed = part.trim();
        if (trimmed === '') {
            return [];
        }
        const rangeMatch = /^(\d+)-(\d+)$/u.exec(trimmed);
        if (!rangeMatch) {
            const page = Number(trimmed);
            if (!Number.isSafeInteger(page) || page < 1) {
                throw new Error(`Invalid page selector ${String(value)} for ${label}`);
            }
            return [page];
        }
        const from = Number(rangeMatch[1]);
        const to = Number(rangeMatch[2]);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
            throw new Error(`Invalid page selector ${String(value)} for ${label}`);
        }
        return Array.from({length: to - from + 1}, (_, index) => from + index);
    });
    if (pages.length === 0 || new Set(pages).size !== pages.length) {
        throw new Error(`Invalid page selector ${String(value)} for ${label}`);
    }
    return pages;
}

function materializeFixtureConfig(fixture) {
    if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
        throw new Error(`Invalid corpus fixture config: ${JSON.stringify(fixture)}`);
    }
    const pdfPath = expandCorpusEnvironmentValue(
        fixture.pdfPath,
        `fixture ${String(fixture.id)} PDF path`,
        fixture.optional === true,
    );
    let pages = fixture.pages;
    if (typeof fixture.pages === 'string') {
        pages = parseCorpusPageSelector(
            expandCorpusEnvironmentValue(fixture.pages, `fixture ${String(fixture.id)} pages`),
            `fixture ${String(fixture.id)}`,
        );
    } else if (typeof fixture.pagesEnv === 'string') {
        const pagesValue = process.env[fixture.pagesEnv];
        if (!pagesValue) {
            throw new Error(`Missing required environment variable ${fixture.pagesEnv} for fixture ${String(fixture.id)} pages`);
        }
        pages = parseCorpusPageSelector(pagesValue, `fixture ${String(fixture.id)}`);
    }
    return {
        ...fixture,
        pdfPath,
        ...(pages === undefined ? {} : {pages}),
    };
}

const {
    buildRunnableNativeScanCleanupManifest,
    buildScanCleanupCompactManifest,
    buildScanCleanupPageOpsInstructions,
    DETECTION_DPI,
    resolveScanCleanupRequestedRenderDpi,
    serializeLegacyScanCleanupCompactManifest,
    serializeLegacyScanCleanupPageOpsInstructions,
} = await tsImport('../../packages/scan-cleanup/core/index.ts', import.meta.url);
const {buildScanCleanupSourceMrcForegroundPdfMatrix} = await tsImport(
    '../../packages/scan-cleanup/core/buildScanCleanupSourceMrcForegroundPdfMatrix.ts',
    import.meta.url,
);
const {readPngHeader} = await tsImport(
    '../../packages/scan-cleanup/core/rasterLayerDimensions.ts',
    import.meta.url,
);

function corpusPagePlan(analysis, previewOutputs, analysisDimensions) {
    const plan = reusablePagePlan(analysis, previewOutputs, analysisDimensions);
    // The native classifier can conservatively label an offcut when it has no
    // cutter coordinate. There is then no reproducible split geometry for the
    // preview to hand to final rendering; replay the page as one canonical
    // sheet so both resolutions exercise identical page-frame semantics.
    if (
        analysis.layoutClassification === 'page-with-offcut'
        && plan.automaticSplit === undefined
    ) {
        return {
            ...plan,
            layout: 'force-single',
        };
    }
    return plan;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultConfigPath = join(projectRoot, '.devkit/scan-cleanup-corpus.json');
const defaultExpectedPath = join(projectRoot, 'scripts/diagnostics/scan-cleanup-corpus-expected-results.json');
const platformArch = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const binaryExtension = process.platform === 'win32' ? '.exe' : '';
const defaultScanCleanupBinary = join(
    projectRoot,
    '.tmp/scan-cleanup',
    platformArch,
    'bin',
    `evb-scan-cleanup${binaryExtension}`,
);
const defaultCombineBinary = join(
    projectRoot,
    '.tmp/pdf-image-combine',
    platformArch,
    'bin',
    `evb-pdf-image-combine${binaryExtension}`,
);
const defaultPageOpsBinary = join(
    projectRoot,
    '.tmp/pdf-page-ops',
    platformArch,
    'bin',
    `evb-pdf-page-ops${binaryExtension}`,
);
const nativeTools = [
    {
        binaryPath: defaultScanCleanupBinary,
        buildCommand: 'pnpm run build:scan-cleanup',
        manifestPath: join(projectRoot, 'native/scan-cleanup/Cargo.toml'),
    },
    {
        binaryPath: defaultCombineBinary,
        buildCommand: 'pnpm run build:pdf-image-combine',
        manifestPath: join(projectRoot, 'native/pdf-image-combine/Cargo.toml'),
    },
    {
        binaryPath: defaultPageOpsBinary,
        buildCommand: 'pnpm run build:pdf-page-ops',
        manifestPath: join(projectRoot, 'native/pdf-page-ops/Cargo.toml'),
    },
];
const MAX_DIMENSION_PX = 40_000;
const MAX_BILEVEL_PIXELS = 160_000_000;
const MAX_CONTINUOUS_TONE_PIXELS = 80_000_000;
const corpusOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};
// The production preview service makes the durable Auto decision on the
// canonical detection grid. Verify that decision on the same grid, then replay
// it on final-quality input.
// A physical 0.05 mm tolerance is about 0.7 pixels on the current 360-DPI
// dominant-bilevel grid. It covers coordinate rounding without coupling this
// exact source-component ledger to whichever render grid policy is active.
const SCANNER_BOUNDARY_BBOX_TOLERANCE_MM = 0.05;
const OUTPUT_MODES = [
    'bw',
    'grayscale',
    'color',
    'mixed',
];
const corpusPageConcurrency = Math.max(1, Math.min(
    4,
    Math.floor(availableParallelism() / 2),
    Number.parseInt(process.env.EVB_SCAN_CLEANUP_CORPUS_CONCURRENCY ?? '4', 10) || 4,
));

async function mapWithConcurrency(items, concurrency, task) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await task(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
export function resolveFixtureExpectations(fixture, canonicalExpected) {
    const resolved = canonicalExpected ? {...canonicalExpected} : {};
    if (fixture.expectedOutputBytes !== undefined) {
        if (!Number.isSafeInteger(fixture.expectedOutputBytes) || fixture.expectedOutputBytes <= 0) {
            throw new Error(`Invalid expectedOutputBytes for fixture "${fixture.id}"`);
        }
        resolved.expectedOutputBytes = fixture.expectedOutputBytes;
    }
    if (fixture.maxOutputToSourceRatio !== undefined) {
        if (
            typeof fixture.maxOutputToSourceRatio !== 'number'
            || !Number.isFinite(fixture.maxOutputToSourceRatio)
            || fixture.maxOutputToSourceRatio <= 0
        ) {
            throw new Error(`Invalid expected maxOutputToSourceRatio for fixture "${fixture.id}"`);
        }
        resolved.maxOutputToSourceRatio = fixture.maxOutputToSourceRatio;
    }
    if (fixture.requireOutputSmallerThanSource !== undefined) {
        if (typeof fixture.requireOutputSmallerThanSource !== 'boolean') {
            throw new Error(`Invalid expected requireOutputSmallerThanSource for fixture "${fixture.id}"`);
        }
        resolved.requireOutputSmallerThanSource = fixture.requireOutputSmallerThanSource;
    }
    if (fixture.expectedModeDistribution !== undefined) {
        const distribution = fixture.expectedModeDistribution;
        if (
            distribution === null
            || typeof distribution !== 'object'
            || Array.isArray(distribution)
            || Object.keys(distribution).length === 0
            || Object.keys(distribution).some(mode => !OUTPUT_MODES.includes(mode))
            || Object.values(distribution).some(count => !Number.isSafeInteger(count) || count < 0)
            || Object.values(distribution).reduce((sum, count) => sum + count, 0) === 0
        ) {
            throw new Error(`Invalid expectedModeDistribution for fixture "${fixture.id}"`);
        }
        resolved.expectedModeDistribution = {...distribution};
    }
    if (resolved.scannerBoundaryExceptions !== undefined) {
        const exceptions = resolved.scannerBoundaryExceptions;
        const valid = Array.isArray(exceptions)
            && exceptions.length > 0
            && exceptions.every(exception =>
                exception !== null
                && typeof exception === 'object'
                && Number.isSafeInteger(exception.page)
                && exception.page > 0
                && typeof exception.reason === 'string'
                && exception.reason.trim() !== ''
                && exception.bboxMm !== null
                && typeof exception.bboxMm === 'object'
                && [
                    'height',
                    'left',
                    'top',
                    'width',
                ].every(key =>
                    typeof exception.bboxMm[key] === 'number'
                    && Number.isFinite(exception.bboxMm[key])
                    && exception.bboxMm[key] >= 0,
                )
                && exception.bboxMm.width > 0
                && exception.bboxMm.height > 0,
            );
        if (!valid) {
            throw new Error(`Invalid expected scannerBoundaryExceptions for fixture "${fixture.id}"`);
        }
        resolved.scannerBoundaryExceptions = exceptions.map(exception => ({
            ...exception,
            bboxMm: {...exception.bboxMm},
        }));
    }
    return resolved;
}

export function compareModeDistribution(outputModes, expectedDistribution) {
    const actual = Object.fromEntries(OUTPUT_MODES.map(mode => [
        mode,
        outputModes.filter(outputMode => outputMode === mode).length,
    ]));
    const expected = Object.fromEntries(OUTPUT_MODES.map(mode => [
        mode,
        expectedDistribution[mode] ?? 0,
    ]));
    return {
        actual,
        expected,
        passed: outputModes.length === Object.values(expected).reduce((sum, count) => sum + count, 0)
            && OUTPUT_MODES.every(mode => actual[mode] === expected[mode]),
    };
}

function parseArgs(argv) {
    const parsed = {
        config: defaultConfigPath,
        expected: defaultExpectedPath,
        allowMissingExpectations: false,
        keepArtifacts: false,
        workDir: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') {
            continue;
        }
        if (argument === '--keep-artifacts') {
            parsed.keepArtifacts = true;
        } else if (argument === '--allow-missing-expectations') {
            parsed.allowMissingExpectations = true;
        } else if (argument === '--config' || argument === '--expected' || argument === '--work-dir') {
            const value = argv[index + 1];
            if (!value) throw new Error(`Missing value for ${argument}`);
            parsed[argument === '--work-dir' ? 'workDir' : argument.slice(2)] = resolve(value);
            index += 1;
        } else if (argument === '--help' || argument === '-h') {
            console.log(`Usage: node scripts/diagnostics/scan-cleanup-corpus-verify.mjs [options]

Options:
  --config <path>       Machine-local fixture config (default: .devkit/scan-cleanup-corpus.json)
  --expected <path>     Checked-in expected results JSON
  --work-dir <path>     Write artifacts to an explicit directory
  --allow-missing-expectations
                         Run structural/parity checks for exploratory standing matrices
  --keep-artifacts      Retain an automatically created work directory after a passing run`);
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    return parsed;
}

async function run(command, args, options = {}) {
    return runDiagnosticCommand(command, args, {
        allowFailure: options.allowFailure,
        cwd: projectRoot,
        env: {
            ...process.env,
            ...options.env,
        },
    });
}

async function assertCorpusNativeBinariesFresh() {
    for (const tool of nativeTools) {
        if (!await readableFile(tool.binaryPath)) {
            throw new Error(`Missing staged release binary: ${tool.binaryPath}\nRun ${tool.buildCommand} first.`);
        }
        const cargoMetadata = await run('cargo', [
            'metadata',
            '--manifest-path',
            tool.manifestPath,
            '--format-version',
            '1',
            '--locked',
            '--no-deps',
        ]);
        let parsedMetadata;
        try {
            parsedMetadata = JSON.parse(cargoMetadata.stdout);
        } catch (error) {
            throw new Error(`Cargo metadata returned invalid JSON for ${tool.manifestPath}`, {cause: error});
        }
        await assertStagedCargoArtifactFresh({
            ...tool,
            sourcePaths: collectCargoSourceInputs(parsedMetadata, tool.manifestPath),
        });
    }
}

function assertionReporter(fixtureId) {
    const assertions = [];
    return {
        add(label, passed, detail) {
            assertions.push({
                detail,
                label,
                passed,
            });
            console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}: ${detail}`);
        },
        assertions,
        fixtureId,
    };
}

function parseDominantSourceDpi(output, pageNumber) {
    const rows = output.split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u));
    const maskedObjectIds = new Set(rows
        .filter(parts => Number(parts[0]) === pageNumber
            && Number(parts[7]) === 1
            && [
                'image',
                'mask',
                'smask',
            ].includes(parts[2]))
        .map(parts => Number(parts[10]))
        .filter(objectId => Number.isSafeInteger(objectId) && objectId > 0));
    const candidates = rows
        .filter(parts => Number(parts[0]) === pageNumber && parts[2] === 'image')
        .map(parts => ({
            area: Number(parts[3]) * Number(parts[4]),
            bitsPerComponent: Number(parts[7]),
            objectId: Number(parts[10]),
            xPpi: Number(parts[12]),
            yPpi: Number(parts[13]),
        }))
        .filter(candidate => Number.isFinite(candidate.area)
            && Number.isFinite(candidate.xPpi)
            && candidate.xPpi > 0
            && Number.isFinite(candidate.yPpi)
            && candidate.yPpi > 0);
    candidates.sort((left, right) => right.area - left.area);
    const dominant = candidates[0];
    const largestBilevelArea = candidates
        .filter(candidate => candidate.bitsPerComponent === 1)
        .reduce((largest, candidate) => Math.max(largest, candidate.area), 0);
    const background = candidates
        .filter(candidate => candidate.bitsPerComponent > 1
            && !maskedObjectIds.has(candidate.objectId))
        .sort((left, right) => right.area - left.area)[0];
    return {
        detected: dominant !== undefined,
        dpi: dominant ? Math.max(1, Math.round(Math.max(dominant.xPpi, dominant.yPpi))) : 300,
        backgroundDpi: background
            ? Math.max(1, Math.round(Math.max(background.xPpi, background.yPpi)))
            : undefined,
        hasBilevelLayer: rows.some(parts =>
            Number(parts[0]) === pageNumber
            && Number(parts[7]) === 1
            && [
                'image',
                'mask',
                'smask',
            ].includes(parts[2])),
        hasDominantBilevelLayer: dominant !== undefined
            && largestBilevelArea >= dominant.area * 0.95,
    };
}

const qpdfObjectTableByPath = new Map();

async function readQpdfObjectTable(pdfPath) {
    let pending = qpdfObjectTableByPath.get(pdfPath);
    if (pending === undefined) {
        pending = run('qpdf', [
            '--json',
            '--json-stream-data=none',
            '--json-key=qpdf',
            pdfPath,
        ]).then(result => {
            const parsed = JSON.parse(result.stdout);
            const objects = [...parsed.qpdf].reverse().find(entry =>
                entry !== null
                && typeof entry === 'object'
                && Object.keys(entry).some(key => key.startsWith('obj:')));
            if (objects === undefined) {
                throw new Error('qpdf JSON contains no object table');
            }
            return objects;
        });
        qpdfObjectTableByPath.set(pdfPath, pending);
    }
    return pending;
}

function sourceMrcMaskDecode(objects, foreground) {
    const foregroundReference = `${foreground[10]} ${foreground[11]} R`;
    const foregroundDictionary = objects[`obj:${foregroundReference}`]?.stream?.dict;
    const maskReference = foregroundDictionary?.['/SMask'];
    const maskDictionary = typeof maskReference === 'string'
        ? objects[`obj:${maskReference}`]?.stream?.dict
        : undefined;
    if (
        maskDictionary?.['/Filter'] !== '/JBIG2Decode'
        || maskDictionary?.['/BitsPerComponent'] !== 1
    ) {
        throw new Error('MRC foreground does not reference a one-bit JBIG2 soft mask');
    }
    const decode = maskDictionary['/Decode'];
    if (decode === undefined || (
        Array.isArray(decode)
        && decode.length === 2
        && decode[0] === 0
        && decode[1] === 1
    )) {
        return 'default';
    }
    if (
        Array.isArray(decode)
        && decode.length === 2
        && decode[0] === 1
        && decode[1] === 0
    ) {
        return 'inverted';
    }
    throw new Error(`Unsupported MRC soft-mask Decode array: ${JSON.stringify(decode)}`);
}

async function extractMrcLayers(
    pdfPath,
    pageNumber,
    selectionOutputPath,
    backgroundOutputPath,
    foregroundOutputPath,
) {
    const listing = await run('pdfimages', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-list',
        pdfPath,
    ]);
    const rows = listing.stdout.split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => parts.length >= 14
            && Number.isSafeInteger(Number(parts[3]))
            && Number(parts[3]) > 0
            && Number.isSafeInteger(Number(parts[4]))
            && Number(parts[4]) > 0);
    const candidateIndex = rows.reduce((best, parts, index) => {
        if (parts[2] !== 'smask' || Number(parts[7]) !== 1) {
            return best;
        }
        if (best < 0) {
            return index;
        }
        const area = Number(parts[3]) * Number(parts[4]);
        const bestArea = Number(rows[best][3]) * Number(rows[best][4]);
        return area > bestArea ? index : best;
    }, -1);
    if (candidateIndex < 0) {
        return null;
    }
    const selection = rows[candidateIndex];
    const foregroundIndex = candidateIndex - 1;
    const foreground = rows[foregroundIndex];
    if (
        foreground === undefined
        || foreground[2] !== 'image'
        || Number(foreground[3]) !== Number(selection[3])
        || Number(foreground[4]) !== Number(selection[4])
    ) {
        return null;
    }
    const selectionAspect = Number(selection[3]) / Number(selection[4]);
    const selectionDpi = Math.min(Number(selection[12]), Number(selection[13]));
    const backgroundIndex = rows
        .map((parts, index) => ({
            area: Number(parts[3]) * Number(parts[4]),
            index,
            parts,
        }))
        .filter(candidate =>
            candidate.index !== foregroundIndex
            && candidate.parts[2] === 'image'
            && Number(candidate.parts[7]) > 1
            && Math.min(Number(candidate.parts[12]), Number(candidate.parts[13])) <= selectionDpi
            && Math.abs(
                Number(candidate.parts[3]) / Number(candidate.parts[4]) / selectionAspect - 1,
            ) <= 0.02,
        )
        .sort((left, right) => right.area - left.area)[0]?.index ?? -1;
    if (backgroundIndex < 0) {
        return null;
    }
    const selectionMaskDecode = sourceMrcMaskDecode(
        await readQpdfObjectTable(pdfPath),
        foreground,
    );
    const prefixName = `.${selectionOutputPath.split('/').at(-1)}-extract`;
    const prefix = join(dirname(selectionOutputPath), prefixName);
    const rawPrefixName = `.${foregroundOutputPath.split('/').at(-1)}-raw`;
    const rawPrefix = join(dirname(selectionOutputPath), rawPrefixName);
    try {
        await run('pdfimages', [
            '-f',
            String(pageNumber),
            '-l',
            String(pageNumber),
            '-png',
            pdfPath,
            prefix,
        ]);
        const extractedSelectionPath =
            `${prefix}-${String(candidateIndex).padStart(3, '0')}.png`;
        const extractedBackgroundPath =
            `${prefix}-${String(backgroundIndex).padStart(3, '0')}.png`;
        if (!await readableFile(extractedSelectionPath)) {
            throw new Error(`MRC selection mask extraction failed for page ${pageNumber}`);
        }
        if (!await readableFile(extractedBackgroundPath)) {
            throw new Error(`MRC background extraction failed for page ${pageNumber}`);
        }
        await rename(extractedBackgroundPath, backgroundOutputPath);
        await rm(extractedSelectionPath, {force: true});
        await run('pdfimages', [
            '-f',
            String(pageNumber),
            '-l',
            String(pageNumber),
            '-all',
            pdfPath,
            rawPrefix,
        ]);
        const extractedForegroundPath =
            `${rawPrefix}-${String(foregroundIndex).padStart(3, '0')}.jp2`;
        const extractedSelectionRawPath =
            `${rawPrefix}-${String(candidateIndex).padStart(3, '0')}.jb2e`;
        if (
            !await readableFile(extractedForegroundPath)
            || !await readableFile(extractedSelectionRawPath)
        ) {
            throw new Error(`MRC compact layer extraction failed for page ${pageNumber}`);
        }
        await Promise.all([
            rename(extractedForegroundPath, foregroundOutputPath),
            rename(extractedSelectionRawPath, selectionOutputPath),
            writeFile(`${selectionOutputPath}.decode`, `${selectionMaskDecode}\n`),
        ]);
        return {
            backgroundPath: backgroundOutputPath,
            foregroundHeight: Number(foreground[4]),
            foregroundPath: foregroundOutputPath,
            foregroundWidth: Number(foreground[3]),
            selectionMaskDecode,
            selectionMaskPath: selectionOutputPath,
        };
    } finally {
        const siblings = await readdir(dirname(selectionOutputPath)).catch(() => []);
        await Promise.all(siblings
            .filter(name =>
                name.startsWith(`${prefixName}-`)
                || name.startsWith(`${rawPrefixName}-`),
            )
            .map(name => rm(join(dirname(selectionOutputPath), name), {force: true})));
    }
}

async function sha256File(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/iu;

function resolveFixtureExpectedSha256(fixture) {
    const configured = [
        fixture.sha256,
        fixture.expectedSha256,
    ].filter(value => value !== undefined);
    if (configured.length > 1 && configured[0] !== configured[1]) {
        throw new Error(`Fixture "${String(fixture.id)}" must use one matching sha256 value`);
    }
    if (configured.length === 0) {
        return null;
    }
    const expectedSha256 = configured[0];
    if (typeof expectedSha256 !== 'string' || !SHA256_HEX_PATTERN.test(expectedSha256)) {
        throw new Error(`Invalid SHA-256 checksum for fixture "${String(fixture.id)}"`);
    }
    return expectedSha256.toLowerCase();
}

function resolveFixtureRequired(fixture) {
    if (fixture.optional !== undefined && typeof fixture.optional !== 'boolean') {
        throw new Error(`Invalid optional flag for fixture "${String(fixture.id)}"`);
    }
    if (fixture.required !== undefined && typeof fixture.required !== 'boolean') {
        throw new Error(`Invalid required flag for fixture "${String(fixture.id)}"`);
    }
    if (fixture.optional === true && fixture.required === true) {
        throw new Error(`Fixture "${String(fixture.id)}" cannot be both optional and required`);
    }
    return fixture.required ?? fixture.optional !== true;
}

/**
 * Admit a source file before any native tool is invoked. A checksum is
 * optional for the standing local corpus, but when configured it pins the
 * exact external source. Optional fixtures keep their existing absent-file
 * skip behavior.
 */
export async function inspectFixtureSource(fixture) {
    const expectedSha256 = resolveFixtureExpectedSha256(fixture);
    const required = resolveFixtureRequired(fixture);
    const fixturePath = fixture.pdfPath;
    if (!await readableFile(fixturePath)) {
        const admissionStatus = required ? 'rejected' : 'skipped';
        return {
            actualSha256: null,
            admissionStatus,
            error: required ? `Required corpus fixture is absent: ${fixturePath}` : null,
            expectedSha256,
            fixturePath,
            reason: required ? 'required source is absent' : 'optional source is absent',
        };
    }
    const actualSha256 = await sha256File(fixturePath);
    if (expectedSha256 !== null && actualSha256 !== expectedSha256) {
        return {
            actualSha256,
            admissionStatus: 'rejected',
            error: [
                `Corpus fixture SHA-256 mismatch: ${fixturePath}`,
                `Expected: ${expectedSha256}`,
                `Actual:   ${actualSha256}`,
            ].join('\n'),
            expectedSha256,
            fixturePath,
            reason: 'source checksum mismatch',
        };
    }
    return {
        actualSha256,
        admissionStatus: 'admitted',
        error: null,
        expectedSha256,
        fixturePath,
        reason: expectedSha256 === null
            ? 'source is readable; no checksum configured'
            : 'source checksum matches',
    };
}

function selectMrcStreamPair(images, pageNumber) {
    const pageImages = images.filter(image => image.page === pageNumber);
    const maskIndex = pageImages.findIndex(image =>
        image.type === 'smask'
        && image.bitsPerComponent === 1
        && image.encoding === 'jbig2',
    );
    if (maskIndex <= 0) {
        return null;
    }
    const mask = pageImages[maskIndex];
    const foreground = pageImages[maskIndex - 1];
    if (
        foreground.type !== 'image'
        || foreground.encoding !== 'jpx'
        || foreground.width !== mask.width
        || foreground.height !== mask.height
    ) {
        return null;
    }
    return {
        foreground,
        mask,
    };
}

function extractedStreamPath(prefix, image, extension) {
    return `${prefix}-${String(image.number).padStart(3, '0')}.${extension}`;
}

function extractedImagePath(prefix, image) {
    const extension = {
        ccitt: 'ccitt',
        jbig2: 'jb2e',
        jpeg: 'jpg',
        jpx: 'jp2',
    }[image.encoding] ?? 'png';
    return extractedStreamPath(prefix, image, extension);
}

async function extractedImageBytes(prefix, images) {
    const sizes = await Promise.all(images.map(async image =>
        (await stat(extractedImagePath(prefix, image))).size,
    ));
    return sizes.reduce((sum, size) => sum + size, 0);
}

function parsePdfPageBoxes(output) {
    const pages = new Map();
    for (const line of output.split(/\r?\n/u)) {
        const match = /^Page\s+(\d+)\s+CropBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/u.exec(line);
        if (!match) continue;
        const [
            pageNumber,
            x1,
            y1,
            x2,
            y2,
        ] = match.slice(1).map(Number);
        pages.set(pageNumber, {
            height: y2 - y1,
            width: x2 - x1,
            x: x1,
            y: y1,
        });
    }
    return pages;
}

function sourceMrcForegroundPdfMatrix(page, pageWidthPoints, pageHeightPoints) {
    const {
        metadata,
        trustedMrcLayers,
    } = page;
    const positiveFinite = value => typeof value === 'number'
        && Number.isFinite(value)
        && value > 0;
    const matrix = metadata.forwardTransform?.matrix;
    if (
        trustedMrcLayers === null
        || trustedMrcLayers === undefined
        || matrix === undefined
        || !positiveFinite(metadata.inputWidthPx)
        || !positiveFinite(metadata.inputHeightPx)
        || !positiveFinite(metadata.outputWidthPx)
        || !positiveFinite(metadata.outputHeightPx)
        || (metadata.intrinsicRasterWidthPx !== undefined
            && metadata.intrinsicRasterWidthPx !== null
            && !positiveFinite(metadata.intrinsicRasterWidthPx))
        || (metadata.intrinsicRasterHeightPx !== undefined
            && metadata.intrinsicRasterHeightPx !== null
            && !positiveFinite(metadata.intrinsicRasterHeightPx))
        || metadata.rotationDegrees !== 0
        || metadata.dewarpMapping != null
    ) {
        throw new Error(
            `Page ${page.sourcePageNumber} cannot preserve source MRC foreground geometry`,
        );
    }
    return buildScanCleanupSourceMrcForegroundPdfMatrix(
        metadata,
        trustedMrcLayers,
        pageWidthPoints,
        pageHeightPoints,
    );
}

function compactSourceInstruction(page, pageBox) {
    const metadata = page.metadata;
    if (
        page.preserveOriginalQuality !== true
        || !page.sourceHasBilevelLayer
        || metadata.half !== 'full'
        || metadata.skewApplied
        || metadata.dewarpModel != null
        || metadata.cropRect === undefined
        || metadata.inputWidthPx === undefined
        || metadata.inputHeightPx === undefined
        || pageBox === undefined
    ) {
        return null;
    }
    const sourceCrop = {
        x: pageBox.x + metadata.cropRect.xPx / metadata.inputWidthPx * pageBox.width,
        y: pageBox.y + pageBox.height
            - (metadata.cropRect.yPx + metadata.cropRect.heightPx)
            / metadata.inputHeightPx * pageBox.height,
        width: metadata.cropRect.widthPx / metadata.inputWidthPx * pageBox.width,
        height: metadata.cropRect.heightPx / metadata.inputHeightPx * pageBox.height,
    };
    const targetWidth = metadata.matchedCanvasTargetWidthPoints
        ?? metadata.canvasWidthPx / page.renderDpi * 72;
    const targetHeight = metadata.matchedCanvasTargetHeightPoints
        ?? metadata.canvasHeightPx / page.renderDpi * 72;
    const scale = Math.min(
        targetWidth / sourceCrop.width,
        targetHeight / sourceCrop.height,
    );
    if (!Number.isFinite(scale) || scale <= 0) {
        return null;
    }
    // The corpus uses the production default top-center placement.
    const placedX = sourceCrop.x * scale
        + (sourceCrop.width * scale - targetWidth) / 2;
    const placedY = sourceCrop.y * scale
        + sourceCrop.height * scale - targetHeight;
    return {
        sourcePageIndex: page.sourcePageNumber - 1,
        rotationQuarterTurns: 0,
        outputs: [{
            cropRect: {
                x: 0,
                y: 0,
                width: targetWidth,
                height: targetHeight,
            },
            contentTransform: {
                scale,
                translateX: -placedX,
                translateY: -placedY,
            },
        }],
    };
}

function tonalJpegQuality(mode) {
    if (mode === 'color') {
        return 87;
    }
    if (mode === 'grayscale' || mode === 'mixed') {
        return 85;
    }
    return null;
}

async function rasterize(pdfPath, pageNumber, dpi, outputPrefix) {
    const outputPath = `${outputPrefix}.png`;
    if (await readableFile(outputPath)) {
        try {
            const header = await readPngHeader(outputPath);
            if (header.width > 0 && header.height > 0) {
                return outputPath;
            }
        } catch {
            // A prior interrupted raster is not reusable; Poppler will replace it.
        }
    }
    await run('pdftoppm', [
        '-f',
        String(pageNumber),
        '-l',
        String(pageNumber),
        '-r',
        String(dpi),
        '-png',
        '-singlefile',
        pdfPath,
        outputPrefix,
    ]);
    return outputPath;
}

function resolveSafeRenderDpi(requestedRenderDpi, maxPixels, sourceDpi, dimensions) {
    const maxDimensionDpi = sourceDpi * Math.min(
        MAX_DIMENSION_PX / dimensions.width,
        MAX_DIMENSION_PX / dimensions.height,
    );
    const maxPixelDpi = sourceDpi * Math.sqrt(
        maxPixels / (dimensions.width * dimensions.height),
    );
    return Math.max(1, Math.floor(Math.min(
        requestedRenderDpi,
        maxDimensionDpi,
        maxPixelDpi,
    )));
}

async function runSidecar(manifestPath, manifestScope) {
    const result = await run(defaultScanCleanupBinary, manifestScope.sidecarArgv(manifestPath));
    const envelopes = result.stdout.split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line));
    const terminal = envelopes.findLast(envelope => envelope.type === 'result');
    if (terminal?.result?.status !== 'success') {
        throw new Error(`Scan-cleanup sidecar did not report success: ${result.stdout}`);
    }
    return result;
}

async function clearRenderTargets(pages) {
    const paths = pages.flatMap(page => [
        page.pageMetadataPath,
        ...page.outputs.flatMap(output => Object.values(output)),
    ]);
    await Promise.all(paths.map(path => rm(path, {force: true})));
}

async function readableFile(path) {
    try {
        await access(path, fsConstants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function buildRenderManifestPage(page, fixtureDir, renderMode) {
    const isPreview = renderMode === 'preview';
    const pagePrefix = isPreview ? 'preview' : 'clean';
    const pageNumber = page.pageNumber;
    const pageDpi = isPreview ? page.detectionDpi : page.renderDpi;
    const renderPlan = isPreview
        ? {
            // The UI preview is rendered in intrinsic output space. Matched
            // document canvases are a final-PDF assembly concern and require a
            // documentCanvas plan that is not available until all sheets exist.
            matchPageSize: false,
            ...corpusPagePlan(page.analysis, [], page.detectionDimensions),
        }
        : {...corpusPagePlan(page.analysis, page.previewOutputs, page.detectionDimensions)};
    return {
        inputPath: isPreview ? page.detectionRaster : page.renderRaster,
        ...(page.trustedMrcLayers === null
            ? {}
            : {
                trustedForegroundMaskPath: page.trustedMrcLayers.selectionMaskPath,
                trustedMrcBackgroundPath: page.trustedMrcLayers.backgroundPath,
            }),
        pageNumber,
        dpi: pageDpi,
        sourceDpi: page.sourceDpi,
        ...(page.sourceHasBilevelLayer ? {sourceHasBilevelLayer: true} : {}),
        ...(page.sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi: page.sourceBackgroundDpi}),
        requestedRenderDpi: isPreview ? page.detectionDpi : page.requestedRenderDpi,
        pageMetadataPath: join(fixtureDir, `${pagePrefix}-${pageNumber}-page.json`),
        resolvedOutputMode: page.analysis.recommendedOutputMode,
        ...(page.analysis.softAlphaForegroundRecommendation === undefined
            ? {}
            : {preferSoftAlphaForeground: page.analysis.softAlphaForegroundRecommendation}),
        resolvedOptions: renderPlan,
        outputs: [
            0,
            1,
        ].map(index => {
            const outputPrefix = `${pagePrefix}-${pageNumber}-${index}`;
            const tonePreservationOutput = isPreview
                ? {}
                : {tonePreservationAlphaOutputPath: join(fixtureDir, `${outputPrefix}-tone-preservation-alpha.png`)};
            return {
                outputPath: join(fixtureDir, `${outputPrefix}.png`),
                metadataPath: join(fixtureDir, `${outputPrefix}.json`),
                bilevelOutputPath: join(fixtureDir, `${outputPrefix}.pbm`),
                backgroundOutputPath: join(fixtureDir, `${outputPrefix}-background.png`),
                foregroundMaskOutputPath: join(fixtureDir, `${outputPrefix}-mask.pbm`),
                foregroundAlphaOutputPath: join(fixtureDir, `${outputPrefix}-alpha.pgm`),
                pictureMaskOutputPath: join(fixtureDir, `${outputPrefix}-picture-mask.pbm`),
                ...tonePreservationOutput,
            };
        }),
    };
}

export function parsePdfImages(output) {
    return output.split(/\r?\n/u)
        .map(line => line.trim().split(/\s+/u))
        .filter(parts => Number.isSafeInteger(Number(parts[0])) && parts.length >= 14)
        .map(parts => ({
            bitsPerComponent: Number(parts[7]),
            encoding: parts[8],
            height: Number(parts[4]),
            number: Number(parts[1]),
            objectId: Number(parts[10]),
            page: Number(parts[0]),
            type: parts[2],
            width: Number(parts[3]),
            xDpi: Number(parts[12]),
            yDpi: Number(parts[13]),
        }));
}

export function parseQpdfPageContentCounts(output) {
    const pages = [];
    let currentPage = null;
    let readingContent = false;
    for (const line of output.split(/\r?\n/u)) {
        const pageMatch = line.match(/^page\s+(\d+):/u);
        if (pageMatch) {
            currentPage = {
                contentStreamCount: 0,
                pageNumber: Number.parseInt(pageMatch[1], 10),
            };
            pages.push(currentPage);
            readingContent = false;
            continue;
        }
        if (currentPage === null) {
            continue;
        }
        if (/^\s+content:\s*$/u.test(line)) {
            readingContent = true;
            continue;
        }
        if (readingContent && /^\s{4,}\d+\s+\d+\s+R\s*$/u.test(line)) {
            currentPage.contentStreamCount += 1;
            continue;
        }
        if (line.trim() !== '') {
            readingContent = false;
        }
    }
    return pages;
}

function parseMediaBoxes(output) {
    return output.split(/\r?\n/u).flatMap(line => {
        const match = /^Page\s+\d+\s+MediaBox:\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)\s+([-\d.]+)/u.exec(line);
        return match ? [[
            Number(match[1]),
            Number(match[2]),
        ]] : [];
    });
}

export function parseConnectedComponents(output) {
    return output.split(/\r?\n/u).flatMap(line => {
        const match = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+[\d.]+,[\d.]+\s+([\d.e+-]+)\s+gray\(([^)]+)\)/iu.exec(line);
        if (!match) {
            return [];
        }
        return [{
            area: Number(match[5]),
            gray: Number(match[6]),
            height: Number(match[2]),
            left: Number(match[3]),
            top: Number(match[4]),
            width: Number(match[1]),
        }];
    });
}

export function scannerBoundaryComponents(components, width, height, dpi) {
    const minimumThickness = Math.max(2, Math.round(dpi * 0.6 / 25.4));
    const minimumArea = Math.max(24, Math.round(dpi * dpi * 12 / (25.4 * 25.4)));
    const boundaryDepth = Math.max(8, Math.round(dpi * 32 / 25.4));
    const boundaryContact = Math.max(6, Math.round(dpi * 30 / 25.4));
    // The artifact-level gate targets catastrophic page-spanning rails and
    // crescents. Smaller edge components can be legitimate titles, folios, or
    // marginal notes; ownership-aware suppression is tested inside the native
    // renderer for those ambiguous cases.
    const minimumBoundarySpan = Math.max(24, Math.round(dpi * 40 / 25.4));
    return components.filter(component => {
        if (component.gray > 32 || component.area < minimumArea) {
            return false;
        }
        const right = component.left + component.width - 1;
        const leftBoundary = component.left <= boundaryContact
            && right <= boundaryDepth
            && component.height >= minimumBoundarySpan
            && component.width >= minimumThickness;
        const rightBoundary = width - 1 - right <= boundaryContact
            && width - component.left <= boundaryDepth
            && component.height >= minimumBoundarySpan
            && component.width >= minimumThickness;
        return leftBoundary || rightBoundary;
    });
}

function scannerBoundaryPhysicalBbox(component) {
    const millimetersPerPixel = 25.4 / component.dpi;
    return {
        height: component.height * millimetersPerPixel,
        left: component.left * millimetersPerPixel,
        top: component.top * millimetersPerPixel,
        width: component.width * millimetersPerPixel,
    };
}

export function reconcileScannerBoundaryExceptions(artifacts, exceptions) {
    const usedArtifacts = new Set();
    const matched = [];
    const stale = [];
    for (const exception of exceptions) {
        const candidates = artifacts.flatMap((artifact, index) => {
            if (
                usedArtifacts.has(index)
                || artifact.pdfPage !== exception.page
                || !Number.isFinite(artifact.dpi)
                || artifact.dpi <= 0
            ) {
                return [];
            }
            const bboxMm = scannerBoundaryPhysicalBbox(artifact);
            const bboxMatches = [
                'height',
                'left',
                'top',
                'width',
            ].every(key =>
                Math.abs(bboxMm[key] - exception.bboxMm[key])
                    <= SCANNER_BOUNDARY_BBOX_TOLERANCE_MM,
            );
            return bboxMatches ? [{
                artifact,
                bboxMm,
                index,
            }] : [];
        });
        if (candidates.length !== 1) {
            stale.push({
                ...exception,
                matchCount: candidates.length,
            });
            continue;
        }
        const [candidate] = candidates;
        usedArtifacts.add(candidate.index);
        matched.push({
            artifact: candidate.artifact,
            bboxMm: candidate.bboxMm,
            exception,
        });
    }
    return {
        matched,
        stale,
        unexpected: artifacts.filter((_, index) => !usedArtifacts.has(index)),
    };
}

function timingStats(records) {
    const values = records.map(record => record.elapsedMs);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
        count: values.length,
        maxMs: values.length === 0 ? 0 : Math.max(...values),
        meanMs: values.length === 0 ? 0 : total / values.length,
        totalMs: total,
    };
}

async function verifyFixture(fixture, expectedFixture, workRoot, sourceAdmission) {
    const fixtureOptions = resolveFixtureOptions(fixture);
    const report = assertionReporter(fixture.id);
    const fixtureDir = join(workRoot, fixture.id);
    const manifestScope = createScanCleanupDiagnosticsManifestScope(
        fixtureDir,
        buildRunnableNativeScanCleanupManifest,
    );
    await mkdir(fixtureDir, {recursive: true});
    console.log(`\n${fixture.id}`);
    const sourcePageBoxes = parsePdfPageBoxes((await run('pdfinfo', [
        '-f',
        String(Math.min(...fixture.pages)),
        '-l',
        String(Math.max(...fixture.pages)),
        '-box',
        fixture.pdfPath,
    ])).stdout);

    const rasterRuns = await mapWithConcurrency(
        fixture.pages,
        corpusPageConcurrency,
        async pageNumber => {
            const dpiListing = await run('pdfimages', [
                '-f',
                String(pageNumber),
                '-l',
                String(pageNumber),
                '-list',
                fixture.pdfPath,
            ]);
            const {
                detected: sourceRasterDetected,
                dpi: sourceDpi,
                hasBilevelLayer: sourceHasBilevelLayer,
                hasDominantBilevelLayer: sourceHasDominantBilevelLayer,
                backgroundDpi: sourceBackgroundDpi,
            } = parseDominantSourceDpi(dpiListing.stdout, pageNumber);
            const sourceRaster = await rasterize(
                fixture.pdfPath,
                pageNumber,
                sourceDpi,
                join(fixtureDir, `source-${pageNumber}-${sourceDpi}dpi`),
            );
            const detectionDpi = Math.min(DETECTION_DPI, sourceDpi);
            const detectionRaster = detectionDpi === sourceDpi
                ? sourceRaster
                : await rasterize(
                    fixture.pdfPath,
                    pageNumber,
                    detectionDpi,
                    join(fixtureDir, `detection-${pageNumber}-${detectionDpi}dpi`),
                );
            const detectionDimensions = await readPngHeader(detectionRaster);
            return {
                detectionDpi,
                detectionDimensions,
                detectionRaster,
                pageNumber,
                sourceDpi,
                sourceRasterDetected,
                sourceHasBilevelLayer,
                sourceHasDominantBilevelLayer,
                sourceBackgroundDpi,
                sourceRaster,
            };
        },
    );
    const detectionAnalysisManifestPath = join(
        fixtureDir,
        'detection-analysis-manifest.json',
    );
    const detectionAnalysisManifest = manifestScope.buildManifest({
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: fixtureOptions,
        pages: rasterRuns.map(page => ({
            inputPath: page.detectionRaster,
            pageNumber: page.pageNumber,
            dpi: page.detectionDpi,
            sourceDpi: page.sourceDpi,
            ...(page.sourceHasBilevelLayer ? {sourceHasBilevelLayer: true} : {}),
            ...(page.sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi: page.sourceBackgroundDpi}),
            pageMetadataPath: join(fixtureDir, `analysis-${page.pageNumber}.json`),
            outputs: [],
        })),
    });
    await writeFile(detectionAnalysisManifestPath, JSON.stringify(detectionAnalysisManifest, null, 2));
    const detectionAnalysisRun = await runSidecar(detectionAnalysisManifestPath, manifestScope);
    await Promise.all([
        writeFile(
            join(fixtureDir, 'detection-analysis-stdout.jsonl'),
            detectionAnalysisRun.stdout,
        ),
        writeFile(
            join(fixtureDir, 'detection-analysis-stderr.jsonl'),
            detectionAnalysisRun.stderr,
        ),
    ]);
    const analyzedRuns = await Promise.all(rasterRuns.map(async page => ({
        ...page,
        analysis: JSON.parse(
            await readFile(join(fixtureDir, `analysis-${page.pageNumber}.json`), 'utf8'),
        ),
    })));
    const renderedRuns = await mapWithConcurrency(
        analyzedRuns,
        corpusPageConcurrency,
        async page => {
            const {
                analysis,
                pageNumber,
                sourceDpi,
                sourceHasBilevelLayer,
                sourceRasterDetected,
                sourceRaster,
            } = page;
            const outputCarriesBinaryLayer = analysis.recommendedOutputMode === 'bw'
            || analysis.recommendedOutputMode === 'mixed';
            const requestedRenderDpi = resolveScanCleanupRequestedRenderDpi({
                sourceDpi,
                outputCarriesBinaryLayer,
                sourceRasterDetected,
            });
            const renderDpi = outputCarriesBinaryLayer
                ? resolveSafeRenderDpi(
                    requestedRenderDpi,
                    analysis.recommendedOutputMode === 'bw'
                        ? MAX_BILEVEL_PIXELS
                        : MAX_CONTINUOUS_TONE_PIXELS,
                    sourceDpi,
                    await readPngHeader(sourceRaster),
                )
                : sourceDpi;
            const renderRaster = renderDpi === sourceDpi
                ? sourceRaster
                : await rasterize(
                    fixture.pdfPath,
                    pageNumber,
                    renderDpi,
                    join(fixtureDir, `render-${pageNumber}-${renderDpi}dpi`),
                );
            const trustedMrcLayers = sourceHasBilevelLayer
                && (
                    analysis.recommendedOutputMode === 'bw'
                    || analysis.recommendedOutputMode === 'mixed'
                )
                ? await extractMrcLayers(
                    fixture.pdfPath,
                    pageNumber,
                    join(fixtureDir, `source-${pageNumber}-mrc-selection.jb2e`),
                    join(fixtureDir, `source-${pageNumber}-mrc-background.png`),
                    join(fixtureDir, `source-${pageNumber}-mrc-foreground.jp2`),
                )
                : null;
            const finalAnalysisMetadataPath = join(
                fixtureDir,
                `final-input-analysis-${pageNumber}.json`,
            );
            return {
                ...page,
                finalAnalysisMetadataPath,
                renderDpi,
                renderRaster,
                requestedRenderDpi,
                trustedMrcLayers,
            };
        },
    );
    const finalAnalysisManifestPath = join(
        fixtureDir,
        'final-input-analysis-manifest.json',
    );
    const finalAnalysisManifest = manifestScope.buildManifest({
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: fixtureOptions,
        pages: renderedRuns.map(page => ({
            inputPath: page.renderRaster,
            pageNumber: page.pageNumber,
            dpi: page.renderDpi,
            sourceDpi: page.sourceDpi,
            ...(page.sourceHasBilevelLayer ? {sourceHasBilevelLayer: true} : {}),
            ...(page.sourceBackgroundDpi === undefined ? {} : {sourceBackgroundDpi: page.sourceBackgroundDpi}),
            requestedRenderDpi: page.requestedRenderDpi,
            pageMetadataPath: page.finalAnalysisMetadataPath,
            outputs: [],
        })),
    });
    await writeFile(finalAnalysisManifestPath, JSON.stringify(finalAnalysisManifest, null, 2));
    const finalAnalysisRun = await runSidecar(finalAnalysisManifestPath, manifestScope);
    await Promise.all([
        writeFile(
            join(fixtureDir, 'final-input-analysis-stdout.jsonl'),
            finalAnalysisRun.stdout,
        ),
        writeFile(
            join(fixtureDir, 'final-input-analysis-stderr.jsonl'),
            finalAnalysisRun.stderr,
        ),
    ]);
    const pageRuns = await Promise.all(renderedRuns.map(async page => ({
        ...page,
        finalInputAnalysis: JSON.parse(
            await readFile(page.finalAnalysisMetadataPath, 'utf8'),
        ),
    })));

    const previewPages = pageRuns.map(page => buildRenderManifestPage(page, fixtureDir, 'preview'));
    const previewManifestPath = join(fixtureDir, 'preview-render-manifest.json');
    const previewManifest = manifestScope.buildManifest({
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        options: fixtureOptions,
        pages: previewPages,
    });
    await writeFile(previewManifestPath, JSON.stringify(previewManifest, null, 2));
    await clearRenderTargets(previewPages);
    await runSidecar(previewManifestPath, manifestScope);
    const previewRuns = await Promise.all(pageRuns.map(async (page, pageIndex) => {
        const previewOutputs = [];
        for (const output of previewPages[pageIndex].outputs) {
            if (!await readableFile(output.metadataPath)) continue;
            previewOutputs.push(JSON.parse(await readFile(output.metadataPath, 'utf8')));
        }
        if (previewOutputs.length === 0) {
            throw new Error(`Preview plan for page ${page.pageNumber} produced no output metadata`);
        }
        return {
            ...page,
            previewOutputs,
        };
    }));

    const renderPages = previewRuns.map(page => buildRenderManifestPage(page, fixtureDir, 'final'));
    const sourceSheets = previewRuns.flatMap(page => page.previewOutputs.map(output => ({
        heightPoints: output.sourceRegion.heightPx / page.detectionDpi * 72,
        widthPoints: output.sourceRegion.widthPx / page.detectionDpi * 72,
    })));
    if (sourceSheets.length === 0) {
        throw new Error(`Fixture "${fixture.id}" produced no source sheets to match`);
    }
    const canvasDpi = Math.max(...previewRuns.map(page => page.renderDpi));
    const documentCanvas = {
        heightPoints: Math.max(...sourceSheets.map(sheet => sheet.heightPoints)),
        widthPoints: Math.max(...sourceSheets.map(sheet => sheet.widthPoints)),
    };
    const renderManifestPath = join(fixtureDir, 'render-manifest.json');
    const renderManifest = manifestScope.buildManifest({
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        options: fixtureOptions,
        documentCanvas: {
            ...documentCanvas,
            heightPx: Math.max(1, Math.round(documentCanvas.heightPoints / 72 * canvasDpi)),
            widthPx: Math.max(1, Math.round(documentCanvas.widthPoints / 72 * canvasDpi)),
        },
        pages: renderPages,
    });
    await writeFile(renderManifestPath, JSON.stringify(renderManifest, null, 2));
    await clearRenderTargets(renderPages);
    await runSidecar(renderManifestPath, manifestScope);

    const combinedPages = [];
    const planParityFailures = [];
    for (const [
        pageIndex,
        page,
    ] of previewRuns.entries()) {
        const renderPage = renderPages[pageIndex];
        const expectedPage = expectedFixture?.pages?.[String(page.pageNumber)];
        const outputFiles = [];
        for (const output of renderPage.outputs) {
            // The sidecar publishes one raster per output and writes this
            // metadata beside it, so its absence means the half was skipped.
            if (!await readableFile(output.metadataPath)) continue;
            const metadata = JSON.parse(await readFile(output.metadataPath, 'utf8'));
            const parityFailures = pagePlanParityFailures(page.analysis, page.previewOutputs, metadata);
            planParityFailures.push(...parityFailures.map(failure => (
                `page ${page.pageNumber} ${metadata.half}: ${failure}`
            )));
            const bilevelPath = metadata.bilevelWritten && await readableFile(output.bilevelOutputPath)
                ? output.bilevelOutputPath
                : null;
            const layered = metadata.layeredWritten
                && await readableFile(output.backgroundOutputPath)
                && (
                    metadata.layeredForegroundKind === 'soft-alpha'
                        ? await readableFile(output.foregroundAlphaOutputPath)
                        : await readableFile(output.foregroundMaskOutputPath)
                );
            const backgroundPath = layered ? output.backgroundOutputPath : null;
            const foregroundMaskPath = layered && metadata.layeredForegroundKind !== 'soft-alpha'
                ? output.foregroundMaskOutputPath
                : null;
            const foregroundAlphaPath = layered && metadata.layeredForegroundKind === 'soft-alpha'
                ? output.foregroundAlphaOutputPath
                : null;
            const pictureMaskPath = await readableFile(output.pictureMaskOutputPath)
                ? output.pictureMaskOutputPath
                : null;
            const backgroundIsColor = backgroundPath
                ? (await readPngHeader(backgroundPath)).isColor
                : false;
            outputFiles.push({
                backgroundIsColor,
                backgroundPath,
                bilevelPath,
                foregroundMaskPath,
                foregroundAlphaPath,
                pictureMaskPath,
                metadata,
                outputPath: output.outputPath,
            });
            combinedPages.push({
                backgroundIsColor,
                backgroundPath,
                bilevelPath,
                foregroundMaskPath,
                foregroundAlphaPath,
                pictureMaskPath,
                metadata,
                mode: page.analysis.recommendedOutputMode,
                outputPath: output.outputPath,
                renderDpi: metadata.renderDpi ?? page.renderDpi,
                preserveOriginalQuality: fixture.preserveOriginalQuality === true,
                sourceHasBilevelLayer: page.sourceHasBilevelLayer,
                sourcePageNumber: page.pageNumber,
                trustedMrcLayers: page.trustedMrcLayers,
            });
        }
        if (expectedPage) {
            report.add(
                `page ${page.pageNumber} resolved mode`,
                page.analysis.recommendedOutputMode === expectedPage.mode,
                `${String(page.analysis.recommendedOutputMode)} (expected ${expectedPage.mode})`,
            );
            report.add(
                `page ${page.pageNumber} recommendation reason`,
                page.analysis.recommendedOutputModeReason === expectedPage.reason,
                `${String(page.analysis.recommendedOutputModeReason)} (expected ${expectedPage.reason})`,
            );
            const confidence = Number(page.analysis.recommendedOutputModeConfidence);
            report.add(
                `page ${page.pageNumber} confidence`,
                confidence >= expectedPage.minConfidence,
                `${confidence.toFixed(4)} (minimum ${expectedPage.minConfidence.toFixed(2)})`,
            );
            report.add(
                `page ${page.pageNumber} output count`,
                outputFiles.length === expectedPage.outputCount,
                `${outputFiles.length} (expected ${expectedPage.outputCount})`,
            );
        }
    }
    report.add(
        '150-DPI preview plan matches final render',
        planParityFailures.length === 0,
        planParityFailures.length === 0
            ? `${combinedPages.length} output(s) preserve mode, crop, skew, and text-tone identity`
            : planParityFailures.slice(0, 8).join('; '),
    );
    const missingDiagnosticsPages = pageRuns
        .filter(page => page.analysis.outputModeDiagnostics === undefined)
        .map(page => page.pageNumber);
    report.add(
        'automatic decision evidence coverage',
        missingDiagnosticsPages.length === 0,
        missingDiagnosticsPages.length === 0
            ? `${pageRuns.length}/${pageRuns.length} page(s)`
            : `missing pages ${missingDiagnosticsPages.slice(0, 20).join(', ')}`,
    );
    const modeEvidence = crossResolutionModeEvidence(pageRuns);
    report.add(
        '150-DPI Auto mode preserves material final-input evidence',
        modeEvidence.destructivePages.length === 0,
        modeEvidence.destructivePages.length === 0
            ? `${pageRuns.length}/${pageRuns.length} page(s)`
            : modeEvidence.destructivePages.slice(0, 20).join(', '),
    );
    report.add(
        'cross-resolution Auto mode differences are conservative',
        modeEvidence.destructivePages.length === 0,
        modeEvidence.unstablePages.length === 0
            ? 'exact agreement'
            : modeEvidence.unstablePages.slice(0, 20).join(', '),
    );
    const unauthorizedSourceMrcPages = combinedPages.filter(page =>
        page.metadata.layeredForegroundKind === 'source-mrc'
        && page.preserveOriginalQuality !== true,
    );
    report.add(
        'fresh raster pages do not publish source-MRC layers',
        unauthorizedSourceMrcPages.length === 0,
        unauthorizedSourceMrcPages.length === 0
            ? 'none'
            : unauthorizedSourceMrcPages.map(page => String(page.sourcePageNumber)).join(', '),
    );

    const compactManifestPath = join(fixtureDir, 'combine-manifest.tsv');
    const compactManifestPages = combinedPages.map(page => {
        const pageWidthPoints = page.metadata.matchedCanvasTargetWidthPoints
            ?? page.metadata.canvasWidthPx / page.renderDpi * 72;
        const pageHeightPoints = page.metadata.matchedCanvasTargetHeightPoints
            ?? page.metadata.canvasHeightPx / page.renderDpi * 72;
        const pageSize = [
            pageWidthPoints.toFixed(6),
            pageHeightPoints.toFixed(6),
        ];
        if (page.bilevelPath) {
            return [
                'image-bilevel',
                ...pageSize,
                page.bilevelPath,
            ].join('\t');
        }
        if (page.backgroundPath && page.foregroundMaskPath) {
            if (
                page.metadata.layeredForegroundKind === 'source-mrc'
                && page.preserveOriginalQuality === true
            ) {
                const matrix = sourceMrcForegroundPdfMatrix(
                    page,
                    pageWidthPoints,
                    pageHeightPoints,
                );
                return [
                    'affine-masked-layered-jpeg',
                    ...pageSize,
                    page.backgroundIsColor ? 87 : 85,
                    page.backgroundPath,
                    page.trustedMrcLayers.foregroundPath,
                    page.trustedMrcLayers.selectionMaskPath,
                    ...matrix.map(value => value.toFixed(10)),
                    page.trustedMrcLayers.selectionMaskDecode,
                ].join('\t');
            }
            return [
                'layered-jpeg',
                ...pageSize,
                page.backgroundIsColor ? 87 : 85,
                page.backgroundPath,
                page.foregroundMaskPath,
            ].join('\t');
        }
        if (page.backgroundPath && page.foregroundAlphaPath) {
            return [
                'soft-layered-jpeg',
                ...pageSize,
                page.backgroundIsColor ? 87 : 85,
                page.backgroundPath,
                page.foregroundAlphaPath,
            ].join('\t');
        }
        const jpegQuality = page.metadata.bilevelWritten ? null : tonalJpegQuality(page.mode);
        return jpegQuality === null
            ? [
                'image',
                ...pageSize,
                page.outputPath,
            ].join('\t')
            : [
                'image-jpeg',
                ...pageSize,
                jpegQuality,
                page.outputPath,
            ].join('\t');
    });
    const compactManifest = buildScanCleanupCompactManifest(compactManifestPages);
    await writeFile(
        compactManifestPath,
        serializeLegacyScanCleanupCompactManifest(compactManifest),
    );
    // Only the explicit lossless path keeps compact source pages. Raster
    // cleanup, including Auto pages with producer MRC hints, always assembles
    // the fresh render artifacts above.
    const compactSourceInstructions = combinedPages.map(page =>
        compactSourceInstruction(page, sourcePageBoxes.get(page.sourcePageNumber)),
    );
    const preservedInstructions = compactSourceInstructions.filter(Boolean);
    const outputPdfPath = join(fixtureDir, `${fixture.id}.pdf`);
    const rasterizedPdfPath = preservedInstructions.length > 0
        ? join(fixtureDir, `${fixture.id}-rasterized.pdf`)
        : outputPdfPath;
    const combine = await run(defaultCombineBinary, [
        '--output',
        rasterizedPdfPath,
        '--compact-manifest',
        compactManifestPath,
        '--json-progress',
    ], {env: {EVB_PDF_COMBINE_TIMING: '1'}});
    await Promise.all([
        writeFile(join(fixtureDir, 'combine-stdout.jsonl'), combine.stdout),
        writeFile(join(fixtureDir, 'combine-stderr.jsonl'), combine.stderr),
    ]);
    if (preservedInstructions.length > 0) {
        const instructionsPath = join(fixtureDir, 'preserved-source-pages.json');
        const preservedPdfPath = join(fixtureDir, 'preserved-source-pages.pdf');
        const instructions = buildScanCleanupPageOpsInstructions(preservedInstructions);
        await writeFile(
            instructionsPath,
            serializeLegacyScanCleanupPageOpsInstructions(instructions),
        );
        await run(defaultPageOpsBinary, [
            'split-pages',
            '--input',
            fixture.pdfPath,
            '--output',
            preservedPdfPath,
            '--instructions-file',
            instructionsPath,
        ]);
        const qpdfArgs = [
            '--empty',
            '--coalesce-contents',
            '--pages',
        ];
        let preservedPageNumber = 0;
        for (const [
            index,
            instruction,
        ] of compactSourceInstructions.entries()) {
            if (instruction) {
                preservedPageNumber += 1;
                qpdfArgs.push(preservedPdfPath, String(preservedPageNumber));
            } else {
                qpdfArgs.push(rasterizedPdfPath, String(index + 1));
            }
        }
        qpdfArgs.push('--', outputPdfPath);
        await run('qpdf', qpdfArgs);
        report.add(
            'compact source-layer retention',
            true,
            `${preservedInstructions.length} automatic page(s) kept their original image objects`,
        );
    }
    const pageStructure = await run('qpdf', [
        '--show-pages',
        outputPdfPath,
    ]);
    await writeFile(join(fixtureDir, 'qpdf-show-pages.txt'), pageStructure.stdout);
    const pageContentCounts = parseQpdfPageContentCounts(pageStructure.stdout);
    const missingContentPages = pageContentCounts.filter(page => page.contentStreamCount < 1);
    report.add(
        'output pages expose at least one content stream each',
        pageContentCounts.length === combinedPages.length && missingContentPages.length === 0,
        missingContentPages.length === 0
            ? `${pageContentCounts.length} page(s), all non-empty`
            : `missing content streams: ${missingContentPages.map(page =>
                `${page.pageNumber}:${page.contentStreamCount}`,
            ).join(', ')}`,
    );
    const timings = combine.stderr.split(/\r?\n/u).flatMap(line => {
        try {
            const value = JSON.parse(line);
            return value.type === 'jbig2-encode-timing' ? [value] : [];
        } catch {
            return [];
        }
    });
    const bilevelPages = combinedPages
        .map((page, index) => ({
            ...page,
            pdfPage: index + 1,
        }))
        .filter(page => page.bilevelPath);
    const layeredPages = combinedPages
        .map((page, index) => ({
            ...page,
            pdfPage: index + 1,
        }))
        .filter(page => page.foregroundMaskPath);
    const imageListingResult = await run('pdfimages', [
        '-list',
        outputPdfPath,
    ]);
    await writeFile(join(fixtureDir, 'pdfimages-list.txt'), imageListingResult.stdout);
    const imageListing = parsePdfImages(imageListingResult.stdout);
    const sourceImageListingResult = await run('pdfimages', [
        '-list',
        fixture.pdfPath,
    ]);
    await writeFile(join(fixtureDir, 'source-pdfimages-list.txt'), sourceImageListingResult.stdout);
    const sourceImageListing = parsePdfImages(sourceImageListingResult.stdout);
    const sourceRawPrefix = join(fixtureDir, 'source-raw-stream');
    const outputRawPrefix = join(fixtureDir, 'output-raw-stream');
    await Promise.all([
        run('pdfimages', [
            '-all',
            fixture.pdfPath,
            sourceRawPrefix,
        ]),
        run('pdfimages', [
            '-all',
            outputPdfPath,
            outputRawPrefix,
        ]),
    ]);
    const compactStreamHashes = [];
    const pageClassSizeBudgets = [];
    for (const [
        outputPageIndex,
        page,
    ] of combinedPages.entries()) {
        const expectsPreservedMrc = page.preserveOriginalQuality === true
            && (
                page.metadata.layeredForegroundKind === 'source-mrc'
                || compactSourceInstructions[outputPageIndex] !== null
            );
        if (!expectsPreservedMrc) {
            continue;
        }
        const sourcePair = selectMrcStreamPair(sourceImageListing, page.sourcePageNumber);
        const outputPair = selectMrcStreamPair(imageListing, outputPageIndex + 1);
        if (sourcePair === null || outputPair === null) {
            report.add(
                `output page ${String(outputPageIndex + 1)} compact stream identity`,
                false,
                sourcePair === null
                    ? 'source JPX/JBIG2 MRC pair not found'
                    : 'output JPX/JBIG2 MRC pair not found',
            );
            continue;
        }
        const sourceForegroundPath = extractedStreamPath(
            sourceRawPrefix,
            sourcePair.foreground,
            'jp2',
        );
        const outputForegroundPath = extractedStreamPath(
            outputRawPrefix,
            outputPair.foreground,
            'jp2',
        );
        const sourceMaskPath = extractedStreamPath(sourceRawPrefix, sourcePair.mask, 'jb2e');
        const outputMaskPath = extractedStreamPath(outputRawPrefix, outputPair.mask, 'jb2e');
        const [
            sourceForegroundHash,
            outputForegroundHash,
            sourceMaskHash,
            outputMaskHash,
        ] = await Promise.all([
            sha256File(sourceForegroundPath),
            sha256File(outputForegroundPath),
            sha256File(sourceMaskPath),
            sha256File(outputMaskPath),
        ]);
        const hashesMatch = sourceForegroundHash === outputForegroundHash
            && sourceMaskHash === outputMaskHash;
        compactStreamHashes.push({
            outputPageNumber: outputPageIndex + 1,
            sourcePageNumber: page.sourcePageNumber,
            foreground: {
                outputSha256: outputForegroundHash,
                sourceSha256: sourceForegroundHash,
            },
            mask: {
                outputSha256: outputMaskHash,
                sourceSha256: sourceMaskHash,
            },
            passed: hashesMatch,
        });
        const sourceBackgroundImages = sourceImageListing.filter(image =>
            image.page === page.sourcePageNumber
            && image.type === 'image'
            && image.bitsPerComponent > 1
            && image.number !== sourcePair.foreground.number,
        );
        const outputBackgroundImages = imageListing.filter(image =>
            image.page === outputPageIndex + 1
            && image.type === 'image'
            && image.bitsPerComponent > 1
            && image.number !== outputPair.foreground.number,
        );
        const [
            sourceBackgroundBytes,
            outputBackgroundBytes,
        ] = await Promise.all([
            extractedImageBytes(sourceRawPrefix, sourceBackgroundImages),
            extractedImageBytes(outputRawPrefix, outputBackgroundImages),
        ]);
        // Cleaned mixed pages re-encode the background at selection dpi with
        // shoulder-normalized picture zones, so a photo page legitimately
        // outgrows a thumbnail-grade source MRC background by an order of
        // magnitude. The floor only has to catch runaway full-res re-encodes
        // (hundreds of KB), not intended photo fidelity.
        const maximumBackgroundBytes = Math.ceil(Math.max(
            sourceBackgroundBytes * 1.5,
            96 * 1024,
        ));
        const backgroundBudgetPassed = outputBackgroundBytes <= maximumBackgroundBytes;
        pageClassSizeBudgets.push({
            class: compactSourceInstructions[outputPageIndex] === null
                ? 'cleaned-mrc'
                : 'preserved-compact-source',
            maximumBytes: maximumBackgroundBytes,
            outputBytes: outputBackgroundBytes,
            outputPageNumber: outputPageIndex + 1,
            passed: backgroundBudgetPassed,
            sourceBytes: sourceBackgroundBytes,
        });
        report.add(
            `output page ${String(outputPageIndex + 1)} compact stream identity`,
            hashesMatch,
            hashesMatch
                ? 'JPX foreground and JBIG2 mask are byte-identical to source'
                : 'foreground or mask hash differs from source',
        );
        report.add(
            `output page ${String(outputPageIndex + 1)} compact background budget`,
            backgroundBudgetPassed,
            `${String(outputBackgroundBytes)} B (maximum ${String(maximumBackgroundBytes)} B; `
            + `${String(sourceBackgroundBytes)} B source background)`,
        );
    }
    await writeFile(
        join(fixtureDir, 'compact-stream-hash-audit.json'),
        `${JSON.stringify(compactStreamHashes, null, 2)}\n`,
    );
    for (const [
        outputPageIndex,
        page,
    ] of combinedPages.entries()) {
        if (page.mode === 'bw') {
            continue;
        }
        const sourceContinuousImages = sourceImageListing.filter(image =>
            image.page === page.sourcePageNumber
            && image.type === 'image'
            && image.bitsPerComponent > 1,
        );
        const outputContinuousImages = imageListing.filter(image =>
            image.page === outputPageIndex + 1
            && image.type === 'image'
            && image.bitsPerComponent > 1,
        );
        const maximumSourceWidth = Math.max(0, ...sourceContinuousImages.map(image => image.width));
        const maximumSourceHeight = Math.max(0, ...sourceContinuousImages.map(image => image.height));
        const oversized = outputContinuousImages.filter(image =>
            image.width > maximumSourceWidth || image.height > maximumSourceHeight,
        );
        report.add(
            `output page ${String(outputPageIndex + 1)} continuous-tone dimensions`,
            sourceContinuousImages.length > 0
                && outputContinuousImages.length > 0
                && oversized.length === 0,
            oversized.length === 0
                ? `${outputContinuousImages.length} image(s) within source ${String(maximumSourceWidth)}x${String(maximumSourceHeight)}`
                : `upscaled ${oversized.map(image => `${image.width}x${image.height}`).join(', ')}`,
        );
    }
    for (const page of bilevelPages) {
        const sourceImages = sourceImageListing.filter(image =>
            image.page === page.sourcePageNumber,
        );
        const outputImages = imageListing.filter(image =>
            image.page === page.pdfPage,
        );
        const [
            sourcePageImageBytes,
            outputPageImageBytes,
        ] = await Promise.all([
            extractedImageBytes(sourceRawPrefix, sourceImages),
            extractedImageBytes(outputRawPrefix, outputImages),
        ]);
        // Binary cleanup can modestly increase the encoded JBIG2/CCITT stream
        // even when it retains the source raster's measured grid.
        const maximumBilevelBytes = Math.ceil(sourcePageImageBytes * 1.65);
        const bilevelBudgetPassed = outputPageImageBytes <= maximumBilevelBytes;
        pageClassSizeBudgets.push({
            class: 'bilevel',
            maximumBytes: maximumBilevelBytes,
            outputBytes: outputPageImageBytes,
            outputPageNumber: page.pdfPage,
            passed: bilevelBudgetPassed,
            sourceBytes: sourcePageImageBytes,
        });
        report.add(
            `output page ${String(page.pdfPage)} bilevel stream budget`,
            bilevelBudgetPassed,
            `${String(outputPageImageBytes)} B (maximum ${String(maximumBilevelBytes)} B; `
            + `${String(sourcePageImageBytes)} B source image streams)`,
        );
    }
    await writeFile(
        join(fixtureDir, 'page-class-size-budget.json'),
        `${JSON.stringify(pageClassSizeBudgets, null, 2)}\n`,
    );
    for (const page of bilevelPages) {
        const image = imageListing.find(candidate => candidate.page === page.pdfPage && candidate.type === 'image');
        report.add(
            `output page ${page.pdfPage} is 1-bit JBIG2`,
            image?.bitsPerComponent === 1 && image.encoding === 'jbig2',
            image ? `${image.bitsPerComponent}-bit ${image.encoding}` : 'no image found',
        );
    }
    for (const page of layeredPages) {
        if (
            page.metadata.layeredForegroundKind === 'source-mrc'
            && page.preserveOriginalQuality === true
        ) {
            if (compactSourceInstructions[page.pdfPage - 1] !== null) {
                report.add(
                    `output page ${page.pdfPage} bypasses source-MRC reconstruction`,
                    true,
                    'whole source page selected; rendered source-fidelity audit remains authoritative',
                );
                continue;
            }
            const mask = imageListing.find(candidate =>
                candidate.page === page.pdfPage
                && candidate.type === 'smask',
            );
            const expectedWidth = page.trustedMrcLayers?.foregroundWidth;
            const expectedHeight = page.trustedMrcLayers?.foregroundHeight;
            const foreground = imageListing.find(candidate =>
                candidate.page === page.pdfPage
                && candidate.type === 'image'
                && candidate.encoding === 'jpx'
                && candidate.objectId === mask?.objectId
                && candidate.width === expectedWidth
                && candidate.height === expectedHeight,
            );
            const dimensionsMatch = foreground?.width === expectedWidth
                && foreground?.height === expectedHeight
                && mask?.width === expectedWidth
                && mask?.height === expectedHeight;
            const maskSharesForegroundObject = foreground !== undefined
                && mask !== undefined
                && foreground.objectId === mask.objectId;
            report.add(
                `output page ${page.pdfPage} preserves compact JPX foreground and 1-bit JBIG2 soft mask`,
                foreground !== undefined
                    && mask?.bitsPerComponent === 1
                    && mask.encoding === 'jbig2'
                    && dimensionsMatch
                    && maskSharesForegroundObject,
                foreground === undefined || mask === undefined
                    ? 'foreground or soft mask missing'
                    : `${foreground.width}x${foreground.height} ${foreground.encoding} + `
                        + `${mask.bitsPerComponent}-bit ${mask.encoding} smask`,
            );
        } else {
            const mask = imageListing.find(candidate =>
                candidate.page === page.pdfPage
                && candidate.type === 'stencil',
            );
            report.add(
                `output page ${page.pdfPage} foreground mask is 1-bit JBIG2`,
                mask?.bitsPerComponent === 1 && mask.encoding === 'jbig2',
                mask ? `${mask.bitsPerComponent}-bit ${mask.encoding}` : 'no mask found',
            );
        }
    }
    // Reconstructed stencils can accidentally absorb a scanner boundary, so
    // keep the geometric component heuristic for those pages. Source-MRC
    // output does not publish this transformed intermediary: the final PDF
    // uses the original source selection as an SMask under an affine matrix.
    // Its authoritative gates are the JPX/SMask structure above and the
    // rendered artifact audit below; applying the old heuristic to the unused
    // intermediary falsely rejects legitimate map and photograph edges.
    const reconstructedLayeredPages = layeredPages.filter(page =>
        page.metadata.layeredForegroundKind !== 'source-mrc'
        || page.preserveOriginalQuality !== true,
    );
    const sourceMrcLayeredCount = layeredPages.length - reconstructedLayeredPages.length;
    const boundaryComponentAudits = await mapWithConcurrency(
        reconstructedLayeredPages,
        corpusPageConcurrency,
        async page => {
            const result = await run('magick', [
                page.foregroundMaskPath,
                '-define',
                'connected-components:verbose=true',
                '-connected-components',
                '8',
                'null:',
            ]);
            const components = parseConnectedComponents(`${result.stdout}\n${result.stderr}`);
            return {
                artifacts: scannerBoundaryComponents(
                    components,
                    page.metadata.canvasWidthPx,
                    page.metadata.canvasHeightPx,
                    page.renderDpi,
                ),
                page,
            };
        },
    );
    const boundaryArtifacts = boundaryComponentAudits.flatMap(({
        artifacts,
        page,
    }) =>
        artifacts.map(component => ({
            ...component,
            dpi: page.renderDpi,
            pdfPage: page.pdfPage,
        })),
    );
    const boundaryReconciliation = reconcileScannerBoundaryExceptions(
        boundaryArtifacts,
        expectedFixture?.scannerBoundaryExceptions ?? [],
    );
    report.add(
        'configured scanner-boundary exceptions match one-to-one',
        boundaryReconciliation.stale.length === 0,
        boundaryReconciliation.stale.length === 0
            ? `${boundaryReconciliation.matched.length} physical bbox exception(s) matched exactly once`
            : boundaryReconciliation.stale.map(exception =>
                `page ${String(exception.page)} ${exception.reason}: ${String(exception.matchCount)} match(es)`,
            ).join('; '),
    );
    const unexpectedBoundaryArtifacts = boundaryReconciliation.unexpected;
    report.add(
        'layered foregrounds contain no unexpected vertical scanner-boundary components',
        unexpectedBoundaryArtifacts.length === 0,
        unexpectedBoundaryArtifacts.length === 0
            ? `${reconstructedLayeredPages.length} reconstructed layer(s) inspected; `
                + `${sourceMrcLayeredCount} source-MRC layer(s) covered by exact-mask structure; `
                + `${boundaryReconciliation.matched.length} ledger exception(s) consumed`
            : unexpectedBoundaryArtifacts.slice(0, 8).map(component =>
                `page ${String(component.pdfPage)} ${String(component.width)}x${String(component.height)}`
                + `+${String(component.left)}+${String(component.top)} area=${String(component.area)}`,
            ).join('; '),
    );

    if (bilevelPages.length > 0) {
        const extractedPrefix = join(fixtureDir, 'extracted');
        const firstBilevelPdfPage = Math.min(...bilevelPages.map(page => page.pdfPage));
        const lastBilevelPdfPage = Math.max(...bilevelPages.map(page => page.pdfPage));
        await run('pdfimages', [
            '-f',
            String(firstBilevelPdfPage),
            '-l',
            String(lastBilevelPdfPage),
            '-png',
            outputPdfPath,
            extractedPrefix,
        ]);
        // `pdfimages -f/-l` restarts the extracted filename sequence at zero,
        // even though `pdfimages -list` keeps the document-global `num`
        // column. Map through the selected listing instead of confusing a
        // later page's global image number with the local extraction index.
        const extractedImages = imageListing.filter(candidate =>
            candidate.page >= firstBilevelPdfPage
            && candidate.page <= lastBilevelPdfPage,
        );
        for (const page of bilevelPages) {
            // pdfimages numbers every embedded image, not every PDF page.
            // Layered pages add a background and stencil, so pageNumber - 1
            // points at the wrong file as soon as one precedes a bilevel page.
            const embeddedImage = imageListing.find(candidate =>
                candidate.page === page.pdfPage
                && candidate.type === 'image',
            );
            const extractedIndex = embeddedImage === undefined
                ? -1
                : extractedImages.indexOf(embeddedImage);
            const extractedPath = extractedIndex < 0
                ? ''
                : `${extractedPrefix}-${String(extractedIndex).padStart(3, '0')}.png`;
            if (!extractedPath || !await readableFile(extractedPath)) {
                report.add(
                    `output page ${page.pdfPage} PBM roundtrip`,
                    false,
                    'embedded image extraction was not found',
                );
                continue;
            }
            const comparison = await run('compare', [
                '-metric',
                'AE',
                page.bilevelPath,
                extractedPath,
                'null:',
            ], {allowFailure: true});
            const metricMatch = /^\s*([0-9.e+-]+)/iu.exec(comparison.stderr);
            const absoluteError = metricMatch ? Number(metricMatch[1]) : Number.NaN;
            report.add(
                `output page ${page.pdfPage} PBM roundtrip`,
                absoluteError === 0,
                `absolute error ${Number.isFinite(absoluteError) ? absoluteError : comparison.stderr.trim()} (exit ${String(comparison.code)})`,
            );
        }
    }

    const mediaBoxResult = await run('pdfinfo', [
        '-f',
        '1',
        '-l',
        String(combinedPages.length),
        '-box',
        outputPdfPath,
    ]);
    await writeFile(join(fixtureDir, 'pdfinfo-box.txt'), mediaBoxResult.stdout);
    const boxes = parseMediaBoxes(mediaBoxResult.stdout);
    const boxKeys = new Set(boxes.map(box => box.map(value => value.toFixed(2)).join('x')));
    report.add(
        'uniform MediaBoxes',
        boxes.length === combinedPages.length && boxKeys.size === 1,
        boxes.length === 0 ? 'no MediaBoxes found' : [...boxKeys].join(', '),
    );

    const artifactAuditDir = join(fixtureDir, 'artifact-audit');
    const artifactAuditSummaryPath = join(artifactAuditDir, 'summary.json');
    const sourcePageSequence = combinedPages
        .map(page => String(page.sourcePageNumber))
        .join(',');
    const artifactAudit = await run('python3', [
        join(projectRoot, 'scripts/diagnostics/scan-cleanup-artifact-audit.py'),
        '--source-pdf',
        fixture.pdfPath,
        '--output-pdf',
        outputPdfPath,
        '--metadata-dir',
        fixtureDir,
        '--analysis-metadata-dir',
        fixtureDir,
        '--artifact-dir',
        artifactAuditDir,
        '--dpi',
        String(DETECTION_DPI),
        '--source-pages',
        sourcePageSequence,
        '--metadata-pages',
        sourcePageSequence,
        '--worst-count',
        String(Math.min(48, combinedPages.length)),
    ], {allowFailure: true});
    await Promise.all([
        writeFile(join(fixtureDir, 'artifact-audit-stdout.log'), artifactAudit.stdout),
        writeFile(join(fixtureDir, 'artifact-audit-stderr.log'), artifactAudit.stderr),
    ]);
    const artifactAuditSummary = await readableFile(artifactAuditSummaryPath)
        ? JSON.parse(await readFile(artifactAuditSummaryPath, 'utf8'))
        : null;
    const artifactFailures = artifactAuditSummary?.acceptanceFailures ?? [];
    const neighborFailures = artifactAuditSummary?.neighborComparisons?.failures ?? [];
    report.add(
        'assembled artifact image-quality audit',
        artifactAudit.code === 0
            && artifactAuditSummary !== null
            && artifactFailures.length === 0
            && neighborFailures.length === 0,
        artifactAuditSummary === null
            ? `audit did not publish summary (exit ${String(artifactAudit.code)}): ${artifactAudit.stderr.trim()}`
            : `${String(artifactAuditSummary.evaluatedPages)}/${String(combinedPages.length)} page(s),`
                + ` ${String(artifactFailures.length)} page failure(s),`
                + ` ${String(neighborFailures.length)} neighbor failure(s)`,
    );

    const outputBytes = (await stat(outputPdfPath)).size;
    const sourceBytes = (await stat(fixture.pdfPath)).size;
    const outputToSourceRatio = outputBytes / sourceBytes;
    const actualModeDistribution = Object.fromEntries(OUTPUT_MODES.map(mode => [
        mode,
        combinedPages.filter(page => page.mode === mode).length,
    ]));
    if (expectedFixture?.expectedModeDistribution) {
        const modeDistribution = compareModeDistribution(
            combinedPages.map(page => page.mode),
            expectedFixture.expectedModeDistribution,
        );
        const formatDistribution = distribution => OUTPUT_MODES
            .filter(mode => distribution[mode] > 0)
            .map(mode => `${mode}=${String(distribution[mode])}`)
            .join(', ');
        report.add(
            'output mode distribution',
            modeDistribution.passed,
            `${formatDistribution(modeDistribution.actual)} (expected ${formatDistribution(modeDistribution.expected)})`,
        );
    }
    if (expectedFixture?.expectedOutputBytes) {
        const lower = expectedFixture.expectedOutputBytes * 0.7;
        const upper = expectedFixture.expectedOutputBytes * 1.3;
        report.add(
            'output size envelope',
            outputBytes >= lower && outputBytes <= upper,
            `${outputBytes.toLocaleString('en-US')} B (expected ${expectedFixture.expectedOutputBytes.toLocaleString('en-US')} B ±30%)`,
        );
    }
    if (expectedFixture?.maxOutputToSourceRatio) {
        report.add(
            'output/source size budget',
            outputToSourceRatio <= expectedFixture.maxOutputToSourceRatio,
            `${outputToSourceRatio.toFixed(3)}x (maximum ${expectedFixture.maxOutputToSourceRatio.toFixed(3)}x)`,
        );
    }
    if (expectedFixture?.requireOutputSmallerThanSource === true) {
        report.add(
            'output is smaller than source',
            outputToSourceRatio < 1,
            `${outputToSourceRatio.toFixed(3)}x (required <1.000x)`,
        );
    }
    const stats = timingStats(timings);
    const encodedMaskPageCount = bilevelPages.length + reconstructedLayeredPages.length;
    report.add(
        'JBIG2 encode timing coverage',
        timings.length === encodedMaskPageCount
            && timings.every(record => Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0),
        `${stats.count}/${String(encodedMaskPageCount)} encoded mask record(s); `
        + `total=${stats.totalMs.toFixed(1)}ms mean=${stats.meanMs.toFixed(1)}ms max=${stats.maxMs.toFixed(1)}ms`,
    );
    const pageEvidence = previewRuns.map((page, pageIndex) => ({
        analysisMetadataPath: join(fixtureDir, `analysis-${page.pageNumber}.json`),
        confidence: page.analysis.recommendedOutputModeConfidence,
        detectionDpi: page.detectionDpi,
        diagnostics: page.analysis.outputModeDiagnostics ?? null,
        finalInputAnalysisMetadataPath: page.finalAnalysisMetadataPath,
        finalInputConfidence: page.finalInputAnalysis.recommendedOutputModeConfidence,
        finalInputDiagnostics: page.finalInputAnalysis.outputModeDiagnostics ?? null,
        finalInputMode: page.finalInputAnalysis.recommendedOutputMode,
        finalInputReason: page.finalInputAnalysis.recommendedOutputModeReason,
        mode: page.analysis.recommendedOutputMode,
        outputMetadataPaths: renderPages[pageIndex].outputs
            .map(output => output.metadataPath),
        pageNumber: page.pageNumber,
        previewMetadataPaths: previewPages[pageIndex].outputs
            .map(output => output.metadataPath),
        reason: page.analysis.recommendedOutputModeReason,
        renderDpi: page.renderDpi,
        requestedRenderDpi: page.requestedRenderDpi,
        sourceDpi: page.sourceDpi,
    }));
    await writeFile(
        join(fixtureDir, 'page-evidence.json'),
        `${JSON.stringify(pageEvidence, null, 2)}\n`,
    );
    const fixtureReport = {
        ...report,
        actualModeDistribution,
        actualSha256: sourceAdmission.actualSha256,
        admissionStatus: sourceAdmission.admissionStatus,
        fixturePath: fixture.pdfPath,
        expectedSha256: sourceAdmission.expectedSha256,
        outputBytes,
        outputToSourceRatio,
        outputPdfPath,
        pageCount: pageRuns.length,
        pageEvidencePath: join(fixtureDir, 'page-evidence.json'),
        artifactAuditSummaryPath,
        sourceAdmission: {
            actualSha256: sourceAdmission.actualSha256,
            expectedSha256: sourceAdmission.expectedSha256,
            reason: sourceAdmission.reason,
            status: sourceAdmission.admissionStatus,
        },
        timing: stats,
    };
    await writeFile(
        join(fixtureDir, 'fixture-report.json'),
        `${JSON.stringify(fixtureReport, null, 2)}\n`,
    );
    return fixtureReport;
}

async function writeFixtureAdmissionReport(fixture, admission, workRoot) {
    const fixtureDir = join(workRoot, fixture.id);
    await mkdir(fixtureDir, {recursive: true});
    const report = {
        actualSha256: admission.actualSha256,
        admissionStatus: admission.admissionStatus,
        error: admission.error,
        expectedSha256: admission.expectedSha256,
        fixtureId: fixture.id,
        fixturePath: fixture.pdfPath,
        reason: admission.reason,
        sourceAdmission: {
            actualSha256: admission.actualSha256,
            expectedSha256: admission.expectedSha256,
            reason: admission.reason,
            status: admission.admissionStatus,
        },
    };
    const reportPath = join(fixtureDir, 'fixture-admission.json');
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    await writeFile(reportPath, serialized);
    return {
        ...admission,
        admissionReportPath: reportPath,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = JSON.parse(await readFile(args.config, 'utf8'));
    const expected = JSON.parse(await readFile(args.expected, 'utf8'));
    if (!Array.isArray(config.fixtures) || config.fixtures.length === 0) {
        throw new Error('Corpus config must contain a non-empty fixtures array');
    }
    const fixtureRuns = config.fixtures.map(rawFixture => {
        const fixture = materializeFixtureConfig(rawFixture);
        if (
            typeof fixture.id !== 'string'
            || typeof fixture.pdfPath !== 'string'
            || !isAbsolute(fixture.pdfPath)
        ) throw new Error(`Invalid corpus fixture config: ${JSON.stringify(fixture)}`);
        const pages = resolveFixturePages(fixture);
        const expectations = resolveFixtureExpectations(fixture, expected.fixtures?.[fixture.id]);
        if (Object.keys(expectations).length === 0 && !args.allowMissingExpectations) {
            throw new Error([
                `Missing required expectations for fixture "${fixture.id}".`,
                'The corpus verifier cannot report a quality pass from parity and structural checks alone.',
                'Add explicit fixture expectations or use the lower-level diagnostic scripts for an exploratory run.',
            ].join(' '));
        }
        return {
            expectations,
            fixture: {
                ...fixture,
                pages,
            },
        };
    });
    const workRoot = args.workDir ?? join(
        projectRoot,
        '.devkit',
        `scan-cleanup-corpus-${new Date().toISOString().replaceAll(/[:.]/gu, '-')}`,
    );
    await mkdir(workRoot, {recursive: true});
    const admittedRuns = [];
    for (const fixtureRun of fixtureRuns) {
        const admission = await writeFixtureAdmissionReport(
            fixtureRun.fixture,
            await inspectFixtureSource(fixtureRun.fixture),
            workRoot,
        );
        if (admission.admissionStatus === 'rejected') {
            throw new Error(admission.error);
        }
        admittedRuns.push({
            ...fixtureRun,
            admission,
        });
    }
    await assertCorpusNativeBinariesFresh();
    const reports = [];
    const skipped = [];
    for (const {
        admission,
        expectations,
        fixture,
    } of admittedRuns) {
        if (admission.admissionStatus === 'skipped') {
            console.log(`\n[SKIP] ${fixture.id}: optional fixture is absent (${fixture.pdfPath})`);
            const skippedReport = {
                actualSha256: admission.actualSha256,
                admissionStatus: admission.admissionStatus,
                assertions: [],
                expectedSha256: admission.expectedSha256,
                fixtureId: fixture.id,
                fixturePath: fixture.pdfPath,
                sourceAdmission: {
                    actualSha256: admission.actualSha256,
                    expectedSha256: admission.expectedSha256,
                    reason: admission.reason,
                    status: admission.admissionStatus,
                },
            };
            await writeFile(
                join(workRoot, fixture.id, 'fixture-report.json'),
                `${JSON.stringify(skippedReport, null, 2)}\n`,
            );
            skipped.push(skippedReport);
            continue;
        }
        reports.push(await verifyFixture(fixture, expectations, workRoot, admission));
    }
    const assertionCount = reports.flatMap(report => report.assertions).length;
    const failed = reports.flatMap(report => report.assertions).filter(assertion => !assertion.passed);
    const corpusSummary = {
        assertionCount,
        failedAssertions: failed,
        fixtureCount: reports.length,
        fixtures: reports.map(report => ({
            actualModeDistribution: report.actualModeDistribution,
            assertionCount: report.assertions.length,
            failedAssertionCount: report.assertions.filter(assertion => !assertion.passed).length,
            fixtureId: report.fixtureId,
            fixturePath: report.fixturePath,
            actualSha256: report.actualSha256,
            admissionStatus: report.admissionStatus,
            expectedSha256: report.expectedSha256,
            outputBytes: report.outputBytes,
            outputPdfPath: report.outputPdfPath,
            pageCount: report.pageCount,
            pageEvidencePath: report.pageEvidencePath,
            artifactAuditSummaryPath: report.artifactAuditSummaryPath,
            timing: report.timing,
        })),
        generatedAt: new Date().toISOString(),
        fixtureAdmissions: admittedRuns.map(({
            admission,
            fixture,
        }) => ({
            actualSha256: admission.actualSha256,
            admissionReportPath: admission.admissionReportPath,
            admissionStatus: admission.admissionStatus,
            expectedSha256: admission.expectedSha256,
            fixtureId: fixture.id,
            fixturePath: fixture.pdfPath,
            reason: admission.reason,
        })),
        skippedFixtures: skipped.map(report => ({
            actualSha256: report.actualSha256,
            admissionStatus: report.admissionStatus,
            expectedSha256: report.expectedSha256,
            fixtureId: report.fixtureId,
            fixturePath: report.fixturePath,
        })),
        workRoot,
    };
    await writeFile(
        join(workRoot, 'corpus-summary.json'),
        `${JSON.stringify(corpusSummary, null, 2)}\n`,
    );
    console.log(
        `\nCorpus summary: ${reports.length} fixture(s),`
        + ` ${assertionCount} assertions, ${failed.length} failure(s)`,
    );
    console.log(`Artifacts: ${workRoot}`);
    if (failed.length > 0) {
        process.exitCode = 1;
    }
    if (!args.keepArtifacts && !args.workDir && failed.length === 0) {
        await rm(workRoot, {
            force: true,
            recursive: true,
        });
        console.log('Artifacts removed after passing run (use --keep-artifacts to retain them).');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main().catch(error => {
        console.error(`\n[FATAL] ${getCliErrorMessage(error)}`);
        process.exitCode = 1;
    });
}
