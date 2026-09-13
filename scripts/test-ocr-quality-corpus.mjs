import {execFile} from 'node:child_process';
import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {
    constants as fsConstants, existsSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
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
import {Worker} from 'node:worker_threads';
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
import {
    generateOcrLanguageQualityFixture,
    LANGUAGE_CODES,
    PAGE_DPI,
} from './ocrLanguageQualityFixtures.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDir);
const corpus = JSON.parse(await readFile(join(scriptDir, 'fixtures', 'ocr-quality-corpus.json'), 'utf8'));
const tesseract = process.env.EVB_TESSERACT_PATH ?? 'tesseract';
const pdftotext = process.env.EVB_PDFTOTEXT_PATH ?? 'pdftotext';
const pdftoppm = process.env.EVB_PDFTOPPM_PATH ?? 'pdftoppm';
const qpdf = process.env.EVB_QPDF_PATH ?? 'qpdf';
const unpaper = process.env.EVB_UNPAPER_PATH
    ?? join(repositoryRoot, 'resources', 'tesseract', 'linux-x64', 'bin', 'unpaper');
const required = process.env.EVB_OCR_QUALITY_REQUIRED === '1';
let tessdataDirectory = process.env.EVB_TESSDATA_PATH
    ?? join(repositoryRoot, 'resources', 'tesseract', 'tessdata');
const fontPath = join(repositoryRoot, 'public', 'pdf', 'standard_fonts', 'LiberationSans-Regular.ttf');
const workDirectory = await mkdtemp(join(tmpdir(), 'evb-ocr-quality-'));
const cleanManifestPath = join(repositoryRoot, 'scripts', 'fixtures', 'ocr-language-quality-manifest.json');

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

async function loadProductionWorker() {
    const bundlePath = join(workDirectory, 'ocr-quality-production-worker.mjs');
    await build({
        bundle: true,
        entryPoints: [join(repositoryRoot, 'electron', 'features', 'ocr', 'worker', 'main.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'node',
        target: 'node22',
        tsconfig: join(repositoryRoot, 'tsconfig.base.json'),
    });
    return bundlePath;
}

async function loadPdfjsTextExtractor() {
    const bundlePath = join(repositoryRoot, '.devkit', 'ocr-quality-pdfjs-extractor.mjs');
    await mkdir(join(repositoryRoot, '.devkit'), {recursive: true});
    await build({
        bundle: true,
        entryPoints: [join(repositoryRoot, 'electron', 'features', 'search', 'extractTextWithPdfjs.ts')],
        format: 'esm',
        outfile: bundlePath,
        platform: 'node',
        target: 'node22',
        tsconfig: join(repositoryRoot, 'tsconfig.base.json'),
    });
    return import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
}

async function runProductionOcrQualityDocument({
    workerBundlePath,
    sourcePdfPath,
    pages,
    tempDirectory,
    unpaperBinary,
    scanCleanupBinary,
}) {
    await mkdir(tempDirectory, {recursive: true});
    const worker = new Worker(pathToFileURL(workerBundlePath), {
        type: 'module',
        workerData: {
            tesseractBinary: tesseract,
            tessdataPath: tessdataDirectory,
            pdftoppmBinary: pdftoppm,
            pdftotextBinary: pdftotext,
            qpdfBinary: qpdf,
            tempDir: tempDirectory,
            ...(scanCleanupBinary ? {scanCleanupBinary} : {}),
            ...(unpaperBinary ? {unpaperBinary} : {}),
        },
    });
    const jobId = `ocr-quality-language-${Date.now()}`;
    const documentRevision = {
        version: 1,
        documentRef: sourcePdfPath,
        authority: 'electron-working-copy',
        token: 'ocr-quality-language-fixture-v1',
        contentRevision: 1,
        mintedAt: Date.UTC(2026, 8, 1),
    };
    const startMessage = {
        type: 'start',
        jobId,
        data: {
            sourcePdfPath,
            documentRevision,
            pages: pages.map(page => ({
                pageNumber: page.pageNumber,
                languages: [page.language],
            })),
            options: {
                renderDpi: PAGE_DPI,
                preprocessingMode: 'clean',
                qualityProfile: 'poor-scan',
                pageSegmentationMode: 6,
                supersessionPolicy: 'replace-all',
                replaceAllAcknowledged: true,
            },
        },
    };

    return new Promise((resolve, reject) => {
        let completeResult;
        let cleanupComplete = false;
        let settled = false;
        const finish = () => {
            if (!settled && completeResult && cleanupComplete) {
                settled = true;
                resolve(completeResult);
            }
        };
        worker.on('message', message => {
            if (message.type === 'resource-acquire') {
                worker.postMessage({
                    type: 'resource-acquired',
                    jobId: message.jobId,
                    requestId: message.requestId,
                    token: `ocr-quality-resource-${message.requestId}`,
                    effectiveDpi: message.requestedDpi,
                });
                return;
            }
            if (message.type === 'resource-release') return;
            if (message.type === 'native-child-intent'
                || message.type === 'native-child-register'
                || message.type === 'native-child-exit') {
                const ackType = `${message.type}-ack`;
                worker.postMessage({
                    type: ackType,
                    jobId: message.jobId,
                    childId: message.childId,
                    accepted: true,
                });
                return;
            }
            if (message.type === 'complete') {
                completeResult = message.result;
                finish();
                return;
            }
            if (message.type === 'cleanup-complete') {
                cleanupComplete = true;
                finish();
            }
        });
        worker.on('error', error => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
        worker.on('exit', code => {
            if (!settled && code !== 0) {
                settled = true;
                reject(new Error(`Production OCR worker exited with code ${code}`));
            }
        });
        worker.postMessage(startMessage);
    });
}

async function collectCatalogPageText(sourcePdfPath) {
    const catalogRoot = `${sourcePdfPath}.ocr`;
    const pageFiles = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                await visit(path);
            } else if (/\/pages\/\d+\/p\d+\.json$/u.test(path)) {
                pageFiles.push(path);
            }
        }
    }
    await visit(catalogRoot);
    const pages = new Map();
    for (const pageFile of pageFiles) {
        const match = /\/p(\d+)\.json$/u.exec(pageFile);
        if (!match) continue;
        const pageNumber = Number(match[1]);
        const artifact = JSON.parse(await readFile(pageFile, 'utf8'));
        pages.set(pageNumber, artifact.text ?? '');
    }
    return pages;
}

async function extractPdfjsPageText(pdfPath) {
    const {extractTextWithPdfjs} = await loadPdfjsTextExtractor();
    const pages = await extractTextWithPdfjs(pdfPath, {
        collectPages: true,
        forcePdfjs: true,
    });
    return pages.map(page => page.text);
}

async function extractPopplerPageText(pdfPath) {
    const {stdout} = await execFileAsync(pdftotext, [
        pdfPath,
        '-',
    ], {
        maxBuffer: 128 * 1024 * 1024,
        timeout: 30_000,
    });
    const pages = stdout.split('\f');
    if (pages.at(-1) === '') pages.pop();
    return pages;
}

function aggregateQuality(samples) {
    const result = {
        sampleCount: samples.length,
        faithful: {
            cerNumerator: 0,
            cerDenominator: 0,
            werNumerator: 0,
            werDenominator: 0,
        },
        compatibility: {
            cerNumerator: 0,
            cerDenominator: 0,
            werNumerator: 0,
            werDenominator: 0,
        },
    };
    for (const sample of samples) {
        const metrics = measureOcrQuality(sample.expected, sample.actual);
        for (const key of [
            'faithful',
            'compatibility',
        ]) {
            result[key].cerNumerator += metrics[key].cer * metrics[key].denominator.cer;
            result[key].cerDenominator += metrics[key].denominator.cer;
            result[key].werNumerator += metrics[key].wer * metrics[key].denominator.wer;
            result[key].werDenominator += metrics[key].denominator.wer;
        }
    }
    return Object.fromEntries([
        'faithful',
        'compatibility',
    ].map(key => [
        key,
        {
            cer: result[key].cerDenominator === 0 ? 0 : result[key].cerNumerator / result[key].cerDenominator,
            wer: result[key].werDenominator === 0 ? 0 : result[key].werNumerator / result[key].werDenominator,
            denominator: {
                cer: result[key].cerDenominator,
                wer: result[key].werDenominator,
            },
        },
    ]));
}

function scoreCleanLanguageSamples(manifest, rawPages, pdfjsPages, popplerPages) {
    const byLanguage = new Map(LANGUAGE_CODES.map(code => [
        code,
        {
            language: code,
            sampleCount: 0,
            invalidFixtureCount: 0,
            coverageGaps: [],
            rawOcr: [],
            pdfjsText: [],
            popplerText: [],
        },
    ]));
    for (const page of manifest.pages) {
        const language = byLanguage.get(page.language);
        if (!page.coverage.valid) {
            language.invalidFixtureCount += 1;
            language.coverageGaps.push({
                pageId: page.id,
                missingGlyphs: page.coverage.missingGlyphs,
            });
            continue;
        }
        language.sampleCount += 1;
        language.rawOcr.push({
            expected: page.text,
            actual: rawPages.get(page.pageNumber) ?? '',
        });
        language.pdfjsText.push({
            expected: page.text,
            actual: pdfjsPages[page.pageNumber - 1] ?? '',
        });
        language.popplerText.push({
            expected: page.text,
            actual: popplerPages[page.pageNumber - 1] ?? '',
        });
    }
    return [...byLanguage.values()].map(language => {
        const scores = {
            rawOcr: aggregateQuality(language.rawOcr),
            pdfjsText: aggregateQuality(language.pdfjsText),
            popplerText: aggregateQuality(language.popplerText),
        };
        const recognitionDefects = [
            'rawOcr',
            'pdfjsText',
            'popplerText',
        ].filter(extractor => (
            language[extractor].length > 0
            && (scores[extractor].faithful.cer > 0 || scores[extractor].faithful.wer > 0)
        ));
        return {
            language: language.language,
            sampleCount: language.sampleCount,
            invalidFixtureCount: language.invalidFixtureCount,
            coverageGaps: language.coverageGaps,
            scores,
            recognitionDefects,
            failures: recognitionDefects.map(extractor => `${extractor} faithful score is non-zero`),
        };
    });
}

async function prepareBenchmarkTessdata() {
    const sourceDirectory = tessdataDirectory;
    const stagedDirectory = join(workDirectory, 'tessdata');
    await mkdir(stagedDirectory, {recursive: true});
    for (const language of LANGUAGE_CODES) {
        await symlink(
            join(sourceDirectory, `${language}.traineddata`),
            join(stagedDirectory, `${language}.traineddata`),
        );
    }
    const pdfFontSource = [
        join(sourceDirectory, 'pdf.ttf'),
        '/usr/share/tesseract-ocr/5/tessdata/pdf.ttf',
    ].find(path => {
        return existsSync(path);
    });
    if (!pdfFontSource) {
        throw new Error('Tesseract PDF output font pdf.ttf is unavailable');
    }
    await symlink(pdfFontSource, join(stagedDirectory, 'pdf.ttf'));

    const sublanguagePath = join(sourceDirectory, 'srp_latn.traineddata');
    try {
        await access(sublanguagePath, fsConstants.R_OK);
        await symlink(sublanguagePath, join(stagedDirectory, 'srp_latn.traineddata'));
    } catch {
        const url = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/e12c65a915945e4c28e237a9b52bc4a8f39a0cec/srp_latn.traineddata';
        const expectedHash = '9bc6caa2ad9daf1706bf4c21741992dd5a334e9ff64cfc1ecd32aa43dd7a150c';
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Pinned srp_latn model download failed: HTTP ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const actualHash = createHash('sha256').update(bytes).digest('hex');
        if (actualHash !== expectedHash) {
            throw new Error(`Pinned srp_latn model hash mismatch: ${actualHash}`);
        }
        await writeFile(join(stagedDirectory, 'srp_latn.traineddata'), bytes);
    }
    tessdataDirectory = stagedDirectory;
}

async function runCleanLanguageBenchmark({
    unpaperBinary, scanCleanupBinary,
}) {
    await prepareBenchmarkTessdata();
    const fixtureDirectory = join(workDirectory, 'ocr-language-quality');
    const fixture = await generateOcrLanguageQualityFixture({
        repositoryRoot,
        outputDirectory: fixtureDirectory,
        manifestPath: cleanManifestPath,
    });
    const workerTempDirectory = join(fixtureDirectory, 'worker-tmp');
    await mkdir(workerTempDirectory, {recursive: true});
    const sourcePdfPath = join(workerTempDirectory, 'source.pdf');
    await copyFile(fixture.pdfPath, sourcePdfPath);
    const sourceText = await execFileAsync(pdftotext, [
        sourcePdfPath,
        '-',
    ], {timeout: 30_000});
    if (sourceText.stdout.replace(/\f/gu, '').trim() !== '') {
        throw new Error('MLOCR-02 source PDF contains extractable text');
    }
    const workerBundlePath = await loadProductionWorker();
    const workerResult = await runProductionOcrQualityDocument({
        workerBundlePath,
        sourcePdfPath,
        pages: fixture.manifest.pages,
        tempDirectory: workerTempDirectory,
        unpaperBinary,
        scanCleanupBinary,
    });
    if (!workerResult.success) {
        throw new Error(`MLOCR-02 production PDF OCR failed: ${workerResult.errors.join('; ')}`);
    }
    const rawPages = await collectCatalogPageText(sourcePdfPath);
    const pdfjsPages = await extractPdfjsPageText(workerResult.pdfPath);
    const popplerPages = await extractPopplerPageText(workerResult.pdfPath);
    const languages = scoreCleanLanguageSamples(fixture.manifest, rawPages, pdfjsPages, popplerPages);
    const report = {
        status: 'complete',
        fixture: {
            languageCount: languages.length,
            pageCount: fixture.manifest.pages.length,
            pdfSha256: fixture.manifest.artifact.pdfSha256,
            outputPdfSha256: workerResult.resultSha256,
            sourceTextEmpty: true,
            physicalPage: fixture.manifest.physicalPage,
            pageOrder: fixture.manifest.pages.map(page => page.id),
            rasterSha256ByPage: Object.fromEntries(fixture.manifest.pages.map(page => [
                page.id,
                page.imageSha256,
            ])),
            fontSha256ById: Object.fromEntries(Object.entries(fixture.manifest.fonts).map(([
                id,
                font,
            ]) => [
                id,
                font.sha256,
            ])),
            extractorPageCounts: {
                rawOcr: rawPages.size,
                pdfjsText: pdfjsPages.length,
                popplerText: popplerPages.length,
            },
        },
        languages,
    };
    process.stdout.write(`MLOCR-02 clean raster report: ${JSON.stringify(report)}\n`);
    return report;
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
        ?? join(repositoryRoot, 'native', 'target', 'release', 'evb-scan-cleanup');
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
        const requested = [...new Set([
            ...LANGUAGE_CODES,
            ...corpus.flatMap(testCase => testCase.language.split('+')),
        ])];
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
                await runCleanLanguageBenchmark({
                    unpaperBinary,
                    scanCleanupBinary,
                });
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
                        `Production coverage: runOcrFileBased profile/TSV parser/searchable PDF; preprocessing=${[...preprocessingCoverage].join(',')} (legacy image-only diagnostic; Poppler rasterization is covered by OCR worker integration tests)\n`,
                    );
                    process.stdout.write(`Legacy image-only diagnostic passed (${corpus.length} degraded multilingual cases)\n`);
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
