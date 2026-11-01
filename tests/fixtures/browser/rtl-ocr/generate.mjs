import {
    readFile, writeFile,
} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';

// Preserve the real EVB OCR streams, embedded fonts and scanned pixels. A new
// OCR run would depend on model/engine changes and would lose this exact case.
const fixture = await PDFDocument.create();
fixture.setCreationDate(new Date('2026-11-01T00:00:00Z'));
fixture.setModificationDate(new Date('2026-11-01T00:00:00Z'));
for (const [
    name,
    digest,
] of [
        [
            'arabic',
            'db56f28171d00079f9f4527abc40de9a3762df733f31e4414a174a2ce30c0c44',
        ],
        [
            'pointed-hebrew',
            '4bc7194bcb204c60bd0b3be613008148fc5f11df927e5f412a0f14e5b81a8d50',
        ],
    ]) {
    const bytes = await readFile(new URL(`sources/${name}.pdf`, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        throw new Error(`Changed OCR source: ${name}`);
    }
    const source = await PDFDocument.load(bytes);
    const [page] = await fixture.copyPages(source, [0]);
    fixture.addPage(page);
}
await writeFile(new URL('saved-rtl-ocr.pdf', import.meta.url), await fixture.save());
