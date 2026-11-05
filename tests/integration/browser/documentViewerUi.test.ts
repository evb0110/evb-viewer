import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, PDFHexString, StandardFonts, rgb,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, readRecoveries, openPdfFromChooser, readPersistedDocumentBytes, addNote, noteTexts, settleActiveOpen,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    it('keeps the viewport center document point through fit changes and view rotation (R3)', async () => {
        const pdf = await PDFDocument.create();
        for (let index = 0; index < 16; index += 1) {
            pdf.addPage([
                600,
                2_400,
            ]).drawText(`Reading page ${String(index + 1)}`, {
                x: 40,
                y: 1_000,
            });
        }
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_200,
            height: 900,
        }});
        const viewport = page.locator('.workspace-host[data-workspace-active="true"] [data-document-viewer-chassis-viewport]');
        const readingPage = page.locator('.workspace-host[data-workspace-active="true"] .page_container[data-page="7"]');
        const problems = collectConsoleProblems(page);
        const settle = async () => {
            const outcome = await page.evaluate(`(async () => {
                const {waitForViewerSettled} = await import('/_nuxt/modules/viewer-invariants/waitForViewerSettled.ts');
                return waitForViewerSettled();
            })()`);
            expect(outcome).toMatchObject({settled: true});
        };
        const customZoom = async () => {
            await page.locator('#editor-global-toolbar-host .zoom-controls-display:visible').click();
            await page.locator('.zoom-chip-custom-input').fill('200');
            await page.locator('.zoom-chip-custom-input').press('Enter');
            await settle();
        };
        const position = async (x: number, y: number) => {
            // Setup may place the viewport directly. The operations below use
            // trusted toolbar/menu input and are measured from rendered boxes.
            await viewport.evaluate((element) => {
                const first = element.querySelector('.page_container')!.getBoundingClientRect();
                element.scrollTop = 6 * (first.height + 20);
            });
            await readingPage.waitFor({state: 'attached'});
            await readingPage.evaluate((element, point) => {
                const container = element.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const box = element.getBoundingClientRect();
                const frame = container.getBoundingClientRect();
                container.scrollLeft += box.left - frame.left - container.clientLeft + box.width * point.x - container.clientWidth / 2;
                container.scrollTop += box.top - frame.top - container.clientTop + box.height * point.y - container.clientHeight / 2;
            }, {
                x,
                y,
            });
            await settle();
        };
        const read = () => readingPage.evaluate((element) => {
            const container = element.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
            const box = element.getBoundingClientRect();
            const frame = container.getBoundingClientRect();
            return {
                x: (frame.left + container.clientLeft + container.clientWidth / 2 - box.left) / box.width,
                y: (frame.top + container.clientTop + container.clientHeight / 2 - box.top) / box.height,
                width: box.width,
                height: box.height,
            };
        });
        const observations: unknown[] = [];
        const check = async (operation: string, expected: {
            x: number;
            y: number
        }) => {
            await settle();
            const actual = await read();
            const errorX = (actual.x - expected.x) * actual.width;
            const errorY = (actual.y - expected.y) * actual.height;
            observations.push({
                operation,
                expected,
                actual,
                errorX,
                errorY,
            });
            expect.soft(Math.abs(errorX), `${operation}: horizontal document point drift`).toBeLessThanOrEqual(1);
            expect.soft(Math.abs(errorY), `${operation}: vertical document point drift`).toBeLessThanOrEqual(1);
        };
        const rotate = async (direction: 'Clockwise' | 'Counterclockwise') => {
            const item = (text: string) => page.getByRole('menuitem', {
                name: text,
                exact: true,
            });
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await item('View').click();
            await item(`Rotate View ${direction}`).click();
        };
        try {
            await openPdfFromChooser(page, {
                name: 'r3-reading-place.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor();
            await settleActiveOpen(page);
            await customZoom();
            for (const fit of [
                'Fit Width',
                'Fit Height',
                'Fit Width',
            ]) {
                await position(0.5, 0.63);
                const before = await read();
                await page.locator('#editor-global-toolbar-host .zoom-controls-display:visible').click();
                await page.locator('.zoom-dropdown').getByRole('button', {
                    name: fit,
                    exact: true,
                }).click();
                await check(fit, before);
            }
            await customZoom();
            await position(0.4, 0.63);
            const before = await read();
            await rotate('Clockwise');
            await check('rotation 0 to 90', {
                x: 1 - before.y,
                y: before.x,
            });
            await rotate('Counterclockwise');
            await check('rotation 90 to 0', before);
            expect(problems).toEqual([]);
        } finally {
            console.info('R3 center observations', JSON.stringify(observations));
            await page.context().close();
        }
    }, 120_000);

    it('keeps compatible PDF.js assets and unsaved work when a deployment changes in an open tab', async () => {
        const evidenceDir = resolve(process.cwd(), '.devkit/browser-pdfjs-deployment');
        mkdirSync(evidenceDir, {recursive: true});
        const version = readFileSync(resolve('public/pdf/.pdfjs-version'), 'utf8').trim();
        const nextVersion = `${version}-next-deployment`;
        const worker = readFileSync(resolve('public/pdf/pdf.worker.min.mjs'), 'utf8');
        expect(worker).toContain(version);
        const nextWorker = worker.replaceAll(version, nextVersion);
        const requests: Array<{
            path: string;
            afterDeployment: boolean
        }> = [];
        let deployed = false;
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_200,
            height: 900,
        }});
        const problems = collectConsoleProblems(page);
        const active = page.locator('.workspace-host[data-workspace-active="true"]');
        try {
            // The existing server retains content-addressed files, as a clean
            // source deploy does. Only the current, mutable deployment changes.
            // Routing also disables HTTP cache, so a cached worker cannot pass.
            await page.context().route(url => url.pathname.startsWith('/pdf/'), async route => {
                const path = new URL(route.request().url()).pathname;
                requests.push({
                    path,
                    afterDeployment: deployed,
                });
                if (deployed && path === '/pdf/pdf.worker.min.mjs') {
                    await route.fulfill({
                        contentType: 'text/javascript',
                        body: nextWorker,
                    });
                } else if (deployed && path === '/pdf/.pdfjs-version') {
                    await route.fulfill({body: `${nextVersion}\n`});
                } else {
                    await route.continue();
                }
            });
            const makePdf = async (label: string) => {
                const pdf = await PDFDocument.create();
                pdf.addPage([
                    400,
                    600,
                ]).drawText(label, {
                    x: 40,
                    y: 540,
                });
                return {
                    name: `${label}.pdf`,
                    mimeType: 'application/pdf',
                    buffer: Buffer.from(await pdf.save()),
                };
            };
            await openPdfFromChooser(page, await makePdf('Before deployment'));
            await expect.poll(() => active.locator('.textLayer').first().textContent()).toContain('Before deployment');
            await settleActiveOpen(page);
            await addNote(page, 'Unsaved across deployment', {
                x: 100,
                y: 150,
            });
            const firstTab = page.getByRole('tab').filter({hasText: 'Before deployment.pdf'});
            await expect.poll(() => firstTab.getAttribute('class')).toContain('is-dirty');
            const documentToken = await page.evaluate(() => {
                const token = crypto.randomUUID();
                Reflect.set(window, '__pdfjsDeploymentDocument', token);
                return token;
            });
            deployed = true;
            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(await makePdf('After deployment'));
            await expect.poll(() => active.locator('.textLayer').first().textContent()).toContain('After deployment');
            await active.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await settleActiveOpen(page);
            const workers = requests.filter(request => request.path.endsWith('/pdf.worker.min.mjs'));
            expect(workers.some(request => request.afterDeployment)).toBe(true);
            expect(new Set(workers.map(request => request.path)).size).toBe(1);
            expect(await page.evaluate(() => Reflect.get(window, '__pdfjsDeploymentDocument'))).toBe(documentToken);
            await firstTab.click();
            await expect.poll(() => active.locator('.textLayer').first().textContent()).toContain('Before deployment');
            await active.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            expect(await firstTab.getAttribute('class')).toContain('is-dirty');
            const download = page.waitForEvent('download');
            await page.locator('.save-split-primary:visible').first().click();
            const savedPath = resolve(evidenceDir, 'preserved.pdf');
            await (await download).saveAs(savedPath);
            expect(noteTexts(await PDFDocument.load(readFileSync(savedPath)))).toContain('Unsaved across deployment');
            await page.screenshot({path: resolve(evidenceDir, 'preserved.png')});
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'requests.json'), JSON.stringify(requests, null, 2));
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            await page.context().close();
        }
    }, 90_000);

    it('retains a fully visible short indicator page while the center enters a tall page', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        for (const [
            index,
            height,
        ] of [
                120,
                1_000,
                600,
            ].entries()) {
            pdf.addPage([
                400,
                height,
            ]).drawText(`Mixed-size reading page ${String(index + 1)}`, {
                x: 24,
                y: height - 40,
                size: 16,
                font,
            });
        }
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), '.devkit/lane-a-rux2', `app-${String(process.pid)}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const page = await lifecycle.browser.newPage({viewport: {
            width: 900,
            height: 700,
        }});
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'mixed-size-reading.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            const readPosition = () => page.evaluate(() => {
                const first = document.querySelector<HTMLElement>('.page_container[data-page="1"]')!;
                const second = document.querySelector<HTMLElement>('.page_container[data-page="2"]')!;
                const viewport = first.closest<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                const view = viewport.getBoundingClientRect();
                const rects = [
                    first,
                    second,
                ].map(element => {
                    const rect = element.getBoundingClientRect();
                    const width = Math.max(0, Math.min(rect.right, view.left + viewport.clientWidth) - Math.max(rect.left, view.left));
                    const height = Math.max(0, Math.min(rect.bottom, view.top + viewport.clientHeight) - Math.max(rect.top, view.top));
                    return {
                        top: rect.top,
                        bottom: rect.bottom,
                        height: rect.height,
                        fraction: width * height / (rect.width * rect.height),
                        fullyVisible: width >= rect.width && height >= rect.height,
                    };
                });
                return {
                    indicator: document.querySelector('.page-controls-current-primary')!.textContent!.trim(),
                    top: viewport.scrollTop,
                    centerY: view.top + viewport.clientHeight / 2,
                    rects,
                };
            });
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            const before = await readPosition();
            observations.push({
                step: 'open',
                ...before,
            });
            const viewer = page.locator('[data-document-viewer-chassis-viewport]').first();
            await viewer.hover();
            // Put the center inside page 2, rather than exactly on its edge
            // when the fit scale makes the initial distance ten pixels.
            await page.mouse.wheel(0, Math.ceil(before.rects[1]!.top - before.centerY) + 1);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(before.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const after = await readPosition();
            observations.push({
                step: 'trusted-wheel',
                ...after,
            });
            await page.screenshot({path: resolve(evidenceDir, 'retained.png')});
            expect(after.rects[0]!.fullyVisible).toBe(true);
            expect(after.centerY).toBeGreaterThan(after.rects[1]!.top);
            expect(after.rects[0]!.fraction).toBeGreaterThan(after.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 80);
            await expect.poll(async () => (await readPosition()).top).toBeGreaterThan(after.top);
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            const partial = await readPosition();
            observations.push({
                step: 'greatest-fraction',
                ...partial,
            });
            expect(partial.rects[0]!.fullyVisible).toBe(false);
            expect(partial.rects[0]!.fraction).toBeGreaterThan(partial.rects[1]!.fraction);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.mouse.wheel(0, 300);
            await expect.poll(async () => (await readPosition()).rects[0]!.fraction).toBe(0);
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            observations.push({
                step: 'short-page-left-viewport',
                ...await readPosition(),
            });
            await page.screenshot({path: resolve(evidenceDir, 'advanced.png')});
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            try {await page.context().close();} finally {await Promise.all(lifecycle.browser.contexts().map(context => context.close()));}
        }
    }, 90_000);

    it('retains an editable text draft when native appearance fails after a pointer move', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-refused-text-pointer-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const fixture = resolve(process.cwd(), 'tests/fixtures/electron/semtext/unfilled-black-c.pdf');
        const originalText = 'Foreign bordered label';
        const draft = 'Recoverable refused move café';
        const refusal = 'Controlled text appearance refusal';
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_200,
            height: 900,
        }});
        const problems = collectConsoleProblems(page);
        try {
            // Hold one real appearance request, then deliver the worker's normal
            // failure envelope after trusted pointerup has joined its completion.
            await page.addInitScript((message: string) => {
                const held: Array<() => void> = [];
                const responses: Array<{
                    id: unknown;
                    type: unknown;
                    ok: unknown
                }> = [];
                const state = {
                    armed: false,
                    appearances: 0,
                    failures: 0,
                    held,
                    responses,
                };
                Reflect.set(window, '__refusedTextPointerAppearance', state);
                const NativeWorker = window.Worker;
                window.Worker = new Proxy(NativeWorker, {construct(Target, args) {
                    const worker: Worker = Reflect.construct(Target, args);
                    if (!String(args[0]).includes('browserPageOps')) return worker;
                    worker.addEventListener('message', (event) => {
                        const response: unknown = event.data;
                        if (typeof response !== 'object' || response === null) return;
                        responses.push({
                            id: Reflect.get(response, 'id'),
                            type: Reflect.get(response, 'type'),
                            ok: Reflect.get(response, 'ok'),
                        });
                    });
                    const post = worker.postMessage.bind(worker);
                    worker.postMessage = (request: unknown, transfer?: Transferable[] | StructuredSerializeOptions) => {
                        if (typeof request === 'object' && request !== null
                            && Reflect.get(request, 'type') === 'textBoxAppearance') {
                            state.appearances += 1;
                            if (state.armed) {
                                state.armed = false;
                                held.push(() => {
                                    state.failures += 1;
                                    worker.dispatchEvent(new MessageEvent('message', {data: {
                                        id: Reflect.get(request, 'id'),
                                        ok: false,
                                        error: message,
                                    }}));
                                });
                                return;
                            }
                        }
                        if (Array.isArray(transfer)) post(request, transfer);
                        else post(request, transfer);
                    };
                    return worker;
                }});
            }, refusal);
            await openPdfFromChooser(page, fixture);
            const box = page.locator('.editor-pane.is-active .pdf-annotation-editor-text-box');
            await box.waitFor({state: 'visible'});
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            await box.dblclick();
            const editor = box.locator('[contenteditable="true"]');
            await editor.waitFor({state: 'visible'});
            // Control+A selects all only off macOS; on a Mac it moves to the line start.
            await editor.press('ControlOrMeta+A');
            await page.keyboard.type(draft);
            expect(await editor.textContent()).toBe(draft);
            await page.evaluate(async () => {
                await document.fonts.ready;
                await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
            });
            await page.waitForFunction(() => {
                const state = Reflect.get(window, '__refusedTextPointerAppearance');
                return state.appearances === state.responses.filter((response: {type: unknown}) => response.type === 'textBoxAppearance').length;
            });
            await page.evaluate(() => { Reflect.get(window, '__refusedTextPointerAppearance').armed = true; });
            await page.keyboard.press('Control+Enter');
            await page.waitForFunction(() => Reflect.get(window, '__refusedTextPointerAppearance').held.length === 1);
            const before = await box.boundingBox();
            if (!before) throw new Error('The pending text frame is not visible');
            const grip = page.locator('.editor-pane.is-active [data-pdf-annotation-move-handle]');
            const start = await grip.evaluate(element => {
                const rect = element.getBoundingClientRect();
                const x = rect.x + rect.width / 2;
                const y = rect.y + rect.height / 2;
                if (!element.contains(document.elementFromPoint(x, y))) throw new Error('The move grip is obstructed');
                return {
                    x,
                    y,
                };
            });
            await page.mouse.move(start.x, start.y);
            await page.mouse.down();
            await page.mouse.move(start.x + 34, start.y + 22, {steps: 6});
            const preview = await box.boundingBox();
            expect(preview!.x - before.x).toBeCloseTo(34, 1);
            expect(preview!.y - before.y).toBeCloseTo(22, 1);
            await page.mouse.up();
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            await page.screenshot({path: resolve(evidenceDir, 'pointerup-held.png')});
            await page.evaluate(() => {
                Reflect.get(window, '__refusedTextPointerAppearance').held.splice(0).forEach((fail: () => void) => fail());
            });
            await page.waitForFunction(() => Reflect.get(window, '__refusedTextPointerAppearance').responses.some(
                (response: {ok: unknown}) => response.ok === false,
            ));
            await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            await page.screenshot({path: resolve(evidenceDir, 'appearance-refused.png')});
            expect(await page.getByRole('alert').filter({hasText: 'Unable to load the document workspace'}).count(),
                'Native appearance refusal must not escape into the workspace crash boundary').toBe(0);
            expect(await editor.textContent()).toBe(draft);
            expect(await box.getAttribute('class')).toContain('is-editing');
            expect(await box.getAttribute('aria-label')).toBe(originalText);
            const refused = await box.boundingBox();
            expect(refused!.x).toBeCloseTo(before.x, 1);
            expect(refused!.y).toBeCloseTo(before.y, 1);
            expect(problems.filter(problem => !problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toEqual([]);
            expect(problems.filter(problem => problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toHaveLength(1);

            await editor.click();
            await editor.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
            await page.keyboard.type('!');
            expect(await editor.textContent()).toBe(`${draft}!`);
            const download = page.waitForEvent('download');
            await page.locator('.save-split-primary:visible').first().click();
            const savedPath = resolve(evidenceDir, 'recovered.pdf');
            await (await download).saveAs(savedPath);
            const readTextBox = async (path: string) => {
                const pdf = await PDFDocument.load(readFileSync(path));
                const annotation = pdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).asArray()
                    .map(ref => pdf.context.lookup(ref, PDFDict))
                    .find(value => value.get(PDFName.of('Subtype'))?.toString() === '/FreeText')!;
                return {
                    text: annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText(),
                    rect: annotation.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString())),
                };
            };
            const source = await readTextBox(fixture);
            const saved = await readTextBox(savedPath);
            expect(saved.text).toBe(`${draft}!`);
            expect(saved.rect[0]).toBe(source.rect[0]);
            expect(saved.rect[3]).toBe(source.rect[3]);
            const reopened = await lifecycle.browser.newPage({viewport: {
                width: 1_200,
                height: 900,
            }});
            const reopenedProblems = collectConsoleProblems(reopened);
            await openPdfFromChooser(reopened, savedPath);
            const reopenedBox = reopened.locator('.pdf-annotation-editor-text-box');
            await reopenedBox.waitFor({state: 'visible'});
            expect(await reopenedBox.getAttribute('aria-label')).toBe(`${draft}!`);
            await reopened.screenshot({path: resolve(evidenceDir, 'reopened.png')});
            expect(reopenedProblems).toEqual([]);
            expect(problems.filter(problem => !problem.includes('[pdf-renderer] Failed to render canvas for page 1'))).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('retains the readable page and retries failed annotation interaction', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const firstPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        firstPage.drawText('First page for annotation recovery proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        pdfPage.drawText('Readable page with an interactive link', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                690,
                390,
                720,
            ],
            Dest: [
                firstPage.ref,
                PDFName.of('XYZ'),
                null,
                null,
                null,
            ],
        }))]));
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-rux3/app-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        try {
            // Setup injects a persistent PDF.js render rejection. The document and
            // all Open/Retry/link interactions still use the normal user path.
            await page.route('**/services/pdfjs/pdfViewerFacade.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'return layer.render({';
                if (!body.includes(marker)) throw new Error('PDF.js annotation render fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker,
                        'if (Reflect.get(window, "__annotationLayerFailure") && options.page.pageNumber === 2) throw new Error("RUX03 injected annotation stage failure"); ' + marker),
                });
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, '__annotationLayerFailure', false);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'annotation-interaction.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container[data-page="1"] .page_canvas canvas').first().waitFor({state: 'visible'});
            // Slow only the interactions under test: a throttled dev-server
            // startup alone can outlast the open-ready wait on CI runners.
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', true));
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            const container = page.locator('.page_container[data-page="2"]').first();
            const canvas = container.locator('.page_canvas canvas').first();
            await canvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => problems.some(problem => problem.includes('Failed to render annotation layer for page 2'))).toBe(true);
            await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
            await page.screenshot({path: resolve(evidenceDir, 'failed.png')});
            const failed = await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                canvases: Array.from(element.querySelectorAll('canvas')).map(item => ({
                    width: item.width,
                    height: item.height,
                })),
                links: element.querySelectorAll('.annotation-layer a').length,
            }));
            writeFileSync(resolve(evidenceDir, 'failed.json'), JSON.stringify({
                failed,
                problems,
            }, null, 2));
            expect(failed.canvases.some(item => item.width > 0 && item.height > 0)).toBe(true);
            expect(failed.links).toBe(0);
            expect(failed.readiness).not.toBe('ready');
            const toast = page.locator('.app-toast-failure:not([data-state="closed"])').first();
            await expect.poll(() => toast.textContent()).toContain('Page 2 links and annotation interactions could not be loaded.');
            const oldWidth = await canvas.evaluate(element => (element as HTMLCanvasElement).width);
            await page.getByRole('button', {
                name: 'Zoom Out',
                exact: true,
            }).first().click();
            await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).not.toBe(oldWidth);
            await expect.poll(() => problems.filter(problem => problem.includes('Failed to render annotation layer for page 2')).length).toBe(2);
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('failed');
            await page.evaluate(() => Reflect.set(window, '__annotationLayerFailure', false));
            await toast.getByRole('button', {
                name: 'Retry',
                exact: true,
            }).click();
            const link = container.locator('.pdf-link-overlay[role="link"]').first();
            await link.waitFor({
                state: 'visible',
                timeout: 15_000,
            });
            await expect.poll(() => container.getAttribute('data-page-layer-readiness')).toBe('ready');
            writeFileSync(resolve(evidenceDir, 'recovered-dom.json'), JSON.stringify(await container.evaluate(element => ({
                readiness: (element as HTMLElement).dataset.pageLayerReadiness,
                links: Array.from(element.querySelectorAll('a')).map(item => item.outerHTML),
            })), null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'layer-recovered.png')});
            await link.click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.getByRole('button', {
                name: 'Next Page',
                exact: true,
            }).first().click();
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('2');
            await link.waitFor({state: 'visible'});
            await link.focus();
            await page.keyboard.press('Enter');
            await expect.poll(() => page.locator('.page-controls-current-primary').first().innerText()).toBe('1');
            await page.screenshot({path: resolve(evidenceDir, 'recovered.png')});
            expect(problems.filter(problem => !problem.includes('Failed to render annotation layer for page 2'))).toEqual([]);
            expect(problems.filter(problem => problem.includes('Failed to render annotation layer for page 2'))).toHaveLength(2);
        } finally {
            try {
                writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
                await page.context().close();
            } finally {
                await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            }
        }
    }, 90_000);

    // C2/L2/A1: foreign icons paint beside the app's single canonical note marker.
    it('loads a foreign attachment icon from the packaged PDF.js image directory', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const file = pdf.context.register(pdf.context.flateStream('Foreign attachment', {Type: 'EmbeddedFile'}));
        const fileSpec = pdf.context.register(pdf.context.obj({
            Type: 'Filespec',
            F: PDFString.of('foreign.txt'),
            EF: {F: file},
        }));
        const attachment = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'FileAttachment',
            Rect: [
                100,
                600,
                124,
                624,
            ],
            Name: 'Paperclip',
            FS: fileSpec,
            Contents: PDFString.of('Foreign attachment icon'),
        }));
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const foreignText = 'Foreign commented highlight text';
        const ownText = 'Own saved highlight text';
        pdfPage.drawText(foreignText, {
            x: 100,
            y: 700,
            size: 14,
            font,
        });
        pdfPage.drawText(ownText, {
            x: 100,
            y: 550,
            size: 14,
            font,
        });
        const highlightWidth = font.widthOfTextAtSize(foreignText, 14);
        const highlight = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Highlight',
            Rect: [
                100,
                697,
                100 + highlightWidth,
                714,
            ],
            QuadPoints: [
                100,
                714,
                100 + highlightWidth,
                714,
                100,
                697,
                100 + highlightWidth,
                697,
            ],
            C: [
                1,
                1,
                0,
            ],
            CA: 0.3,
            Contents: PDFString.of('Foreign highlight popup'),
        }));
        const ink = pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Ink',
            Rect: [
                100,
                640,
                180,
                670,
            ],
            InkList: [[
                100,
                650,
                140,
                660,
                180,
                650,
            ]],
            C: [
                0,
                0,
                1,
            ],
            BS: {W: 3},
            Contents: PDFString.of('Foreign ink popup'),
        }));
        pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj([
            attachment,
            highlight,
            ink,
        ]));
        const fixtureBytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(process.cwd(), `.devkit/browser-foreign-attachment-${process.pid}.pdf`), fixtureBytes);
        let releaseCapture: (() => Promise<void>) | undefined;
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const responsePromise = page.waitForResponse(response => response.url().endsWith('/annotation-paperclip.svg'));
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-attachment.pdf',
                mimeType: 'application/pdf',
                buffer: fixtureBytes,
            });
            const response = await responsePromise;
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const icon = page.locator('.page_container--rendered .fileAttachmentAnnotation img').first();
            await icon.waitFor({state: 'attached'});
            await expect.poll(() => icon.evaluate(image => (image as HTMLImageElement).complete)).toBe(true);
            const nativePopups = page.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible');
            const popupObservations: Array<{
                label: string;
                hover: number;
                click: number
            }> = [];
            const hoverAndClick = async (x: number, y: number, label: string) => {
                const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
                if (!bounds) throw new Error(`${label} page is not visible`);
                const px = bounds.x + x * bounds.width / 612;
                const py = bounds.y + (792 - y) * bounds.height / 792;
                await page.mouse.move(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const hover = await nativePopups.count();
                await page.mouse.click(px, py);
                await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
                const click = await nativePopups.count();
                popupObservations.push({
                    label,
                    hover,
                    click,
                });
                await page.mouse.click(px, py);
                await page.mouse.move(0, 0);
            };
            await hoverAndClick(140, 705, 'foreign Highlight');
            await hoverAndClick(140, 660, 'foreign Ink');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.locator('.tool-button[data-tool="select"]').click();
            await hoverAndClick(140, 705, 'foreign Highlight in edit mode');
            await hoverAndClick(140, 660, 'foreign Ink in edit mode');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.sidebar-wrapper').evaluate(
                element => element.getBoundingClientRect().width,
            )).toBe(0);
            const foreignMarkerCount = await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count();
            // The recovery owner has built its checkpoint before loading this
            // record. Hold its first dirty capture outside the document lease,
            // so ordinary Save As can supersede it at normal CPU speed.
            await page.evaluate(`(async () => {
                const {getWindowTabsCapability} = await import('/_nuxt/utils/platformWindowTabs.ts');
                const recovery = getWindowTabsCapability().browserRecovery;
                if (!recovery) throw new Error('Browser recovery is unavailable');
                const load = recovery.load.bind(recovery);
                const clear = recovery.clear.bind(recovery);
                let release;
                let released = false;
                const held = new Promise(resolve => { release = resolve; });
                Reflect.set(window, '__releaseForeignCapture', () => {
                    released = true;
                    recovery.load = load;
                    release();
                });
                Reflect.set(window, '__restoreForeignCapture', () => {
                    recovery.load = load;
                    recovery.clear = clear;
                    release();
                });
                recovery.load = async (...args) => {
                    const api = Reflect.get(window, '__evbTestApi');
                    if (!api.getActiveToolbarSnapshot()?.canSave) return load(...args);
                    recovery.load = load;
                    const previous = await load(...args);
                    Reflect.set(window, '__foreignCaptureHeld', {
                        retainedCopies: (previous?.checkpoint.tabs ?? [])
                            .filter(tab => tab.isDirty && tab.workingCopyRef)
                            .map(tab => tab.workingCopyRef),
                    });
                    await held;
                    return previous;
                };
                recovery.clear = async (...args) => {
                    const result = await clear(...args);
                    if (released) {
                        recovery.clear = clear;
                        Reflect.set(window, '__foreignCaptureRetired', true);
                    }
                    return result;
                };
            })()`);
            releaseCapture = async () => {
                if (!page.isClosed()) await page.evaluate(() => Reflect.get(window, '__restoreForeignCapture')?.());
            };
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.toolbar-group-item--quick-note button')
                .getAttribute('aria-pressed')).toBe('true');
            // Resolve the click from the settled page, rather than a copied bounding box.
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 300,
                y: 300,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Canonical note beside a foreign attachment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await expect.poll(() => page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).count()).toBe(foreignMarkerCount + 1);
            expect(await page.locator('.textAnnotation img:visible').count()).toBe(0);
            // Set up an EVB-authored highlight, then exercise its persisted
            // surface through real clicks and text dragging after Save As.
            const createdHighlight = await page.evaluate(async (text) => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                await api.callActiveWorkspaceCommand?.('handleDisableDragMode');
                const span = Array.from(document.querySelectorAll('.text-layer span'))
                    .find(element => element.textContent === text);
                if (!span?.firstChild) throw new Error('Own highlight text is missing');
                const range = document.createRange();
                range.selectNodeContents(span);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return api.callActiveWorkspaceCommand?.('highlightSelection');
            }, ownText);
            expect(createdHighlight?.value).toBe(true);
            await page.locator('[data-markup-subtype="Highlight"]').last()
                .locator('[data-annotation-hit-target]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Open Pop-up Note',
                exact: true,
            }).click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            })
                .fill('Own saved highlight comment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.waitForFunction(() => Boolean(Reflect.get(window, '__foreignCaptureHeld')));
            expect(await page.evaluate(() => Reflect.get(window, '__foreignCaptureHeld').retainedCopies)).toEqual([]);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const downloadPromise = page.waitForEvent('download');
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(process.cwd(), `.devkit/browser-foreign-attachment-saved-${process.pid}.pdf`);
            await (await downloadPromise).saveAs(savedPath);
            const savedPdf = await PDFDocument.load(readFileSync(savedPath));
            const savedAnnots = savedPdf.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
            expect(Array.from({length: savedAnnots.size()}, (_, index) =>
                savedAnnots.lookup(index, PDFDict).lookup(PDFName.of('Subtype'), PDFName).toString(),
            ).filter(subtype => subtype === '/Highlight')).toHaveLength(2);
            expect(Array.from({length: savedAnnots.size()}, (_, index) => {
                const annotation = savedAnnots.lookup(index, PDFDict);
                const contents = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                return contents?.decodeText();
            })).toContain('Own saved highlight comment');
            await expect.poll(() => page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(false);
            await page.evaluate(() => Reflect.get(window, '__releaseForeignCapture')());
            await page.waitForFunction(() => Reflect.get(window, '__foreignCaptureRetired') === true);
            expect(await readRecoveries(page)).toEqual([]);
            const recoveryArtifacts = await page.evaluate(async () => {
                const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                try {
                    return await new Promise<string[]>((resolveArtifacts, rejectArtifacts) => {
                        const request = db.transaction('documents').objectStore('documents').getAll();
                        request.onsuccess = () => resolveArtifacts(request.result
                            .filter((record: {fileName: string}) => record.fileName.endsWith('.recovery.pdf'))
                            .map((record: {fileName: string}) => record.fileName));
                        request.onerror = () => rejectArtifacts(request.error);
                    });
                } finally {
                    db.close();
                }
            });
            expect(recoveryArtifacts).toEqual([]);
            writeFileSync(resolve(process.cwd(), `.devkit/browser-foreign-capture-${process.pid}.json`), JSON.stringify({
                held: await page.evaluate(() => Reflect.get(window, '__foreignCaptureHeld')),
                retired: await page.evaluate(() => Reflect.get(window, '__foreignCaptureRetired')),
                recoveryRecords: await readRecoveries(page),
                recoveryArtifacts,
            }, null, 2));
            // Opening the actual downloaded bytes in a fresh browser page
            // proves this is the saved surface, not the unsaved overlay.
            const reopened = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 800,
            }});
            try {
                const reopenedProblems = collectConsoleProblems(reopened);
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                keepFileChooserInterceptionEnabled(reopened);
                const reopenChooser = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooser).setFiles(savedPath);
                await reopened.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
                await expect.poll(() => reopened.locator('[data-markup-subtype="Highlight"]').count()).toBe(2);
                const savedHighlight = reopened.locator('[data-markup-subtype="Highlight"]').last();
                const hit = savedHighlight.locator('[data-annotation-hit-target]').first();
                const ownLineBounds = await reopened.locator('.text-layer span').filter({hasText: ownText}).first().boundingBox();
                const savedHitBounds = await hit.boundingBox();
                if (!ownLineBounds || !savedHitBounds) throw new Error('Saved highlight is not visible over its text');
                expect(savedHitBounds.x).toBeLessThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.x + savedHitBounds.width).toBeGreaterThan(ownLineBounds.x + ownLineBounds.width / 2);
                expect(savedHitBounds.y).toBeLessThan(ownLineBounds.y + ownLineBounds.height / 2);
                expect(savedHitBounds.y + savedHitBounds.height).toBeGreaterThan(ownLineBounds.y + ownLineBounds.height / 2);
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                await reopened.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await reopened.getByRole('tab', {
                    name: 'Annotations',
                    exact: true,
                }).click();
                await reopened.locator('.tool-button[data-tool="select"]').click();
                const selectTool = reopened.locator('.tool-button[data-tool="select"]');
                await expect.poll(() => selectTool.getAttribute('aria-pressed')).toBe('true');
                // The sidebar toolbar occupies (100, 200); deselect on blank PDF space.
                await reopened.locator('.page_container[data-page="1"]').first().click({position: {
                    x: 12,
                    y: 12,
                }});
                await expect.poll(() => selectTool.getAttribute('aria-pressed')).toBe('true');
                await expect.poll(() => savedHighlight.getAttribute('class')).not.toContain('is-selected');
                await hit.click();
                await expect.poll(() => savedHighlight.getAttribute('class')).toContain('is-selected');
                await reopened.getByRole('button', {
                    name: 'Text Select',
                    exact: true,
                }).click();
                const line = reopened.locator('.text-layer span').filter({hasText: foreignText}).first();
                const lineBounds = await line.boundingBox();
                if (!lineBounds) throw new Error('Commented highlight text is not visible');
                await reopened.mouse.move(lineBounds.x + 1, lineBounds.y + lineBounds.height / 2);
                await reopened.mouse.down();
                await reopened.mouse.move(lineBounds.x + lineBounds.width - 1, lineBounds.y + lineBounds.height / 2, {steps: 12});
                await reopened.mouse.up();
                await expect.poll(() => reopened.evaluate(() => document.getSelection()?.toString())).toBe(foreignText);
                expect(await reopened.locator('.popupAnnotation:visible, .popup:visible, .commentPopup:visible').count()).toBe(0);
                await reopened.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-saved-selection-${process.pid}.png`)});
                expect(reopenedProblems).toEqual([]);
            } finally {
                await reopened.close();
            }
            console.info('Popup observations', JSON.stringify(popupObservations));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-popups-${process.pid}.json`), JSON.stringify(popupObservations, null, 2));
            for (const observation of popupObservations) {
                expect(observation.hover, `${observation.label} hover`).toBe(0);
                expect(observation.click, `${observation.label} click`).toBe(0);
            }
            // Resolve and measure in one browser task: a locator's element
            // handle can be retired by annotation-layer replacement before
            // its later evaluate call runs.
            const readDimensions = () => page.evaluate(() => {
                const image = Array.from(document.querySelectorAll<HTMLImageElement>(
                    '.page_container--rendered .annotation-layer .fileAttachmentAnnotation img',
                )).find(candidate => {
                    const layer = candidate.closest<HTMLElement>('.annotation-layer');
                    const bounds = layer?.getBoundingClientRect();
                    return candidate.isConnected && layer?.isConnected
                        && bounds && bounds.width > 0 && bounds.height > 0
                        && getComputedStyle(layer).visibility !== 'hidden';
                });
                if (!image) return null;
                const rect = image.getBoundingClientRect();
                return {
                    naturalWidth: image.naturalWidth,
                    width: rect.width,
                    height: rect.height,
                    imageStyle: image.getAttribute('style'),
                    containerStyle: image.parentElement?.getAttribute('style'),
                    containerDisplay: image.parentElement && getComputedStyle(image.parentElement).display,
                    scaleFactor: getComputedStyle(image).getPropertyValue('--total-scale-factor'),
                };
            });
            let dimensions!: NonNullable<Awaited<ReturnType<typeof readDimensions>>>;
            await expect.poll(async () => {
                const current = await readDimensions();
                if (!current) return false;
                dimensions = current;
                return true;
            }).toBe(true);
            const bytes = await response.body();
            const observation = {
                url: new URL(response.url()).pathname,
                status: response.status(),
                sha256: createHash('sha256').update(bytes).digest('hex'),
                ...dimensions,
            };
            console.info('Foreign annotation image', JSON.stringify(observation));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.json`), JSON.stringify(observation, null, 2));
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-annotation-icon-${process.pid}.png`)});
            const [pdfjsAssetIdentity] = JSON.parse(readFileSync(resolve('public/pdf/assets.json'), 'utf8')) as string[];
            expect(new URL(response.url()).pathname).toBe(`/pdf/${pdfjsAssetIdentity}/images/annotation-paperclip.svg`);
            expect(response.status()).toBe(200);
            expect(bytes).toEqual(readFileSync(resolve(process.cwd(), 'node_modules/pdfjs-dist/web/images/annotation-paperclip.svg')));
            expect(dimensions.naturalWidth).toBeGreaterThan(0);
            expect(dimensions.width).toBeGreaterThan(0);
            expect(dimensions.height).toBeGreaterThan(0);
            expect(await icon.isVisible()).toBe(true);
            const paintedIcon = await loadImage(Buffer.from(await icon.screenshot()));
            const iconContext = createCanvas(paintedIcon.width, paintedIcon.height).getContext('2d');
            iconContext.drawImage(paintedIcon, 0, 0);
            const pixels = iconContext.getImageData(0, 0, paintedIcon.width, paintedIcon.height).data;
            let inkPixels = 0;
            for (let index = 0; index < pixels.length; index += 4) {
                if (pixels[index]! < 128 && pixels[index + 1]! < 128 && pixels[index + 2]! < 128) {
                    inkPixels += 1;
                }
            }
            expect(inkPixels).toBeGreaterThan(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            try {
                await releaseCapture?.();
            } finally {
                await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            }
        }
    }, 90_000);

    it('keeps the performance restart notice through Settings remount until reload', async () => {
        try {
            const page = await lifecycle.browser.newPage();
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            const settings = page.locator('nav[aria-label="Workspace"]').getByRole('button', {
                name: 'Settings',
                exact: true,
            });
            const notice = page.locator('.settings-performance-restart-notice');
            const chooseMode = async (label: string, mode: string) => {
                await page.getByRole('button', {
                    name: 'Performance mode',
                    exact: true,
                }).click();
                await page.getByRole('option', {
                    name: label,
                    exact: true,
                }).click();
                await page.waitForFunction(value => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').performanceMode === value, mode);
            };
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.textContent()).toBe('Restart to apply this change.');
            await page.getByRole('button', {
                name: 'Recent Files',
                exact: true,
            }).click();
            await settings.click();
            await page.getByRole('button', {
                name: 'Performance mode',
                exact: true,
            }).click();
            await page.keyboard.press('Escape');
            await page.getByRole('listbox').waitFor({state: 'hidden'});
            await page.screenshot({path: resolve(process.cwd(), '.devkit/lane-b/evidence/op-03-remount.png')});
            expect(await notice.count()).toBe(1);
            expect(await notice.textContent()).toBe('Restart to apply this change.');
            expect(await notice.isVisible()).toBe(true);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(0);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(1);
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await settings.click();
            expect(await notice.count()).toBe(0);
            await chooseMode('Auto (recommended)', 'auto');
            await expect.poll(() => notice.count()).toBe(1);
            await chooseMode('Low — minimize background work', 'low');
            await expect.poll(() => notice.count()).toBe(0);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // T3/C2, issue #1037: foreign FreeText is printable when its viewer supplies
    // the appearance. Explicit /AP remains authoritative (ADR 0003).
    it('prints existing FreeText without AP and preserves explicit appearances', async () => {
        const evidence = resolve(process.cwd(), `.devkit/1037/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        let printStartedAt: number | undefined;
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    const image = document.querySelector<HTMLImageElement>('.browser-print-page img');
                    if (!image) throw new Error('No printed page');
                    const canvas = document.createElement('canvas');
                    canvas.width = image.naturalWidth;
                    canvas.height = image.naturalHeight;
                    canvas.getContext('2d')!.drawImage(image, 0, 0);
                    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                    const red: number[][] = [];
                    const cyan: number[][] = [];
                    for (let index = 0; index < pixels.length; index += 4) {
                        const point = [
                            (index / 4) % canvas.width / canvas.width,
                            Math.floor(index / 4 / canvas.width) / canvas.height,
                        ];
                        if (pixels[index]! > 150 && pixels[index + 1]! < 100 && pixels[index + 2]! < 100) red.push(point);
                        if (pixels[index]! < 100 && pixels[index + 1]! > 150 && pixels[index + 2]! > 150) cyan.push(point);
                    }
                    Reflect.set(window.top!, '__freeTextPrint', {
                        red,
                        cyan,
                        image: canvas.toDataURL(),
                    });
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.load(readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')));
            const first = pdf.getPage(0);
            const annotations = first.node.lookup(PDFName.of('Annots'), PDFArray);
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    72,
                    550,
                    350,
                    630,
                ],
                Contents: PDFHexString.fromText('Foreign FreeText\nПривет мир'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
            })));
            const appearance = pdf.context.register(pdf.context.flateStream('0 1 1 rg 0 0 80 80 re f', {
                Type: 'XObject',
                Subtype: 'Form',
                BBox: [
                    0,
                    0,
                    80,
                    80,
                ],
                Resources: {},
            }));
            annotations.push(pdf.context.register(pdf.context.obj({
                Type: 'Annot',
                Subtype: 'FreeText',
                F: 4,
                Rect: [
                    400,
                    550,
                    480,
                    630,
                ],
                Contents: PDFString.of('Explicit AP overrides this red text'),
                DA: PDFString.of('/Helvetica 18 Tf 1 0 0 rg'),
                AP: {N: appearance},
            })));
            const input = Buffer.from(await pdf.save());
            writeFileSync(resolve(evidence, 'input.pdf'), input);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'foreign-freetext-print.pdf',
                mimeType: 'application/pdf',
                buffer: input,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.screenshot({path: resolve(evidence, 'opened.png')});
            printStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__freeTextPrint'))), {timeout: 15_000}).toBe(true);
            const output = await page.evaluate(() => Reflect.get(window, '__freeTextPrint') as {
                red: number[][];
                cyan: number[][];
                image: string;
            });
            writeFileSync(resolve(evidence, 'printed.png'), Buffer.from(output.image.split(',')[1]!, 'base64'));
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                elapsedMs: Date.now() - printStartedAt,
                red: output.red.length,
                cyan: output.cyan.length,
                problems,
            }));
            expect(output.red.length).toBeGreaterThan(200);
            expect(output.cyan.length).toBeGreaterThan(1_000);
            // A4 fit centers the letter page vertically. Both appearances keep
            // their source rectangles, and the explicit AP never becomes text.
            expect(output.red.every(([
                x,
                y,
            ]) => x! >= 72 / 612 && x! < 350 / 612 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(output.cyan.every(([
                x,
                y,
            ]) => x! > 0.65 && x! < 0.79 && y! > 0.2 && y! < 0.34)).toBe(true);
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidence, 'console.json'), JSON.stringify(problems));
            await page.screenshot({path: resolve(evidence, 'final.png')});
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    // T3: printing hands the system dialog every page. The print document
    // once refused rasters above 256 MiB across pages and 64 Mi pixels on
    // one page. Here 41 sheets at 300 DPI need about 1.4 GB of RGBA, and the
    // 28-inch first page alone printed at its size needs 282 MB.
    it('prints every page of a document whose page rasters exceed the former print budgets', async () => {
        const evidence = resolve(process.cwd(), `.devkit/print-every-page/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    // Each source page carries a black bar whose height on the page encodes its number.
                    const printed = Array.from(document.querySelectorAll<HTMLElement>('.browser-print-page'), (section) => {
                        const image = section.querySelector('img');
                        if (!image?.complete || image.naturalWidth === 0) return null;
                        const sample = document.createElement('canvas');
                        sample.width = 50;
                        sample.height = 400;
                        const context = sample.getContext('2d')!;
                        context.drawImage(image, 0, 0, sample.width, sample.height);
                        const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
                        const darkRows: number[] = [];
                        for (let row = 0; row < sample.height; row += 1) {
                            if (pixels[(row * sample.width + 25) * 4]! < 80) darkRows.push(row);
                        }
                        return {
                            width: image.naturalWidth,
                            height: image.naturalHeight,
                            barCenter: darkRows.length ? (darkRows[0]! + darkRows.at(-1)!) / 2 / sample.height : null,
                        };
                    });
                    Reflect.set(window.top!, '__printedPages', printed);
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.create();
            const pageCount = 41;
            for (let index = 0; index < pageCount; index += 1) {
                const pdfPage = pdf.addPage(index === 0 ? [
                    28 * 72,
                    28 * 72,
                ] : [
                    612,
                    792,
                ]);
                const {
                    width, height,
                } = pdfPage.getSize();
                pdfPage.drawRectangle({
                    x: 0,
                    y: height * (1 - (index + 0.5) / pageCount) - height / 400,
                    width,
                    height: height / 200,
                    color: rgb(0, 0, 0),
                });
            }
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'print-every-page.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            const readPrinted = async () => {
                await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__printedPages'))), {timeout: 120_000}).toBe(true);
                return page.evaluate(() => {
                    const printed = Reflect.get(window, '__printedPages') as Array<{
                        width: number;
                        height: number;
                        barCenter: number | null;
                    } | null>;
                    Reflect.deleteProperty(window, '__printedPages');
                    return printed;
                });
            };

            const sheetsStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            const sheets = await readPrinted();
            const sheetsElapsedMs = Date.now() - sheetsStartedAt;
            expect(sheets).toHaveLength(pageCount);
            const sheetBars = sheets.map(sheet => sheet?.barCenter ?? null);
            expect(sheetBars.every(bar => bar !== null)).toBe(true);
            // Every source page reached its own sheet, in order.
            expect(sheetBars.every((bar, index) => index < 2 || bar! > sheetBars[index - 1]!)).toBe(true);

            const currentPageStartedAt = Date.now();
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Print Current Page/u}).click();
            const currentPage = await readPrinted();
            const currentPageElapsedMs = Date.now() - currentPageStartedAt;
            expect(currentPage).toHaveLength(1);
            expect(currentPage[0]).toMatchObject({
                width: Math.ceil(28 * 72 * (300 / 72)),
                height: Math.ceil(28 * 72 * (300 / 72)),
            });
            expect(currentPage[0]!.barCenter).toBeCloseTo(0.5 / pageCount, 2);
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                sheetsElapsedMs,
                currentPageElapsedMs,
                sheets,
                currentPage,
                problems,
            }, null, 2));
            expect(problems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);

    // T6/T3: storage-backed browser PDFs print every sheet, including unsaved notes.
    it('prints a browser PDF above the in-memory limit, its current page and an unsaved note', async () => {
        const evidence = resolve(process.cwd(), `.devkit/browser-print-large-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 800,
        }});
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await page.addInitScript(() => {
                window.print = () => {
                    const sheets = Array.from(document.querySelectorAll<HTMLImageElement>('.browser-print-page img'), image => {
                        if (!image.complete || image.naturalWidth === 0) throw new Error('An unloaded sheet reached window.print');
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth;
                        canvas.height = image.naturalHeight;
                        const context = canvas.getContext('2d')!;
                        context.drawImage(image, 0, 0);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        let inkPixels = 0;
                        let yellowPixels = 0;
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index + 3]! > 8 && Math.min(pixels[index]!, pixels[index + 1]!, pixels[index + 2]!) < 245) inkPixels += 1;
                            if (pixels[index]! > 150 && pixels[index + 1]! > 100 && pixels[index + 2]! < 100) yellowPixels += 1;
                        }
                        return {
                            inkPixels,
                            yellowPixels,
                            image: canvas.toDataURL('image/png'),
                        };
                    });
                    Reflect.set(window.top!, '__largePdfPrintSheets', sheets);
                };
            });
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            for (let index = 0; index < 2; index += 1) {
                const sheet = pdf.addPage([
                    612,
                    792,
                ]);
                sheet.drawText(`Browser large PDF print page ${String(index + 1)}`, {
                    x: 48,
                    y: 710,
                    size: 24,
                    font,
                });
                sheet.drawRectangle({
                    x: 48,
                    y: 560,
                    width: 420,
                    height: 64,
                    color: rgb(0, 0, 0),
                });
            }
            // A referenced, uncompressed stream makes a valid 20 MB PDF rather
            // than trailing padding after EOF, above the 16 MiB in-memory limit.
            pdf.catalog.set(PDFName.of('PrintFixturePadding'), pdf.context.register(pdf.context.stream(Buffer.alloc(20_000_000, 0x20))));
            const bytes = Buffer.from(await pdf.save({useObjectStreams: false}));
            await openPdfFromChooser(page, {
                name: 'browser-print-20mb.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            const source = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.([
                    'pdfSourceState',
                    'totalPages',
                ]);
            });
            expect(source).toMatchObject({
                totalPages: 2,
                pdfSourceState: {
                    hasInMemoryData: false,
                    reloadKind: 'path',
                    reloadPath: expect.stringMatching(/^browser:\/\//u),
                },
            });
            observations.push({
                bytes: bytes.length,
                source,
            });
            const readSheets = async (action: string) => {
                await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__largePdfPrintSheets'))), {timeout: 15_000}).toBe(true);
                const sheets = await page.evaluate(() => {
                    const sheets = Reflect.get(window, '__largePdfPrintSheets') as Array<{
                        inkPixels: number;
                        yellowPixels: number;
                        image: string;
                    }>;
                    Reflect.deleteProperty(window, '__largePdfPrintSheets');
                    return sheets;
                });
                observations.push({
                    action,
                    sheets: sheets.map(({
                        inkPixels, yellowPixels,
                    }) => ({
                        inkPixels,
                        yellowPixels,
                    })),
                });
                for (const [
                    index,
                    sheet,
                ] of sheets.entries()) {
                    writeFileSync(resolve(evidence, `${action}-${String(index + 1)}.png`), Buffer.from(sheet.image.split(',')[1]!, 'base64'));
                    expect(sheet.inkPixels).toBeGreaterThan(1_000);
                }
                return sheets;
            };
            const printAll = async () => {
                await page.getByRole('button', {
                    name: 'Print',
                    exact: true,
                }).click();
                await page.getByRole('button', {
                    name: 'Print...',
                    exact: true,
                }).click();
            };
            await printAll();
            const clean = await readSheets('clean-all');
            expect(clean).toHaveLength(2);
            expect(clean[0]!.yellowPixels).toBe(0);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Print Current Page/u}).click();
            expect(await readSheets('clean-current')).toHaveLength(1);

            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            const note = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await note.fill('Unsaved large PDF print note');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            await printAll();
            const dirty = await readSheets('dirty-all');
            expect(dirty).toHaveLength(2);
            expect(dirty[0]!.yellowPixels).toBeGreaterThan(50);
            expect(dirty[1]!.yellowPixels).toBe(0);
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
        } finally {
            await page.screenshot({path: resolve(evidence, 'workspace.png')});
            writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await page.context().close();
        }
    }, 90_000);

    it('opens URI destinations by pointer and Enter with no opener or console failure', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-external-url-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const destination = `${lifecycle.origin}/privacy-policy`;
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const sourcePage = pdf.addPage([
            612,
            792,
        ]);
        sourcePage.drawText('Open privacy policy', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        sourcePage.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(pdf.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [
                72,
                694,
                260,
                722,
            ],
            Border: [
                0,
                0,
                0,
            ],
            A: {
                S: 'URI',
                URI: PDFString.of(destination),
            },
        }))]));
        const bytes = Buffer.from(await pdf.save());
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const observations: Array<{
            input: string;
            url: string;
            opener: boolean
        }> = [];
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'external-uri.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const link = page.locator('.pdf-link-overlay').first();
            await link.waitFor({state: 'visible'});
            for (const input of [
                'pointer',
                'Enter',
            ]) {
                const openedPage = context.waitForEvent('page');
                if (input === 'pointer') {
                    await link.click();
                } else {
                    await link.focus();
                    await link.press('Enter');
                }
                const destinationPage = await openedPage;
                await destinationPage.waitForURL(destination);
                await destinationPage.waitForLoadState('domcontentloaded');
                const opener = await destinationPage.evaluate(() => window.opener !== null);
                observations.push({
                    input,
                    url: destinationPage.url(),
                    opener,
                });
                expect(destinationPage.url()).toBe(destination);
                expect(opener).toBe(false);
                await destinationPage.close();
            }
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'result.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('starts and opens a PDF without desktop diagnostics or recovery warnings under an Electron-shaped user agent', async () => {
        try {
            // Embedded Electron-based browsers report this user agent without
            // installing the EVB preload bridge.
            const page = await lifecycle.browser.newPage({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Nightly)/0.0.44 Chrome/146.0.0.0 Electron/44.4.2 Safari/537.36',
                viewport: {
                    width: 1_280,
                    height: 900,
                },
            });
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            expect(await page.evaluate(() => 'electronAPI' in window)).toBe(false);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            // The reported tab opened in the background. Headless Chromium
            // keeps every page visible, so emulate the tab being hidden and
            // shown again; showing it heartbeats the recovery lease.
            for (const visibilityState of [
                'hidden',
                'visible',
            ]) {
                await page.evaluate(nextState => new Promise<void>((resolveVisibility) => {
                    Object.defineProperty(document, 'visibilityState', {
                        configurable: true,
                        get: () => nextState,
                    });
                    document.dispatchEvent(new Event('visibilitychange'));
                    setTimeout(resolveVisibility, 0);
                }), visibilityState);
            }

            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('opens the Start file chooser in the click while the workspace chunk is still loading', async () => {
        const workspaceModuleRequested = Promise.withResolvers<undefined>();
        const releaseWorkspaceModule = Promise.withResolvers<undefined>();
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            // Start paints from the tab while the workspace chunk loads. Holding
            // the workspace module keeps that state for as long as the test needs.
            await page.route((url) => url.pathname.endsWith('/workspace-shell/components/DocumentWorkspace.vue')
                && !url.searchParams.has('vue'), async (route) => {
                workspaceModuleRequested.resolve(undefined);
                await releaseWorkspaceModule.promise;
                await route.continue();
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await workspaceModuleRequested.promise;
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // A browser shows a file chooser only within the click's 5 s user
            // activation.
            const chooserPromise = page.waitForEvent('filechooser', {timeout: 5_000});
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            releaseWorkspaceModule.resolve(undefined);
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');
            expect(consoleProblems).toEqual([]);
        } finally {
            releaseWorkspaceModule.resolve(undefined);
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('imports every note when the annotation parse output exceeds 16 MiB', async () => {
        // Desktop reads its parse output without a total byte limit, so the
        // browser lists all 2,500 notes whose parse output is about 21 MB.
        const noteCount = 2_500;
        const pdf = await PDFDocument.create();
        const text = 'Long imported note text. '.repeat(320);
        for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
            const pdfPage = pdf.addPage([
                612,
                792,
            ]);
            pdfPage.node.set(PDFName.of('Annots'), pdf.context.obj(Array.from({length: noteCount / 10}, (_, index) => {
                const x = 20 + (index % 25) * 22;
                const y = 20 + Math.floor(index / 25) * 70;
                return pdf.context.register(pdf.context.obj({
                    Type: 'Annot',
                    Subtype: 'Text',
                    Rect: [
                        x,
                        y,
                        x + 18,
                        y + 18,
                    ],
                    Contents: PDFHexString.fromText(`Note ${pageIndex * (noteCount / 10) + index + 1}. ${text}`),
                    T: PDFString.of('Importer'),
                    NM: PDFString.of(`imported-note-${pageIndex}-${index}`),
                    M: PDFString.of('D:20260101000000Z'),
                    Open: false,
                }));
            })));
        }
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'many-long-notes.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save({useObjectStreams: true})),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.notes-list-header .notes-count:visible').first().textContent(), {timeout: 120_000})
                .toBe(`(${noteCount})`);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);

    it('shows a literal percent sequence in a browser file name exactly on its tab', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles({
                name: 'report%20final.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf')),
            });

            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            );
            await expect.poll(() => activeTab.textContent()).toContain('report%20final.pdf');
            await expect.poll(() => activeTab.getAttribute('aria-label')).toBe('report%20final.pdf');
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('explains the missing components of an indirect DjVu index, then opens it with them', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-index-only-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.deleteProperty(window, 'showOpenFilePicker');
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const indirectDir = resolve(process.cwd(), 'tests/fixtures/djvu/sources/indirect');
            const indexFile = {
                name: 'café-index.djvu',
                mimeType: 'image/vnd.djvu',
                buffer: readFileSync(resolve(indirectDir, 'index.djvu')),
            };

            const chooserPromise = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await chooserPromise).setFiles(indexFile);
            const toast = page.locator('.app-toast-failure');
            await toast.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const text = await toast.innerText();
            writeFileSync(resolve(evidenceDir, 'visible.json'), JSON.stringify({
                text,
                pageErrors,
            }, null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'toast.png')});

            // C4: the failure itself explains why and how to open the document.
            expect(text).toContain('This DjVu index keeps its pages in separate files. Open it again and select the index together with the files next to it.');
            expect(text).not.toContain('The file could not be opened.');
            expect(await toast.count()).toBe(1);

            // Selecting the index with the files beside it opens its pages from them.
            const componentChooser = page.waitForEvent('filechooser');
            await page.locator('.start-open-panel .open-panel-cta').click();
            await (await componentChooser).setFiles([
                indexFile,
                ...[
                    'low-dpi.djvu',
                    'high-dpi.djvu',
                ].map(name => ({
                    name,
                    mimeType: 'image/vnd.djvu',
                    buffer: readFileSync(resolve(indirectDir, name)),
                })),
            ]);
            const sourceImage = page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => sourceImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
            await expect.poll(() => page.locator('.page-controls').first().innerText()).toMatch(/\b2\b/u);
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('café-index.djvu');
            await page.screenshot({path: resolve(evidenceDir, 'opened-with-components.png')});
            expect(pageErrors).toEqual([]);
        } finally {
            await context.close();
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('opens and converts DjVu documents above the former browser limits', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-former-limits-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const openFixture = async (name: string) => {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources', name));
            return {
                page,
                problems,
            };
        };
        try {
            // A 10000x8001 page: 80 million pixels, above the former 45-megapixel open limit.
            const huge = await openFixture('huge-page.djvu');
            const sourceImage = huge.page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await expect.poll(() => sourceImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
            await huge.page.screenshot({path: resolve(evidenceDir, 'huge-page.png')});
            expect(huge.problems).toEqual([]);

            // 501 pages, above the former 500-page conversion limit.
            const many = await openFixture('browser-boundary-501-pages.djvu');
            const pageControls = many.page.locator('.page-controls').first();
            await expect.poll(() => pageControls.innerText(), {timeout: 90_000}).toMatch(/\b501\b/u);
            await many.page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = many.page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 90_000}).toBe(true);
            await convertButton.click();
            await many.page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            await expect.poll(() => many.page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('browser-boundary-501-pages.pdf');
            await expect.poll(() => pageControls.innerText()).toMatch(/\b501\b/u);
            await many.page.screenshot({path: resolve(evidenceDir, 'converted-501.png')});
            expect(many.problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 300_000);

    it('keeps the DjVu outline in a compact PDF at source detail', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-compact-outline-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // Three 96x96 pages; the outline names pages by component id and by number.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bookmark-component-ids.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 60_000}).toBe(true);
            // The recommended method is the compact one; bookmarks are kept by default.
            expect(await dialog.getByRole('checkbox', {name: 'Preserve bookmarks'}).isChecked()).toBe(true);
            await convertButton.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                return api?.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath ?? null;
            });
            expect(pdfRef).toMatch(/\.pdf$/u);
            const bytes = Uint8Array.from(await readPersistedDocumentBytes(page, pdfRef!));
            writeFileSync(resolve(evidenceDir, 'compact.pdf'), bytes);
            const pdf = await PDFDocument.load(bytes, {updateMetadata: false});
            const pageRefs = pdf.getPages().map(pdfPage => pdfPage.ref.toString());
            const outline: string[] = [];
            let node = pdf.context.lookup(pdf.context.lookup(pdf.catalog.get(PDFName.of('Outlines')), PDFDict).get(PDFName.of('First')));
            while (node instanceof PDFDict) {
                const title = node.get(PDFName.of('Title'));
                const destination = node.get(PDFName.of('Dest'));
                const target = destination instanceof PDFArray ? destination.get(0) : null;
                outline.push(`${title instanceof PDFHexString || title instanceof PDFString ? title.decodeText() : ''} -> ${target instanceof PDFRef ? pageRefs.indexOf(target.toString()) + 1 : 0}`);
                node = pdf.context.lookup(node.get(PDFName.of('Next')));
            }
            expect(outline).toEqual([
                'Page one -> 1',
                'Page two component target -> 2',
                'Page three numeric control -> 3',
            ]);
            // Source detail: each page keeps its 96 pixels across.
            const imageWidths = [...pdf.context.enumerateIndirectObjects()]
                .map(([
                    , object,
                ]) => object)
                .filter((object): object is PDFRawStream => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image')
                .map(image => image.dict.get(PDFName.of('Width'))?.toString());
            expect(imageWidths).toEqual([
                '96',
                '96',
                '96',
            ]);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 240_000);

    it('keeps a bitonal DjVu as bilevel masks in a compact PDF', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-compact-masks-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // Page 1 is a JB2 mask; page 2 is an IW44 background only.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {name: /Convert to PDF/u}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const convertButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await expect.poll(() => convertButton.isEnabled(), {timeout: 60_000}).toBe(true);
            await convertButton.click();
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfRef = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                return api?.readActiveWorkspaceStateValues?.<{originalPath: string}>(['originalPath']).originalPath ?? null;
            });
            expect(pdfRef).toMatch(/\.pdf$/u);
            const bytes = Uint8Array.from(await readPersistedDocumentBytes(page, pdfRef!));
            writeFileSync(resolve(evidenceDir, 'compact.pdf'), bytes);
            const pdf = await PDFDocument.load(bytes, {updateMetadata: false});
            // As desktop writes it: page 1, a JB2 mask, stays a bilevel image
            // mask at the source resolution; page 2, background only, is a photo.
            const pageImages = pdf.getPages().map((pdfPage) => {
                const xObjects = pdfPage.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
                const image = xObjects?.values().map(value => pdf.context.lookup(value)).find(value => value instanceof PDFRawStream);
                return image instanceof PDFRawStream
                    ? {
                        width: image.dict.get(PDFName.of('Width'))?.toString(),
                        mask: image.dict.get(PDFName.of('ImageMask'))?.toString() ?? null,
                        filter: image.dict.get(PDFName.of('Filter'))?.toString() ?? null,
                    }
                    : null;
            });
            expect(pageImages).toEqual([
                expect.objectContaining({
                    width: '512',
                    mask: 'true',
                }),
                {
                    width: '512',
                    mask: null,
                    filter: '/DCTDecode',
                },
            ]);
            expect(pageImages[0]?.filter).not.toBe('/DCTDecode');
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 240_000);

    it('prints a DjVu document through the browser print dialog', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-djvu-print-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        try {
            const page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                // The print dialog's sheets, as the browser would print them.
                window.print = () => {
                    const sheets = Array.from(document.querySelectorAll<HTMLImageElement>('.browser-print-page img')).map((image) => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth;
                        canvas.height = image.naturalHeight;
                        canvas.getContext('2d')!.drawImage(image, 0, 0);
                        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
                        let ink = 0;
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index]! < 128 && pixels[index + 1]! < 128 && pixels[index + 2]! < 128) ink += 1;
                        }
                        return {
                            ink,
                            image: canvas.toDataURL(),
                        };
                    });
                    Reflect.set(window.top!, '__djvuPrint', sheets);
                };
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // Page 1 is a JB2 mask of four black lines; page 2 is faint pencil.
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__djvuPrint'))), {timeout: 60_000}).toBe(true);
            const sheets = await page.evaluate(() => Reflect.get(window, '__djvuPrint') as Array<{
                ink: number;
                image: string;
            }>);
            for (const [
                index,
                sheet,
            ] of sheets.entries()) {
                writeFileSync(resolve(evidenceDir, `printed-${index + 1}.png`), Buffer.from(sheet.image.split(',')[1]!, 'base64'));
            }
            expect(sheets).toHaveLength(2);
            expect(sheets[0]!.ink).toBeGreaterThan(1_000);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 180_000);

    it('renders a DjVu open, conversion, and generated PDF reopen in the viewer', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const chooser = await chooserPromise;
            await chooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
            ));

            const sourceImage = page.locator('[data-testid="document-page-source-image"]').first();
            await sourceImage.waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('DjVu viewer open did not settle');
                }
            });
            const sourceEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                sourceImages: document.querySelectorAll('[data-testid="document-page-source-image"]').length,
                sourcePages: document.querySelectorAll('[data-testid="document-page-source-page"]').length,
            }));
            expect(sourceEvidence.sourceImages).toBeGreaterThan(0);
            expect(sourceEvidence.sourcePages).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-open.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: /Convert to PDF/}).filter({visible: true}).first().click();
            const dialog = page.getByRole('dialog');
            await dialog.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            const conversionButton = dialog.getByRole('button', {
                name: 'Convert',
                exact: true,
            });
            await page.waitForFunction(() => {
                const button = Array.from(document.querySelectorAll('[role="dialog"] button'))
                    .find(candidate => candidate.textContent?.trim() === 'Convert');
                return button instanceof HTMLButtonElement && !button.disabled;
            }, null, {timeout: 90_000});
            await conversionButton.click();
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-after-convert.png'),
                fullPage: true,
            });

            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Generated PDF reopen did not settle');
                }
            });
            const renderedPdf = page.locator('.page_container--rendered .page_canvas canvas').first();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 120_000,
            });
            const pdfEvidence = await page.evaluate(() => ({
                bodyText: document.body.innerText,
                renderedCanvases: document.querySelectorAll('.page_container--rendered .page_canvas canvas').length,
            }));
            expect(pdfEvidence.renderedCanvases).toBeGreaterThan(0);
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-pdf-reopen.png'),
                fullPage: true,
            });
            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentPdf = page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: 'bitonal-faint-pencil.pdf'});
            await recentPdf.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentPdf.click();
            await renderedPdf.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"][aria-selected="true"]').textContent())
                .toContain('bitonal-faint-pencil.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-djvu-viewer-reloaded.png'),
                fullPage: true,
            });
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);

    // New Pane keeps the existing document and adds an independent tab area
    // on the requested side (T4 distinguishes it from a split document view).
    it('opens an independent pane to the right with the New Pane Right shortcut', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-pane-shortcut-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const page = await lifecycle.browser.newPage({viewport: {
            width: 1_280,
            height: 900,
        }});
        const problems = collectConsoleProblems(page);
        const readLayout = () => page.locator('.editor-pane:visible').evaluateAll(panes => panes.map(pane => ({
            pane: pane.getBoundingClientRect().toJSON(),
            tabAreas: [...pane.querySelectorAll('[data-tab-list]')].map(tabs => tabs.getBoundingClientRect().toJSON()),
            selectedTabs: [...pane.querySelectorAll('[data-tab-list] [role="tab"][aria-selected="true"]')].map(tab => tab.textContent?.trim()),
        })));
        try {
            await openPdfFromChooser(page, resolve(process.cwd(), 'tests/fixtures/electron/semtext/unfilled-black-c.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor();
            expect(await page.locator('.editor-pane:visible').count()).toBe(1);
            await page.keyboard.press('ControlOrMeta+Backslash');
            await expect.poll(() => page.locator('.editor-pane:visible').count()).toBe(2);
            await page.locator('.editor-pane:visible').nth(1).getByRole('tab', {
                name: 'New Tab',
                exact: true,
            }).waitFor();
            const [
                left,
                right,
            ] = await readLayout();
            expect(left!.selectedTabs).toEqual(['unfilled-black-c.pdf']);
            expect(right!.selectedTabs).toEqual(['New Tab']);
            expect(right!.pane.x).toBeGreaterThanOrEqual(left!.pane.x + left!.pane.width);
            expect(right!.pane.y).toBe(left!.pane.y);
            expect(right!.pane.height).toBe(left!.pane.height);
            for (const view of [
                left!,
                right!,
            ]) {
                expect(view.pane.width).toBeGreaterThan(0);
                expect(view.pane.height).toBeGreaterThan(0);
                expect(view.tabAreas).toHaveLength(1);
                const tabs = view.tabAreas[0]!;
                expect(tabs.width).toBeGreaterThan(0);
                expect(tabs.height).toBeGreaterThan(0);
                expect(tabs.x).toBeGreaterThanOrEqual(view.pane.x);
                expect(tabs.x + tabs.width).toBeLessThanOrEqual(view.pane.x + view.pane.width);
                expect(tabs.y).toBeGreaterThanOrEqual(view.pane.y);
                expect(tabs.y + tabs.height).toBeLessThanOrEqual(view.pane.y + view.pane.height);
            }
            expect(problems).toEqual([]);
        } finally {
            try {
                writeFileSync(resolve(evidenceDir, 'layout.json'), JSON.stringify(await readLayout(), null, 2));
                writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
                await page.screenshot({path: resolve(evidenceDir, 'pane-shortcut.png')});
            } finally {
                await page.context().close();
            }
        }
    }, 90_000);

    // I1: the desktop Edit menu's image accelerators act in the browser, and a
    // paste carries its image where the browser refuses clipboard reads.
    it('inserts images by the Edit menu shortcuts and by a paste with clipboard reading denied', async () => {
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-image-paste-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1_280,
                height: 900,
            },
            permissions: ['clipboard-write'],
        });
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const pngOf = (width: number, height: number, color: string) => {
            const canvas = createCanvas(width, height);
            const context2d = canvas.getContext('2d');
            context2d.fillStyle = color;
            context2d.fillRect(0, 0, width, height);
            return canvas.toBuffer('image/png');
        };
        try {
            const fixture = await PDFDocument.create();
            fixture.addPage([
                612,
                792,
            ]).drawText('Images arrive on this page', {
                x: 40,
                y: 740,
            });
            await openPdfFromChooser(page, {
                name: 'image-shortcuts.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await fixture.save()),
            });
            const pdfPage = page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered').first();
            await pdfPage.locator('canvas').first().waitFor({timeout: 30_000});
            const placement = page.locator('.workspace-host[data-workspace-active="true"] .pdf-image-placement');
            const placeImage = async () => {
                await placement.waitFor({
                    state: 'visible',
                    timeout: 10_000,
                });
                await placement.locator('.pdf-image-placement__action--primary').click();
                await placement.waitFor({
                    state: 'hidden',
                    timeout: 30_000,
                });
            };

            const chooser = page.waitForEvent('filechooser', {timeout: 5_000});
            await page.keyboard.press('ControlOrMeta+Shift+I');
            await (await chooser).setFiles({
                name: 'inserted.png',
                mimeType: 'image/png',
                buffer: pngOf(40, 24, '#1f6feb'),
            });
            await placeImage();

            // Setup: the page writes a PNG to the clipboard in the next click's
            // activation. Reading the clipboard stays denied.
            const pngBase64 = pngOf(48, 32, '#d22f48').toString('base64');
            await page.evaluate((base64) => {
                Reflect.set(window, '__clipboardWritten', new Promise((resolveWrite) => {
                    document.addEventListener('click', () => {
                        const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
                        void navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([bytes], {type: 'image/png'})})])
                            .then(() => resolveWrite('written'), (error: unknown) => resolveWrite(String(error)));
                    }, {
                        capture: true,
                        once: true,
                    });
                }));
            }, pngBase64);
            const box = await pdfPage.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.click(box!.x + box!.width / 2, box!.y + 60);
            expect(await page.evaluate(() => Reflect.get(window, '__clipboardWritten'))).toBe('written');
            const clipboardReadPermission = await page.evaluate(async () => (
                await navigator.permissions.query({name: 'clipboard-read' as PermissionName})
            ).state);
            expect(clipboardReadPermission).toBe('denied');
            // C4: a denied Paste Image command explains the usable alternative.
            await page.keyboard.press('ControlOrMeta+Shift+V');
            const blockedRead = page.getByRole('region').getByText('The browser blocked reading the clipboard. Press Ctrl+V (⌘V on a Mac) to paste the image.', {exact: true});
            await expect.poll(() => blockedRead.isVisible()).toBe(true);
            writeFileSync(resolve(evidenceDir, 'blocked-read.json'), JSON.stringify({
                permission: clipboardReadPermission,
                text: await blockedRead.innerText(),
            }, null, 2));
            await page.screenshot({path: resolve(evidenceDir, 'clipboard-warning.png')});
            await page.keyboard.press('ControlOrMeta+V');
            await placeImage();

            const download = page.waitForEvent('download', {timeout: 30_000});
            await page.keyboard.press('ControlOrMeta+Shift+S');
            const saved = await PDFDocument.load(readFileSync(await (await download).path()));
            const annots = saved.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
            const imageSizes = Array.from({length: annots?.size() ?? 0}, (_, index) => annots!.lookup(index, PDFDict))
                .flatMap((annot) => {
                    const xObjects = annot.lookupMaybe(PDFName.of('AP'), PDFDict)
                        ?.lookupMaybe(PDFName.of('N'), PDFStream)
                        ?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict)
                        ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
                    return (xObjects?.keys() ?? []).map((key) => {
                        const image = xObjects!.lookup(key, PDFStream).dict;
                        return `${String(image.get(PDFName.of('Width')))}x${String(image.get(PDFName.of('Height')))}`;
                    });
                });
            expect(imageSizes.toSorted()).toEqual([
                '40x24',
                '48x32',
            ]);
            writeFileSync(resolve(evidenceDir, 'saved-image-sizes.json'), JSON.stringify(imageSizes.toSorted()));
            expect(problems).toEqual([]);
        } finally {
            try {
                writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
                await page.screenshot({path: resolve(evidenceDir, 'image-paste.png')});
            } finally {
                await context.close();
            }
        }
    }, 120_000);

    it('keeps window menus open through startup and active-document changes', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_024,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        let releaseWorkspace = () => {};
        const workspaceGate = new Promise<void>((resolveGate) => {
            releaseWorkspace = resolveGate;
        });
        let workspaceHeld = false;
        const appMenuTrigger = page.getByRole('button', {
            name: 'Menu',
            exact: true,
        });
        const moreToolsTrigger = page.getByRole('button', {
            name: 'More tools',
            exact: true,
        });
        const menuItem = (name: string) => page.locator('[role="menuitem"], [role="menuitemcheckbox"]').filter({hasText: new RegExp(`^${name}`, 'u')});
        const visibleMenuCount = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))
            .filter(menu => menu.getBoundingClientRect().width > 0).length);
        const selectedTabId = () => page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('data-tab-id');
        // The trigger, or the wrapper the menu library made its trigger, holds focus.
        const hasFocus = (trigger: typeof appMenuTrigger) => trigger.evaluate((button) => {
            const focused = document.activeElement;
            return focused !== null && focused !== document.body && (focused === button || focused.contains(button));
        });
        // Records, on every frame until stopped, what a person sees of the open
        // menus and their trigger: the same trigger node must stay connected and
        // expanded, and the View submenu must keep showing View's entries.
        const startFrameRecorder = (triggerLabel: string) => page.evaluate((label) => {
            const trigger = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
            const frames: Array<{
                menus: number;
                expanded: boolean;
                connected: boolean;
                viewEntries: boolean;
                pagesEntries: boolean;
                workspaceToolbar: boolean;
            }> = [];
            let recording = true;
            const record = () => {
                if (!recording) {
                    return;
                }
                const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]'))
                    .filter(menu => menu.getBoundingClientRect().width > 0);
                const texts = menus.map(menu => menu.textContent ?? '');
                frames.push({
                    menus: menus.length,
                    expanded: trigger?.getAttribute('aria-expanded') === 'true',
                    connected: trigger?.isConnected === true,
                    viewEntries: texts.some(text => text.includes('Zoom In') && text.includes('Fit Height')),
                    pagesEntries: texts.some(text => text.includes('Delete Selected Pages')),
                    workspaceToolbar: document.querySelector('#editor-global-toolbar-host > [role="toolbar"]') !== null,
                });
                requestAnimationFrame(record);
            };
            requestAnimationFrame(record);
            Reflect.set(window, '__menuFrames', {
                frames,
                stop: () => {
                    recording = false;
                },
            });
        }, triggerLabel);
        const readFrames = () => page.evaluate(() => (Reflect.get(window, '__menuFrames') as {frames: Array<Record<string, boolean | number>>;}).frames);
        const stopFrameRecorder = () => page.evaluate(() => (Reflect.get(window, '__menuFrames') as {stop: () => void}).stop());
        const waitForRecordedFrames = (count: number) => page.waitForFunction(
            minimum => (Reflect.get(window, '__menuFrames') as {frames: unknown[]}).frames.length >= minimum,
            count,
            {timeout: 10_000},
        );
        const activeFitHeight = () => page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('.workspace-host[data-workspace-active="true"]');
            const viewport = host?.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]');
            const firstPage = host?.querySelector<HTMLElement>('.page_container--rendered[data-page="1"], [data-testid="document-page-source-image"]');
            if (!viewport || !firstPage) {
                return null;
            }
            return firstPage.getBoundingClientRect().height <= viewport.clientHeight + 1;
        });
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            // Hold only the real workspace module, so the window is ready and
            // its startup toolbar is shown while the workspace still loads.
            await page.route(/\/components\/DocumentWorkspace\.vue(?:\?|$)/u, async (route) => {
                workspaceHeld = true;
                await workspaceGate;
                await route.continue();
            });
            await page.goto(lifecycle.origin, {waitUntil: 'commit'});
            await page.waitForFunction(() => Reflect.get(window, '__appReady') === true, undefined, {timeout: 30_000});
            expect(workspaceHeld, 'the workspace module is held while the window is ready').toBe(true);

            // Startup: Menu and View stay open while the workspace toolbar
            // replaces the startup toolbar.
            await appMenuTrigger.click();
            await menuItem('View').click();
            await menuItem('Zoom In').waitFor();
            await startFrameRecorder('Menu');
            releaseWorkspace();
            await page.locator('#editor-global-toolbar-host > [role="toolbar"]').waitFor({timeout: 30_000});
            await page.waitForFunction(() => {
                const frames = (Reflect.get(window, '__menuFrames') as {frames: Array<{workspaceToolbar: boolean}>}).frames;
                return frames.filter(frame => frame.workspaceToolbar).length >= 10;
            }, undefined, {timeout: 10_000});
            await stopFrameRecorder();
            const startupFrames = await readFrames();
            expect(startupFrames.some(frame => !frame.workspaceToolbar), 'frames before the handoff were recorded').toBe(true);
            expect(startupFrames.filter(frame => frame.menus !== 2 || !frame.expanded || !frame.connected || !frame.viewEntries)).toEqual([]);

            // Escape in the View submenu closes the whole menu, as the menu library
            // does, and Menu's trigger takes focus back.
            await page.keyboard.press('Escape');
            await expect.poll(visibleMenuCount).toBe(0);
            await expect.poll(() => hasFocus(appMenuTrigger)).toBe(true);

            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const fixture = await PDFDocument.create();
            for (const label of [
                'First page',
                'Second page',
            ]) {
                fixture.addPage([
                    400,
                    600,
                ]).drawText(label, {
                    x: 40,
                    y: 540,
                });
            }
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'menu-lifetime.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await fixture.save()),
            });
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered[data-page="1"] canvas').first().waitFor({timeout: 30_000});
            expect(await activeFitHeight()).toBe(false);
            const pdfTabId = await selectedTabId();
            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            await expect.poll(selectedTabId).not.toBe(pdfTabId);
            const emptyTabId = await selectedTabId();

            // Ctrl+Tab to the PDF: the open View submenu stays View and its
            // entries become available; Fit Height acts on the PDF.
            await appMenuTrigger.click();
            await menuItem('View').click();
            await expect.poll(() => menuItem('Zoom In').getAttribute('aria-disabled')).toBe('true');
            await startFrameRecorder('Menu');
            await page.keyboard.press('Control+Tab');
            await expect.poll(selectedTabId).toBe(pdfTabId);
            await expect.poll(() => menuItem('Zoom In').getAttribute('aria-disabled'), {timeout: 15_000}).toBeNull();
            await expect.poll(() => menuItem('Pages').count()).toBe(1);
            await waitForRecordedFrames(10);
            await stopFrameRecorder();
            expect((await readFrames()).filter(frame => frame.menus !== 2 || !frame.connected || !frame.viewEntries || frame.pagesEntries)).toEqual([]);
            await menuItem('Fit Height').click();
            await expect.poll(visibleMenuCount).toBe(0);
            await expect.poll(activeFitHeight, {timeout: 15_000}).toBe(true);

            // Back to the empty tab: View stays open and its entries turn off.
            await appMenuTrigger.click();
            await menuItem('View').click();
            await expect.poll(() => menuItem('Zoom In').getAttribute('aria-disabled')).toBeNull();
            await startFrameRecorder('Menu');
            await page.keyboard.press('Control+Tab');
            await expect.poll(selectedTabId).toBe(emptyTabId);
            await expect.poll(() => menuItem('Zoom In').getAttribute('aria-disabled'), {timeout: 15_000}).toBe('true');
            await expect.poll(() => menuItem('Pages').count()).toBe(0);
            await waitForRecordedFrames(10);
            await stopFrameRecorder();
            expect((await readFrames()).filter(frame => frame.menus !== 2 || !frame.connected || !frame.viewEntries || frame.pagesEntries)).toEqual([]);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await expect.poll(visibleMenuCount).toBe(0);

            // More tools stays open across Ctrl+Tab, Escape hands focus back to
            // its trigger, and an outside click dismisses it for good.
            await moreToolsTrigger.click();
            await expect.poll(visibleMenuCount).toBe(1);
            await startFrameRecorder('More tools');
            await page.keyboard.press('Control+Tab');
            await expect.poll(selectedTabId).toBe(pdfTabId);
            await waitForRecordedFrames(10);
            await stopFrameRecorder();
            expect((await readFrames()).filter(frame => frame.menus !== 1 || !frame.expanded || !frame.connected)).toEqual([]);
            await page.keyboard.press('Escape');
            await expect.poll(visibleMenuCount).toBe(0);
            await expect.poll(() => hasFocus(moreToolsTrigger)).toBe(true);

            await moreToolsTrigger.click();
            await expect.poll(visibleMenuCount).toBe(1);
            const outside = await page.locator('.workspace-host[data-workspace-active="true"] [data-document-viewer-chassis-viewport]').first().boundingBox();
            expect(outside).not.toBeNull();
            await startFrameRecorder('More tools');
            await page.mouse.click(outside!.x + 40, outside!.y + outside!.height - 40);
            await expect.poll(visibleMenuCount).toBe(0);
            await waitForRecordedFrames(30);
            await stopFrameRecorder();
            const outsideFrames = await readFrames();
            const firstClosedFrame = outsideFrames.findIndex(frame => frame.menus === 0);
            expect(firstClosedFrame).toBeGreaterThanOrEqual(0);
            expect(outsideFrames.slice(firstClosedFrame).filter(frame => frame.menus !== 0 || frame.expanded)).toEqual([]);

            // A focused PDF-only entry becomes disabled on a DjVu. The open
            // menu must keep keyboard navigation and run the DjVu command.
            await page.locator(`[role="tab"][data-tab-id="${emptyTabId}"]`).click();
            const djvuChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await djvuChooser).setFiles(resolve(process.cwd(), 'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu'));
            await page.locator('.workspace-host[data-workspace-active="true"] [data-testid="document-page-source-image"]').first().waitFor({timeout: 60_000});
            await appMenuTrigger.click();
            await menuItem('View').click();
            await menuItem('Fit Height').click();
            await expect.poll(activeFitHeight).toBe(true);
            await page.keyboard.press('Control+Tab');
            await expect.poll(selectedTabId).toBe(pdfTabId);
            await moreToolsTrigger.click();
            await page.keyboard.type('single');
            const focusedMenuText = () => page.evaluate(() => document.activeElement?.textContent?.trim());
            await expect.poll(focusedMenuText).toBe('Single Page');
            await page.keyboard.press('Control+Tab');
            await expect.poll(selectedTabId).toBe(emptyTabId);
            await expect.poll(() => menuItem('Single Page').getAttribute('aria-disabled')).toBe('true');
            await expect.poll(() => page.evaluate(() => {
                const focused = document.activeElement;
                return focused !== null && focused.closest('.overflow-menu.toolbar-menu-panel') !== null
                    && !focused.matches(':disabled');
            })).toBe(true);
            await page.keyboard.press('ArrowDown');
            await expect.poll(focusedMenuText).toBe('Fit Height');
            // Expire the menu library's one-second typeahead buffer from "single".
            await page.waitForTimeout(1_100);
            await page.keyboard.press('f');
            await expect.poll(focusedMenuText).toBe('Fit Width');
            await page.keyboard.press('Enter');
            await expect.poll(visibleMenuCount).toBe(0);
            await expect.poll(activeFitHeight).toBe(false);
            expect(problems).toEqual([]);
        } finally {
            releaseWorkspace();
            await context.close();
        }
    }, 120_000);

    it('runs desktop\'s File, Pages and View menu commands from the page menu', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const menuItem = (name: string) => page.locator('[role="menuitem"], [role="menuitemcheckbox"]').filter({hasText: new RegExp(`^${name}`, 'u')});
        const openMenu = async (submenu?: string) => {
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            if (submenu) {
                await menuItem(submenu).click();
            }
        };
        const closeMenu = async () => {
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.getByRole('menu').first().waitFor({state: 'hidden'});
        };
        const choose = async (submenu: string | undefined, name: string) => {
            await openMenu(submenu);
            await menuItem(name).click();
            await page.getByRole('menu').first().waitFor({state: 'hidden'});
        };
        const isLandscape = (pageNumber: number) => page.locator(`.workspace-host[data-workspace-active="true"] .page_container--rendered[data-page="${String(pageNumber)}"]`).first().evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > rect.height;
        });
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            // Without a document desktop's View menu is disabled, and it shows
            // neither view rotation nor a Pages menu.
            await openMenu('View');
            expect(await menuItem('Zoom In').getAttribute('aria-disabled')).toBe('true');
            expect(await menuItem('Rotate View Clockwise').count()).toBe(0);
            await closeMenu();
            await openMenu();
            expect(await menuItem('Pages').count()).toBe(0);
            await closeMenu();

            const fixture = await PDFDocument.create();
            for (const label of [
                'First portrait page',
                'Second portrait page',
            ]) {
                fixture.addPage([
                    400,
                    600,
                ]).drawText(label, {
                    x: 40,
                    y: 540,
                });
            }
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'menu-parity.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await fixture.save()),
            });
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered[data-page="2"] canvas').first().waitFor({timeout: 30_000});
            expect(await isLandscape(1)).toBe(false);
            expect(await isLandscape(2)).toBe(false);

            // Pages: the selection commands wait for a selected page.
            await openMenu('Pages');
            expect(await menuItem('Delete Selected Pages').getAttribute('aria-disabled')).toBe('true');
            expect(await menuItem('Insert Pages').getAttribute('aria-disabled')).toBeNull();
            await closeMenu();
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            const selectFirst = page.locator('.workspace-host[data-workspace-active="true"] [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle');
            await selectFirst.click();
            await expect.poll(() => selectFirst.getAttribute('aria-pressed')).toBe('true');
            await openMenu('Pages');
            expect(await menuItem('Delete Selected Pages').getAttribute('aria-disabled')).toBeNull();
            await menuItem('Rotate Clockwise').click();
            await expect.poll(() => isLandscape(1)).toBe(true);
            expect(await isLandscape(2)).toBe(false);
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress: boolean}>(['isPageOperationInProgress']).isPageOperationInProgress === false;
            });

            // View: the shortcut the browser honors is shown; view rotation
            // turns every page, and the chosen layout is checked.
            await openMenu('View');
            expect(await menuItem('Zoom In').innerText()).toMatch(/(?:⌘|Ctrl\+)=/u);
            expect(await menuItem('Rotate View Clockwise').getAttribute('aria-disabled')).toBeNull();
            await menuItem('Rotate View Clockwise').click();
            await expect.poll(() => isLandscape(2)).toBe(true);
            expect(await isLandscape(1)).toBe(false);
            await choose('View', 'Facing Pages');
            await expect.poll(() => page.evaluate(() => {
                const [
                    first,
                    second,
                ] = [
                    1,
                    2,
                ].map(pageNumber => document.querySelector(`.workspace-host[data-workspace-active="true"] .page_container--rendered[data-page="${String(pageNumber)}"]`)!.getBoundingClientRect());
                return Math.abs(first!.top - second!.top) < 2 && second!.left >= first!.right - 1;
            })).toBe(true);
            await openMenu('View');
            expect(await menuItem('Facing Pages').getAttribute('aria-checked')).toBe('true');
            expect(await menuItem('Single Page').getAttribute('aria-checked')).toBe('false');
            await closeMenu();

            // File and View: tabs and panes.
            const tabs = page.locator('[data-tab-list] [role="tab"]');
            const tabCount = await tabs.count();
            await openMenu();
            expect(await menuItem('New Tab').innerText()).not.toMatch(/⌘|Ctrl\+/u);
            await menuItem('New Tab').click();
            await expect.poll(() => tabs.count()).toBe(tabCount + 1);
            // Each tab's workspace brings its own toolbar, and with it the menu.
            await page.locator('.workspace-host[data-workspace-active="true"] .workspace-transfer-content').waitFor();
            await choose(undefined, 'Close Tab');
            await expect.poll(() => tabs.count()).toBe(tabCount);
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered canvas').first().waitFor();
            await choose('View', 'New Pane Right');
            await expect.poll(() => page.locator('.editor-pane[data-editor-pane-id]').count()).toBe(2);
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);
});
