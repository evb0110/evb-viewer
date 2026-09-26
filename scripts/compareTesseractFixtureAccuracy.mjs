import { execFile } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
    createCanvas,
    GlobalFonts,
} from '@napi-rs/canvas';

const OCR_WORD_PATTERN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}]|[-./](?=[\p{L}\p{M}\p{N}]))*/gu;

/** @typedef {{id: string, language: string, lines: string[], profile: {background: number, foreground: number, noiseAmplitude: number, rotationDegrees: number, scanLineEvery: number, speckleEvery: number}}} IOcrFixture */

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDirectory);
const [
    baselinePath,
    candidatePath,
    tessdataPath,
] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !tessdataPath) {
    throw new Error('Usage: node scripts/compareTesseractFixtureAccuracy.mjs <baseline> <candidate> <tessdata>');
}
const baselineBinary = resolve(baselinePath);
const candidateBinary = resolve(candidatePath);
const tessdataDirectory = resolve(tessdataPath);

/** @type {IOcrFixture[]} */
const fixtures = JSON.parse(await readFile(join(scriptDirectory, 'fixtures', 'ocr-quality-corpus.json'), 'utf8'));
const scratchRoot = join(projectRoot, '.devkit', 'tmp');
await mkdir(scratchRoot, {recursive: true});
const workDirectory = await mkdtemp(join(scratchRoot, 'tesseract-fixture-accuracy-'));

/** @param {number} seed */
function deterministicNoise(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        return state / 0x1_0000_0000;
    };
}

/** @param {IOcrFixture} fixture @param {number} index */
function renderFixture(fixture, index) {
    const width = 1_440;
    const height = 480;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    const {profile} = fixture;
    context.fillStyle = `rgb(${profile.background}, ${profile.background - 2}, ${profile.background - 5})`;
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    context.rotate(profile.rotationDegrees * Math.PI / 180);
    context.translate(-width / 2, -height / 2);
    context.fillStyle = `rgb(${profile.foreground}, ${profile.foreground}, ${profile.foreground})`;
    context.font = '50px EvbOcrCorpus';
    context.textBaseline = 'alphabetic';
    fixture.lines.forEach((line, lineIndex) => context.fillText(line, 94, 130 + lineIndex * 112));
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
            const current = image.data[offset + channel] ?? 0;
            image.data[offset + channel] = Math.max(0, Math.min(255, current + noise + scanLine + speckle));
        }
    }
    context.putImageData(image, 0, 0);
    return canvas.encode('png');
}

/** @param {string} binary @param {string} inputPath @param {string} language */
async function recognize(binary, inputPath, language) {
    const {stdout} = await execFileAsync(binary, [
        inputPath,
        'stdout',
        '--tessdata-dir',
        tessdataDirectory,
        '-l',
        language,
        '--oem',
        '1',
        '--psm',
        '6',
    ]);
    return stdout;
}

/** @param {string} value */
function tokenizeWords(value) {
    return value
        .normalize('NFC')
        .replace(/\s+/gu, ' ')
        .trim()
        .match(OCR_WORD_PATTERN) ?? [];
}

/** @param {string} expected @param {string} actual */
function wordErrorRate(expected, actual) {
    const expectedWords = tokenizeWords(expected);
    const actualWords = tokenizeWords(actual);
    let previous = Array.from({length: expectedWords.length + 1}, (_, index) => index);
    for (let actualIndex = 0; actualIndex < actualWords.length; actualIndex += 1) {
        const current = [actualIndex + 1];
        for (let expectedIndex = 0; expectedIndex < expectedWords.length; expectedIndex += 1) {
            current.push(Math.min(
                (current[expectedIndex] ?? 0) + 1,
                (previous[expectedIndex + 1] ?? 0) + 1,
                (previous[expectedIndex] ?? 0) + (expectedWords[expectedIndex] === actualWords[actualIndex] ? 0 : 1),
            ));
        }
        previous = current;
    }
    return {
        errors: previous[expectedWords.length] ?? 0,
        words: expectedWords.length,
    };
}

try {
    if (!GlobalFonts.registerFromPath(join(projectRoot, 'public/pdf/standard_fonts/LiberationSans-Regular.ttf'), 'EvbOcrCorpus')) {
        throw new Error('OCR corpus font could not be registered.');
    }
    const comparison = [];
    for (const [
        index,
        fixture,
    ] of fixtures.entries()) {
        const imagePath = join(workDirectory, `${fixture.id}.png`);
        await writeFile(imagePath, await renderFixture(fixture, index));
        const expected = fixture.lines.join('\n');
        const baselineText = await recognize(baselineBinary, imagePath, fixture.language);
        const candidateText = await recognize(candidateBinary, imagePath, fixture.language);
        const baselineMetrics = wordErrorRate(expected, baselineText);
        const candidateMetrics = wordErrorRate(expected, candidateText);
        const row = {
            fixture: fixture.id,
            baselineWordAccuracy: 1 - baselineMetrics.errors / Math.max(1, baselineMetrics.words),
            baselineWer: baselineMetrics.errors / Math.max(1, baselineMetrics.words),
            candidateWordAccuracy: 1 - candidateMetrics.errors / Math.max(1, candidateMetrics.words),
            candidateWer: candidateMetrics.errors / Math.max(1, candidateMetrics.words),
            words: baselineMetrics.words,
        };
        comparison.push(row);
        process.stdout.write(`${JSON.stringify(row)}\n`);
    }
    const regressions = comparison.filter(row => row.candidateWer > row.baselineWer);
    if (regressions.length > 0) {
        throw new Error(`Tesseract word accuracy regressed: ${JSON.stringify(regressions)}`);
    }
} finally {
    await rm(workDirectory, {
        force: true,
        recursive: true,
    });
}
