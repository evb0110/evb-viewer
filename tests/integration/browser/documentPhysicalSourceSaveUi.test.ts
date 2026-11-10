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
        'legacy-file-unchanged',
        'legacy-bytes-unchanged',
        'legacy-file-changed',
        'legacy-bytes-changed',
        'missing-baseline',
    ] as const)('preserves physical-source Save authority after %s', async scenario => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 900,
        }});
        const page = await context.newPage();
        const name = 'physical-authority.pdf';
        const note = 'Independent working note';
        const book = await createReadingBook('Physical authority', name);
        // A valid PDF with trailing comments; offset 1 MiB is outside all old witness samples.
        const legacyKind = scenario.startsWith('legacy-file') ? 'file' : scenario.startsWith('legacy-bytes') ? 'bytes' : null;
        const changed = scenario === 'unsampled-edit' || scenario.endsWith('-changed') || scenario === 'missing-baseline';
        const bytes = scenario === 'unsampled-edit' || legacyKind
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
            if (legacyKind) {
                const sampleSize = 64 * 1024;
                const middle = Math.floor(bytes.length / 2) - sampleSize / 2;
                const samples = Buffer.concat([
                    bytes.subarray(0, sampleSize),
                    bytes.subarray(middle, middle + sampleSize),
                    bytes.subarray(-sampleSize),
                ]);
                let first = 2_166_136_261;
                let second = 2_169_136_261;
                for (const byte of samples) {
                    first = Math.imul(first ^ byte, 16_777_619);
                    second = Math.imul(second ^ byte, 2_654_435_761);
                }
                const baseline = `${legacyKind}:${bytes.length}:${legacyKind === 'file' ? '100:' : ''}${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
                // Setup only: emulate a pre-upgrade persisted baseline in the open working copy.
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const {loadAllRecordKeys, loadRecord, persistRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    for (const ref of await loadAllRecordKeys()) {
                        const record = await loadRecord(ref);
                        if (record?.kind !== 'working' && record?.kind !== 'source') continue;
                        record.sourceBaseWitness = ${JSON.stringify(baseline)};
                        await persistRecord(record);
                        (await store.requireEntry(ref)).sourceBaseWitness = record.sourceBaseWitness;
                    }
                })()`);
            }
            if (scenario === 'missing-baseline') {
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const {loadAllRecordKeys, loadRecord, persistRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    for (const ref of await loadAllRecordKeys()) {
                        const record = await loadRecord(ref);
                        if (record?.kind !== 'working') continue;
                        delete record.sourceBaseWitness;
                        await persistRecord(record);
                        delete (await store.requireEntry(ref)).sourceBaseWitness;
                    }
                })()`);
            }
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
                position: legacyKind ? 1024 * 1024 : scenario === 'missing-baseline' ? bytes.length - 1 : 1024 * 1024,
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
            if (changed || legacyKind) {
                if (changed) expect(saved[legacyKind ? 1024 * 1024 : scenario === 'missing-baseline' ? bytes.length - 1 : 1024 * 1024]).toBe(88);
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
                const persistedWitnesses = await page.evaluate(`(async () => {
                    const {loadAllRecordKeys, loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    return Promise.all((await loadAllRecordKeys()).map(async ref => (await loadRecord(ref))?.sourceBaseWitness));
                })()`) as string[];
                expect(persistedWitnesses.length).toBeGreaterThanOrEqual(2);
                expect(persistedWitnesses.every(witness => witness?.startsWith('content-v2:'))).toBe(true);
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
