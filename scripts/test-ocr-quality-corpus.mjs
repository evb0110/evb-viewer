import {execFile} from 'node:child_process';
import {
    access,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    constants as fsConstants, existsSync,
} from 'node:fs';
import {createHash} from 'node:crypto';
import {
    basename,
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
    measureUnicodeMarks,
    retainsFaithfulCriticalToken,
    retainsCriticalToken,
} from './ocrQualityMetrics.mjs';
import {
    DEGRADATION_PROFILES,
    generateOcrLanguageQualityFixture,
    LANGUAGE_CODES,
    PAGE_DPI,
    transformPageGeometry,
    realizeOcrQualityProfile,
} from './ocrLanguageQualityFixtures.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDir);
const corpus = JSON.parse(await readFile(join(scriptDir, 'fixtures', 'ocr-quality-corpus.json'), 'utf8'));
const platformArch = `${process.platform}-${process.arch}`;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
function bundledExecutable(family, name) {
    return join(repositoryRoot, 'resources', family, platformArch, 'bin', `${name}${executableSuffix}`);
}
const tesseract = process.env.EVB_TESSERACT_PATH ?? bundledExecutable('tesseract', 'tesseract');
const pdftotext = process.env.EVB_PDFTOTEXT_PATH ?? bundledExecutable('poppler', 'pdftotext');
const pdftoppm = process.env.EVB_PDFTOPPM_PATH ?? bundledExecutable('poppler', 'pdftoppm');
const qpdf = process.env.EVB_QPDF_PATH ?? bundledExecutable('qpdf', 'qpdf');
const pdfPageOps = process.env.EVB_PDF_PAGE_OPS_PATH
    ?? join(
        repositoryRoot,
        'native',
        'target',
        'release',
        process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops',
    );
const required = process.env.EVB_OCR_QUALITY_REQUIRED === '1';
const degradedOptIn = required || process.env.EVB_OCR_QUALITY_DEGRADED === '1';
const tessdataDirectory = process.env.EVB_TESSDATA_PATH
    ?? join(repositoryRoot, 'resources', 'tesseract', 'tessdata');
const fontPath = join(repositoryRoot, 'public', 'pdf', 'standard_fonts', 'LiberationSans-Regular.ttf');
const scratchRoot = join(repositoryRoot, '.devkit', 'tmp');
await mkdir(scratchRoot, {recursive: true});
const workDirectory = await mkdtemp(join(scratchRoot, 'evb-ocr-quality-'));
// MLOCR-02/03 measure what users get: the popup defaults, or its Poor scan
// profile when EVB_OCR_QUALITY_OPTIONS=poor-scan. Both come from the shared
// contract once the production runner bundle loads.
const recognitionPreset = process.env.EVB_OCR_QUALITY_OPTIONS ?? 'defaults';
let recognitionOptions;

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
        stdin: {
            contents: `
                export {runProductionOcrQualityCase} from './electron/features/ocr/pipeline/runProductionOcrQualityCase.ts';
                export {shouldNormalizeGreekMicroSign} from './electron/features/ocr/pipeline/tesseractRunner.ts';
                export {DEFAULT_OCR_RECOGNITION_OPTIONS, POOR_SCAN_OCR_RECOGNITION_OPTIONS} from './packages/contracts/electronApiOcr.ts';
            `,
            resolveDir: repositoryRoot,
            sourcefile: 'ocr-quality-production-runner.ts',
        },
        format: 'esm',
        outfile: bundlePath,
        platform: 'node',
        target: 'node22',
        tsconfig: join(repositoryRoot, 'tsconfig.base.json'),
    });
    return import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
}

async function loadProductionPipeline() {
    const bundlePath = join(workDirectory, 'ocr-quality-production-pipeline.mjs');
    await build({
        bundle: true,
        stdin: {
            contents: `
                export {runOcrJob} from './electron/features/ocr/pipeline/runOcrJob.ts';
                export {configureMainJobBroker} from './electron/resources/jobBroker.ts';
                export {initializeHostResourceProfile} from './electron/resources/hostResourceProfile.ts';
            `,
            resolveDir: repositoryRoot,
            sourcefile: 'ocr-quality-production-pipeline.ts',
        },
        format: 'esm',
        outfile: bundlePath,
        platform: 'node',
        target: 'node22',
        tsconfig: join(repositoryRoot, 'tsconfig.base.json'),
    });
    const pipeline = await import(`${pathToFileURL(bundlePath).href}?run=${Date.now()}`);
    // The app configures these at startup; OCR page leases need them.
    pipeline.configureMainJobBroker(pipeline.initializeHostResourceProfile({
        app: {getGPUFeatureStatus: () => ({})},
        performanceMode: 'auto',
    }));
    return pipeline;
}

/**
 * The production writer on Tesseract's own page: it removes the page's hidden
 * text and writes the repaired searchable layer in its place.
 */
async function writeSinglePageTextLayer(pdfPageOpsBinary, tesseractPdfPath, directory, normalizeGreekMicroSign) {
    const outputPath = join(directory, 'searchable.pdf');
    const instructionsPath = join(directory, 'text-layer.json');
    await writeFile(instructionsPath, JSON.stringify({pages: [{
        pageNumber: 1,
        sourcePath: tesseractPdfPath,
        normalizeGreekMicroSign,
    }]}));
    await execFileAsync(pdfPageOpsBinary, [
        'ocr-text-layer',
        '--input',
        tesseractPdfPath,
        '--output',
        outputPath,
        '--instructions-file',
        instructionsPath,
    ], {timeout: 30_000});
    return outputPath;
}

async function loadPdfjsTextExtractor() {
    const bundlePath = join(workDirectory, 'ocr-quality-pdfjs-extractor.mjs');
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

let pdfjsTextExtractor;

async function runProductionOcrQualityDocument({
    pipeline,
    sourcePdfPath,
    pages,
    tempDirectory,
    scanCleanupBinary,
    pdfPageOpsBinary,
}) {
    await mkdir(tempDirectory, {recursive: true});
    return pipeline.runOcrJob({
        jobId: `ocr-quality-language-${Date.now()}`,
        sourcePdfPath,
        documentRevision: {
            version: 1,
            documentRef: sourcePdfPath,
            authority: 'electron-working-copy',
            token: 'ocr-quality-language-fixture-v1',
            contentRevision: 1,
            mintedAt: Date.UTC(2026, 8, 1),
        },
        pages: pages.map(page => ({
            pageNumber: page.pageNumber,
            languages: [page.language],
        })),
        options: {
            renderDpi: PAGE_DPI,
            ...recognitionOptions,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
        },
        paths: {
            tesseractBinary: tesseract,
            tessdataPath: tessdataDirectory,
            pdftoppmBinary: pdftoppm,
            pdftotextBinary: pdftotext,
            qpdfBinary: qpdf,
            tempDir: tempDirectory,
            ...(scanCleanupBinary ? {scanCleanupBinary} : {}),
            ...(pdfPageOpsBinary ? {pdfPageOpsBinary} : {}),
        },
        signal: new AbortController().signal,
        publish: () => undefined,
        log: () => undefined,
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
            } else if (/[\\/]pages[\\/]\d+[\\/]p\d+\.json$/u.test(path)) {
                pageFiles.push(path);
            }
        }
    }
    await visit(catalogRoot);
    const pages = new Map();
    for (const pageFile of pageFiles) {
        const match = /^p(\d+)\.json$/u.exec(basename(pageFile));
        if (!match) continue;
        const pageNumber = Number(match[1]);
        const artifact = JSON.parse(await readFile(pageFile, 'utf8'));
        pages.set(pageNumber, artifact.text ?? '');
    }
    return pages;
}

async function extractPdfjsPageText(pdfPath) {
    pdfjsTextExtractor ??= await loadPdfjsTextExtractor();
    const pages = await pdfjsTextExtractor.extractTextWithPdfjs(pdfPath, {
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
        marks: {
            expected: 0,
            actual: 0,
            missing: 0,
            extra: 0,
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
        const marks = measureUnicodeMarks(sample.expected, sample.actual);
        result.marks.expected += marks.expected;
        result.marks.actual += marks.actual;
        result.marks.missing += marks.missing;
        result.marks.extra += marks.extra;
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
    ]).concat([[
        'marks',
        {
            ...result.marks,
            retainedRatio: result.marks.expected === 0
                ? (result.marks.actual === 0 ? 1 : 0)
                : Math.min(result.marks.expected, result.marks.actual) / result.marks.expected,
        },
    ]]));
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
        if (page.kind !== 'language') continue;
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

async function directoryBytes(directory) {
    let total = 0;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            total += await directoryBytes(path);
        } else {
            total += (await stat(path)).size;
        }
    }
    return total;
}

function polygonIntersectionOverUnion(first, second) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const firstArea = first.width * first.height;
    const secondArea = second.width * second.height;
    return intersection / Math.max(1, firstArea + secondArea - intersection);
}

function tokenOverlap(first, second) {
    const firstTokens = new Set(first.toLocaleLowerCase('und').match(/[\p{L}\p{M}\p{N}]+/gu) ?? []);
    const secondTokens = new Set(second.toLocaleLowerCase('und').match(/[\p{L}\p{M}\p{N}]+/gu) ?? []);
    if (firstTokens.size === 0 || secondTokens.size === 0) return 0;
    let intersection = 0;
    for (const token of firstTokens) {
        if (secondTokens.has(token)) intersection += 1;
    }
    return intersection / Math.max(firstTokens.size, secondTokens.size);
}

function referenceLines(page) {
    return page.blocks.flatMap(block => block.lines.map(line => ({
        ...line,
        blockId: block.id,
        language: block.language,
        role: block.role,
    })));
}

function emittedRegions(words) {
    const regions = [];
    for (const word of words) {
        const polygon = {
            x: word.x,
            y: word.y,
            width: word.width,
            height: word.height,
        };
        const centerY = polygon.y + polygon.height / 2;
        const previous = regions.at(-1);
        if (!previous || Math.abs(centerY - previous.centerY) > Math.max(polygon.height, previous.polygon.height) * 0.75) {
            regions.push({
                text: word.text,
                polygon,
                centerY,
                words: [word],
            });
            continue;
        }
        previous.text = `${previous.text} ${word.text}`;
        previous.words.push(word);
        const right = Math.max(previous.polygon.x + previous.polygon.width, polygon.x + polygon.width);
        const bottom = Math.max(previous.polygon.y + previous.polygon.height, polygon.y + polygon.height);
        previous.polygon = {
            x: Math.min(previous.polygon.x, polygon.x),
            y: Math.min(previous.polygon.y, polygon.y),
            width: right - Math.min(previous.polygon.x, polygon.x),
            height: bottom - Math.min(previous.polygon.y, polygon.y),
        };
        previous.centerY = previous.polygon.y + previous.polygon.height / 2;
    }
    return regions;
}

function evaluatePageOutput(page, result, pdfjsText, searchablePdfText, transformedPage) {
    const expected = page.text ?? '';
    const raw = measureOcrQuality(expected, result.text);
    const pdfjs = measureOcrQuality(expected, pdfjsText);
    const searchablePdf = measureOcrQuality(expected, searchablePdfText);
    const marks = measureUnicodeMarks(expected, result.text);
    const expectedLines = referenceLines(transformedPage);
    const predictedRegions = emittedRegions(result.words ?? []);
    const usedReferences = new Set();
    const matches = [];
    for (const predicted of predictedRegions) {
        let best = null;
        expectedLines.forEach((reference, index) => {
            if (usedReferences.has(index)) return;
            const geometry = polygonIntersectionOverUnion(predicted.polygon, reference.polygon);
            const text = tokenOverlap(predicted.text, reference.text);
            const score = geometry * 0.65 + text * 0.35;
            if (!best || score > best.score) best = {
                index,
                geometry,
                text,
                score,
            };
        });
        if (best && (best.geometry >= 0.05 || best.text >= 0.25)) {
            usedReferences.add(best.index);
            matches.push({
                predicted,
                referenceIndex: best.index,
                geometry: best.geometry,
            });
        }
    }
    const unmatchedReferenceRegions = expectedLines.length - matches.length;
    const extraPredictedRegions = predictedRegions.length - matches.length;
    const orderIndexes = matches.map(match => match.referenceIndex);
    let orderFailureCount = 0;
    if (!page.readingOrderAmbiguous) {
        for (let left = 0; left < orderIndexes.length; left += 1) {
            for (let right = left + 1; right < orderIndexes.length; right += 1) {
                if (orderIndexes[left] > orderIndexes[right]) orderFailureCount += 1;
            }
        }
    }
    const actualLines = result.text.split(/\r?\n/gu).map(line => line.trim()).filter(Boolean);
    const availableExpectedLines = expectedLines.map(line => line.text);
    const usedActualLines = new Set();
    let missingLineCount = 0;
    for (const expectedLine of availableExpectedLines) {
        let bestIndex = -1;
        let bestScore = 0;
        actualLines.forEach((actualLine, index) => {
            if (usedActualLines.has(index)) return;
            const score = tokenOverlap(expectedLine, actualLine);
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
            }
        });
        if (bestIndex >= 0 && bestScore >= 0.25) usedActualLines.add(bestIndex);
        else missingLineCount += 1;
    }
    let duplicateLineCount = 0;
    for (const [
        index,
        actualLine,
    ] of actualLines.entries()) {
        if (usedActualLines.has(index)) continue;
        if (availableExpectedLines.some(expectedLine => tokenOverlap(expectedLine, actualLine) >= 0.25)) {
            duplicateLineCount += 1;
        }
    }
    const criticalTokens = page.criticalTokens ?? [];
    const missingCriticalTokens = criticalTokens.filter(token => (
        !retainsFaithfulCriticalToken(result.text, token)
        || !retainsFaithfulCriticalToken(pdfjsText, token)
        || !retainsFaithfulCriticalToken(searchablePdfText, token)
    ));
    return {
        rawOcr: raw,
        pdfjsText: pdfjs,
        searchablePdf,
        marks,
        criticalTokenCount: criticalTokens.length,
        missingCriticalTokens,
        missingLineCount,
        duplicateLineCount,
        geometry: {
            referenceRegionCount: expectedLines.length,
            predictedRegionCount: predictedRegions.length,
            matchedRegionCount: matches.length,
            unmatchedReferenceRegions,
            extraPredictedRegions,
            meanIntersectionOverUnion: matches.length === 0
                ? (expectedLines.length === 0 ? 1 : 0)
                : matches.reduce((sum, match) => sum + match.geometry, 0) / matches.length,
        },
        order: {
            ambiguous: page.readingOrderAmbiguous,
            excludedFromAcceptance: page.readingOrderAmbiguous,
            failureCount: orderFailureCount,
            emittedRegionOrder: orderIndexes,
        },
    };
}

function summarizeDegradedEntries(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const key = `${entry.profileId}|${entry.severity}|${entry.language}`;
        const group = groups.get(key) ?? {
            profileId: entry.profileId,
            severity: entry.severity,
            language: entry.language,
            entries: [],
        };
        group.entries.push(entry);
        groups.set(key, group);
    }
    return [...groups.values()].map(group => {
        const rawEntries = group.entries.map(entry => ({
            expected: entry.expected,
            actual: entry.rawActual,
        }));
        const pdfEntries = group.entries.map(entry => ({
            expected: entry.expected,
            actual: entry.pdfActual,
        }));
        const pdfjsEntries = group.entries.map(entry => ({
            expected: entry.expected,
            actual: entry.pdfjsActual,
        }));
        const rawCharacterWeighted = aggregateQuality(rawEntries);
        const pdfjsCharacterWeighted = aggregateQuality(pdfjsEntries);
        const pdfCharacterWeighted = aggregateQuality(pdfEntries);
        const rawMacro = {
            cer: group.entries.reduce((sum, entry) => sum + entry.evaluation.rawOcr.faithful.cer, 0) / group.entries.length,
            wer: group.entries.reduce((sum, entry) => sum + entry.evaluation.rawOcr.faithful.wer, 0) / group.entries.length,
        };
        const pdfMacro = {
            cer: group.entries.reduce((sum, entry) => sum + entry.evaluation.searchablePdf.faithful.cer, 0) / group.entries.length,
            wer: group.entries.reduce((sum, entry) => sum + entry.evaluation.searchablePdf.faithful.wer, 0) / group.entries.length,
        };
        const pdfjsMacro = {
            cer: group.entries.reduce((sum, entry) => sum + entry.evaluation.pdfjsText.faithful.cer, 0) / group.entries.length,
            wer: group.entries.reduce((sum, entry) => sum + entry.evaluation.pdfjsText.faithful.wer, 0) / group.entries.length,
        };
        return {
            profileId: group.profileId,
            severity: group.severity,
            language: group.language,
            sampleCount: group.entries.length,
            acceptanceEligible: group.entries.every(entry => entry.acceptanceEligible),
            purpose: group.entries[0].purpose,
            rawOcr: {
                macro: rawMacro,
                characterWeighted: rawCharacterWeighted,
            },
            pdfjsText: {
                macro: pdfjsMacro,
                characterWeighted: pdfjsCharacterWeighted,
            },
            searchablePdf: {
                macro: pdfMacro,
                characterWeighted: pdfCharacterWeighted,
            },
            marks: group.entries.reduce((summary, entry) => {
                summary.expected += entry.evaluation.marks.expected;
                summary.actual += entry.evaluation.marks.actual;
                summary.missing += entry.evaluation.marks.missing;
                summary.extra += entry.evaluation.marks.extra;
                return summary;
            }, {
                expected: 0,
                actual: 0,
                missing: 0,
                extra: 0,
            }),
            criticalTokens: {
                expected: group.entries.reduce((sum, entry) => sum + entry.evaluation.criticalTokenCount, 0),
                missing: group.entries.reduce((sum, entry) => sum + entry.evaluation.missingCriticalTokens.length, 0),
            },
            criticalNumbers: {
                expected: group.entries.reduce((sum, entry) => sum + entry.evaluation.criticalTokenCount, 0),
                missing: group.entries.reduce((sum, entry) => sum + entry.evaluation.missingCriticalTokens.length, 0),
            },
            completeness: {
                missingLines: group.entries.reduce((sum, entry) => sum + entry.evaluation.missingLineCount, 0),
                duplicateLines: group.entries.reduce((sum, entry) => sum + entry.evaluation.duplicateLineCount, 0),
                unmatchedReferenceRegions: group.entries.reduce((sum, entry) => sum + entry.evaluation.geometry.unmatchedReferenceRegions, 0),
                extraPredictedRegions: group.entries.reduce((sum, entry) => sum + entry.evaluation.geometry.extraPredictedRegions, 0),
            },
            geometry: {meanIntersectionOverUnion: group.entries.reduce((sum, entry) => sum + entry.evaluation.geometry.meanIntersectionOverUnion, 0) / group.entries.length},
            order: {
                ambiguousPages: group.entries.filter(entry => entry.evaluation.order.ambiguous).length,
                failures: group.entries.reduce((sum, entry) => sum + entry.evaluation.order.failureCount, 0),
            },
            resources: {
                runtimeMs: {
                    mean: group.entries.reduce((sum, entry) => sum + entry.runtimeMs, 0) / group.entries.length,
                    max: Math.max(...group.entries.map(entry => entry.runtimeMs)),
                },
                peakRssBytes: Math.max(...group.entries.map(entry => entry.peakRssBytes)),
                scratchBytes: Math.max(...group.entries.map(entry => entry.scratchBytes)),
            },
        };
    });
}

async function runMeasuredDegradedCase({
    page,
    profile,
    cleanRaster,
    cleanImageSha256,
    transformedPage,
    outputDirectory,
    selectedLanguage,
    productionRunner,
    scanCleanupBinary,
    pdfPageOpsBinary,
}) {
    const {
        raster, realized,
    } = await realizeOcrQualityProfile({
        cleanRaster,
        profile,
    });
    const caseDirectory = join(outputDirectory, `${page.id}__${profile.id}`);
    await mkdir(caseDirectory, {recursive: true});
    const imagePath = join(caseDirectory, 'degraded-input.png');
    await writeFile(imagePath, raster);
    const memorySamples = [process.memoryUsage().rss];
    const memoryMonitor = setInterval(() => {
        memorySamples.push(process.memoryUsage().rss);
    }, 25);
    const startedAt = process.hrtime.bigint();
    let result;
    try {
        result = await productionRunner.runProductionOcrQualityCase({
            dpi: realized.dpi,
            recognitionOptions,
            inputPath: imagePath,
            language: selectedLanguage,
            outputDirectory: caseDirectory,
            tessdataDirectory,
            tesseractBinary: tesseract,
            ...(scanCleanupBinary ? {scanCleanupBinary} : {}),
        });
    } finally {
        clearInterval(memoryMonitor);
        memorySamples.push(process.memoryUsage().rss);
    }
    const runtimeMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const textLayerStartedAt = process.hrtime.bigint();
    const repairedPdfPath = await writeSinglePageTextLayer(
        pdfPageOpsBinary,
        result.pdfPath,
        caseDirectory,
        productionRunner.shouldNormalizeGreekMicroSign(selectedLanguage.split('+')),
    );
    const textLayerRuntimeMs = Number(process.hrtime.bigint() - textLayerStartedAt) / 1_000_000;
    const searchablePdfText = (await execFileAsync(pdftotext, [
        repairedPdfPath,
        '-',
    ], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
    })).stdout;
    const pdfjsText = (await extractPdfjsPageText(repairedPdfPath))[0] ?? '';
    const transformed = transformPageGeometry(page, realized.affine);
    const evaluation = evaluatePageOutput(page, result, pdfjsText, searchablePdfText, transformedPage ?? transformed);
    const scratchBytes = await directoryBytes(caseDirectory);
    const resourceUsage = process.resourceUsage();
    const peakRssBytes = Math.max(
        ...memorySamples,
        resourceUsage.maxRSS * 1024,
    );
    return {
        pageId: page.id,
        sourceDocumentId: page.sourceDocumentId,
        cohortId: page.cohortId,
        split: page.split,
        profileId: profile.id,
        severity: profile.severity,
        purpose: profile.purpose,
        acceptanceEligible: profile.acceptanceEligible,
        language: page.language,
        selectedLanguages: page.selectedLanguages ?? [page.language],
        productionLanguage: selectedLanguage,
        expected: page.text,
        rawActual: result.text,
        pdfjsActual: pdfjsText,
        pdfActual: searchablePdfText,
        cleanImageSha256,
        realized,
        imageSha256: realized.imageSha256,
        evaluation,
        runtimeMs,
        textLayerRuntimeMs,
        peakRssBytes,
        scratchBytes,
        preprocessing: result.preprocessing,
        wordCount: result.wordCount,
    };
}

function selectDegradedPages(manifest) {
    return manifest.pages.filter(page => (
        (page.kind === 'language' && page.evaluationEligible && page.coverage.valid)
        || page.kind === 'mixed' && page.evaluationEligible && page.coverage.valid
        || page.control === 'blank'
        || page.control === 'image-only'
    ));
}

async function runDegradedLanguageBenchmark({
    fixture,
    productionRunner,
    scanCleanupBinary,
    pdfPageOpsBinary,
}) {
    const profileById = new Map(DEGRADATION_PROFILES.map(profile => [
        profile.id,
        profile,
    ]));
    const cleanProfile = profileById.get('clean-300dpi');
    if (!cleanProfile) throw new Error('MLOCR-03 clean control profile is missing');
    const pageImages = new Map(fixture.pageImages.map(entry => [
        entry.page.id,
        entry.raster,
    ]));
    const pages = selectDegradedPages(fixture.manifest);
    const outputDirectory = join(workDirectory, 'ocr-language-quality-degraded');
    const cleanImageHashes = new Map();
    const entries = [];
    const profiles = DEGRADATION_PROFILES;
    const selectedLanguagesByPage = new Map();
    for (const page of pages) {
        const cleanRaster = pageImages.get(page.id);
        if (!cleanRaster) throw new Error(`Missing clean counterpart for ${page.id}`);
        const clean = await realizeOcrQualityProfile({
            cleanRaster,
            profile: cleanProfile,
        });
        cleanImageHashes.set(page.id, clean.realized.imageSha256);
    }
    for (const profile of profiles) {
        for (const page of pages) {
            const cleanRaster = pageImages.get(page.id);
            if (!cleanRaster || !page.coverage.valid) continue;
            const selectedLanguage = page.control
                ? 'eng'
                : (page.selectedLanguages?.length > 0
                    ? page.selectedLanguages
                    : [page.language]).join('+');
            const priorLanguages = selectedLanguagesByPage.get(page.id);
            if (priorLanguages !== undefined && priorLanguages !== selectedLanguage) {
                throw new Error(`Selected languages changed across profiles for ${page.id}`);
            }
            selectedLanguagesByPage.set(page.id, selectedLanguage);
            const entry = await runMeasuredDegradedCase({
                page,
                profile,
                cleanRaster,
                cleanImageSha256: cleanImageHashes.get(page.id),
                outputDirectory,
                selectedLanguage,
                productionRunner,
                scanCleanupBinary,
                pdfPageOpsBinary,
            });
            entries.push(entry);
            process.stdout.write(
                `MLOCR-03 ${profile.id} ${page.id}: raw CER=${entry.evaluation.rawOcr.faithful.cer.toFixed(4)}, WER=${entry.evaluation.rawOcr.faithful.wer.toFixed(4)}, missingLines=${entry.evaluation.missingLineCount}, duplicateLines=${entry.evaluation.duplicateLineCount}, unmatchedRegions=${entry.evaluation.geometry.unmatchedReferenceRegions}, extraRegions=${entry.evaluation.geometry.extraPredictedRegions}, orderFailures=${entry.evaluation.order.failureCount}, runtimeMs=${entry.runtimeMs.toFixed(1)}\n`,
            );
        }
    }
    return {
        status: 'complete',
        benchmark: 'MLOCR-03',
        pdfStage: 'native-ocr-text-layer',
        pdfWriter: {
            binary: pdfPageOpsBinary,
            sha256: createHash('sha256').update(await readFile(pdfPageOpsBinary)).digest('hex'),
        },
        runtimeStage: 'recognition-and-preprocessing',
        recognitionOptions,
        frozenPolicy: fixture.manifest.policy,
        frozenDefinition: fixture.manifest.frozen,
        split: fixture.manifest.corpusSplit,
        pageCount: pages.length,
        profileCount: profiles.length,
        cleanCounterparts: Object.fromEntries(cleanImageHashes),
        imageHashes: entries.map(entry => ({
            pageId: entry.pageId,
            profileId: entry.profileId,
            cleanImageSha256: entry.cleanImageSha256,
            degradedImageSha256: entry.imageSha256,
            realized: entry.realized,
        })),
        pages: entries.map(entry => ({
            pageId: entry.pageId,
            sourceDocumentId: entry.sourceDocumentId,
            cohortId: entry.cohortId,
            split: entry.split,
            profileId: entry.profileId,
            severity: entry.severity,
            purpose: entry.purpose,
            acceptanceEligible: entry.acceptanceEligible,
            language: entry.language,
            selectedLanguages: entry.selectedLanguages,
            evaluation: entry.evaluation,
            runtimeMs: entry.runtimeMs,
            textLayerRuntimeMs: entry.textLayerRuntimeMs,
            peakRssBytes: entry.peakRssBytes,
            scratchBytes: entry.scratchBytes,
            preprocessing: entry.preprocessing,
            wordCount: entry.wordCount,
        })),
        summaries: summarizeDegradedEntries(entries),
    };
}

async function runCleanLanguageBenchmark({
    scanCleanupBinary, pdfPageOpsBinary,
}) {
    const fixtureDirectory = join(workDirectory, 'ocr-language-quality');
    const fixture = await generateOcrLanguageQualityFixture({
        repositoryRoot,
        outputDirectory: fixtureDirectory,
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
    const pipeline = await loadProductionPipeline();
    const cleanPages = fixture.manifest.pages.filter(page => page.kind === 'language');
    // Keep every page on the frozen fixture. Reusing each result as the next
    // input makes later language jobs render an accumulating PDF.
    const workerResult = await runProductionOcrQualityDocument({
        pipeline,
        sourcePdfPath,
        pages: cleanPages,
        tempDirectory: workerTempDirectory,
        scanCleanupBinary,
        pdfPageOpsBinary,
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
        pdfStage: 'production-pipeline-native-ocr-text-layer',
        pdfWriter: {
            binary: pdfPageOpsBinary,
            sha256: createHash('sha256').update(await readFile(pdfPageOpsBinary)).digest('hex'),
        },
        recognitionOptions,
        fixture: {
            languageCount: languages.length,
            pageCount: cleanPages.length,
            pdfSha256: fixture.manifest.artifact.pdfSha256,
            outputPdfSha256: workerResult.resultSha256,
            sourceTextEmpty: true,
            physicalPage: fixture.manifest.physicalPage,
            pageOrder: cleanPages.map(page => page.id),
            rasterSha256ByPage: Object.fromEntries(cleanPages.map(page => [
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

async function resolveOptionalScanCleanup() {
    const candidate = process.env.EVB_SCAN_CLEANUP_PATH
        ?? join(repositoryRoot, 'native', 'target', 'release', `evb-scan-cleanup${executableSuffix}`);
    try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
    } catch {
        return undefined;
    }
}

async function resolveOptionalPdfPageOps() {
    try {
        await access(pdfPageOps, fsConstants.X_OK);
        return pdfPageOps;
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
            const result = await execFileAsync(binary, args, {timeout: 10_000});
            process.stdout.write(`OCR executable identity: ${JSON.stringify({
                name,
                binary,
                version: `${result.stdout}\n${result.stderr}`.trim(),
                ...(existsSync(binary) ? {sha256: createHash('sha256').update(await readFile(binary)).digest('hex')} : {}),
            })}\n`);
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
            const productionRunner = await loadProductionRunner();
            const recognitionPresets = {
                'defaults': productionRunner.DEFAULT_OCR_RECOGNITION_OPTIONS,
                'poor-scan': productionRunner.POOR_SCAN_OCR_RECOGNITION_OPTIONS,
            };
            recognitionOptions = recognitionPresets[recognitionPreset];
            process.stdout.write(`OCR quality configuration: ${JSON.stringify({
                recognitionPreset,
                recognitionOptions,
                tessdataDirectory,
            })}\n`);
            const scanCleanupBinary = await resolveOptionalScanCleanup();
            const pdfPageOpsBinary = await resolveOptionalPdfPageOps();
            if (!recognitionOptions) {
                reportIncomplete([`EVB_OCR_QUALITY_OPTIONS must be one of ${Object.keys(recognitionPresets).join(', ')}; got ${recognitionPreset}`]);
            } else if (!pdfPageOpsBinary) {
                reportIncomplete([`required OCR text-layer writer is unavailable: ${pdfPageOps}`]);
            } else if (required && !scanCleanupBinary) {
                reportIncomplete(['required clean preprocessing tool is unavailable']);
            } else {
                await runCleanLanguageBenchmark({
                    scanCleanupBinary,
                    pdfPageOpsBinary,
                });
                if (degradedOptIn) {
                    const fixtureDirectory = join(workDirectory, 'ocr-language-quality-degraded-fixture');
                    const fixture = await generateOcrLanguageQualityFixture({
                        repositoryRoot,
                        outputDirectory: fixtureDirectory,
                    });
                    const degradedReport = await runDegradedLanguageBenchmark({
                        fixture,
                        productionRunner,
                        scanCleanupBinary,
                        pdfPageOpsBinary,
                    });
                    process.stdout.write(`MLOCR-03 degraded raster report: ${JSON.stringify(degradedReport)}\n`);
                } else {
                    process.stdout.write('MLOCR-03 degraded raster benchmark skipped; set EVB_OCR_QUALITY_DEGRADED=1 or use the required quality command\n');
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
                    // The scan-like legacy diagnostic exists to exercise clean
                    // preprocessing, so it always uses the Poor scan profile.
                    const result = await productionRunner.runProductionOcrQualityCase({
                        dpi: 300,
                        recognitionOptions: productionRunner.POOR_SCAN_OCR_RECOGNITION_OPTIONS,
                        inputPath: imagePath,
                        language: testCase.language,
                        outputDirectory: caseDirectory,
                        tessdataDirectory,
                        tesseractBinary: tesseract,
                        ...(scanCleanupBinary ? {scanCleanupBinary} : {}),
                    });
                    preprocessingCoverage.add(result.preprocessing);
                    const repairedPdfPath = await writeSinglePageTextLayer(
                        pdfPageOpsBinary,
                        result.pdfPath,
                        caseDirectory,
                        productionRunner.shouldNormalizeGreekMicroSign(testCase.language.split('+')),
                    );
                    const {stdout: searchablePdfText} = await execFileAsync(pdftotext, [
                        repairedPdfPath,
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
                        `Production coverage: runOcrFileBased profile/TSV parser/native ocr-text-layer searchable PDF; preprocessing=${[...preprocessingCoverage].join(',')} (legacy image-only diagnostic; Poppler rasterization is covered by OCR pipeline integration tests)\n`,
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
