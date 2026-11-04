import {
    createHash, randomBytes,
} from 'node:crypto';
import {
    readFileSync, writeFileSync, mkdirSync,
} from 'node:fs';
import {
    basename, resolve,
} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import {chromium} from 'playwright';
import type {
    Download, Page,
} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    installPickerHandleFixture, openPdfFromChooser, lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, paneSelector, readPanePageWidth, zoomActivePane, readBrowserPayloadCounts, settleActiveOpen,
} from './documentLifecycleTestHelpers';

// A six-page portrait PDF whose pages read "<label> page <n>".
async function createReadingBook(label: string, name: string) {
    const pdf = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
        pdf.addPage([
            400,
            600,
        ]).drawText(`${label} page ${String(pageNumber)}`, {
            x: 40,
            y: 500,
            size: 24,
        });
    }
    return {
        name,
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
    };
}

// What the reader sees of the active view: the toolbar's page and zoom, and
// the page in the middle of the viewport with its painted orientation.
function readReadingView(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector('.workspace-host[data-workspace-active="true"]');
        const viewport = host?.getBoundingClientRect();
        const visible = Array.from(host?.querySelectorAll<HTMLElement>('.page_container--rendered') ?? []).find((container) => {
            const rect = container.getBoundingClientRect();
            return viewport && rect.bottom > viewport.top + viewport.height / 4 && rect.top < viewport.bottom - viewport.height / 4;
        });
        const rect = visible?.getBoundingClientRect();
        return {
            indicator: document.querySelector('.page-controls-current-primary')?.textContent?.trim(),
            zoom: document.querySelector('.zoom-controls-display-value')?.textContent?.trim(),
            visibleText: visible?.querySelector('.textLayer')?.textContent?.trim(),
            landscape: rect ? rect.width > rect.height : null,
        };
    });
}

// Opens a reading book through Start's Open File button and the file chooser.
async function openReadingBook(page: Page, label: string, name: string) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {
        name: 'Open File',
        exact: true,
    }).first().click();
    await (await chooser).setFiles(await createReadingBook(label, name));
    await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe(`${label} page 1`);
    await settleActiveOpen(page);
}

describe('browser document lifecycle UI', () => {

    it.each([
        'corrupt',
        'clean',
        'future-storage',
        'future-cookie',
        'future-between-pages',
    ] as const)('recovers browser settings without overwriting another version (%s)', async (scenario) => {
        // The full headless browser supports history-cache restores; the
        // default headless shell always reports every tab as visible.
        const historyBrowser = scenario === 'future-between-pages'
            ? await chromium.launch({
                headless: true,
                channel: 'chromium',
                ignoreDefaultArgs: ['--disable-back-forward-cache'],
            })
            : null;
        const context = await (historyBrowser ?? lifecycle.browser).newContext({viewport: {
            width: 1280,
            height: 1000,
        }});
        const page = await context.newPage();
        const settingsKey = 'evb-viewer:browser:settings';
        const cookieKey = 'evb_viewer_settings';
        const supported = JSON.stringify({
            ...DEFAULT_SETTINGS,
            authorName: 'Compatible author',
        }, null, 2);
        const future = JSON.stringify({
            ...DEFAULT_SETTINGS,
            version: 99,
            authorName: 'Future author must not be adopted',
            clientDiagnosticsPreference: 'granted',
        }, null, 2);
        const requests: string[] = [];
        const problems: string[] = [];
        const historyMisses: unknown[] = [];
        context.on('request', request => requests.push(request.url()));
        page.on('pageerror', error => problems.push(error.message));
        await context.route('**/api/1/envelope/**', route => route.fulfill({
            status: 200,
            body: '{}',
        }));
        const evidenceDirectory = process.env.EVB_SETTINGS_EVIDENCE_DIR;
        if (evidenceDirectory) mkdirSync(evidenceDirectory, {recursive: true});
        async function capture(phase: string) {
            const evidence = {
                scenario,
                phase,
                browser: lifecycle.browser.version(),
                ready: await page.evaluate(() => Reflect.get(window, '__appReady') === true),
                stored: await page.evaluate(key => localStorage.getItem(key), settingsKey),
                cookie: (await context.cookies()).find(cookie => cookie.name === cookieKey)?.value ?? null,
                diagnosticsRequests: requests.filter(url => /@sentry|sentry[_/.]|\/api\/1\/envelope/iu.test(url)),
                problems,
                resumeEvents: await page.evaluate(() => Reflect.get(window, '__settingsResumeEvents') as string[] | undefined),
                historyMisses,
            };
            console.info('Browser settings evidence', JSON.stringify(evidence));
            if (evidenceDirectory) {
                writeFileSync(resolve(evidenceDirectory, `${scenario}-${phase}.json`), JSON.stringify(evidence, null, 2));
                await page.screenshot({path: resolve(evidenceDirectory, `${scenario}-${phase}.png`)});
            }
            return evidence;
        }
        try {
            const notice = page.getByText('Saved settings could not be used, so defaults were restored.', {exact: false});
            const newerNotice = page.getByText('These settings were saved by a newer version of EVB Viewer. They are kept unchanged, and this version uses its defaults and cannot save settings. Open the newer version to change them.', {exact: false});
            const loadApp = async (load: () => Promise<unknown>) => {
                await load();
                // Bootstrap adds the notice before it reports the app ready.
                await page.waitForFunction(() => Reflect.get(window, '__appReady') === true, undefined, {timeout: 60_000});
            };
            if (scenario.startsWith('future-')) {
                // Seed a fresh origin before any app script runs. Whitespace in
                // these raw values makes a parse-and-rewrite lose byte parity.
                await context.addInitScript(({
                    key, value,
                }) => {
                    if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
                }, {
                    key: settingsKey,
                    value: scenario === 'future-storage' ? future : supported,
                });
                await context.addCookies([{
                    name: cookieKey,
                    value: encodeURIComponent(scenario === 'future-cookie' ? future : supported),
                    url: lifecycle.origin,
                }]);
            }
            await loadApp(() => page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'}));
            if (scenario === 'corrupt') {
                await expect(notice.count()).resolves.toBe(0);

                // Setup: storage corrupted outside the app, as by a crash mid-write or an extension.
                await page.evaluate(() => window.localStorage.setItem('evb-viewer:browser:settings', '{"version": 2, "authorName": '));
                await loadApp(() => page.reload({waitUntil: 'domcontentloaded'}));
                await notice.first().waitFor({timeout: 10_000});
                const stored = await page.evaluate(() => window.localStorage.getItem('evb-viewer:browser:settings'));
                expect(JSON.parse(stored ?? 'null')).toMatchObject({version: 2});

                await loadApp(() => page.reload({waitUntil: 'domcontentloaded'}));
                await expect(notice.count()).resolves.toBe(0);
                return;
            }
            if (scenario === 'future-storage' || scenario === 'future-cookie') {
                await newerNotice.first().waitFor();
                await capture('startup');
            } else {
                expect(await newerNotice.count()).toBe(0);
                expect(await notice.count()).toBe(0);
            }
            await page.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const author = page.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            const consent = page.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            expect(await consent.isChecked()).toBe(false);
            expect(await author.inputValue()).toBe(scenario === 'future-between-pages' ? 'Compatible author' : '');
            if (scenario === 'future-between-pages') {
                await page.evaluate(() => {
                    const events: string[] = [];
                    Reflect.set(window, '__settingsResumeEvents', events);
                    document.addEventListener('visibilitychange', () => events.push(document.visibilityState));
                    window.addEventListener('pageshow', event => events.push(`pageshow:${String(event.persisted)}`));
                });
                // The peer supplies a newer version's bytes. Loading another
                // copy of this old app would contend with its cached document
                // lease and make Chromium evict A before pageshow can run.
                const away = `${lifecycle.origin}/__settings-history-away`;
                await context.route(away, route => route.fulfill({
                    contentType: 'text/html',
                    body: '<p>Settings history navigation fixture</p>',
                }));
                const second = await context.newPage();
                await second.goto(away);
                const session = await context.newCDPSession(page);
                await session.send('Page.enable');
                session.on('Page.backForwardCacheNotUsed', event => historyMisses.push(event));
                // Resume the original page from the history cache after another
                // page writes newer settings. A reload would lose this listener
                // and cannot satisfy the persisted pageshow assertion.
                await page.goto(away);
                await second.evaluate(({
                    key, value,
                }) => localStorage.setItem(key, value), {
                    key: settingsKey,
                    value: future,
                });
                await page.goBack({waitUntil: 'commit'});
                await page.waitForFunction(() => {
                    const events = Reflect.get(window, '__settingsResumeEvents') as string[] | undefined;
                    return events?.includes('pageshow:true');
                });
                await session.detach();
                expect(await author.inputValue()).not.toBe('Future author must not be adopted');
                expect(await consent.isChecked()).toBe(false);
            }
            if (scenario !== 'clean') {
                // A real keyboard event also exercises error reporting. Future
                // consent must neither load the SDK nor transmit an envelope.
                await author.evaluate(element => element.addEventListener('keydown', () => {
                    throw new Error('Settings compatibility input failure');
                }, {once: true}));
                await author.press('ArrowRight');
                await page.locator('.app-toast-error-id').first().waitFor();
            }
            await author.fill(`Saved by ${scenario}`);
            if (scenario === 'clean') {
                await page.waitForFunction(({
                    key, name,
                }) => JSON.parse(localStorage.getItem(key) ?? '{}').authorName === name, {
                    key: settingsKey,
                    name: `Saved by ${scenario}`,
                });
                expect(await newerNotice.count()).toBe(0);
                expect(await page.getByText('Last save failed', {exact: true}).count()).toBe(0);
            } else {
                await page.getByText('Last save failed', {exact: true}).first().waitFor();
                const refused = await capture('save-refused');
                expect(refused.stored).toBe(scenario === 'future-cookie' ? supported : future);
                // A supported legacy cookie is migrated away on a normal start.
                expect(refused.cookie).toBe(scenario === 'future-between-pages' ? null : encodeURIComponent(scenario === 'future-cookie' ? future : supported));
                expect(refused.diagnosticsRequests).toEqual([]);
                if (scenario === 'future-between-pages') {
                    // The other version releases ownership. The same live page
                    // can save again without a reload or private settings API.
                    await context.addCookies([{
                        name: cookieKey,
                        value: encodeURIComponent(supported),
                        url: lifecycle.origin,
                    }]);
                    await page.evaluate(({
                        key, value,
                    }) => localStorage.setItem(key, value), {
                        key: settingsKey,
                        value: supported,
                    });
                    await author.fill('Saved after compatible settings returned');
                    await page.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? '{}').authorName === 'Saved after compatible settings returned', settingsKey);
                }
            }
            expect((await capture('passed')).diagnosticsRequests).toEqual([]);
        } finally {
            try {
                await capture('final');
            } finally {
                try {
                    await context.close();
                } finally {
                    await historyBrowser?.close();
                }
            }
        }
    }, 120_000);

    it('withdraws hosted diagnostics in another open window and allows an explicit regrant', async () => {
        try {
            const context = await lifecycle.browser.newContext();
            const envelopes: string[] = [];
            await context.route('**/api/1/envelope/**', async (route) => {
                envelopes.push(route.request().postData() ?? '');
                await route.fulfill({
                    status: 200,
                    body: '{}',
                });
            });
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            const first = await context.newPage();
            await first.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(first);
            await first.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const consent = first.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');

            const second = await context.newPage();
            await second.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(second);
            await second.getByRole('button', {
                name: 'Settings',
                exact: true,
            }).filter({visible: true}).first().click();
            const remoteConsent = second.getByRole('switch', {
                name: 'Send privacy-sanitized error diagnostics',
                exact: true,
            });
            const author = second.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            async function reportInputFailure(phase: string) {
                const previousIds = await second.locator('.app-toast-error-id').allTextContents();
                // Fault a real input handler, then reach it through trusted keyboard
                // input. Unique causes prevent Sentry deduplication hiding a send.
                await second.evaluate((message) => {
                    document.querySelector('#settings-author')!.addEventListener('keydown', () => {
                        throw new Error(message);
                    }, {once: true});
                }, phase);
                await author.press('ArrowRight');
                const receipt = await second.waitForFunction((previous) => {
                    const id = Array.from(document.querySelectorAll('.app-toast-error-id'))
                        .map(element => element.textContent ?? '')
                        .find(text => !previous.includes(text));
                    return id?.replace('Error ID: ', '');
                }, previousIds);
                const id = await receipt.jsonValue();
                if (!id) throw new Error('The visible failure has no Error ID');
                return id;
            }
            const grantedId = await reportInputFailure('granted-control');
            await expect.poll(() => envelopes.some(body => body.includes(grantedId))).toBe(true);
            // Pause delivery of the committed denial, without retaining an
            // unrelated IndexedDB transaction needed by the first window's save.
            const session = await context.newCDPSession(second);
            try {
                await session.send('Debugger.enable');
                const paused = new Promise<void>(resolvePaused => session.once('Debugger.paused', () => resolvePaused()));
                await session.send('DOMDebugger.setEventListenerBreakpoint', {eventName: 'storage'});
                await consent.uncheck();
                await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'denied');
                await paused;
            } finally {
                await session.send('DOMDebugger.removeEventListenerBreakpoint', {eventName: 'storage'}).catch(() => undefined);
                await session.send('Debugger.resume').catch(() => undefined);
                await session.detach();
            }
            await author.fill('After withdrawal');
            await second.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').authorName === 'After withdrawal');
            const withdrawnId = await reportInputFailure('withdrawn-control');
            const checkedAfterWithdrawal = await remoteConsent.isChecked();
            await consent.check();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'granted');
            await expect.poll(() => remoteConsent.isChecked()).toBe(true);
            const regrantedId = await reportInputFailure('regranted-control');
            await expect.poll(() => envelopes.some(body => body.includes(regrantedId))).toBe(true);
            console.info('Hosted consent evidence', JSON.stringify({
                granted: envelopes.some(body => body.includes(grantedId)),
                withdrawn: envelopes.some(body => body.includes(withdrawnId)),
                regranted: envelopes.some(body => body.includes(regrantedId)),
                checkedAfterWithdrawal,
            }));
            expect(envelopes.some(body => body.includes(withdrawnId))).toBe(false);
            expect(checkedAfterWithdrawal).toBe(false);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

    // T2/T4: reading an information page keeps accepted work and both live views.
    it('preserves an unsaved note and linked view zoom through Privacy and About routes', async () => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1_600,
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
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Accepted note survives information routes';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            expect(await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(text);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
            const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
            const right = panes[1]!;
            await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30_000});
            await zoomActivePane(page, right, 'Zoom Out', 1);
            const widths = await Promise.all(panes.map(pane => readPanePageWidth(page, pane)));
            expect(widths[0]).not.toBe(widths[1]);
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-information-before.png')});

            for (const informationPage of [
                'privacy',
                'about',
            ]) {
                if (informationPage === 'privacy') {
                    await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note`).last().click();
                    await page.getByRole('button', {
                        name: 'Minimize note',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} .pdf-annotation-editor-note.is-selected`).count()).toBe(1);
                } else {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                const currentPage = await page.locator('.page-controls-current-primary:visible').textContent();
                const activeTabs = await page.locator('.tab.is-active[data-tab-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-tab-id')));
                let unexpectedChoosers = 0;
                let unexpectedDownloads = 0;
                const onChooser = () => { unexpectedChoosers += 1; };
                const onDownload = () => { unexpectedDownloads += 1; };
                page.on('filechooser', onChooser);
                page.on('download', onDownload);
                await page.getByRole('button', {
                    name: 'Settings',
                    exact: true,
                }).filter({visible: true}).first().click();
                const tabCount = await page.locator('.tab[data-tab-id]').count();
                await page.getByRole('link', {
                    name: informationPage === 'privacy'
                        ? 'Read the complete privacy notice' : 'Open About and Acknowledgements',
                    exact: true,
                }).filter({visible: true}).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe(`/${informationPage}`);
                await page.locator(`.${informationPage}-document h1`).waitFor();
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}.png`)});
                const documentKeys = [
                    'Backspace',
                    'Delete',
                    'Control+s',
                    'PageDown',
                    'Control+=',
                    'Control+b',
                ];
                for (const key of documentKeys) {
                    await page.keyboard.press(key);
                }
                // Window-level tab and file accelerators must also belong to
                // the visible shell, rather than its retained document owner.
                await page.keyboard.press('Control+Shift+Tab');
                for (const key of [
                    ...documentKeys,
                    'Control+o',
                ]) {
                    await page.keyboard.press(key);
                }
                if (informationPage === 'about') {
                    await page.getByRole('link', {
                        name: 'Back to viewer',
                        exact: true,
                    }).click();
                } else {
                    await page.goBack();
                }
                await expect.poll(() => new URL(page.url()).pathname).toBe('/');
                await page.locator('.editor-pane .tab[data-tab-id]').first().waitFor();
                page.off('filechooser', onChooser);
                page.off('download', onDownload);
                expect(unexpectedChoosers).toBe(0);
                expect(unexpectedDownloads).toBe(0);
                expect(await page.locator('.tab[data-tab-id]').count()).toBe(tabCount);
                // Settings itself is a new empty tab; the document tab in
                // each pane remains selected when returning to it below.
                expect(await page.locator(`${paneSelector(panes[0]!)} .tab.is-active[data-tab-id]`).getAttribute('data-tab-id')).toBe(activeTabs[0]);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-returned-shell.png`)});
                await page.locator(`${paneSelector(right)} .tab`).filter({hasText: 'generated-text.pdf'}).click();
                await page.locator('.page-controls-current-primary:visible').waitFor();
                expect(await page.locator('.page-controls-current-primary:visible').textContent()).toBe(currentPage);
                await page.getByRole('button', {
                    name: 'Open Note',
                    exact: true,
                }).filter({visible: true}).last().click();
                expect(await page.getByRole('textbox', {
                    name: 'Write annotation note',
                    exact: true,
                }).inputValue()).toBe(text);
                await page.getByRole('button', {
                    name: 'Minimize note',
                    exact: true,
                }).click();
                expect(await page.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
                if (informationPage === 'about') {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                    expect(await page.locator(`${paneSelector(right)} [data-thumbnail-page="1"] .pdf-thumbnail-selection-toggle`).getAttribute('aria-pressed')).toBe('true');
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                expect(await Promise.all(panes.map(pane => readPanePageWidth(page, pane)))).toEqual(widths);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-return.png`)});
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
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

            const validChooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const validChooser = await validChooserPromise;
            await validChooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));

            const renderedCanvas = page.locator('.page_container--rendered canvas').first();
            await renderedCanvas.waitFor({
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
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            const canvasCountBefore = await page.locator('.page_container--rendered canvas').count();

            const corruptChooserPromise = page.waitForEvent('filechooser');
            await page.keyboard.press('Control+O');
            const corruptChooser = await corruptChooserPromise;
            await corruptChooser.setFiles({
                name: 'corrupt-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ncorrupt and truncated'),
            });

            await page.locator('.app-toast-failure').filter({hasText: 'Failed to open file'}).waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            await expect.poll(() => renderedCanvas.isVisible()).toBe(true);
            expect(await page.locator('.page_container--rendered canvas').count())
                .toBe(canvasCountBefore);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 90_000);

    it.each([
        [
            'removal',
            'Remove from Recent',
            undefined,
        ],
        [
            'clear',
            'Clear Recent Files',
            'Clear History',
        ],
    ] as const)('keeps an open document source when Recent Files %s meets an unreadable dependent record', async (_action, buttonName, confirmName) => {
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
                name: 'recent-dependent.pdf',
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
            // The open document's source record, found by its file name.
            const sourceRef = await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                for (const key of await loadAllRecordKeys()) {
                    const found = await loadRecord(key);
                    if (found?.fileName === 'recent-dependent.pdf' && found.kind === 'source') return key;
                }
                return null;
            })()`);
            expect(typeof sourceRef).toBe('string');
            // Opening the file also creates a readable working copy that names the source,
            // which keeps the source by itself. Remove those copies so the unreadable record
            // below is the only dependent of the source.
            await page.evaluate(`(async () => {
                const {loadAllRecordKeys, loadRecord, runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                const dependents = [];
                for (const key of await loadAllRecordKeys()) {
                    if ((await loadRecord(key))?.sourceRef === ${JSON.stringify(sourceRef)}) dependents.push(key);
                }
                await runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    for (const key of dependents) transaction.objectStore(DOCUMENTS_STORE).delete(key);
                    setResult(true);
                });
            })()`);
            // A working record that names the source but cannot be decoded. The helper
            // resolves null when its database cannot open, so the write is asserted.
            const planted = await page.evaluate(`(async () => {
                const {runObjectStoresTransaction} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                const {DOCUMENTS_STORE} = await import('/_nuxt/platform/browser/browserDocumentConstants.ts');
                return runObjectStoresTransaction([DOCUMENTS_STORE], 'readwrite', (transaction, setResult) => {
                    transaction.objectStore(DOCUMENTS_STORE).put({
                        ref: 'browser://documents/unreadable-dependent.pdf',
                        sourceRef: ${JSON.stringify(sourceRef)},
                        kind: 'working',
                        storageMode: 'source-proxy',
                    });
                    setResult(true);
                });
            })()`);
            expect(planted).toBe(true);

            await page.getByRole('button', {
                name: 'New Tab',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: buttonName,
                exact: true,
            }).click();
            if (confirmName) {
                await page.getByRole('button', {
                    name: confirmName,
                    exact: true,
                }).click();
            }
            await expect.poll(() => page.getByRole('button', {
                name: 'Remove from Recent',
                exact: true,
            }).count()).toBe(0);
            // The row can leave the list before the detached cleanup that follows the
            // removal has finished. An awaited cleanup of the same ref, serialized behind
            // it, settles the outcome before the stored record is read.
            await page.evaluate(`(async () => {
                const {browserDocumentStore} = await import('/_nuxt/platform/browser/browserDocumentRepository.ts');
                await browserDocumentStore.cleanupDetachedDocument(${JSON.stringify(sourceRef)});
            })()`);
            // Read the stored record and its first chunk on a raw connection: the bytes helper
            // reads nothing whenever its database connection fails to open.
            const stored = await page.evaluate<{
                present: boolean;
                chunkBytes: number | null
            }>(`(async () => {
                const database = await new Promise((resolve, reject) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const transaction = database.transaction(['documents', 'document-chunks'], 'readonly');
                const read = (store, key) => new Promise((resolve, reject) => {
                    const request = transaction.objectStore(store).get(key);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const record = await read('documents', ${JSON.stringify(sourceRef)});
                const chunk = record?.storageMode === 'chunked'
                    ? await read('document-chunks', ${JSON.stringify(sourceRef)} + '::' + record.chunkGeneration + '::0')
                    : undefined;
                database.close();
                return {present: Boolean(record), chunkBytes: chunk?.data?.byteLength ?? chunk?.byteLength ?? null};
            })()`);
            expect(stored.present).toBe(true);
            expect(stored.chunkBytes).toBeGreaterThan(0);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120_000);

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
                expect(await peer.evaluate(`(async () => {
                    const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    const row = await loadRecord(${JSON.stringify(ref)});
                    return {mode: row?.storageMode, chunks: row?.chunkCount};
                })()`)).toEqual({
                    mode: 'chunked',
                    chunks: 2,
                });
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

    // R4: with "Reopen documents where I left off" off, a document opened in
    // the tab that closing the last tab leaves starts at page 1 with the
    // default zoom and no view rotation, whatever the closed document showed.
    it('opens the next PDF in the emptied last tab at its defaults, not the closed view', async () => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await openReadingBook(page, 'First', 'first.pdf');
            const opened = await readView();
            expect(opened).toMatchObject({
                indicator: '1',
                landscape: false,
            });

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            // The browser shows no view-rotation control yet (desktop has it in its View menu).
            await page.evaluate(() => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!testApi?.callActiveWorkspaceSyncCommand?.('handleViewRotationCw').called) throw new Error('View rotation is unavailable');
            });
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'First page 4',
                landscape: true,
            });

            await page.getByRole('button', {name: 'Close Tab'}).click();
            await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').count()).toBe(1);
            await waitForOpenFileReady(page);
            await openReadingBook(page, 'Second', 'second.pdf');
            await page.screenshot({path: resolve(process.cwd(), '.devkit/browser-last-tab-next-open.png')});
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Second page 1',
            });
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    // R4: with "Reopen documents where I left off" on, a Recent PDF reopens at
    // the page, zoom and view rotation it was closed at, also after a Save; a
    // file of the same name and page count with other bytes opens at its start.
    it.each([
        'download',
        'file-handle',
    ] as const)('reopens a Recent PDF where the reader left it, and other bytes of that name at their start (%s)', async (saveMode) => {
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1_280,
            height: 900,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const readView = () => readReadingView(page);
        const settle = () => settleActiveOpen(page);
        const openFile = (label: string) => openReadingBook(page, label, 'reading-view.pdf');
        try {
            if (saveMode !== 'download') await page.addInitScript(installPickerHandleFixture);
            await page.addInitScript((mode) => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                if (mode === 'download') {
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    return;
                }
                // A File is a structured-cloneable picker-handle fixture. Its
                // prototype methods survive an IndexedDB round trip and reload,
                // and the actual bytes and writes live in a real OPFS file.
                // Chromium 153 traps when deserializing native OPFS handles.
                Reflect.set(window, 'showSaveFilePicker', async () => new File([], 'reading-view.pdf'));
            }, saveMode);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            await page.locator('.rail-item', {hasText: 'Settings'}).click();
            await page.getByRole('switch', {name: 'Reopen documents where I left off'}).click();
            await expect.poll(() => page.getByRole('switch', {name: 'Reopen documents where I left off'}).getAttribute('aria-checked')).toBe('true');
            await page.locator('.rail-item', {hasText: 'Recent Files'}).click();
            await openFile('Reading');
            const opened = await readView();

            await page.locator('.page-controls-display').click();
            await page.locator('.page-controls-inline-input').fill('4');
            await page.keyboard.press('Enter');
            await page.locator('#editor-global-toolbar-host button[aria-label^="Zoom In"]:not([disabled])').first().click();
            await expect.poll(async () => (await readView()).zoom, {timeout: 15_000}).not.toBe(opened.zoom);
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'View',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {
                name: 'Rotate View Clockwise',
                exact: true,
            }).click();
            // An ordinary Save of a note writes the reader's own bytes; the view stays theirs.
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container[data-page="4"]').first().click({position: {
                x: 80,
                y: 80,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Saved where I left off');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            // The button's name is its tooltip, which changes once nothing is left to save.
            const save = page.locator('.save-split-primary').first();
            const download = saveMode === 'download' ? page.waitForEvent('download') : null;
            await save.click();
            if (download) {
                expect(noteTexts(await PDFDocument.load(readFileSync(await (await download).path())))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(async () => [
                await save.getAttribute('aria-busy'),
                await save.isDisabled(),
            ], {timeout: 15_000}).toEqual([
                'false',
                true,
            ]);
            if (saveMode === 'file-handle') {
                const bytes = await page.evaluate(async () => {
                    const root = await navigator.storage.getDirectory();
                    const handle = await root.getFileHandle('reading-view.pdf');
                    return Array.from(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
                });
                expect(noteTexts(await PDFDocument.load(Uint8Array.from(bytes)))).toEqual(new Set(['Saved where I left off']));
            }
            await expect.poll(readView, {timeout: 15_000}).toMatchObject({
                indicator: '4',
                visibleText: 'Reading page 4',
                landscape: true,
            });
            const left = await readView();
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-left.png`)});
            // A reload leaves nothing of the closed view but what Recent stored.
            // Close remembers the view before its tab goes, so the reload waits for that.
            const closeAndReload = async () => {
                await page.getByRole('button', {name: 'Close Tab'}).click();
                await expect.poll(() => page.locator('[data-tab-list] [role="tab"]').filter({hasText: '.pdf'}).count(), {timeout: 15_000}).toBe(0);
                await page.locator('.workspace-host[data-workspace-active="true"] .workspace-host__start').waitFor();
                await page.reload({waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
            };
            const reopenFromRecent = async (name: string) => {
                await page.locator('[data-recent-open-actionable="true"] .recent-open').filter({hasText: name}).click();
                await page.locator('.workspace-host[data-workspace-active="true"] .page_container--rendered').first().waitFor({timeout: 30_000});
                await settle();
            };
            await closeAndReload();

            await reopenFromRecent('reading-view.pdf');
            await expect.poll(readView, {timeout: 15_000}).toEqual(left);
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-restored.png`)});
            await closeAndReload();

            await openFile('Changed');
            await expect.poll(readView, {timeout: 15_000}).toEqual({
                ...opened,
                visibleText: 'Changed page 1',
            });
            await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-recent-reading-view-${saveMode}-changed-bytes.png`)});
            expect(problems).toEqual([]);
        } finally {
            await context.close();
        }
    }, 120_000);

    it('renders an externally replaced PDF and reopens that persisted Recent file', async () => {
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

            // A previous PDF can remain painted before the incoming open claims
            // the workspace. Readiness must belong to the requested document.
            const waitForDocument = (fileName: string, expectedText: string) => page.waitForFunction(({
                fileName, expectedText,
            }) => {
                const tab = document.querySelector('[data-tab-list] [role="tab"][aria-selected="true"]');
                const container = document.querySelector('.page_container--rendered[data-page="1"]');
                const canvas = container?.querySelector<HTMLCanvasElement>('.page_canvas canvas');
                const layer = container?.querySelector('.textLayer');
                const rect = canvas?.getBoundingClientRect();
                return tab?.textContent?.includes(fileName)
                    && canvas && canvas.width > 0 && canvas.height > 0
                    && rect && rect.width > 0 && rect.height > 0
                    && getComputedStyle(canvas).visibility === 'visible'
                    && layer?.getAttribute('data-pdf-text-layer-ready') === 'true'
                    && layer.textContent?.includes(expectedText);
            }, {
                fileName,
                expectedText,
            }, {timeout: 60_000});
            let openCount = 0;
            const openWithFile = async (filePath: string, expectedText: string) => {
                const chooserPromise = page.waitForEvent('filechooser');
                if (openCount === 0) {
                    await page.getByRole('button', {
                        name: 'Open File',
                        exact: true,
                    }).first().click();
                } else {
                    await page.keyboard.press('Control+O');
                }
                await (await chooserPromise).setFiles(filePath);
                openCount += 1;
                await waitForDocument(basename(filePath), expectedText);
                await page.evaluate(async () => {
                    const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                    if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                        throw new Error('PDF viewer open did not settle');
                    }
                });
            };

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ), 'Hello Arabic world');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ), 'EVB annotation interoperability corpus');
            const replacementTab = page.locator('[data-tab-list] [role="tab"][aria-selected="true"]');
            await expect.poll(() => replacementTab.textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-replacement-rendered.png'),
                fullPage: true,
            });

            await page.getByRole('button', {name: 'Close tab'}).last().click();
            await page.reload({waitUntil: 'domcontentloaded'});
            const recentReplacement = page.locator(
                '[data-recent-open-actionable="true"] .recent-open',
            ).filter({hasText: 'synthetic-annotation-interoperability.pdf'});
            await recentReplacement.waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await recentReplacement.click();
            await waitForDocument('synthetic-annotation-interoperability.pdf', 'EVB annotation interoperability corpus');
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-recent-reopen-rendered.png'),
                fullPage: true,
            });
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
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
            const recoveryCount = () => page.evaluate(async () => {
                const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                try {
                    return await new Promise<number>((resolveCount, rejectCount) => {
                        const request = db.transaction('workspace-recovery').objectStore('workspace-recovery').count();
                        request.onsuccess = () => resolveCount(request.result);
                        request.onerror = () => rejectCount(request.error);
                    });
                } finally { db.close(); }
            });
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
                    const {loadRecord} = await import('/_nuxt/platform/browser/browserDocumentIdb.ts');
                    return Boolean(await loadRecord(${JSON.stringify(sourceRef)}));
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
                // Terminal transfer protection lasts 60 seconds. Observe collection
                // after it expires and a normal lifecycle event publishes the graph.
                const expiredAt = Date.now() + 61_000;
                await Promise.all([
                    page,
                    creator,
                ].map(participant => participant.clock.setFixedTime(expiredAt)));
                await page.getByRole('button', {
                    name: 'New Tab',
                    exact: true,
                }).click();
                expect(creator.isClosed()).toBe(false);
                await expect.poll(() => readBrowserPayloadCounts(page), {timeout: 15_000}).toEqual({
                    records: 0,
                    chunks: 0,
                    recovery: 0,
                });
            }
            expect(await page.locator('.app-toast-failure').count()).toBe(0);
            expect(problems.flat()).toEqual([]);
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 240_000);
});
