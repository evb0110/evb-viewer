#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    basename,
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
    StandardFonts,
    degrees,
    drawImage,
} from 'pdf-lib';
import * as stockPdfJs from 'pdfjs-dist-codex-preview/legacy/build/pdf.mjs';
import {
    REQUIRED_CASES,
    checkQpdf,
    inspectPdf,
    validateCorpus,
} from './verify-interop-corpus.mjs';

const root = resolve(import.meta.dirname, '..');
const corpusDirectory = join(root, 'tests/fixtures/electron/interop');
const STOCK_PDFJS_VERSION = '5.4.296';
const PDF_LIB_VERSION = '1.17.1';
const FIXED_DATE = new Date('2026-09-01T00:00:00.000Z');
const SYNTHETIC_FILENAME = 'synthetic-annotation-interoperability.pdf';
const STOCK_FILENAME = 'stock-pdfjs-save-of-synthetic.pdf';
const STAMP_JPEG = Uint8Array.from(Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAoAEADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAcI/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Al7UCSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//Z',
    'base64',
));

function literal(value) {
    return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function appearance(context, font, {
    background,
    border,
    label,
    width,
    height,
}) {
    const content = [
        'q',
        `${background} rg`,
        `0 0 ${width} ${height} re f`,
        `${border} RG`,
        '1 w',
        `0 0 ${width} ${height} re S`,
        'BT',
        '/F1 11 Tf',
        '4 18 Td',
        `(${literal(label)}) Tj`,
        'ET',
        'Q',
    ].join('\n');
    return context.register(context.stream(Buffer.from(content, 'ascii'), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        Resources: context.obj({Font: context.obj({F1: font.ref})}),
        BBox: [
            0,
            0,
            width,
            height,
        ],
    }));
}

function emptyAppearance(context) {
    return context.register(context.stream(new Uint8Array(), {
        Type: PDFName.of('XObject'),
        Subtype: PDFName.of('Form'),
        BBox: [
            0,
            0,
            0,
            0,
        ],
    }));
}

async function createSyntheticPdf(outputPath) {
    const document = await PDFDocument.create();
    document.setTitle('EVB interop synthetic corpus');
    document.setAuthor('EVB Viewer interoperability tests');
    document.setSubject('Deterministic annotation interoperability fixture');
    document.setProducer('EVB interop corpus generator');
    document.setCreationDate(FIXED_DATE);
    document.setModificationDate(FIXED_DATE);

    const page = document.addPage([
        612,
        792,
    ]);
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText('EVB annotation interoperability corpus', {
        font,
        size: 20,
        x: 72,
        y: 720,
    });
    page.drawText('All annotation dictionaries below use fixed identities and dates.', {
        font,
        size: 12,
        x: 72,
        y: 690,
    });

    const context = document.context;
    const annotation = fields => context.register(context.obj({
        Type: PDFName.of('Annot'),
        P: page.ref,
        F: PDFNumber.of(4),
        M: PDFString.of('D:20260901000000Z'),
        ...fields,
    }));
    const textBoxAppearance = appearance(context, font, {
        background: '0.92 0.96 1',
        border: '0.1 0.25 0.7',
        label: 'editable text box',
        width: 180,
        height: 50,
    });
    const highlightAppearance = appearance(context, font, {
        background: '1 0.9 0.1',
        border: '0.75 0.55 0',
        label: 'highlight',
        width: 180,
        height: 24,
    });
    const shapeAppearance = appearance(context, font, {
        background: '0.85 0.92 1',
        border: '0.1 0.35 0.8',
        label: 'square shape',
        width: 110,
        height: 58,
    });
    const stampImage = await document.embedJpg(STAMP_JPEG);
    const stampImageName = 'InteropStampImage';
    const stampAppearance = context.register(context.formXObject(
        drawImage(stampImageName, {
            height: 56,
            rotate: degrees(0),
            width: 86,
            x: 0,
            xSkew: degrees(0),
            y: 0,
            ySkew: degrees(0),
        }),
        {
            BBox: context.obj([
                0,
                0,
                86,
                56,
            ]),
            Resources: {XObject: {[stampImageName]: stampImage.ref}},
        },
    ));
    const blankAppearance = emptyAppearance(context);

    const textBox = annotation({
        Subtype: PDFName.of('FreeText'),
        Rect: [
            72,
            610,
            252,
            660,
        ],
        NM: PDFHexString.fromText('interop-text-box'),
        Contents: PDFHexString.fromText('Editable interoperability text'),
        DA: PDFString.of('/Helvetica 11 Tf 0 0 0 rg'),
        RC: PDFHexString.fromText('<body xmlns="http://www.w3.org/1999/xhtml">Rich text sentinel</body>'),
        DS: PDFString.of('font: Helvetica 11pt; text-align: left'),
        EVBVendorKey: PDFHexString.fromText('preserve-text-box-vendor-key'),
        AP: context.obj({N: textBoxAppearance}),
    });

    const highlight = annotation({
        Subtype: PDFName.of('Highlight'),
        Rect: [
            72,
            520,
            252,
            544,
        ],
        QuadPoints: [
            72,
            544,
            252,
            544,
            72,
            520,
            252,
            520,
        ],
        NM: PDFHexString.fromText('interop-highlight'),
        Contents: PDFHexString.fromText('Editable interoperability highlight'),
        C: [
            1,
            0.8,
            0,
        ],
        CA: PDFNumber.of(0.45),
        AP: context.obj({N: highlightAppearance}),
    });

    const shape = annotation({
        Subtype: PDFName.of('Square'),
        Rect: [
            350,
            510,
            460,
            568,
        ],
        NM: PDFHexString.fromText('interop-shape-square'),
        C: [
            0.1,
            0.35,
            0.85,
        ],
        IC: [
            0.85,
            0.92,
            1,
        ],
        CA: PDFNumber.of(0.5),
        Border: [
            0,
            0,
            2,
        ],
        EVBVendorKey: PDFHexString.fromText('preserve-shape-vendor-key'),
        AP: context.obj({N: shapeAppearance}),
    });

    const stamp = annotation({
        Subtype: PDFName.of('Stamp'),
        Rect: [
            480,
            510,
            566,
            566,
        ],
        NM: PDFHexString.fromText('interop-stamp'),
        Name: PDFName.of('Approved'),
        Contents: PDFHexString.fromText('Approved interoperability stamp'),
        AP: context.obj({N: stampAppearance}),
    });

    const legacyNote = annotation({
        Subtype: PDFName.of('FreeText'),
        Rect: [
            0,
            791.99,
            0.01,
            792,
        ],
        NM: PDFHexString.fromText('interop-marker-edited-legacy-note'),
        Contents: PDFHexString.fromText('Legacy note to edit'),
        Popup: null,
        AP: context.obj({N: blankAppearance}),
    });
    const legacyPopup = annotation({
        Subtype: PDFName.of('Popup'),
        Parent: legacyNote,
        Rect: [
            0,
            791.99,
            0.01,
            792,
        ],
        Open: false,
    });
    context.lookup(legacyNote).set(PDFName.of('Popup'), legacyPopup);

    const nativeNote = annotation({
        Subtype: PDFName.of('Text'),
        Rect: [
            280,
            610,
            312,
            642,
        ],
        NM: PDFHexString.fromText('interop-native-note'),
        Contents: PDFHexString.fromText('Native text note'),
        T: PDFHexString.fromText('Interop author'),
        C: [
            1,
            0.75,
            0,
        ],
        StateModel: PDFName.of('Review'),
        State: PDFName.of('Accepted'),
    });
    const nativePopup = annotation({
        Subtype: PDFName.of('Popup'),
        Parent: nativeNote,
        Rect: [
            280,
            610,
            460,
            700,
        ],
        Open: false,
    });
    context.lookup(nativeNote).set(PDFName.of('Popup'), nativePopup);

    const reply = annotation({
        Subtype: PDFName.of('Text'),
        Rect: [
            320,
            610,
            352,
            642,
        ],
        NM: PDFHexString.fromText('interop-native-note-reply'),
        Contents: PDFHexString.fromText('Reply to native text note'),
        T: PDFHexString.fromText('Reply author'),
        IRT: nativeNote,
        RT: PDFName.of('R'),
        StateModel: PDFName.of('Review'),
        State: PDFName.of('Marked'),
    });
    const secondReply = annotation({
        Subtype: PDFName.of('Text'),
        Rect: [
            360,
            610,
            392,
            642,
        ],
        NM: PDFHexString.fromText('interop-native-note-reply-2'),
        Contents: PDFHexString.fromText('Second reply to native text note'),
        T: PDFHexString.fromText('Second reply author'),
        IRT: reply,
        RT: PDFName.of('R'),
    });

    const missingNameLink = annotation({
        Subtype: PDFName.of('Link'),
        Rect: [
            390,
            680,
            540,
            705,
        ],
        Border: [
            0,
            0,
            1,
        ],
        A: context.obj({
            S: PDFName.of('URI'),
            URI: PDFString.of('https://example.com/evb-interop-corpus'),
        }),
    });

    page.node.set(PDFName.of('Annots'), context.obj([
        textBox,
        highlight,
        shape,
        stamp,
        legacyNote,
        legacyPopup,
        nativeNote,
        nativePopup,
        reply,
        secondReply,
        missingNameLink,
    ]));

    await writeFile(outputPath, await document.save({
        addDefaultPage: false,
        useObjectStreams: false,
        updateFieldAppearances: false,
    }));
}

async function saveWithStockPdfJs(inputPath, outputPath) {
    const input = new Uint8Array(await readFile(inputPath));
    let document;
    try {
        document = await stockPdfJs.getDocument({
            data: input,
            disableWorker: true,
            useSystemFonts: true,
        }).promise;
        document.annotationStorage.setValue('pdfjs_internal_editor_0', {
            annotationType: 3,
            pageIndex: 0,
            rect: [
                90,
                560,
                270,
                600,
            ],
            rotation: 0,
            structTreeParentId: null,
            popupRef: '',
            color: [
                0,
                0,
                0,
            ],
            fontSize: 12,
            value: 'Stock-authored annotation editor',
            date: new Date(FIXED_DATE),
        });
        const saved = await document.saveDocument();
        await writeFile(outputPath, Buffer.from(saved));
    } catch (caught) {
        throw new Error(
            `stock unpatched pdf.js ${STOCK_PDFJS_VERSION} saveDocument failed: ${caught.message}`,
            {cause: caught},
        );
    } finally {
        await document?.destroy().catch(() => undefined);
    }
}

function aggregateCases(inventories) {
    return Object.fromEntries(REQUIRED_CASES.map(name => [
        name,
        inventories.some(inventory => inventory.requiredCases[name]),
    ]));
}

async function hashFile(filePath) {
    const bytes = await readFile(filePath);
    return {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

async function makeEntry({
    filePath,
    provenance,
}) {
    const inventory = await inspectPdf(filePath);
    const qpdf = await checkQpdf(filePath);
    const hash = await hashFile(filePath);
    return {
        file: basename(filePath),
        status: 'ready',
        ...hash,
        pages: inventory.pages,
        kinds: inventory.kinds,
        subtypes: inventory.subtypes,
        variantCoverage: inventory.variantCoverage,
        preservedKeys: inventory.preservedKeys,
        scenarioCount: inventory.kinds.length + Object.values(inventory.requiredCases).filter(Boolean).length,
        qpdfWarningBaseline: {
            exitCode: qpdf.exitCode,
            warnings: qpdf.warnings,
        },
        provenance,
        inventory: {
            annotationCount: inventory.annotations.length,
            requiredCases: inventory.requiredCases,
        },
    };
}

async function createManifest(workDirectory) {
    const syntheticPath = join(workDirectory, SYNTHETIC_FILENAME);
    const stockPath = join(workDirectory, STOCK_FILENAME);
    await createSyntheticPdf(syntheticPath);
    await saveWithStockPdfJs(syntheticPath, stockPath);
    const syntheticEntry = await makeEntry({
        filePath: syntheticPath,
        provenance: {
            kind: 'synthetic-pdf-lib',
            tool: 'pdf-lib',
            version: PDF_LIB_VERSION,
            license: 'MIT',
            method: 'Deterministic low-level PDF dictionaries and appearance streams generated by this script.',
            claimLimitations: 'This fixture is synthetic and is not claimed to be authored by pdf.js.',
        },
    });
    const stockEntry = await makeEntry({
        filePath: stockPath,
        provenance: {
            kind: 'stock-pdfjs-save-of-synthetic-input',
            packageName: 'pdfjs-dist-codex-preview',
            version: STOCK_PDFJS_VERSION,
            license: 'Apache-2.0',
            method: 'Stock unpatched pdf.js getDocument({ data, disableWorker: true }).promise followed by PDFDocumentProxy.saveDocument().',
            sourceFixture: SYNTHETIC_FILENAME,
            claimLimitations: 'The final bytes and one additional FreeText annotation were written by stock pdf.js. The other annotation dictionaries originated in the synthetic input, so this does not claim that stock pdf.js authored every annotation kind.',
        },
    });
    const inventories = [
        syntheticEntry,
        stockEntry,
    ].map(entry => ({requiredCases: entry.inventory.requiredCases}));
    return {
        schemaVersion: 1,
        generator: 'scripts/generate-interop-corpus.mjs',
        generationDate: '2026-09-01T00:00:00.000Z',
        metadataPolicy: 'Fixed neutral metadata. No private source document or recording is used.',
        requiredKinds: [
            'highlight',
            'note',
            'shape',
            'stamp',
            'text-box',
        ],
        requiredCases: aggregateCases(inventories),
        entries: [
            syntheticEntry,
            stockEntry,
        ],
    };
}

async function copyGeneratedFiles(workDirectory, destinationDirectory, manifest) {
    await mkdir(destinationDirectory, {recursive: true});
    for (const entry of manifest.entries) {
        await writeFile(
            join(destinationDirectory, entry.file),
            await readFile(join(workDirectory, entry.file)),
        );
    }
    await writeFile(
        join(destinationDirectory, 'corpus-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );
}

async function compareGeneratedFiles(workDirectory, destinationDirectory, manifest) {
    const existing = JSON.parse(await readFile(join(destinationDirectory, 'corpus-manifest.json'), 'utf8'));
    const expectedJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const actualJson = `${JSON.stringify(existing, null, 2)}\n`;
    if (expectedJson !== actualJson) {
        throw new Error('interop corpus manifest is not reproducible; run the generator to inspect the difference');
    }
    for (const entry of manifest.entries) {
        const expected = await readFile(join(workDirectory, entry.file));
        const actual = await readFile(join(destinationDirectory, entry.file));
        if (!expected.equals(actual)) {
            throw new Error(`interop corpus fixture is not reproducible: ${entry.file}`);
        }
    }
}

async function main() {
    const checkOnly = process.argv.includes('--check');
    const workDirectory = await mkdtemp(join(tmpdir(), 'evb-interop-corpus-'));
    try {
        const manifest = await createManifest(workDirectory);
        if (checkOnly) {
            await compareGeneratedFiles(workDirectory, corpusDirectory, manifest);
        } else {
            await copyGeneratedFiles(workDirectory, corpusDirectory, manifest);
        }
        const result = await validateCorpus({
            corpusDirectory: checkOnly ? corpusDirectory : corpusDirectory,
            runQpdf: true,
        });
        process.stdout.write(`${JSON.stringify({
            mode: checkOnly ? 'check' : 'write',
            ...result,
        }, null, 2)}\n`);
    } finally {
        await rm(workDirectory, {
            recursive: true,
            force: true,
        });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        await main();
    } catch (caught) {
        process.stderr.write(`${caught.stack ?? caught}\n`);
        process.exitCode = 1;
    }
}

export {createManifest};
