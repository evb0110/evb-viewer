import {readFileSync} from 'node:fs';
import {PDFDocument} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import {
    lifecycle, waitForOpenFileReady, addNote, noteTexts, settleActiveOpen,
} from './documentLifecycleTestHelpers';
import {
    createReadingBook, readReadingView,
} from './documentReadingTestHelpers';

describe('browser document lifecycle UI', () => {

    // T3: physical Save compares every opening byte and ignores an mtime-only touch.
    it.each([
        'unsampled-edit',
        'mtime-only',
    ] as const)('preserves physical-source Save authority after %s', async scenario => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 900,
        }});
        const page = await context.newPage();
        const name = 'physical-authority.pdf';
        const note = 'Independent working note';
        const book = await createReadingBook('Physical authority', name);
        // A valid PDF with trailing comments; offset 1 MiB is outside any sampled witness.
        const changed = scenario === 'unsampled-edit';
        const bytes = changed
            ? Buffer.concat([
                book.buffer,
                Buffer.from('\n%'),
                Buffer.alloc(17 * 1024 * 1024, 32),
            ])
            : book.buffer;
        try {
            await page.addInitScript(fileName => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showOpenFilePicker', async () => [new File([], fileName)]);
                Object.defineProperties(File.prototype, {
                    kind: {get: () => 'file'},
                    createWritable: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        return (await root.getFileHandle(this.name)).createWritable();
                    }},
                    isSameEntry: {value: async function (this: File, other: FileSystemHandle) {return this.name === other.name;}},
                    getFile: {value: async function (this: File) {
                        const root = await navigator.storage.getDirectory();
                        const file = await (await root.getFileHandle(this.name)).getFile();
                        return new File([await file.arrayBuffer()], this.name, {
                            type: 'application/pdf',
                            lastModified: Number(sessionStorage.getItem('physical-mtime') ?? 100),
                        });
                    }},
                });
            }, name);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.evaluate(async ({
                fileName, content,
            }) => {
                const root = await navigator.storage.getDirectory();
                const output = await (await root.getFileHandle(fileName, {create: true})).createWritable();
                await output.write(Uint8Array.from(atob(content), character => character.charCodeAt(0)));
                await output.close();
            }, {
                fileName: name,
                content: bytes.toString('base64'),
            });
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe('Physical authority page 1');
            await settleActiveOpen(page);
            await addNote(page, note, {
                x: 90,
                y: 100,
            });
            await page.evaluate(async ({
                fileName, changeBytes, position,
            }) => {
                sessionStorage.setItem('physical-mtime', changeBytes ? '100' : '200');
                if (!changeBytes) return;
                const root = await navigator.storage.getDirectory();
                const handle = await root.getFileHandle(fileName);
                const output = await handle.createWritable({keepExistingData: true});
                await output.write({
                    type: 'write',
                    position,
                    data: Uint8Array.of(88),
                });
                await output.close();
            }, {
                fileName: name,
                changeBytes: changed,
                position: 1024 * 1024,
            });
            const save = page.locator('.save-split-primary').first();
            await save.click();
            // Both success and refusal settle the save operation; inspect actual disk bytes.
            await expect.poll(() => save.getAttribute('aria-busy'), {timeout: 15_000}).toBe('false');
            const savedBase64 = await page.evaluate(async fileName => {
                const root = await navigator.storage.getDirectory();
                const file = await (await root.getFileHandle(fileName)).getFile();
                return new Promise<string>((resolveRead, rejectRead) => {
                    const reader = new FileReader();
                    reader.onload = () => resolveRead(String(reader.result).split(',')[1]!);
                    reader.onerror = () => rejectRead(reader.error);
                    reader.readAsDataURL(file);
                });
            }, name);
            const saved = Buffer.from(savedBase64, 'base64');
            if (changed) {
                expect(saved[1024 * 1024]).toBe(88);
                expect(noteTexts(await PDFDocument.load(Uint8Array.from(saved)))).not.toContain(note);
                expect(await save.isDisabled()).toBe(false);
                // Save As still contains the reader's independent authored work.
                await page.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                const download = page.waitForEvent('download');
                await page.evaluate(() => Reflect.set(window, 'showSaveFilePicker', undefined));
                await page.getByRole('menuitem', {name: /^Save As/u}).click();
                expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toContain(note);
            } else {
                expect(noteTexts(await PDFDocument.load(Uint8Array.from(saved)))).toContain(note);
                expect(await save.isDisabled()).toBe(true);
                await addNote(page, 'Second save advances the baseline', {
                    x: 140,
                    y: 140,
                });
                await save.click();
                await expect.poll(() => save.isDisabled(), {timeout: 15_000}).toBe(true);
            }
        } finally {
            await context.close();
        }
    }, 120_000);
});
