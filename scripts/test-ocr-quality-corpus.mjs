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
        entryPoints: [join(repositoryRoot, 'electron', 'ocr', 'worker', 'runProductionOcrQualityCase.ts')],
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

function isMissingExecutableError(error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function probeNativeOcrExecutables() {
    try {
        await execFileAsync(tesseract, ['--version'], {timeout: 10_000});
        await execFileAsync(pdftotext, ['-v'], {timeout: 10_000});
        return true;
    } catch (error) {
        if (isMissingExecutableError(error) && !required) {
            process.stdout.write('OCR quality corpus skipped: a required native OCR tool is unavailable\n');
            return false;
        }
        throw error;
    }
}

try {
    const nativeToolsAvailable = await probeNativeOcrExecutables();
    if (!nativeToolsAvailable) {
        // Optional local runs may skip only when the executable probe failed.
    } else {
        if (!GlobalFonts.registerFromPath(fontPath, 'EvbOcrCorpus')) {
            throw new Error(`Could not register OCR corpus font: ${fontPath}`);
        }
        const {runProductionOcrQualityCase} = await loadProductionRunner();
        const unpaperBinary = await resolveOptionalPreprocessor();
        const scanCleanupBinary = await resolveOptionalScanCleanup();
        if (required && !unpaperBinary && !scanCleanupBinary) {
            throw new Error('Required OCR quality coverage needs the scan-cleanup or unpaper preprocessor');
        }
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
            const missingTokens = testCase.criticalTokens.filter(token => (
                !retainsCriticalToken(result.text, token)
            || !retainsCriticalToken(searchablePdfText, token)
            ));
            process.stdout.write(
                `${testCase.id}: wrapper CER=${metrics.cer.toFixed(4)} WER=${metrics.wer.toFixed(4)}; searchable PDF CER=${pdfMetrics.cer.toFixed(4)} WER=${pdfMetrics.wer.toFixed(4)}; words=${result.wordCount}\n`,
            );
            if (metrics.cer > testCase.maxCer
            || metrics.wer > testCase.maxWer
            || pdfMetrics.cer > testCase.maxCer
            || pdfMetrics.wer > testCase.maxWer
            || result.wordCount === 0
            || missingTokens.length > 0) {
                failures.push({
                    id: testCase.id,
                    actual: metrics.normalizedActual,
                    cer: metrics.cer,
                    maxCer: testCase.maxCer,
                    pdfActual: pdfMetrics.normalizedActual,
                    pdfCer: pdfMetrics.cer,
                    pdfWer: pdfMetrics.wer,
                    wer: metrics.wer,
                    maxWer: testCase.maxWer,
                    missingTokens,
                });
            }
        }
        if (failures.length > 0) {
            throw new Error(`OCR quality regression:\n${JSON.stringify(failures, null, 2)}`);
        }
        if (required && !preprocessingCoverage.has('clean-applied')) {
            throw new Error('Required OCR quality coverage did not exercise successful clean preprocessing');
        }
        process.stdout.write(
            `Production coverage: runOcrFileBased profile/TSV parser/searchable PDF; preprocessing=${[...preprocessingCoverage].join(',')} (Poppler rasterization is covered by OCR worker integration tests)\n`,
        );
        process.stdout.write(`OCR quality corpus passed (${corpus.length} degraded multilingual cases)\n`);
    }
} finally {
    await rm(workDirectory, {
        recursive: true,
        force: true,
    });
}
