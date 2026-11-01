import {
    mkdir, readFile, writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    addNote,
    lifecycle,
    noteTexts,
    openPdfFromChooser,
} from './documentLifecycleTestHelpers';

/** Desktop's verdict for a PDF, from the browser's page tool (the same Rust function). */
async function readAppendAdmission(bytes: Uint8Array) {
    const module = new WebAssembly.Module(await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm')));
    const {
        memory,
        evb_pdf_page_ops_alloc: alloc,
        evb_pdf_page_ops_free: free,
        evb_pdf_page_ops_append_admission: admit,
    } = new WebAssembly.Instance(module, {}).exports;
    if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== 'function' || typeof free !== 'function' || typeof admit !== 'function') {
        throw new Error('The page tool has no append admission');
    }
    const pointer = Number(alloc(bytes.byteLength));
    new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
    const verdict = Number(admit(pointer, bytes.byteLength));
    free(pointer, bytes.byteLength);
    return [
        'appendable',
        'repairable',
        'limited',
        'unverified',
    ][verdict] ?? `failed (${verdict})`;
}

describe('browser damaged PDF repair', () => {
    // Behavior contract: a PDF desktop opens and edits after qpdf rebuilds its
    // cross-reference table opens and takes edits in the browser too.
    it('rewrites a PDF with a broken startxref on open, so a note saves into it', async () => {
        const evidence = process.env.EVB_QPDF_REPAIR_EVIDENCE_DIR;
        if (evidence) await mkdir(evidence, {recursive: true});
        const source = (await readFile(join(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'))).toString('latin1');
        // startxref points into the header line, not at the cross-reference stream.
        const damaged = Buffer.from(`${source.slice(0, source.lastIndexOf('startxref'))}startxref\n9\n%%EOF\n`, 'latin1');
        expect(await readAppendAdmission(damaged)).toBe('repairable');
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1440,
            height: 900,
        }});
        try {
            await openPdfFromChooser(page, {
                name: 'damaged-startxref.pdf',
                mimeType: 'application/pdf',
                buffer: damaged,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            const text = 'Note saved into a repaired PDF';
            await addNote(page, text, {
                x: 200,
                y: 200,
            });
            if (evidence) await page.screenshot({path: join(evidence, 'annotated.png')});
            const download = page.waitForEvent('download', {timeout: 60_000});
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const path = await (await download).path();
            if (!path) throw new Error('The repaired PDF was not saved');
            const saved = new Uint8Array(await readFile(path));
            if (evidence) await writeFile(join(evidence, 'saved.pdf'), saved);
            // The note was appended to a base whose chain an edit can extend:
            // the saved file takes the next edit, as desktop's would.
            expect(noteTexts(await PDFDocument.load(saved), '/Text')).toContain(text);
            expect(await readAppendAdmission(saved)).toBe('appendable');
            expect(Buffer.from(saved).includes(damaged.subarray(-64))).toBe(false);
        } finally {
            if (evidence) await page.screenshot({path: join(evidence, 'terminal.png')});
            if (evidence) await writeFile(join(evidence, 'terminal.txt'), await page.locator('body').innerText());
            await page.context().close();
        }
    }, 120_000);
});
