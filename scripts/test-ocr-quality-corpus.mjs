import {execFile} from 'node:child_process';
import {
    access,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {
    fileURLToPath,
    pathToFileURL,
} from 'node:url';
import {promisify} from 'node:util';
import {
    createCanvas,
    GlobalFonts,
} from '@napi-rs/canvas';
import {build} from 'esbuild';
import {
    measureOcrQuality,
    retainsFaithfulCriticalToken,
    retainsCriticalToken,
} from './ocrQualityMetrics.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDir);
const corpus = JSON.parse(await readFile(join(scriptDir, 'fixtures', 'ocr-quality-corpus.json'), 'utf8'));
const tesseract = process.env.EVB_TESSERACT_PATH ?? 'tesseract';
const pdftotext = process.env.EVB_PDFTOTEXT_PATH ?? 'pdftotext';
const unpaper = process.env.EVB_UNPAPER_PATH ?? 'unpaper';
const required = process.env.EVB_OCR_QUALITY_REQUIRED === '1';
const tessdataDirectory = process.env.EVB_TESSDATA_PATH
    ?? join(repositoryRoot, 'resources', 'tesseract', 'tessdata');
const fontPath = join(repositoryRoot, 'public', 'pdf', 'standard_fonts', 'LiberationSans-Regular.ttf');
const workDirectory = await mkdtemp(join(tmpdir(), 'evb-ocr-quality-'));

function deterministicNoise(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

function renderCorpusImage(testCase, index) {
    const width = 1_440;
    const height = 480;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    const {profile} = testCase;
    context.fillStyle = `rgb(${profile.background}, ${profile.background - 2}, ${profile.background - 5})`;
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(profile.rotationDegrees * Math.PI / 180);
    context.translate(-width / 2, -height / 2);
    context.fillStyle = `rgb(${profile.foreground}, ${profile.foreground}, ${profile.foreground})`;
    context.font = '50px EvbOcrCorpus';
    context.textBaseline = 'alphabetic';
    testCase.lines.forEach((line, lineIndex) => {
        context.fillText(line, 94, 130 + lineIndex * 112);
    });
    context.restore();

    const image = context.getImageData(0, 0, width, height);
    const random = deterministicNoise(0x45564200 + index);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
        const offset = pixel * 4;
        const noise = Math.round((random() - 0.5) * profile.noiseAmplitude * 2);
        const row = Math.floor(pixel / width);
        const scanLine = row % profile.scanLineEvery === 0 ? -10 : 0;
        const speckle = pixel % profile.speckleEvery === 0 ? -55 : 0;
        for (let channel = 0; channel < 3; channel += 1) {
            image.data[offset + channel] = Math.max(
                0,
                Math.min(255, image.data[offset + channel] + noise + scanLine + speckle),
            );
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.encode('png');
}

async function loadProductionRunner() {
    const bundlePath = join(workDirectory, 'ocr-quality-production-runner.mjs');
    await build({
        bundle: true,
        entryPoints: [join(repositoryRoot, 'electron', 'features', 'ocr', 'worker', 'runProductionOcrQualityCase.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'node',
        target: 'node22',
        tsconfig: join(repositoryRoot, 'tsconfig.base.json'),
    });
    return import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
}

async function resolveOptionalPreprocessor() {
    try {
        await execFileAsync(unpaper, ['--version'], {timeout: 10_000});
        return unpaper;
    } catch {
        return undefined;
    }
}

async function resolveOptionalScanCleanup() {
    const candidate = process.env.EVB_SCAN_CLEANUP_PATH
        ?? join(repositoryRoot, 'native', 'target', 'debug', 'evb-scan-cleanup');
    try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
    } catch {
        return undefined;
    }
}

function describeProbeError(error) {
    if (error instanceof Error) return error.message;
    return String(error);
}

async function probeNativeOcrExecutables() {
    const probes = [
        [
            'tesseract',
            tesseract,
            ['--version'],
        ],
        [
            'pdftotext',
            pdftotext,
            ['-v'],
        ],
    ];
    const missing = [];
    for (const [
        name,
        binary,
        args,
    ] of probes) {
        try {
            await execFileAsync(binary, args, {timeout: 10_000});
        } catch (error) {
            missing.push(`${name} (${binary}): ${describeProbeError(error)}`);
        }
    }
    return missing;
}

async function probeTesseractModels() {
    try {
        const {stdout} = await execFileAsync(tesseract, [
            '--list-langs',
            '--tessdata-dir',
            tessdataDirectory,
        ], {timeout: 10_000});
        const available = new Set(stdout
            .split(/\r?\n/gu)
            .map(value => value.trim())
            .filter(value => value && !value.startsWith('List of available languages')));
        const requested = [...new Set(corpus.flatMap(testCase => testCase.language.split('+')))];
        const missing = requested
            .filter(language => !available.has(language))
            .map(language => `model ${language} is not available in ${tessdataDirectory}`);
        return missing;
    } catch (error) {
        return [`Tesseract models could not be listed from ${tessdataDirectory}: ${describeProbeError(error)}`];
    }
}

function reportIncomplete(reasons) {
    process.stdout.write(`OCR quality corpus incomplete: ${JSON.stringify({
        status: 'incomplete',
        reasons,
    })}\n`);
    process.exitCode = 2;
}

try {
    const missingTools = await probeNativeOcrExecutables();
    if (missingTools.length > 0) {
        reportIncomplete(missingTools);
    } else {
        const missingModels = await probeTesseractModels();
        if (missingModels.length > 0) {
            reportIncomplete(missingModels);
        } else if (!GlobalFonts.registerFromPath(fontPath, 'EvbOcrCorpus')) {
            reportIncomplete([`OCR corpus font could not be registered: ${fontPath}`]);
        } else {
            const {runProductionOcrQualityCase} = await loadProductionRunner();
            const unpaperBinary = await resolveOptionalPreprocessor();
            const scanCleanupBinary = await resolveOptionalScanCleanup();
            if (required && !unpaperBinary && !scanCleanupBinary) {
                reportIncomplete(['required clean preprocessing tool is unavailable']);
            } else {
                const failures = [];
                const preprocessingCoverage = new Set();
                for (const [
                    index,
                    testCase,
                ] of corpus.entries()) {
                    const imagePath = join(workDirectory, `${testCase.id}.png`);
                    await writeFile(imagePath, await renderCorpusImage(testCase, index));
                    const caseDirectory = join(workDirectory, testCase.id);
                    const result = await runProductionOcrQualityCase({
                        dpi: 300,
                        inputPath: imagePath,
                        language: testCase.language,
                        outputDirectory: caseDirectory,
                        tessdataDirectory,
                        tesseractBinary: tesseract,
                        ...(scanCleanupBinary ? {scanCleanupBinary} : {}),
                        ...(unpaperBinary ? {unpaperBinary} : {}),
                    });
                    preprocessingCoverage.add(result.preprocessing);
                    const {stdout: searchablePdfText} = await execFileAsync(pdftotext, [
                        result.pdfPath,
                        '-',
                    ], {timeout: 30_000});
                    const expected = testCase.lines.join('\n');
                    const metrics = measureOcrQuality(expected, result.text);
                    const pdfMetrics = measureOcrQuality(expected, searchablePdfText);
                    const faithfulMissingTokens = testCase.criticalTokens.filter(token => (
                        !retainsFaithfulCriticalToken(result.text, token)
                || !retainsFaithfulCriticalToken(searchablePdfText, token)
                    ));
                    const compatibilityMissingTokens = testCase.criticalTokens.filter(token => (
                        !retainsCriticalToken(result.text, token)
                || !retainsCriticalToken(searchablePdfText, token)
                    ));
                    process.stdout.write(
                        `${testCase.id}: faithful CER=${metrics.faithful.cer.toFixed(4)} / ${metrics.faithful.denominator.cer} Unicode scalars, WER=${metrics.faithful.wer.toFixed(4)} / ${metrics.faithful.denominator.wer} tokens (NFC, ${metrics.faithful.tokenizer}); compatibility CER=${metrics.compatibility.cer.toFixed(4)} / ${metrics.compatibility.denominator.cer} Unicode scalars, WER=${metrics.compatibility.wer.toFixed(4)} / ${metrics.compatibility.denominator.wer} tokens (${metrics.compatibility.normalization}, ${metrics.compatibility.tokenizer}); searchable PDF faithful CER=${pdfMetrics.faithful.cer.toFixed(4)} / ${pdfMetrics.faithful.denominator.cer} Unicode scalars, WER=${pdfMetrics.faithful.wer.toFixed(4)} / ${pdfMetrics.faithful.denominator.wer} tokens (NFC, ${pdfMetrics.faithful.tokenizer}); searchable PDF compatibility CER=${pdfMetrics.compatibility.cer.toFixed(4)} / ${pdfMetrics.compatibility.denominator.cer} Unicode scalars, WER=${pdfMetrics.compatibility.wer.toFixed(4)} / ${pdfMetrics.compatibility.denominator.wer} tokens (${pdfMetrics.compatibility.normalization}, ${pdfMetrics.compatibility.tokenizer}); words=${result.wordCount}; empty reference=${metrics.faithful.referenceEmpty}\n`,
                    );
                    if (metrics.faithful.cer > testCase.maxCer
                || metrics.faithful.wer > testCase.maxWer
                || pdfMetrics.faithful.cer > testCase.maxCer
                || pdfMetrics.faithful.wer > testCase.maxWer
                || result.wordCount === 0
                || faithfulMissingTokens.length > 0) {
                        failures.push({
                            id: testCase.id,
                            faithfulActual: metrics.faithful.normalizedActual,
                            faithfulCer: metrics.faithful.cer,
                            faithfulWer: metrics.faithful.wer,
                            faithfulCerDenominator: metrics.faithful.denominator.cer,
                            faithfulWerDenominator: metrics.faithful.denominator.wer,
                            compatibilityActual: metrics.compatibility.normalizedActual,
                            compatibilityCer: metrics.compatibility.cer,
                            compatibilityWer: metrics.compatibility.wer,
                            pdfFaithfulActual: pdfMetrics.faithful.normalizedActual,
                            pdfFaithfulCer: pdfMetrics.faithful.cer,
                            pdfFaithfulWer: pdfMetrics.faithful.wer,
                            pdfCompatibilityActual: pdfMetrics.compatibility.normalizedActual,
                            pdfCompatibilityCer: pdfMetrics.compatibility.cer,
                            pdfCompatibilityWer: pdfMetrics.compatibility.wer,
                            maxCer: testCase.maxCer,
                            maxWer: testCase.maxWer,
                            faithfulMissingTokens,
                            compatibilityMissingTokens,
                        });
                    }
                }
                if (failures.length > 0) {
                    throw new Error(`OCR quality regression:\n${JSON.stringify(failures, null, 2)}`);
                }
                if (required && !preprocessingCoverage.has('clean-applied')) {
                    reportIncomplete(['required OCR quality coverage did not exercise successful clean preprocessing']);
                } else {
                    process.stdout.write(
                        `Production coverage: runOcrFileBased profile/TSV parser/searchable PDF; preprocessing=${[...preprocessingCoverage].join(',')} (Poppler rasterization is covered by OCR worker integration tests)\n`,
                    );
                    process.stdout.write(`OCR quality corpus passed (${corpus.length} degraded multilingual cases)\n`);
                }
            }
        }
    }
} finally {
    await rm(workDirectory, {
        recursive: true,
        force: true,
    });
}
