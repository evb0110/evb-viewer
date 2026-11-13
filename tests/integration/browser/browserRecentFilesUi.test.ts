import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync, closeSync, ftruncateSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    basename, resolve,
} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {Download} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, readBrowserPayloadCounts, readRecoveries, settleActiveOpen,
} from './documentLifecycleTestHelpers';
import {
    createReadingBook, readReadingView,
} from './documentReadingTestHelpers';

describe('browser document lifecycle UI', () => {
    // T6: Recent follows desktop's ten-document MRU, without a browser byte budget.
    it('C07 retains two large books and the ten newest distinct Recent documents', async () => {
        const evidence = resolve(process.env.EVB_C07_EVIDENCE_DIR ?? '.devkit/c07-verify/run');
        mkdirSync(evidence, {recursive: true});
        // About 540 MiB of books per run, removed when the run ends.
        const fixtures = mkdtempSync(resolve(tmpdir(), 'evb-c07-'));
        const books = [
            'Amber',
            'Cobalt',
        ].map(label => {
            // A valid one-page PDF with a referenced, sparse embedded file.
            // Real file sizes exercise retention; random payload bytes add only I/O.
            const path = resolve(fixtures, `c07-${label.toLowerCase()}.pdf`);
            const file = openSync(path, 'w');
            const offsets = [0];
            let size = 0;
            const write = (bytes: string | Buffer) => {
                const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
                writeSync(file, buffer, 0, buffer.length, size);
                size += buffer.length;
            };
            const object = (id: number, body: string) => {
                offsets[id] = size;
                write(`${id} 0 obj\n${body}\nendobj\n`);
            };
            try {
                write('%PDF-1.7\n');
                object(1, '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(payload.bin) 6 0 R] >> >> >>');
                object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
                object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
                const content = `BT /F1 24 Tf 40 500 Td (${label} page 1) Tj ET\n`;
                object(4, `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
                object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
                object(6, '<< /Type /Filespec /F (payload.bin) /EF << /F 7 0 R >> >>');
                offsets[7] = size;
                write(`7 0 obj\n<< /Type /EmbeddedFile /Length ${270 * 1024 * 1024} >>\nstream\n`);
                size += 270 * 1024 * 1024;
                ftruncateSync(file, size);
                write('\nendstream\nendobj\n');
                const xref = size;
                write(`xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
            } finally {
                closeSync(file);
            }
            return {
                label,
                path,
                name: basename(path),
                size,
            };
        });
        writeFileSync(resolve(evidence, 'fixtures.json'), JSON.stringify(books, null, 2));
        try {
            for (const journey of [
                'large',
                'count',
            ] as const) {
                const context = await lifecycle.browser.newContext({viewport: {
                    width: 1280,
                    height: 900,
                }});
                const page = await context.newPage();
                const problems = collectConsoleProblems(page);
                const paintings = new Map<string, string>();
                const recentNames = () => page.locator('.recent-file-name').allTextContents().then(names => names.map(name => name.trim()));
                const paintedText = async (label: string) => {
                    await settleActiveOpen(page);
                    await page.locator('.page_container--rendered canvas').first().waitFor();
                    await expect.poll(async () => (await readReadingView(page)).visibleText).toBe(`${label} page 1`);
                    // Verify painted ink as well as the text layer: an empty canvas is not a reopen.
                    const painting = await page.locator('.page_container--rendered canvas').first().evaluate(async (canvas: HTMLCanvasElement) => {
                        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                        const ink = pixels.some((channel, index) => index % 4 !== 3 && channel < 100 && pixels[index - index % 4 + 3]! > 0);
                        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
                        return {
                            ink,
                            hash: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''),
                        };
                    });
                    expect(painting.ink).toBe(true);
                    if (paintings.has(label)) expect(painting.hash).toBe(paintings.get(label));
                    else {
                        expect(Array.from(paintings.values())).not.toContain(painting.hash);
                        paintings.set(label, painting.hash);
                    }
                };
                // Open each next document in the emptied tab, without rebuilding the app.
                const open = async (fixture: Parameters<typeof openPdfFromChooser>[1]) => {
                    const chooser = page.waitForEvent('filechooser');
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                    await (await chooser).setFiles(fixture);
                };
                const close = async () => {
                    await page.getByRole('button', {
                        name: 'Close Tab',
                        exact: true,
                    }).click();
                    await page.locator('.workspace-host[data-workspace-active="true"] .workspace-host__start').waitFor();
                };
                const assertRecent = async (names: string[]) => {
                    await expect.poll(recentNames).toEqual(names);
                    await page.getByRole('button', {
                        name: 'Menu',
                        exact: true,
                    }).click();
                    await page.getByRole('menuitem', {
                        name: 'Open Recent',
                        exact: true,
                    }).click();
                    await expect.poll(() => page.getByRole('menuitem').filter({hasText: /^c07-.*\.pdf$/u}).allTextContents().then(items => items.map(item => item.trim()))).toEqual(names);
                    await page.screenshot({
                        animations: 'disabled',
                        path: resolve(evidence, `${journey}-open-recent.png`),
                    });
                    await page.keyboard.press('Escape');
                    await page.keyboard.press('Escape');
                    await page.keyboard.press('Escape');
                };
                try {
                    await page.addInitScript(() => {
                        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                        Reflect.set(window, 'showSaveFilePicker', undefined);
                        window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                    });
                    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                    await waitForOpenFileReady(page);
                    keepFileChooserInterceptionEnabled(page);
                    if (journey === 'large') {
                        for (const book of books) {
                            await open(book.path);
                            await paintedText(book.label);
                            await close();
                        }
                        await page.reload({waitUntil: 'domcontentloaded'});
                        await waitForOpenFileReady(page);
                        // Each book keeps its stored copy for Recent Files; nothing else stays stored.
                        const storedFiles = (await readBrowserPayloadCounts(page)).sizes.map(fileSize => ({fileSize}));
                        const recordedBytes = storedFiles.reduce((sum, file) => sum + file.fileSize, 0);
                        writeFileSync(resolve(evidence, 'storage.json'), JSON.stringify({
                            storedFiles,
                            recordedBytes,
                            estimate: await page.evaluate(() => navigator.storage.estimate()),
                            browser: lifecycle.browser.version(),
                        }, null, 2));
                        // This is the baseline's reported symptom: the older large book disappears.
                        await assertRecent([
                            'c07-cobalt.pdf',
                            'c07-amber.pdf',
                        ]);
                        expect(storedFiles).toHaveLength(books.length);
                        expect(storedFiles).toEqual(expect.arrayContaining(books.map(book => ({fileSize: book.size}))));
                        expect(recordedBytes).toBeGreaterThan(512 * 1024 * 1024);
                        for (const book of books) {
                            if (book.label === 'Amber') {
                                await page.locator('[data-recent-open-actionable="true"] .recent-open').filter({hasText: book.name}).click();
                            } else {
                                await page.getByRole('button', {
                                    name: 'Menu',
                                    exact: true,
                                }).click();
                                await page.getByRole('menuitem', {
                                    name: 'Open Recent',
                                    exact: true,
                                }).click();
                                await page.getByRole('menuitem', {
                                    name: book.name,
                                    exact: true,
                                }).click();
                            }
                            await paintedText(book.label);
                            await page.screenshot({
                                animations: 'disabled',
                                path: resolve(evidence, `${book.label.toLowerCase()}-reopened.png`),
                            });
                            await close();
                        }
                    } else {
                        for (let index = 1; index <= 11; index += 1) {
                            await open(await createReadingBook(`Small ${index}`, `c07-small-${index}.pdf`));
                            await paintedText(`Small ${index}`);
                            await close();
                        }
                        await page.reload({waitUntil: 'domcontentloaded'});
                        await waitForOpenFileReady(page);
                        await assertRecent([
                            'c07-small-11.pdf',
                            'c07-small-10.pdf',
                            'c07-small-9.pdf',
                            'c07-small-8.pdf',
                            'c07-small-7.pdf',
                            'c07-small-6.pdf',
                            'c07-small-5.pdf',
                            'c07-small-4.pdf',
                            'c07-small-3.pdf',
                            'c07-small-2.pdf',
                        ]);
                        await page.locator('[data-recent-open-actionable="true"] .recent-open').filter({hasText: 'c07-small-4.pdf'}).click();
                        await paintedText('Small 4');
                        await close();
                        await assertRecent([
                            'c07-small-4.pdf',
                            'c07-small-11.pdf',
                            'c07-small-10.pdf',
                            'c07-small-9.pdf',
                            'c07-small-8.pdf',
                            'c07-small-7.pdf',
                            'c07-small-6.pdf',
                            'c07-small-5.pdf',
                            'c07-small-3.pdf',
                            'c07-small-2.pdf',
                        ]);
                    }
                    expect(problems).toEqual([]);
                } finally {
                    writeFileSync(resolve(evidence, `${journey}-console.json`), JSON.stringify(problems, null, 2));
                    writeFileSync(resolve(evidence, `${journey}-paintings.json`), JSON.stringify(Object.fromEntries(paintings), null, 2));
                    writeFileSync(resolve(evidence, `${journey}-recent.json`), JSON.stringify(await recentNames(), null, 2));
                    await page.screenshot({
                        animations: 'disabled',
                        path: resolve(evidence, `${journey}-final.png`),
                    });
                    await context.close();
                }
            }
        } finally {
            rmSync(fixtures, {
                recursive: true,
                force: true,
            });
        }
    }, 120_000);

    // T2/C1: accepted independent settings survive an interleaved latest-read/write.
    it('serializes Scan Cleanup document and global intents with real cross-page IndexedDB', async () => {
        const bundle = await build({
            stdin: {
                contents: `
                import * as preferences from './app/utils/browserScanCleanupPreferences';
                import {createScanCleanupPageOverride} from './packages/contracts/scan-cleanup/scanCleanupPageOverrides';
                const key = 'evb.scanCleanup.documentOverrides.v1';
                const marginsMm = {leftMm: 3, rightMm: 4, topMm: 5, bottomMm: 6};
                globalThis.__b02Preferences = preferences;
                globalThis.__b02Race = async kind => {
                    const hash = 'a'.repeat(64);
                    const override = createScanCleanupPageOverride({rotationDegrees: 90});
                    if (['copy', 'adopt', 'reset', 'override-edits'].includes(kind)) {
                        localStorage.setItem(key, JSON.stringify({book: {updatedAt: 1, marginsMm, outputMode: 'bw', overrides: {}}}));
                    }
                    let nested;
                    let armed = true;
                    const storage = {
                        get(name) {
                            const snapshot = localStorage.getItem(name);
                            if (armed) {
                                armed = false;
                                nested = Promise.resolve(kind === 'global'
                                    ? preferences.saveScanCleanupPreferencesPatch({firstRunGuidanceDismissed: true})
                                    : kind === 'override-edits'
                                        ? preferences.saveScanCleanupDocumentPreferences('book', {overrideEdits: {'2': override}})
                                        : preferences.saveScanCleanupDocumentPreferences(kind === 'adopt' ? hash : ['other-document', 'copy', 'reset'].includes(kind) ? 'peer' : 'book', {outputMode: 'color'}));
                            }
                            return snapshot;
                        },
                        set(name, value) {localStorage.setItem(name, value); return true;},
                    };
                    await (kind === 'global'
                        ? preferences.saveScanCleanupPreferencesPatch({marginsMm}, storage)
                        : kind === 'copy' ? preferences.copyScanCleanupDocumentPreferences(['book'], 'copy', storage)
                        : kind === 'adopt' ? preferences.adoptScanCleanupDocumentKey(hash, 'book', storage)
                        : kind === 'reset' ? preferences.resetScanCleanupDocumentOverrides('book', storage)
                        : preferences.saveScanCleanupDocumentPreferences('book', kind === 'override-edits' ? {overrideEdits: {'1': override}} : {marginsMm}, storage));
                    await nested;
                    return JSON.parse(localStorage.getItem(kind === 'global' ? 'evb.scanCleanup.settings.v1' : key));
                };
            `,
                resolveDir: process.cwd(),
                loader: 'ts',
            },
            bundle: true,
            write: false,
            format: 'iife',
            platform: 'browser',
            tsconfig: resolve(process.cwd(), 'tsconfig.json'),
            define: {'import.meta.dev': 'false'},
        });
        const context = await lifecycle.browser.newContext();
        await context.route('**/b02-preferences', route => route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>Scan Cleanup preference integration</title>',
        }));
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        try {
            for (const page of [
                pageA,
                pageB,
            ]) {
                await page.goto(`${lifecycle.origin}/b02-preferences`);
                await page.addScriptTag({content: bundle.outputFiles[0]!.text});
            }
            const observations: Array<{
                kind: string;
                run: number;
                margin: number | null;
                peer: unknown
            }> = [];
            for (const kind of [
                'same-document',
                'other-document',
                'global',
                'override-edits',
                'copy',
                'adopt',
                'reset',
            ]) {
                for (let run = 0; run < 3; run += 1) {
                    await pageA.evaluate(() => {
                        localStorage.removeItem('evb.scanCleanup.documentOverrides.v1');
                        localStorage.removeItem('evb.scanCleanup.settings.v1');
                    });
                    await pageA.evaluate(async race => Reflect.get(window, '__b02Race')(race), kind);
                    // Reload the peer to read persisted state after storage-event delivery.
                    await pageB.reload();
                    await pageB.addScriptTag({content: bundle.outputFiles[0]!.text});
                    const saved = await pageB.evaluate(race => JSON.parse(localStorage.getItem(race === 'global'
                        ? 'evb.scanCleanup.settings.v1' : 'evb.scanCleanup.documentOverrides.v1') ?? '{}'), kind);
                    observations.push({
                        kind,
                        run,
                        margin: (kind === 'global' ? saved.marginsMm?.leftMm : saved[kind === 'adopt' ? 'a'.repeat(64) : kind === 'copy' ? 'copy' : 'book']?.marginsMm?.leftMm) ?? null,
                        peer: kind === 'global' ? saved.firstRunGuidanceDismissed
                            : kind === 'override-edits' ? Boolean(saved.book?.overrides?.['1'] && saved.book?.overrides?.['2'])
                                : saved[kind === 'adopt' ? 'a'.repeat(64) : [
                                    'other-document',
                                    'copy',
                                    'reset',
                                ].includes(kind) ? 'peer' : 'book']?.outputMode,
                    });
                }
            }
            console.info('B02 controlled preference interleavings', JSON.stringify(observations));
            expect(observations).toEqual([
                'same-document',
                'other-document',
                'global',
                'override-edits',
                'copy',
                'adopt',
                'reset',
            ].flatMap(kind => Array.from({length: 3}, (_value, run) => ({
                kind,
                run,
                margin: 3,
                peer: [
                    'global',
                    'override-edits',
                ].includes(kind) ? true : 'color',
            }))));
            // Independent renderer contexts share the very same transaction owner.
            await Promise.all([
                pageA.evaluate(async () => Reflect.get(window, '__b02Preferences').saveScanCleanupDocumentPreferences('cross-page', {outputMode: 'color'})),
                pageB.evaluate(async () => Reflect.get(window, '__b02Preferences').saveScanCleanupDocumentPreferences('cross-page', {marginsMm: {
                    leftMm: 7,
                    rightMm: 7,
                    topMm: 7,
                    bottomMm: 7,
                }})),
            ]);
            await pageA.reload();
            expect(await pageA.evaluate(() => JSON.parse(localStorage.getItem('evb.scanCleanup.documentOverrides.v1') ?? '{}')['cross-page'])).toMatchObject({
                outputMode: 'color',
                marginsMm: {leftMm: 7},
            });
        } finally {
            await context.close();
        }
    });

    // A committed producer target must survive peer collection until its consumer adopts it.
    it.each([
        'conversion',
        'save-as',
    ] as const)('retains pending %s bytes through peer Recent clearing', async operation => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const peer = await context.newPage();
        const problems = collectConsoleProblems(page);
        let savedDigest: number[] | null = null;
        try {
            for (const participant of [
                page,
                peer,
            ]) {
                await participant.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await participant.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(participant);
                keepFileChooserInterceptionEnabled(participant);
            }
            const peerChooser = peer.waitForEvent('filechooser');
            await peer.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await peerChooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await peer.locator('.page_container--rendered canvas').first().waitFor();
            await peer.getByRole('button', {name: 'Close tab'}).last().click();
            // Observe completion of the actual UI-triggered collection, not just the list repaint.
            await peer.evaluate(`(async () => {
                const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                const clear = store.clearRecentFiles.bind(store);
                store.clearRecentFiles = async () => {await clear(); window.__peerClearCompleted = true;};
            })()`);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            if (operation === 'conversion') {
                await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
                await page.locator('[data-testid="document-page-source-image"]').first().waitFor({timeout: 90_000});
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const retain = store.setRetention.bind(store);
                    store.setRetention = async (ref, retention) => {
                        const result = await retain(ref, retention);
                        if ((await store.requireEntry(ref)).kind === 'output' && retention === 'durable') {
                            window.__pendingTargetRef = ref;
                            await new Promise(resolve => {window.__resumeTarget = resolve;});
                        }
                        return result;
                    };
                })()`);
                await page.getByRole('button', {name: /Convert to PDF/}).filter({visible: true}).first().click();
                await page.getByRole('dialog').getByRole('button', {
                    name: 'Convert',
                    exact: true,
                }).click();
            } else {
                await page.evaluate(`(async () => {
                    const {getDocumentPdfCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                    const capability = getDocumentPdfCapability();
                    const analyze = capability.analyzePdfConformance.bind(capability);
                    capability.analyzePdfConformance = async (ref, options) => {
                        if (!options?.purpose && ref.endsWith('/pending-save.pdf') && !window.__lateConformanceRef) {
                            window.__lateConformanceRef = ref;
                            await new Promise(resolve => {window.__resumeLateConformance = resolve;});
                            try {return await analyze(ref, options);}
                            catch(error) {console.info('LATE_CONFORMANCE_CAUSE', {name:error.name, message:error.message, stack:error.stack}); throw error;}
                            finally {window.__lateConformanceDone = true;}
                        }
                        return analyze(ref, options);
                    };
                })()`);
                const input = await PDFDocument.load(readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')));
                await input.attach(randomBytes(4 * 1024 * 1024 + 64 * 1024), 'public-padding.bin');
                await (await chooser).setFiles({
                    name: 'pending-save.pdf',
                    mimeType: 'application/pdf',
                    buffer: Buffer.from(await input.save()),
                });
                await page.locator('.page_container--rendered canvas').first().waitFor();
                await page.evaluate(`(async () => {
                    const {browserDocumentStore: store} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    const create = store.createStoredDocument.bind(store);
                    store.createStoredDocument = async (name, bytes, options) => {
                        const ref = await create(name, bytes, options);
                        if (options.kind === 'source') {
                            window.__pendingTargetRef = ref;
                            await new Promise(resolve => {window.__resumeTarget = resolve;});
                        }
                        return ref;
                    };
                })()`);
                await page.waitForFunction(() => Boolean(Reflect.get(window, '__resumeLateConformance')));
                const download = page.waitForEvent('download');
                await page.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).click();
                await page.getByRole('menuitem', {name: /^Save As/u}).click();
                const savedPath = await (await download).path();
                const savedBytes = readFileSync(savedPath!);
                savedDigest = Array.from(createHash('sha256').update(savedBytes).digest());
                expect((await PDFDocument.load(savedBytes)).getPageCount()).toBe(1);
            }
            await page.waitForFunction(() => Boolean(Reflect.get(window, '__resumeTarget')));
            const ref: string = await page.evaluate(() => Reflect.get(window, '__pendingTargetRef'));
            const before = await readPersistedDocumentBytes(peer, ref, operation === 'save-as');
            if (operation === 'conversion') expect(before.slice(0, 5)).toEqual([
                37,
                80,
                68,
                70,
                45,
            ]);
            else {
                expect(before).toEqual(savedDigest);
            }
            await peer.getByRole('button', {
                name: 'Clear Recent Files',
                exact: true,
            }).click();
            await peer.getByRole('button', {
                name: 'Clear History',
                exact: true,
            }).click();
            await peer.waitForFunction(() => Reflect.get(window, '__peerClearCompleted') === true);
            const after = await readPersistedDocumentBytes(peer, ref, operation === 'save-as');
            await page.evaluate(() => Reflect.get(window, '__resumeTarget')());
            expect(createHash('sha256').update(Uint8Array.from(after)).digest('hex'),
                'Committed target bytes survive collection before adoption')
                .toBe(createHash('sha256').update(Uint8Array.from(before)).digest('hex'));
            if (operation === 'conversion') expect((await PDFDocument.load(Uint8Array.from(after))).getPageCount()).toBe(2);
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({timeout: 60_000});
            await expect.poll(async () => await page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').getAttribute('aria-description') ?? '', {timeout: 30_000}).not.toMatch(/unsaved/iu);
            if (operation === 'save-as') {
                await expect.poll(() => page.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).isEnabled(), {timeout: 30_000}).toBe(true);
            }
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            if (operation === 'save-as') {
                await page.evaluate(() => Reflect.get(window, '__resumeLateConformance')());
                await page.waitForFunction(() => Reflect.get(window, '__lateConformanceDone') === true);
            }
            const recentOpen = page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: operation === 'conversion' ? 'bitonal-faint-pencil.pdf' : 'pending-save.pdf'});
            // Recent registration and Close finish asynchronously. Wait for the
            // saved document on Start before navigation can interrupt either.
            await recentOpen.waitFor({state: 'visible'});
            await page.reload({waitUntil: 'domcontentloaded'});
            await recentOpen.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({timeout: 60_000});
            if (operation === 'save-as') {
                await expect.poll(() => page.locator('.textLayer').first().innerText()).toContain('Hello Arabic world');
            }
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-pending-${operation}-reloaded.png`)});
            expect(problems).toEqual([]);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it.each([
        'clean-open',
        'two-window-move',
        'two-window-move-source-stays-open',
        'clear-recent',
    ])('keeps the saved copy source and both notes after Clear Recent Files and Save (mode=%s)', async (mode) => {
        try {
            const context=await lifecycle.browser.newContext({
                viewport:{
                    width:1280,
                    height:900,
                },
                acceptDownloads:true,
            });
            let page=await context.newPage();
            const creator = page;
            const problems = [collectConsoleProblems(page)];
            await openPdfFromChooser(page, {
                name: 'review-saved.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
            await addNote(page,'review first saved note',{
                x:160,
                y:180,
            });
            const recoveryCount = async () => (await readRecoveries(page)).length;
            await expect.poll(recoveryCount, {timeout: 30_000}).toBe(1);
            const firstDownload=page.waitForEvent('download');
            await page.getByRole('button',{
                name:'Save options',
                exact:true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const firstPath = await (await firstDownload).path();
            expect(firstPath).not.toBeNull();
            expect(Array.from(noteTexts(await PDFDocument.load(readFileSync(firstPath!)))))
                .toContain('review first saved note');
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                await api.waitForActiveDocumentOpenSettled?.();
            });
            await expect.poll(recoveryCount, {timeout: 30_000}).toBe(0);
            if (mode === 'clear-recent') {
                const sourceRef = await page.evaluate(() => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
                });
                const tabId=await page.locator('.tab.is-active[data-tab-id]').first().getAttribute('data-tab-id');
                await page.getByRole('button',{
                    name:'New Tab',
                    exact:true,
                }).click();
                await page.getByRole('button',{
                    name:'Clear Recent Files',
                    exact:true,
                }).click();
                await page.getByRole('button',{
                    name:'Clear History',
                    exact:true,
                }).click();
                await expect.poll(()=>page.getByRole('button',{
                    name:'Remove from Recent',
                    exact:true,
                }).count()).toBe(0);
                expect(await page.evaluate(`(async () => {
                    const {browserDocumentStore} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                    return browserDocumentStore.isStored(${JSON.stringify(sourceRef)});
                })()`)).toBe(true);
                await page.locator(`.tab[data-tab-id="${tabId}"]`).click();
                await page.locator('.page_container--rendered canvas').first().waitFor({timeout:30000});
            }
            if (mode.startsWith('two-window-move')) {
                const target = await context.newPage();
                problems.push(collectConsoleProblems(target));
                await target.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await target.goto(`${lifecycle.origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(target);
                await expect.poll(() => page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return (await api.listTargetWindows?.())?.some(info => info.windowId === 2);
                }), {timeout: 30_000}).toBe(true);
                expect(await page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    return api.transferActiveTabToWindow?.(2);
                })).toMatchObject({success: true});
                await target.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
                if (mode === 'two-window-move-source-stays-open') {
                    // The test bridge transfers the payload. Complete the departing
                    // tab's close through trusted UI while keeping its context alive.
                    await page.locator('.tab.is-active .tab-close').click();
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().waitFor();
                }
                if (mode === 'two-window-move') await page.close();
                page = target;
            }
            await addNote(page,'review second saved note',{
                x:260,
                y:280,
            });
            const downloads: Download[] = [];
            page.on('download', download => downloads.push(download));
            await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).click();
            const workingRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{workingCopyPath: string}>(['workingCopyPath']).workingCopyPath;
            });
            const savedSource = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath;
            });
            await expect.poll(async () => Array.from(noteTexts(await PDFDocument.load(Uint8Array.from(
                await readPersistedDocumentBytes(page, savedSource!),
            )))), {timeout: 15_000}).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            await expect.poll(() => downloads.length, {timeout: 15_000}).toBe(1);
            const downloadedPath = await downloads[0]!.path();
            expect(downloadedPath).not.toBeNull();
            expect(Array.from(noteTexts(await PDFDocument.load(readFileSync(downloadedPath!))))).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            const savedBytes = await readPersistedDocumentBytes(page, workingRef!);
            const savedTexts = Array.from(noteTexts(await PDFDocument.load(Uint8Array.from(savedBytes))));
            expect(savedTexts).toEqual(expect.arrayContaining([
                'review first saved note',
                'review second saved note',
            ]));
            if (mode === 'two-window-move-source-stays-open') {
                expect(creator.isClosed()).toBe(false);
                // Keep the creator context alive through the receiver's final close.
                await page.locator('.tab.is-active .tab-close').click();
                await page.getByRole('button', {
                    name: 'Clear Recent Files',
                    exact: true,
                }).click();
                await page.getByRole('button', {
                    name: 'Clear History',
                    exact: true,
                }).click();
                expect(creator.isClosed()).toBe(false);
            }
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(problems.flat()).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
