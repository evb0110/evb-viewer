import {
    writeFileSync, mkdirSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {DEFAULT_SETTINGS} from '@contracts/settings';
import {chromium} from 'playwright';
import type {
    BrowserContext, Page,
} from 'playwright';
import {
    afterEach, beforeEach, describe, expect, it,
} from 'vitest';
import {
    lifecycle, waitForOpenFileReady, keepFileChooserInterceptionEnabled, clickCenter, paneSelector, readPanePageWidth, zoomActivePane,
} from './documentLifecycleTestHelpers';

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
});


describe('browser Settings save failure UI', () => {
    let context: BrowserContext;
    let page: Page;
    beforeEach(async () => {
        context = await lifecycle.browser.newContext({
            permissions: [
                'clipboard-read',
                'clipboard-write',
            ],
            ...(process.env.EVB_D15_EVIDENCE_DIR ? {recordVideo: {dir: resolve(process.env.EVB_D15_EVIDENCE_DIR, 'browser-video')}} : {}),
        });
        page = await context.newPage();
        await page.addInitScript((settings) => {
            localStorage.setItem('evb-viewer:browser:settings', JSON.stringify(settings));
            document.cookie = 'i18n_redirected=ru; path=/';
        }, {
            ...DEFAULT_SETTINGS,
            locale: 'ru',
            authorName: 'Saved author',
            clientDiagnosticsPreference: 'denied',
        });
        await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
        await page.locator('.start-rail button').filter({hasText: 'Настройки'}).click();
        await page.locator('#settings-author').waitFor({state: 'visible'});
    });
    afterEach(async ({task}) => {
        const video = page?.video();
        await context?.close();
        if (video && process.env.EVB_D15_EVIDENCE_DIR) {
            const name = task.name.match(/QuotaExceededError|SecurityError|Error/u)?.[0] ?? 'unknown';
            const action = task.name.startsWith('copy ') ? 'copy' : 'retry';
            await video.saveAs(resolve(process.env.EVB_D15_EVIDENCE_DIR, `settings-${name}-${action}.webm`));
            await video.delete();
        }
    });

    it.each([
        {
            name: 'QuotaExceededError',
            action: 'copy',
        },
        {
            name: 'SecurityError',
            action: 'copy',
        },
        {
            name: 'Error',
            action: 'copy',
        },
        {
            name: 'Error',
            action: 'retry',
        },
    ])('$action handles a late $name after Settings closes with a localized cause', async ({
        name, action,
    }) => {
        const author = page.locator('#settings-author');
        await page.evaluate((name) => {
            const original = Storage.prototype.setItem;
            Reflect.set(window, '__restoreD15Storage', () => {Storage.prototype.setItem = original;});
            Storage.prototype.setItem = function(key, value) {
                if (key === 'evb-viewer:browser:settings') {
                    Reflect.set(window, '__D15SettingsOpenAtWrite', Boolean(document.querySelector('#settings-author')));
                    throw name === 'Error' ? new Error('RAW unknown detail') : new DOMException('RAW storage detail', name);
                }
                return original.call(this, key, value);
            };
        }, name);
        const recent = await page.locator('.start-rail button').filter({hasText: 'Недавние'}).boundingBox();
        expect(recent).not.toBeNull();
        await author.fill('Retained after closing');
        await page.mouse.click(recent!.x + recent!.width / 2, recent!.y + recent!.height / 2);
        expect(await author.count()).toBe(0);
        // The actual debounced storage attempt must occur after Settings closes.
        await expect.poll(() => page.evaluate(() => Reflect.get(window, '__D15SettingsOpenAtWrite'))).toBe(false);
        const toast = page.locator('.app-toast-failure').filter({has: page.getByRole('button', {
            name: 'Повторить',
            exact: true,
        })});
        const evidence = resolve(process.env.EVB_D15_EVIDENCE_DIR ?? '.devkit/d15/screenshots');
        mkdirSync(evidence, {recursive: true});
        try {
            await page.evaluate(() => new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame())));
            expect(await toast.isVisible()).toBe(true);
        } finally {
            await page.screenshot({path: resolve(evidence, `settings-${name}-${action}.png`)});
        }
        const reason = name === 'QuotaExceededError' ? 'Хранилище заполнено. Освободите место и повторите попытку.'
            : name === 'SecurityError' ? 'Доступ к хранилищу заблокирован. Разрешите доступ и повторите попытку.'
                : 'Не удалось записать настройки в хранилище. Повторите попытку.';
        expect(await toast.locator('.app-toast-failure-reason').textContent()).toBe(reason);
        expect(await toast.textContent()).not.toContain('RAW');
        if (action === 'copy') {
            const receipt = await toast.locator('.app-toast-error-id').textContent();
            await toast.getByRole('button', {
                name: 'Копировать подробности',
                exact: true,
            }).click();
            const copy = await page.evaluate(() => navigator.clipboard.readText());
            expect(copy).toContain(name === 'Error' ? 'Error: RAW unknown detail' : `${name}: RAW storage detail`);
            expect(copy).toContain('Error ID:');
            expect(copy).toContain(receipt!.split(': ').at(-1)!);
        } else {
            await page.evaluate(() => (Reflect.get(window, '__restoreD15Storage') as () => void)());
            await toast.getByRole('button', {
                name: 'Повторить',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').authorName)).toBe('Retained after closing');
        }
    });
});
