#!/usr/bin/env node

import {
    mkdir,
    open,
    stat,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PDFDocument,
    PDFName,
    PDFString,
    StandardFonts,
} from 'pdf-lib';

export const DEFAULT_LARGE_PDF_FIXTURE_BYTES = 513 * 1024 * 1024;
export const DEFAULT_LARGE_PDF_FIXTURE_PAGES = 431;

function parsePositiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function readArgument(name) {
    const prefix = `--${name}=`;
    return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

export async function generateLargePdfE2eFixture({
    outputPath,
    pageCount = DEFAULT_LARGE_PDF_FIXTURE_PAGES,
    targetBytes = DEFAULT_LARGE_PDF_FIXTURE_BYTES,
}) {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const font = await pdf.embedFont(StandardFonts.Helvetica);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = pdf.addPage([
            612,
            792,
        ]);
        page.drawText(`EVB deterministic large-PDF fixture — page ${pageNumber} of ${pageCount}`, {
            font,
            size: 14,
            x: 54,
            y: 720,
        });
        page.drawText('This fixture is sparse-padded so CI can exercise a half-gibibyte file without storing a binary.', {
            font,
            size: 9,
            x: 54,
            y: 696,
        });
    }

    const existingNote = pdf.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('FreeText'),
        Rect: [
            54,
            620,
            300,
            662,
        ],
        Contents: PDFString.of('EVB deterministic existing FreeText note'),
        DA: PDFString.of('/Helvetica 12 Tf 0 g'),
        F: 4,
        Border: [
            0,
            0,
            1,
        ],
    });
    pdf.getPage(0).node.addAnnot(pdf.context.register(existingNote));

    const basePdf = await pdf.save({
        addDefaultPage: false,
        useObjectStreams: false,
    });
    const baseText = Buffer.from(basePdf).toString('latin1');
    const startXrefMatches = [...baseText.matchAll(/startxref\s+(\d+)\s+%%EOF/gu)];
    const startXref = startXrefMatches.at(-1)?.[1];
    if (startXref === undefined) {
        throw new Error('Generated PDF is missing its startxref trailer');
    }

    const finalTrailer = Buffer.from(`\nstartxref\n${startXref}\n%%EOF\n`, 'ascii');
    if (targetBytes < basePdf.byteLength + finalTrailer.byteLength) {
        throw new Error(`targetBytes must be at least ${basePdf.byteLength + finalTrailer.byteLength}`);
    }

    const absoluteOutputPath = resolve(outputPath);
    await mkdir(dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, basePdf);
    const handle = await open(absoluteOutputPath, 'r+');
    try {
        await handle.truncate(targetBytes);
        await handle.write(finalTrailer, 0, finalTrailer.byteLength, targetBytes - finalTrailer.byteLength);
    } finally {
        await handle.close();
    }

    const generated = await stat(absoluteOutputPath);
    if (generated.size !== targetBytes) {
        throw new Error(`Generated fixture size mismatch: expected ${targetBytes}, got ${generated.size}`);
    }
    return absoluteOutputPath;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    void (async () => {
        const outputPath = readArgument('output');
        if (!outputPath) {
            throw new Error('Usage: generate-large-pdf-e2e-fixture.mjs --output=<path> [--pages=431] [--bytes=537919488]');
        }
        const pageCount = parsePositiveInteger(readArgument('pages') ?? DEFAULT_LARGE_PDF_FIXTURE_PAGES, 'pages');
        const targetBytes = parsePositiveInteger(readArgument('bytes') ?? DEFAULT_LARGE_PDF_FIXTURE_BYTES, 'bytes');
        const generatedPath = await generateLargePdfE2eFixture({
            outputPath,
            pageCount,
            targetBytes,
        });
        process.stdout.write(`${generatedPath}\n`);
    })().catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
