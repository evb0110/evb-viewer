import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFName, PDFString, StandardFonts,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, openPdfFromChooser, addNote, noteTexts, settleActiveOpen,
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
});
