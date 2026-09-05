#!/usr/bin/env node

import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    PDFName,
    PDFString,
    StandardFonts,
} from 'pdf-lib';

const outputPath = resolve(
    process.argv[2] ?? 'tests/fixtures/electron/freetext-lifecycle-test.pdf',
);

const pdf = await PDFDocument.create();
const page = pdf.addPage([
    612,
    792,
]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText('FreeText Lifecycle Test', {
    font,
    size: 24,
    x: 100,
    y: 650,
});
page.drawText('This PDF contains reachable FreeText and Popup annotations.', {
    font,
    size: 14,
    x: 100,
    y: 600,
});

const context = pdf.context;
const pageRef = page.ref;
const text = (value) => PDFString.of(value);
const annotation = (fields) => context.register(context.obj({
    Type: PDFName.of('Annot'),
    ...fields,
}));

const noteRef = annotation({
    Subtype: PDFName.of('FreeText'),
    Rect: [
        0,
        791.99,
        0.01,
        792,
    ],
    NM: text('lifecycle-note'),
    Contents: text('Reachable lifecycle note'),
    Popup: null,
    AP: null,
    P: pageRef,
});
const blankAppearanceRef = context.register(context.stream(new Uint8Array(), {
    Type: PDFName.of('XObject'),
    Subtype: PDFName.of('Form'),
    BBox: [
        0,
        0,
        0,
        0,
    ],
}));
const popupRef = annotation({
    Subtype: PDFName.of('Popup'),
    Parent: noteRef,
    Rect: [
        0,
        791.99,
        0.01,
        792,
    ],
    Open: false,
    P: pageRef,
});
const note = context.lookup(noteRef);
note.set(PDFName.of('Popup'), popupRef);
note.set(PDFName.of('AP'), context.obj({ N: blankAppearanceRef }));

const textBoxOneRef = annotation({
    Subtype: PDFName.of('FreeText'),
    Rect: [
        100,
        500,
        320,
        560,
    ],
    NM: text('lifecycle-text-box-one'),
    Contents: text('Reachable text box one'),
    DA: text('/Helvetica 14 Tf 0 0 1 rg'),
    RC: text('<body>Foreign rich text sentinel</body>'),
    DS: text('foreign-style-sentinel'),
    P: pageRef,
});
const textBoxTwoRef = annotation({
    Subtype: PDFName.of('FreeText'),
    Rect: [
        100,
        400,
        340,
        455,
    ],
    NM: text('lifecycle-text-box-two'),
    Contents: text('Reachable text box two'),
    DA: text('/Helvetica 12 Tf 0 0 0 rg'),
    P: pageRef,
});

page.node.set(PDFName.of('Annots'), context.obj([
    noteRef,
    popupRef,
    textBoxOneRef,
    textBoxTwoRef,
]));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, await pdf.save({ useObjectStreams: false }));
process.stdout.write(`${outputPath}\n`);
