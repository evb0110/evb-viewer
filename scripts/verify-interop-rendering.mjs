#!/usr/bin/env node

import {execFile} from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import {promisify} from 'node:util';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    checkQpdf,
    inspectPdf,
    validateCorpus,
} from './verify-interop-corpus.mjs';

const execFileAsync = promisify(execFile);
const RENDER_DPI = 144;
const MAX_REGION_MEAN = 64_000;
const MIN_PAINT_DELTA = 1_024;
const RENDER_OPTIONS = Object.freeze({
    command: 'pdftoppm -png -singlefile -r 144 -f 1 -l 1',
    dpi: RENDER_DPI,
    negativeControl: 'pdftoppm -hide-annotations -png -singlefile -r 144 -f 1 -l 1',
    page: 1,
});

function fail(message) {
    throw new Error(`Interop rendering validation failed: ${message}`);
}

async function runCommand(command, args, options = {}) {
    try {
        return await execFileAsync(command, args, {
            maxBuffer: 1024 * 1024,
            ...options,
        });
    } catch (caught) {
        throw new Error(`${command} ${args.join(' ')} failed: ${caught.message}`, {cause: caught});
    }
}

async function toolVersion(command, args) {
    const result = await runCommand(command, args);
    return `${result.stdout}${result.stderr}`.trim().split('\n')[0] ?? '';
}

function parsePageSize(output) {
    const match = /Page(?:\s+\d+)?\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/u.exec(output);
    if (!match) {
        fail(`pdfinfo did not report a point-sized page: ${output}`);
    }
    return {
        height: Number(match[2]),
        width: Number(match[1]),
    };
}

function parseImageInfo(output) {
    const match = /^(\d+)x(\d+)\s+([0-9.]+)$/u.exec(output.trim());
    if (!match) {
        fail(`identify returned an unexpected image description: ${output}`);
    }
    return {
        height: Number(match[2]),
        mean: Number(match[3]),
        width: Number(match[1]),
    };
}

async function renderPage(inputPath, outputDirectory, options = {}) {
    const outputBase = join(
        outputDirectory,
        `${basename(inputPath, '.pdf')}${options.outputSuffix ?? ''}`,
    );
    const renderArguments = [
        ...(options.hideAnnotations ? ['-hide-annotations'] : []),
        '-png',
        '-singlefile',
        '-r',
        String(RENDER_DPI),
        '-f',
        '1',
        '-l',
        '1',
        inputPath,
        outputBase,
    ];
    const render = await runCommand('pdftoppm', renderArguments);
    const pngPath = `${outputBase}.png`;
    const [
        info,
        pageInfo,
    ] = await Promise.all([
        runCommand('identify', [
            '-format',
            '%wx%h %[mean]',
            pngPath,
        ]),
        runCommand('pdfinfo', [
            '-f',
            '1',
            '-l',
            '1',
            inputPath,
        ]),
    ]);
    const image = parseImageInfo(info.stdout);
    const page = parsePageSize(pageInfo.stdout);
    const expected = {
        height: Math.round(page.height * RENDER_DPI / 72),
        width: Math.round(page.width * RENDER_DPI / 72),
    };
    if (image.width !== expected.width || image.height !== expected.height) {
        fail(`${basename(inputPath)} rendered at ${image.width}x${image.height}, expected ${expected.width}x${expected.height}`);
    }
    return {
        hideAnnotations: options.hideAnnotations === true,
        image,
        page,
        pngPath,
        stderr: render.stderr.trim(),
    };
}

async function cropMean(pngPath, rectangle, page, image) {
    const scaleX = image.width / page.width;
    const scaleY = image.height / page.height;
    const left = Math.max(0, Math.floor(rectangle.left * scaleX));
    const top = Math.max(0, Math.floor((page.height - rectangle.top) * scaleY));
    const right = Math.min(image.width, Math.ceil(rectangle.right * scaleX));
    const bottom = Math.min(image.height, Math.ceil((page.height - rectangle.bottom) * scaleY));
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) {
        return null;
    }
    const result = await runCommand('convert', [
        pngPath,
        '-crop',
        `${width}x${height}+${left}+${top}`,
        '-format',
        '%[mean]',
        'info:',
    ]);
    const mean = Number(result.stdout.trim());
    if (!Number.isFinite(mean)) {
        fail(`ImageMagick returned an invalid crop mean for ${pngPath}`);
    }
    return {
        mean,
        rectangle: {
            bottom,
            height,
            left,
            top,
            width,
        },
    };
}

async function validateFile(inputPath, outputDirectory, expectedQpdfWarnings = null) {
    const qpdf = await checkQpdf(inputPath);
    if (expectedQpdfWarnings) {
        if (qpdf.exitCode !== expectedQpdfWarnings.exitCode
            || JSON.stringify(qpdf.warnings) !== JSON.stringify(expectedQpdfWarnings.warnings)) {
            fail(`${basename(inputPath)} qpdf result differs from the recorded baseline`);
        }
    } else if (qpdf.exitCode !== 0 || qpdf.warnings.length > 0) {
        fail(`${basename(inputPath)} qpdf did not pass cleanly: ${JSON.stringify(qpdf)}`);
    }

    const [
        inventory,
        render,
        hiddenAnnotationRender,
    ] = await Promise.all([
        inspectPdf(inputPath),
        renderPage(inputPath, outputDirectory),
        renderPage(inputPath, outputDirectory, {
            hideAnnotations: true,
            outputSuffix: '-annotations-hidden',
        }),
    ]);
    const checkKind = async kind => {
        const candidates = inventory.annotations.filter(annotation => annotation.kind === kind);
        const annotation = candidates.find(candidate => (
            candidate.rect
            && !candidate.blankAppearance
            && (kind !== 'note' || candidate.subtype === 'Text')
        )) ?? candidates.find(candidate => candidate.rect);
        if (!annotation?.rect) {
            fail(`${basename(inputPath)} has no positioned ${kind} annotation`);
        }
        const [
            crop,
            hiddenCrop,
        ] = await Promise.all([
            cropMean(render.pngPath, annotation.rect, render.page, render.image),
            cropMean(
                hiddenAnnotationRender.pngPath,
                annotation.rect,
                hiddenAnnotationRender.page,
                hiddenAnnotationRender.image,
            ),
        ]);
        if (!crop) {
            fail(`${basename(inputPath)} has a ${kind} rectangle too small to render`);
        }
        if (!hiddenCrop) {
            fail(`${basename(inputPath)} has a ${kind} rectangle too small for the hidden-annotation control`);
        }
        const requiresPaint = kind !== 'note' || !annotation.blankAppearance;
        if (requiresPaint && crop.mean >= MAX_REGION_MEAN) {
            fail(`${basename(inputPath)} ${kind} crop is indistinguishable from white paper: mean=${crop.mean}`);
        }
        if (requiresPaint && hiddenCrop.mean < MAX_REGION_MEAN) {
            fail(`${basename(inputPath)} ${kind} hidden-annotation control is not blank: mean=${hiddenCrop.mean}`);
        }
        if (requiresPaint && hiddenCrop.mean - crop.mean < MIN_PAINT_DELTA) {
            fail(`${basename(inputPath)} ${kind} paint delta is too small: normal=${crop.mean}, hidden=${hiddenCrop.mean}`);
        }
        return {
            blankAppearance: annotation.blankAppearance,
            crop,
            kind,
            hiddenCrop,
            name: annotation.name,
            paintDelta: hiddenCrop.mean - crop.mean,
            subtype: annotation.subtype,
        };
    };
    const visualChecks = await Promise.all([
        'text-box',
        'highlight',
        'note',
        'stamp',
        'shape',
    ].map(checkKind));
    return {
        bytes: (await readFile(inputPath)).length,
        file: inputPath,
        inventory: {
            annotations: inventory.annotations.length,
            kinds: inventory.kinds,
            pages: inventory.pages,
        },
        qpdf,
        render: {
            image: render.image,
            page: render.page,
            pngPath: render.pngPath,
            stderr: render.stderr,
        },
        negativeControl: {
            image: hiddenAnnotationRender.image,
            page: hiddenAnnotationRender.page,
            pngPath: hiddenAnnotationRender.pngPath,
            stderr: hiddenAnnotationRender.stderr,
        },
        visualChecks,
    };
}

function argumentValues(name) {
    const values = [];
    for (let index = 0; index < process.argv.length; index += 1) {
        if (process.argv[index] === name && process.argv[index + 1]) {
            values.push(process.argv[index + 1]);
            index += 1;
        }
    }
    return values;
}

export async function verifyInteropRendering({
    artifactDirectory,
    corpusDirectory,
    inputPaths,
}) {
    const outputDirectory = artifactDirectory
        ? resolve(artifactDirectory)
        : await mkdtemp('/tmp/evb-interop-render-');
    await mkdir(outputDirectory, {recursive: true});
    let expectedEntries = new Map();
    let paths = inputPaths ?? [];
    if (paths.length === 0) {
        const manifestResult = await validateCorpus({
            corpusDirectory,
            runQpdf: true,
        });
        const manifest = JSON.parse(await readFile(join(corpusDirectory, 'corpus-manifest.json'), 'utf8'));
        expectedEntries = new Map(manifest.entries.map(entry => [
            resolve(corpusDirectory, entry.file),
            entry,
        ]));
        paths = manifest.entries
            .filter(entry => entry.status === 'ready')
            .map(entry => resolve(corpusDirectory, entry.file));
        if (manifestResult.scenarioCount <= 0) {
            fail('corpus reported no scenarios');
        }
    }
    const files = await Promise.all(paths.map(async (inputPath, index) => {
        const resolvedPath = resolve(inputPath);
        const entry = expectedEntries.get(resolvedPath);
        // Inputs run concurrently; same-named files from different directories must not share PNG paths.
        const fileDirectory = join(outputDirectory, String(index));
        await mkdir(fileDirectory, {recursive: true});
        return validateFile(
            resolvedPath,
            fileDirectory,
            entry?.qpdfWarningBaseline ?? null,
        );
    }));
    const result = {
        artifactDirectory: outputDirectory,
        files,
        renderer: {
            imageMagick: await toolVersion('identify', ['-version']),
            pdfinfo: await toolVersion('pdfinfo', ['-v']),
            pdftoppm: await toolVersion('pdftoppm', ['-v']),
            qpdf: await toolVersion('qpdf', ['--version']),
        },
        renderOptions: RENDER_OPTIONS,
    };
    if (!artifactDirectory) {
        await rm(outputDirectory, {
            recursive: true,
            force: true,
        });
    }
    return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const corpusDirectory = resolve(
        process.env.EVB_INTEROP_CORPUS_DIR
            ?? join(import.meta.dirname, '..', 'tests/fixtures/electron/interop'),
    );
    const inputPaths = argumentValues('--input');
    const artifactDirectory = argumentValues('--artifact-dir')[0];
    try {
        const result = await verifyInteropRendering({
            artifactDirectory,
            corpusDirectory,
            inputPaths,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (caught) {
        process.stderr.write(`${caught.stack ?? caught}\n`);
        process.exitCode = 1;
    }
}
