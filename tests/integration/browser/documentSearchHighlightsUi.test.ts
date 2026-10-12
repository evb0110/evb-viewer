import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    PDFDocument, PDFName, PDFString, StandardFonts,
} from 'pdf-lib';
import type {Page} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    it('finds a regex match while the search worker is still starting', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            // A first search on a hosted page fetches the worker over the
            // network. Holding that fetch past the 250 ms matching budget
            // checks that the budget counts matching and not worker start-up.
            await page.route(url => url.pathname.includes('browserSearch.worker'), async (route) => {
                await new Promise(resolveDelay => setTimeout(resolveDelay, 1_500));
                await route.continue();
            });
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
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            const regexToggle = page.locator('.document-search-bar button[aria-label="Use regular expression"]:visible');
            if (await regexToggle.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await regexToggle.first().click();
            const searchInput = page.locator('.document-search-bar input:visible').first();
            await searchInput.fill('Fir\\w+');
            await searchInput.press('Enter');

            await expect.poll(
                () => page.locator('.document-search-results:visible').first().textContent(),
                {timeout: 30_000},
            ).toMatch(/1 result|Search unavailable/u);
            expect(await page.locator('.document-search-result:visible .document-search-result-highlight').allTextContents())
                .toEqual(['First']);
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('keeps known PDF regex hits when another document cancels its search', async () => {
        const releaseWorker = Promise.withResolvers<undefined>();
        try {
            const page = await lifecycle.browser.newPage();
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            const bytes = [...readFileSync(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'))];
            await page.evaluate(`(async () => {
                const {browserDocumentStore} = await import('/_nuxt/platform/browserDocumentStore.ts');
                const {createBrowserSearchCapability} = await import('/_nuxt/platform/browser-api/createBrowserSearchCapability.ts');
                const {capability} = createBrowserSearchCapability();
                const refs = [];
                for (const name of ['first.pdf', 'other.pdf']) refs.push(await browserDocumentStore.createStoredDocument(name, Uint8Array.from(${JSON.stringify(bytes)}), {
                    mimeType: 'application/pdf', kind: 'source', retention: 'transient', saveKind: 'pdf',
                }));
                const control = await capability.run(refs[1], 'First');
                if (!control.results.some(hit => hit.excerpt.match === 'First')) throw new Error('PDF text control did not contain First');
                window.__searchPosted = 0;
                const post = Worker.prototype.postMessage;
                Worker.prototype.postMessage = function(message, options) {
                    if (message.type === 'matchPageText') {
                        window.__searchPosted += 1;
                    }
                    return post.call(this, message, options);
                };
                const controls = document.createElement('div');
                controls.style.cssText = 'position:fixed;left:16px;top:16px;z-index:2147483647;background:white;color:black;padding:8px';
                controls.innerHTML = '<button id="search-first">Search first PDF</button><button id="search-other">Search other PDF</button><button id="search-cancel-first">Cancel first search</button><output id="search-first-result">Ready</output><output id="search-other-result">Ready</output>';
                document.body.prepend(controls);
                refs.forEach((ref, index) => {
                    const name = index === 0 ? 'first' : 'other';
                    const requestId = 'core4-search-' + name;
                    const output = controls.querySelector('#search-' + name + '-result');
                    controls.querySelector('#search-' + name).addEventListener('click', event => {
                        if (!event.isTrusted) throw new Error('Search requires trusted input');
                        output.textContent = 'Searching';
                        void capability.run(ref, 'Fir(st)', {requestId, useRegex: true}).then(result => {
                            output.textContent = result.results.map(hit => hit.excerpt.match).join(' | ') || 'No results';
                        }, error => { output.textContent = error.message; });
                    });
                });
                controls.querySelector('#search-cancel-first').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Cancel requires trusted input');
                    void capability.cancel('core4-search-first');
                });
            })()`);
            await page.route(url => url.pathname.includes('browserSearch.worker'), async route => {
                await releaseWorker.promise;
                await route.continue().catch(() => undefined);
            });
            await page.locator('#search-first').click();
            await page.locator('#search-other').click();
            await page.waitForFunction(() => Reflect.get(window, '__searchPosted') === 2);
            await page.locator('#search-cancel-first').click();
            releaseWorker.resolve(undefined);
            await expect.poll(() => page.locator('#search-other-result').textContent(), {timeout: 30_000}).toContain('First');
        } finally {
            releaseWorker.resolve(undefined);
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    it('isolates another document when a DjVu regex is canceled', async () => {
        try {
            const page = await lifecycle.browser.newPage();
            const url = `${lifecycle.origin}/__search-isolation`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body>Search isolation</body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            const result = await page.evaluate<{second: {
                ok: boolean;
                count?: number
            }}>(`(async () => {
            const {searchDjvuWorkerText} = await import('/_nuxt/platform/browser-api/createDjvuWorkerFromPath.ts');
            const worker = text => ({doc:{
                getPagesQuantity:()=>({run:async()=>1}),
                getPagesSizes:()=>({run:async()=>[{width:612,height:792}]}),
                getPage:()=>({getText:()=>({run:async()=>text}),getNormalizedTextZones:()=>({run:async()=>null})})
            }});
            const a = new AbortController(); const b = new AbortController();
            const options = {pageCount:1,matchOptions:{useRegex:true,matchCase:false,wholeWord:false}};
            const first = searchDjvuWorkerText(worker('a'.repeat(250000)+'!'), {...options,query:'a+.a+$',requestId:'review-a',signal:a.signal})
                .then(()=>({ok:true}), e=>({ok:false,name:e.name,message:e.message}));
            await new Promise(r=>setTimeout(r,200));
            const second = searchDjvuWorkerText(worker('hello'), {...options,query:'hello',requestId:'review-b',signal:b.signal})
                .then(r=>({ok:true,count:r.results.length}), e=>({ok:false,name:e.name,message:e.message}));
            await new Promise(r=>setTimeout(r,50)); a.abort();
            return {first:await first, second:await second, secondAborted:b.signal.aborted};
        })()`);
            expect(result.second).toEqual({
                ok:true,
                count:1,
            });
        } finally {await Promise.all(lifecycle.browser.contexts().map(context => context.close()));}
    }, 90_000);

    it('preserves the regex budget across normalization at the page-text cap', async () => {
        try {
            const page = await lifecycle.browser.newPage();
            const url = `${lifecycle.origin}/__search-normalization`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body>Search normalization</body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            const results = await page.evaluate<Array<{
                size: number;
                remainingMs: number;
                nextMatches?: number;
                error?: string
            }>>(`(async () => {
                const {matchBrowserSearchPageWindow: match} = await import('/_nuxt/platform/browser-api/matchBrowserSearchPageWindow.ts');
                const options = {useRegex: true, matchCase: false, wholeWord: false};
                const results = [];
                for (const size of [1000000, 8388608]) {
                    const budget = {remainingMs: 250};
                    const started = performance.now();
                    try {
                        await match('a'.repeat(size), '^Z', options, 501, 0, budget, new AbortController().signal);
                        const next = await match('Z', '^Z', options, 501, 0, budget, new AbortController().signal);
                        results.push({size, elapsedMs: Math.round(performance.now() - started), remainingMs: budget.remainingMs, nextMatches: next.matches.length});
                    } catch (error) {
                        results.push({size, remainingMs: budget.remainingMs, error: String(error)});
                    }
                }
                return results;
            })()`);
            console.info('Normalization budget', JSON.stringify(results));
            expect(results.every(result => !result.error && result.remainingMs > 0 && result.nextMatches === 1)).toBe(true);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it.each([
        {
            label: 'literal without workers',
            fragmented: false,
        },
        {
            label: 'later fragmented window',
            fragmented: true,
        },
    ])('reconciles search highlight text: $label', async ({fragmented}) => {
        const evidenceDir = resolve(process.cwd(), `.devkit/search-highlight-regressions/${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        try {
            const page = await lifecycle.browser.newPage();
            const url = `${lifecycle.origin}/__highlight-window`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><button id="highlight">Highlight selected result</button><div class="pdfViewer"><div id="ink"></div><div id="layer" class="textLayer"></div></div></body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.evaluate(`Promise.all([
                import('/_nuxt/assets/css/main.css'),
                import('/_nuxt/assets/css/pdf-search-highlights.scss'),
            ]).then(() => undefined)`);
            await page.addStyleTag({content: 'body {font: 24px sans-serif} .pdfViewer {position: relative} #ink, #layer {white-space: pre} #layer {position: absolute; inset: 0; color: transparent}'});
            await page.evaluate(`(async () => {
                const {usePdfSearchHighlight} = await import('/_nuxt/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight.ts');
                const {registerTextLayerTextMapping} = await import('/_nuxt/modules/pdf-viewer/engine/search/pdfSearchHighlightDom.ts');
                const fragmented = ${fragmented};
                const items = fragmented ? ['needle', '\\n', ...'needle'] : ['prefix needle'];
                const layer = document.querySelector('#layer');
                document.querySelector('#ink').textContent = items.join('');
                const spans = items.map(text => {
                    const span = document.createElement('span');
                    span.textContent = text;
                    layer.append(span);
                    return span;
                });
                registerTextLayerTextMapping(layer, {textDivs: spans, textContentItemsStr: items});
                if (!fragmented) window.Worker = undefined;
                const highlight = usePdfSearchHighlight();
                document.querySelector('#highlight').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Highlight requires trusted input');
                    const start = fragmented ? 7 : 0;
                    const ordinal = fragmented ? 1 : 0;
                    highlight.highlightPage(layer, {
                        pageIndex: 0, pageText: '', searchQuery: 'needle',
                        searchOptions: {useRegex: fragmented, matchCase: false, wholeWord: false},
                        matches: [{start, end: start + 6, matchIndex: ordinal, pageMatchIndex: ordinal}],
                    }, {pageIndex: 0, startOffset: start, endOffset: start + 6, matchIndex: ordinal, pageMatchIndex: ordinal});
                });
            })()`);
            await page.locator('#highlight').click();
            try {
                await expect.poll(async () => (await page.locator('.pdf-search-highlight--current').allTextContents()).join(''))
                    .toBe('needle');
                expect(await page.locator('#layer').textContent()).toBe(fragmented ? 'needle\nneedle' : 'prefix needle');
                const paint = await page.locator('.pdf-search-highlight--current').first().evaluate(element => ({
                    background: getComputedStyle(element).backgroundColor,
                    width: element.getBoundingClientRect().width,
                }));
                expect(paint.background).not.toBe('rgba(0, 0, 0, 0)');
                expect(paint.width).toBeGreaterThan(0);
                if (fragmented) expect(await page.locator('#layer > span').first().locator('.pdf-search-highlight').count()).toBe(0);
            } finally {
                const label = fragmented ? 'fragmented' : 'literal';
                await page.screenshot({path: resolve(evidenceDir, `${label}.png`)});
                writeFileSync(resolve(evidenceDir, `${label}.json`), JSON.stringify({
                    current: (await page.locator('.pdf-search-highlight--current').allTextContents()).join(''),
                    text: await page.locator('#layer').textContent(),
                }, null, 2));
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it.each([
        true,
        false,
    ])('paints authoritative regex highlights while trusted input stays responsive (known text: %s)', async (knownText) => {
        try {
            // The blank renderer fixture loads product CSS directly.
            const page = await lifecycle.browser.newPage({bypassCSP: true});
            const url = `${lifecycle.origin}/__highlight-responsiveness`;
            await page.route(url, route => route.fulfill({
                contentType: 'text/html',
                body: '<!doctype html><html><body><button id="highlight">Highlight</button><button id="respond">Respond</button><output id="response">Ready</output><div class="pdfViewer"><div id="page-ink"></div><div id="text-layer" class="textLayer"></div></div></body></html>',
            }));
            await page.goto(url, {waitUntil: 'domcontentloaded'});
            await page.evaluate(`Promise.all([
                import('/_nuxt/assets/css/main.css'),
                import('/_nuxt/assets/css/pdf-search-highlights.scss'),
            ]).then(() => undefined)`);
            await page.addStyleTag({content: '.pdfViewer {position: relative} .textLayer {position: absolute; inset: 0; color: transparent}'});
            await page.evaluate(`(async () => {
                const {usePdfSearchHighlight} = await import('/_nuxt/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight.ts');
                const {registerTextLayerTextMapping} = await import('/_nuxt/modules/pdf-viewer/engine/search/pdfSearchHighlightDom.ts');
                const layer = document.querySelector('#text-layer');
                const span = document.createElement('span');
                const text = 'needle ' + 'a'.repeat(250000) + '!';
                document.querySelector('#page-ink').textContent = text;
                span.textContent = text;
                layer.append(span);
                registerTextLayerTextMapping(layer, {textDivs: [span], textContentItemsStr: [text]});
                const highlight = usePdfSearchHighlight();
                document.querySelector('#highlight').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Highlight requires trusted input');
                    highlight.highlightPage(layer, {
                        pageIndex: 0, pageText: ${knownText ? 'text' : '\'\''}, searchQuery: 'needle|a+.a+$',
                        searchOptions: {useRegex: true, matchCase: false, wholeWord: false},
                        matches: [{start: 0, end: 6, matchIndex: 0, pageMatchIndex: 0}],
                    }, null);
                });
                document.querySelector('#respond').addEventListener('click', event => {
                    if (!event.isTrusted) throw new Error('Response requires trusted input');
                    document.querySelector('#response').textContent = 'Responded';
                });
            })()`);
            // Containment also bounds the pre-fix renderer when its click handler
            // runs the pathological failure tail after the valid needle match.
            let containment: ReturnType<typeof setTimeout> | undefined;
            const action = (async () => {
                const started = performance.now();
                await page.locator('#highlight').click();
                await page.locator('#respond').click();
                await expect.poll(() => page.locator('#response').textContent(), {timeout: 1_000}).toBe('Responded');
                const acknowledgementMs = performance.now() - started;
                expect(acknowledgementMs).toBeLessThan(1_000);
                // A failed match cannot verify backend coordinates in unknown layer text.
                await expect.poll(() => page.locator('.pdf-search-highlight').allTextContents()).toEqual(knownText ? ['needle'] : []);
                if (knownText) {
                    const painted = await page.locator('.pdf-search-highlight').evaluate(element => ({
                        background: getComputedStyle(element).backgroundColor,
                        width: element.getBoundingClientRect().width,
                    }));
                    expect(painted.background).not.toBe('rgba(0, 0, 0, 0)');
                    expect(painted.width).toBeGreaterThan(0);
                }
                console.info('Highlight trusted click acknowledgement', acknowledgementMs);
            })();
            try {
                await Promise.race([
                    action,
                    new Promise<never>((_resolve, reject) => {
                        containment = setTimeout(() => reject(new Error('Renderer highlight blocked trusted input for 3 seconds')), 3_000);
                    }),
                ]);
            } finally {
                clearTimeout(containment);
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('stops a catastrophic DjVu regex at the search budget and keeps the page responsive', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
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

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/djvu/search/regex-budget-text-layer.djvu',
            ));
            await page.locator('[data-testid="document-page-source-image"]').first().waitFor({
                state: 'visible',
                timeout: 90_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('DjVu viewer open did not settle');
                }
            });

            const regexToggle = page.locator('.document-search-bar button[aria-label="Use regular expression"]:visible');
            if (await regexToggle.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await regexToggle.first().click();
            const searchInput = page.locator('.document-search-bar input:visible').first();
            await searchInput.fill('a+.a+$');
            await searchInput.press('Enter');

            // Chromium takes quadratic time to match a+.a+$ over this run of a's,
            // longer than the poll below unbounded. The 250 ms budget stops it in
            // the worker, so the search reports the budget error instead.
            await expect.poll(
                () => page.locator('.document-search-results:visible').first().textContent(),
                {timeout: 30_000},
            ).toMatch(/matching budget/u);
            await regexToggle.first().click();
            await expect.poll(() => regexToggle.first().getAttribute('aria-pressed'), {timeout: 1_000}).toBe('false');
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 180_000);

    // #937: identical lines down a page are separate search text, so each
    // copy is a result with its own box on the page.
    it('finds every copy of a line repeated down the page', async () => {
        const pdf = await PDFDocument.create();
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        for (let line = 0; line < 5; line += 1) {
            pdfPage.drawText('The quick brown fox jumps over the lazy dog near the old stone bridge.', {
                font,
                size: 12,
                x: 72,
                y: 700 - line * 40,
            });
        }
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_280,
                height: 900,
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

            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles({
                name: 'repeated-lines.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            const searchInput = page.locator('.document-search-bar input:visible').first();
            if (await searchInput.count() === 0) {
                if (await page.locator('[data-testid="document-sidebar"]:visible').count() === 0) {
                    await page.locator('button[aria-label="Toggle Sidebar"]:visible').first().click();
                }
                await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            }
            await searchInput.fill('fox');
            await searchInput.press('Enter');
            await page.locator('.document-search-result:visible').first().click({timeout: 30_000});

            await expect.poll(() => page.evaluate(() => ({
                summary: document.querySelector('.document-search-results-header-summary')?.textContent?.trim() ?? '',
                boxRows: new Set(Array.from(document.querySelectorAll('.page_container .pdf-word-box'))
                    .map(box => box.getBoundingClientRect())
                    .filter(rect => rect.width > 0)
                    .map(rect => Math.round(rect.top))).size,
            })), {timeout: 30_000}).toEqual({
                summary: expect.stringMatching(/^5 results\b/u),
                boxRows: 5,
            });
            expect(consoleProblems).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);
});

describe('optional search-cache mutation completion proof', () => {
    it.each([
        'denied',
        'blocked',
    ] as const)('commits and displays rotation while optional cache is %s', async (fault) => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdfPage.drawText('Optional cache rotation proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-search-cache-mutation-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, `${fault}-source.pdf`), bytes);
        let page: Page | undefined;
        try {
            page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 900,
            }});
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
            await (await chooser).setFiles({
                name: 'optional-cache-rotation.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered[data-page="1"] canvas').first().waitFor({timeout: 30000});
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Initial real PDF did not settle');
            });
            const workingPath = await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string}>(['workingCopyPath']).workingCopyPath;
            });
            if (!workingPath) throw new Error('Real working document identity is missing');
            if (!await page.locator('[data-thumbnail-page="1"]').first().isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
            }
            await page.locator('[data-thumbnail-page="1"]').first().waitFor({state: 'visible'});
            await page.evaluate(async (mode) => {
                const cacheName = 'evb-browser-search-cache';
                const original = IDBFactory.prototype.open;
                Reflect.set(window, '__br02CacheRequests', 0);
                if (mode === 'denied') {
                    IDBFactory.prototype.open = function(name: string, version?: number) {
                        if (name === cacheName) {
                            Reflect.set(window, '__br02CacheRequests', Reflect.get(window, '__br02CacheRequests') + 1);
                            throw new DOMException('BR02 injected optional cache denial', 'SecurityError');
                        }
                        return version === undefined ? original.call(this, name) : original.call(this, name, version);
                    };
                    Reflect.set(window, '__br02ReleaseCache', () => {IDBFactory.prototype.open = original;});
                    return;
                }
                await new Promise<void>((resolveDelete, rejectDelete) => {
                    const request = indexedDB.deleteDatabase(cacheName);
                    request.onsuccess = () => resolveDelete();
                    request.onerror = () => rejectDelete(request.error);
                    request.onblocked = () => rejectDelete(new Error('Healthy initial cache retained an unexpected connection'));
                });
                const legacy = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = original.call(indexedDB, cacheName, 1);
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                legacy.onversionchange = () => {};
                IDBFactory.prototype.open = function(name: string, version?: number) {
                    const request = version === undefined ? original.call(this, name) : original.call(this, name, version);
                    if (name === cacheName) request.onblocked = () => {
                        Reflect.set(window, '__br02CacheRequests', Reflect.get(window, '__br02CacheRequests') + 1);
                    };
                    return request;
                };
                Reflect.set(window, '__br02ReleaseCache', () => {IDBFactory.prototype.open = original; legacy.close();});
            }, fault);
            await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            let storedBytes: number[] = [];
            await expect.poll(async () => {
                storedBytes = await readPersistedDocumentBytes(page!, workingPath);
                if (!storedBytes.length) return null;
                return (await PDFDocument.load(Uint8Array.from(storedBytes))).getPage(0).getRotation().angle;
            }, {timeout: 15000}).toBe(90);
            writeFileSync(resolve(evidenceDir, `${fault}-committed.pdf`), Buffer.from(storedBytes));
            await expect.poll(() => page!.evaluate(() => Reflect.get(window, '__br02CacheRequests'))).toBeGreaterThan(0);
            writeFileSync(resolve(evidenceDir, `${fault}-committed.json`), JSON.stringify({
                workingPath,
                rotation: 90,
                problems,
            }, null, 2));
            await expect.poll(() => page!.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const r = element.getBoundingClientRect();
                return r.width > r.height;
            }), {timeout: 15000}).toBe(true);
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(await page.locator('.page_container--rendered[data-page="1"] .textLayer').first().textContent()).toContain('Optional cache rotation proof');
            const download = page.waitForEvent('download');
            await page.locator('button[aria-label="Save options"]').first().click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            const savedPath = resolve(evidenceDir, `${fault}-saved.pdf`);
            await (await download).saveAs(savedPath);
            const saved = await PDFDocument.load(readFileSync(savedPath));
            expect(saved.getPage(0).getRotation().angle).toBe(90);
            expect(saved.getPageCount()).toBe(1);
            if (fault === 'denied') expect(problems.length).toBeGreaterThan(0);
            expect(
                problems.every(problem => problem.includes('[search] Optional search-cache invalidation failed')),
                JSON.stringify(problems),
            ).toBe(true);
            writeFileSync(resolve(evidenceDir, `${fault}-result.json`), JSON.stringify({
                workingPath,
                rotation: 90,
                savedRotation: saved.getPage(0).getRotation().angle,
                cacheRequests: await page.evaluate(() => Reflect.get(window, '__br02CacheRequests')),
                problems,
            }, null, 2));
        } finally {
            if (page) {
                await page.screenshot({path: resolve(evidenceDir, `${fault}-final.png`)}).catch(() => {});
                await page.evaluate(() => Reflect.get(window, '__br02ReleaseCache')?.()).catch(() => {});
                await page.close();
            }
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90000);
    it('keeps rotated search boxes on their words without coordinate warnings', async () => {
        const pdf = await PDFDocument.create();
        pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
        pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
        const pdfPage = pdf.addPage([
            612,
            792,
        ]);
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        pdfPage.drawText('Optional cache rotation proof', {
            x: 72,
            y: 700,
            size: 18,
            font,
        });
        const bytes = Buffer.from(await pdf.save());
        const evidenceDir = resolve(process.cwd(), `.devkit/lane-a-1094/browser-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, 'source.pdf'), bytes);
        let page: Page | undefined;
        try {
            page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 900,
            }});
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
            await (await chooser).setFiles({
                name: 'rotated-search.pdf',
                mimeType: 'application/pdf',
                buffer: bytes,
            });
            await page.locator('.page_container--rendered[data-page="1"] canvas').first().waitFor({timeout: 30_000});
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
            });
            if (!await page.locator('[data-thumbnail-page="1"]').first().isVisible()) {
                await page.getByRole('button', {
                    name: 'Toggle Sidebar',
                    exact: true,
                }).click();
                await page.getByRole('tab', {
                    name: 'Pages',
                    exact: true,
                }).click();
            }
            await page.locator('[data-thumbnail-page="1"]').first().click({button: 'right'});
            await page.getByRole('menuitem', {
                name: 'Rotate Clockwise',
                exact: true,
            }).click();
            await expect.poll(() => page!.locator('.page_container--rendered[data-page="1"]').first().evaluate(element => {
                const rect = element.getBoundingClientRect();
                return rect.width > rect.height;
            }), {timeout: 15_000}).toBe(true);
            await page.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Rotated PDF did not settle');
            });
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues?.<{isPageOperationInProgress?: boolean}>(['isPageOperationInProgress'])?.isPageOperationInProgress === false;
            }, undefined, {timeout: 30_000});
            await page.waitForFunction(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.()?.initialVisualReady === true;
            }, undefined, {timeout: 30_000});
            await page.locator('[data-testid="document-sidebar"] [role="tab"]:visible', {hasText: 'Search'}).first().click();
            const input = page.locator('.document-search-bar input:visible').first();
            await input.fill('proof');
            expect(await input.inputValue()).toBe('proof');
            writeFileSync(resolve(evidenceDir, 'before-enter.json'), JSON.stringify(await page.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return {
                    toolbar: api.getActiveToolbarSnapshot?.(),
                    state: api.readActiveWorkspaceStateValues?.([
                        'searchQuery',
                        'isPageOperationInProgress',
                    ]),
                    input: document.querySelector<HTMLInputElement>('.document-search-bar input')?.value,
                };
            }), null, 2));
            await input.press('Enter');
            await expect.poll(() => page!.locator('.document-search-results-header-summary').textContent(), {timeout: 30_000}).toMatch(/^1 result\b/u);
            await page.locator('.document-search-result:visible').first().click();
            const box = page.locator('.page_container[data-page="1"] .pdf-word-box[data-word="proof"]').first();
            await box.waitFor({state: 'visible'});
            const alignment = await box.evaluate(element => {
                const container = element.closest('.page_container')!;
                const canvas = container.querySelector('canvas')!;
                const textLayer = container.querySelector('.textLayer')!;
                const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
                let node: Node | null;
                let wordRange: Range | null = null;
                while ((node = walker.nextNode())) {
                    const at = node.textContent?.indexOf('proof') ?? -1;
                    if (at < 0) continue;
                    wordRange = document.createRange();
                    wordRange.setStart(node, at);
                    wordRange.setEnd(node, at + 5);
                    break;
                }
                if (!wordRange) throw new Error('Rendered proof word is absent');
                const word = wordRange.getBoundingClientRect();
                const highlight = element.getBoundingClientRect();
                const renderedCanvas = canvas.getBoundingClientRect();
                const sx = canvas.width / renderedCanvas.width;
                const sy = canvas.height / renderedCanvas.height;
                const x = Math.floor((word.left - renderedCanvas.left) * sx);
                const y = Math.floor((word.top - renderedCanvas.top) * sy);
                const width = Math.ceil(word.width * sx);
                const height = Math.ceil(word.height * sy);
                const pixels = canvas.getContext('2d')!.getImageData(x, y, width, height).data;
                let darkPixels = 0;
                let paintedPixelsInBox = 0;
                for (let py = 0; py < height; py += 1) {
                    for (let px = 0; px < width; px += 1) {
                        const offset = (py * width + px) * 4;
                        if (pixels[offset]! >= 128 || pixels[offset + 1]! >= 128 || pixels[offset + 2]! >= 128) continue;
                        darkPixels += 1;
                        const clientX = renderedCanvas.left + (x + px + 0.5) / sx;
                        const clientY = renderedCanvas.top + (y + py + 0.5) / sy;
                        if (clientX >= highlight.left && clientX <= highlight.right && clientY >= highlight.top && clientY <= highlight.bottom) paintedPixelsInBox += 1;
                    }
                }
                return {
                    word: word.toJSON(),
                    highlight: highlight.toJSON(),
                    darkPixels,
                    paintedPixelsInBox,
                    wordCenterInsideBox: (word.left + word.right) / 2 >= highlight.left
                        && (word.left + word.right) / 2 <= highlight.right
                        && (word.top + word.bottom) / 2 >= highlight.top
                        && (word.top + word.bottom) / 2 <= highlight.bottom,
                    boxCenterInsideWord: (highlight.left + highlight.right) / 2 >= word.left
                        && (highlight.left + highlight.right) / 2 <= word.right
                        && (highlight.top + highlight.bottom) / 2 >= word.top
                        && (highlight.top + highlight.bottom) / 2 <= word.bottom,
                    canvas: {
                        width: canvas.width,
                        height: canvas.height,
                    },
                };
            });
            writeFileSync(resolve(evidenceDir, 'alignment.json'), JSON.stringify(alignment, null, 2));
            writeFileSync(resolve(evidenceDir, 'console-problems.json'), JSON.stringify(problems, null, 2));
            expect(alignment.darkPixels).toBeGreaterThan(0);
            expect(alignment.paintedPixelsInBox).toBeGreaterThan(0);
            expect(alignment.wordCenterInsideBox).toBe(true);
            expect(alignment.boxCenterInsideWord).toBe(true);
            expect(problems).toEqual([]);
        } finally {
            try {
                if (page) {
                    await page.screenshot({path: resolve(evidenceDir, 'final.png')}).catch(() => {});
                    await page.close();
                }
            } finally {
                await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
            }
        }
    }, 120_000);

});

it.each([
    false,
    true,
])('selects the fragmented second PDF occurrence with trusted search input (regex: %s)', async (regex) => {
    const out = resolve(process.cwd(), '.devkit/core4-r6/app', process.env.PROOF_REVISION ?? 'head', regex ? 'regex-triple' : 'literal-triple');
    mkdirSync(out, {recursive: true});
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const sheet = pdf.addPage([
        612,
        792,
    ]);
    sheet.drawText('needle', {
        x: 72,
        y: 700,
        font,
        size: 24,
    });
    let x = 72;
    for (const [
        index,
        char,
    ] of [...'needle'].entries()) {
        const glyphFont = index % 2 ? bold : font;
        sheet.drawText(char, {
            x,
            y: 650,
            font: glyphFont,
            size: 24,
        });
        x += glyphFont.widthOfTextAtSize(char, 24);
    }
    sheet.drawText('needle', {
        x: 72,
        y: 600,
        font,
        size: 24,
    });
    const bytes = Buffer.from(await pdf.save());
    writeFileSync(resolve(out, 'fixture.pdf'), bytes);
    let page: Page | undefined;
    try {
        page = await lifecycle.browser.newPage({viewport: {
            width: 1280,
            height: 900,
        }});
        // Setup supplies the reviewer's known backend extraction coordinates,
        // without geometry, at the result-to-UI boundary. The actual fixture,
        // PDF.js text layer, search controls and compositor remain real.
        await page.route('**/runtime/composables/usePdfSearch.ts*', async route => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const resultsWithPageIndex = response.results.map';
            if (!source.includes(marker)) throw new Error('Search result setup seam missing');
            const ordinal = 1;
            const start = 7;
            const setup = `response.results = response.results.slice(0, 1).map(result => ({...result, pageNumber: 1, pageMatchIndex: ${ordinal}, matchIndex: ${ordinal}, startOffset: ${start}, endOffset: ${start + 6}, words: undefined, excerpt: {before: '', match: 'needle', after: ''}})); `;
            await route.fulfill({
                response,
                body: source.replace(marker, setup + marker),
            });
        });
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
        await (await chooser).setFiles({
            name: 'glyph-run-search.pdf',
            mimeType: 'application/pdf',
            buffer: bytes,
        });
        const layer = page.locator('.page_container[data-page="1"] .textLayer').first();
        await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
        writeFileSync(resolve(out, 'text-runs.json'), JSON.stringify(await layer.locator(':scope > span').allTextContents(), null, 2));
        await page.evaluate(async () => {
            const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
            if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
        });
        if (!await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).isVisible()) await page.getByRole('button', {
            name: 'Toggle Sidebar',
            exact: true,
        }).click();
        await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).click();
        if (regex) await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();

        const input = page.locator('.document-search-bar input:visible').first();
        await input.fill('needle');
        await input.press('Enter');
        await expect.poll(() => page!.locator('.document-search-result:visible').count(), {timeout: 30000}).toBe(1);
        await page.locator('.document-search-result:visible').first().click();
        await expect.poll(async () => (await layer.locator('.pdf-search-highlight--current').allTextContents()).join(''), {timeout: 10000}).toBe('needle');
        const rects = await layer.locator('.pdf-search-highlight--current').evaluateAll(elements => elements.map(el => ({
            text: el.textContent,
            rect: el.getBoundingClientRect().toJSON(),
            color: getComputedStyle(el).backgroundColor,
        })));
        expect(rects.every(rect => rect.rect.width > 0 && rect.color !== 'rgba(0, 0, 0, 0)')).toBe(true);
        expect(rects).toHaveLength(6);
        expect(await layer.locator(':scope > span').last().locator('.pdf-search-highlight').count()).toBe(0);
        writeFileSync(resolve(out, 'paint.json'), JSON.stringify(rects, null, 2));
    } finally {
        if (page) {
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
            writeFileSync(resolve(out, 'state.json'), JSON.stringify(await page.evaluate(() => ({
                current: [...document.querySelectorAll('.pdf-search-highlight--current')].map(el => el.textContent).join(''),
                all: [...document.querySelectorAll('.textLayer')].map(el => el.textContent),
            })).catch(() => null), null, 2));
            await page.close();
        }
        await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
    }
}, 120000);

it.each([
    'dom',
    'css',
])('real ligature regex overlap preserves the rendered text (%s)', async (mode) => {
    const out = resolve(process.cwd(), '.devkit/core4-r6/app', process.env.PROOF_REVISION ?? 'head', `overlap-${mode}`);
    mkdirSync(out, {recursive: true});
    // Keep actual ligature glyphs and Unicode source ranges in the public PDF.
    const fontData = readFileSync(resolve(process.cwd(), 'public/fonts/annotation/DejaVuSans.ttf'));
    const tables = new Map<string, number>();
    for (let index = 0; index < fontData.readUInt16BE(4); index += 1) {
        const position = 12 + index * 16;
        tables.set(fontData.toString('ascii', position, position + 4), fontData.readUInt32BE(position + 8));
    }
    const cmap = tables.get('cmap')!;
    let glyph = 0;
    for (let index = 0; index < fontData.readUInt16BE(cmap + 2); index += 1) {
        const subtable = cmap + fontData.readUInt32BE(cmap + 4 + index * 8 + 4);
        if (fontData.readUInt16BE(subtable) !== 12) continue;
        for (let group = 0; group < fontData.readUInt32BE(subtable + 12); group += 1) {
            const position = subtable + 16 + group * 12;
            const start = fontData.readUInt32BE(position);
            const end = fontData.readUInt32BE(position + 4);
            if (start <= 0xFB03 && 0xFB03 <= end) glyph = fontData.readUInt32BE(position + 8) + 0xFB03 - start;
        }
    }
    if (!glyph) throw new Error('The public DejaVu font has no ffi ligature');
    const head = tables.get('head')!;
    const hhea = tables.get('hhea')!;
    const hmtx = tables.get('hmtx')!;
    const width = 1000 * fontData.readUInt16BE(hmtx + Math.min(glyph, fontData.readUInt16BE(hhea + 34) - 1) * 4)
        / fontData.readUInt16BE(head + 18);
    const pdf = await PDFDocument.create();
    const sheet = pdf.addPage([
        612,
        792,
    ]);
    const context = pdf.context;
    const fontFile = context.register(context.flateStream(fontData, {Length1: fontData.length}));
    const descriptor = context.register(context.obj({
        Type: 'FontDescriptor',
        FontName: 'DejaVuSans',
        Flags: 4,
        FontBBox: [
            -1021,
            -463,
            1793,
            1232,
        ],
        ItalicAngle: 0,
        Ascent: 928,
        Descent: -236,
        CapHeight: 729,
        StemV: 80,
        FontFile2: fontFile,
    }));
    const gidMap = context.register(context.flateStream(Uint8Array.from([
        0,
        0,
        glyph >> 8,
        glyph & 255,
    ])));
    const descendant = context.register(context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: 'DejaVuSans',
        CIDSystemInfo: {
            Registry: PDFString.of('Adobe'),
            Ordering: PDFString.of('Identity'),
            Supplement: 0,
        },
        FontDescriptor: descriptor,
        DW: 1000,
        W: [
            1,
            [width],
        ],
        CIDToGIDMap: gidMap,
    }));
    const toUnicode = context.register(context.flateStream(`/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Ligature def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfchar
<0001> <FB03>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
`));
    const font = context.register(context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'DejaVuSans',
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: toUnicode,
    }));
    sheet.node.set(PDFName.of('Resources'), context.obj({Font: {F1: font}}));
    sheet.node.addContentStream(context.register(context.flateStream('BT /F1 36 Tf 72 700 Td <00010001> Tj ET')));
    const bytes = Buffer.from(await pdf.save());
    writeFileSync(resolve(out, 'fixture.pdf'), bytes);
    let page: Page | undefined;
    try {
        page = await lifecycle.browser.newPage({viewport: {
            width: 1280,
            height: 900,
        }});
        // Geometry-free results exercise the actual text-layer compositor.
        // The matcher still supplies all four real normalized regex ranges.
        await page.route('**/runtime/composables/usePdfSearch.ts*', async route => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const resultsWithPageIndex = response.results.map';
            if (!source.includes(marker)) throw new Error('Search setup seam missing');
            await route.fulfill({
                response,
                body: source.replace(marker,
                    'response.results = response.results.map(result => ({...result, words: undefined})); ' + marker),
            });
        });
        await page.addInitScript(mode => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            window.localStorage.setItem('pdfHighlightMode', mode);
            window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
        }, mode);
        await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        keepFileChooserInterceptionEnabled(page);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'ligature-overlap.pdf',
            mimeType: 'application/pdf',
            buffer: bytes,
        });
        const layer = page.locator('.page_container[data-page="1"] .textLayer').first();
        await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
        await page.evaluate(async () => {
            if (!await (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi).waitForActiveDocumentOpenSettled?.()) throw new Error('PDF did not settle');
        });
        const before = await layer.textContent();
        expect(before).toBe('ﬃﬃ');
        writeFileSync(resolve(out, 'text-before.json'), JSON.stringify({
            text: before,
            runs: await layer.locator(':scope > span').allTextContents(),
        }, null, 2));
        if (!await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).isVisible()) await page.getByRole('button', {
            name: 'Toggle Sidebar',
            exact: true,
        }).click();
        await page.getByRole('tab', {
            name: 'Search',
            exact: true,
        }).click();
        await page.evaluate(async () => {
            const monitor = Reflect.get(window, '__evbViewerInvariants') as {waitForSettled: (options: {timeoutMs: number}) => Promise<{
                settled: boolean;
                reason?: string
            }>};
            const outcome = await monitor.waitForSettled({timeoutMs: 10000});
            if (!outcome.settled) throw new Error(outcome.reason ?? 'Sidebar layout did not settle');
        });
        // Sidebar opening can change fit-width, so sample ink in this layout.
        const inkBounds = await layer.locator(':scope > span').evaluate(span => {
            const range = document.createRange();
            range.selectNodeContents(span);
            return range.getBoundingClientRect().toJSON();
        });
        await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();
        const input = page.locator('.document-search-bar input:visible').first();
        await input.fill('f|if');
        await input.press('Enter');
        await expect.poll(() => page!.locator('.document-search-result:visible').count(), {timeout: 30000}).toBe(4);
        await page.locator('.document-search-result:visible').nth(2).click();
        const readCurrent = () => mode === 'dom'
            ? layer.locator('.pdf-search-highlight--current').allTextContents().then(texts => texts.join(''))
            : page!.evaluate(() => [...CSS.highlights.get('pdf-search-current-match') ?? []].map(range => range.toString()).join(''));
        await expect.poll(readCurrent, {timeout: 10000}).toBe(before);
        const state = {
            before,
            after: await layer.textContent(),
            current: await readCurrent(),
            paint: await layer.locator('.pdf-search-highlight').allTextContents(),
        };
        writeFileSync(resolve(out, 'state.json'), JSON.stringify(state, null, 2));
        expect(state.after).toBe(before);
        expect(state.current).toBe(before);
        const paintBounds = mode === 'dom'
            ? await layer.locator('.pdf-search-highlight').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()))
            : await page.evaluate(() => [...CSS.highlights.get('pdf-search-current-match') ?? []].flatMap(range => range instanceof Range ? [range.getBoundingClientRect().toJSON()] : []));
        writeFileSync(resolve(out, 'geometry.json'), JSON.stringify({
            inkBounds,
            paintBounds,
        }, null, 2));
        expect(paintBounds.every(rect => rect.width > 0 && rect.left >= inkBounds.left - 1 && rect.right <= inkBounds.right + 1)).toBe(true);
    } finally {
        if (page) {
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
            await page.close();
        }
        await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
    }
}, 120000);
