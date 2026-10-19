import {
    createHash, randomBytes,
} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {
    basename, resolve,
} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {chromium} from 'playwright';
import type {Download} from 'playwright';
import {
    describe, expect, it,
} from 'vitest';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    openPdfFromChooser, lifecycle, readPersistedDocumentBytes, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, addNote, noteTexts, clickCenter, paneSelector, readPanePageWidth, zoomActivePane, readBrowserPayloadCounts,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    // T4: every accepted note belongs to the document's Save As frontier.
    it.each([
        'single',
        'split',
    ])('writes the accepted note through browser Save As from %s view', async (view) => {
        try {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1600,
                height: 900,
            }});
            const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
            await openPdfFromChooser(page, fixture);
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const text = 'Accepted note survives information routes';
            await addNote(page, text, {
                x: 200,
                y: 200,
            });
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
            if (view === 'split') {
                await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
                await page.getByRole('menuitem', {
                    name: 'Split Right',
                    exact: true,
                }).click();
                await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
                const panes = await page.locator('.editor-pane').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.editorPaneId!));
                const right = panes[1]!;
                await page.locator(`${paneSelector(right)} .page_container--rendered canvas`).first().waitFor({timeout: 30000});
                await zoomActivePane(page, right, 'Zoom Out', 1);
            }
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
            const savedContents: string[] = [];
            const downloads: Array<Promise<void>> = [];
            page.on('download', download => {
                const index = downloads.length;
                downloads.push((async () => {
                    const path = resolve(process.cwd(), `.devkit/browser-save-as-${process.pid}-${view}-${index}.pdf`);
                    await download.saveAs(path);
                    const bytes = readFileSync(path);
                    const pdf = await PDFDocument.load(bytes);
                    savedContents.push(...noteTexts(pdf));
                    console.info('SAVE_AS_BYTES', JSON.stringify({
                        view,
                        path,
                        byteLength: bytes.length,
                        originalChecksum: createHash('sha256').update(readFileSync(fixture)).digest('hex'),
                        savedChecksum: createHash('sha256').update(bytes).digest('hex'),
                        savedContents,
                    }));
                })());
            });
            await page.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            try {
                await expect.poll(() => savedContents, {timeout: 30000}).toContain(text);
            } finally {
                await Promise.all(downloads);
            }
        } finally {
            await Promise.all(lifecycle.browser.contexts().map(context => context.close()));
        }
    }, 120000);

    it.each([
        'save',
        'save-as',
    ] as const)('retains a note accepted after the %s frontier for the next save', async mode => {
        const context = await lifecycle.browser.newContext({
            viewport: {
                width: 1280,
                height: 900,
            },
            acceptDownloads: true,
        });
        let page: Awaited<ReturnType<typeof context.newPage>> | undefined;
        try {
            await context.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            page = await context.newPage();
            const problems = collectConsoleProblems(page);
            await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const pdf = await PDFDocument.create();
            pdf.addPage([
                612,
                792,
            ]).drawText('Accepted edits stay in their document', {
                x: 40,
                y: 740,
            });
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooser).setFiles({
                name: 'save-frontier.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
            const save = async (as: boolean) => {
                const download = page!.waitForEvent('download');
                if (as) {
                    await page!.getByRole('button', {
                        name: 'Save options',
                        exact: true,
                    }).click();
                    await page!.getByRole('menuitem', {name: /^Save As/u}).click();
                } else await page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).click();
                const path = await (await download).path();
                if (!path) throw new Error('Save did not provide its downloaded bytes');
                return PDFDocument.load(readFileSync(path));
            };
            if (mode === 'save') {
                await save(true);
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save options',
                    exact: true,
                }).isEnabled()).toBe(true);
                await page.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    await api.waitForActiveDocumentOpenSettled?.();
                });
                await page.locator('.editor-pane.is-active .page_container--rendered [data-pdf-annotation-editor-ready="true"]').first().waitFor();
            }
            await addNote(page, 'Before the save frontier', {
                x: 160,
                y: 180,
            });
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Before the save frontier');
            await page.evaluate(`(async () => {
                const {getDocumentWorkingCopyCapability} = await import('/_nuxt/utils/platformDocuments.ts');
                const capability = getDocumentWorkingCopyCapability();
                const method = ${JSON.stringify(mode)} === 'save-as' ? 'createWorkingCopyFromPath' : 'parsePdfAnnotations';
                const original = capability[method].bind(capability);
                const held = new Promise(resolve => Reflect.set(window, '__releaseSaveFrontier', resolve));
                capability[method] = async (...args) => {
                    capability[method] = original;
                    const result = ${JSON.stringify(mode)} === 'save' ? await original(...args) : undefined;
                    Reflect.set(window, '__saveFrontierHeld', true);
                    await held;
                    return ${JSON.stringify(mode)} === 'save' ? result : original(...args);
                };
            })()`);
            const first = save(mode === 'save-as');
            await page.waitForFunction(() => Reflect.get(window, '__saveFrontierHeld') === true);
            await addNote(page, 'Accepted after the save frontier', {
                x: 260,
                y: 280,
            });
            expect(await page.locator('.pdf-annotation-editor-note').count()).toBe(2);
            await expect.poll(() => page!.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.readActiveWorkspaceStateValues!<{annotationComments: Array<{text: string}>}>(['annotationComments']).annotationComments.map(note => note.text);
            })).toContain('Accepted after the save frontier');
            await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')());
            const published = noteTexts(await first);
            await expect.poll(() => page!.getByRole('button', {
                name: 'Save options',
                exact: true,
            }).isEnabled()).toBe(true);
            expect(published).toContain('Before the save frontier');
            await expect.poll(() => page!.locator('.pdf-annotation-editor-note').count()).toBe(2);
            if (!published.has('Accepted after the save frontier')) {
                await expect.poll(() => page!.getByRole('button', {
                    name: 'Save',
                    exact: true,
                }).isEnabled()).toBe(true);
            }
            await page.locator('.pdf-annotation-editor-note').last().click();
            await expect.poll(() => page!.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe('Accepted after the save frontier');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(published.has('Accepted after the save frontier')))).toEqual(new Set([
                'Before the save frontier',
                'Accepted after the save frontier',
            ]));
            await page.locator('.pdf-annotation-editor-note').last().click();
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Edited after Save As');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            expect(noteTexts(await save(false))).toContain('Edited after Save As');
            expect(problems).toEqual([]);
        } finally {
            if (page && !page.isClosed()) await page.evaluate(() => Reflect.get(window, '__releaseSaveFrontier')?.()).catch(() => undefined);
            await context.close();
        }
    }, 120000);

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
            await page.reload({waitUntil: 'domcontentloaded'});
            await page.locator('[data-recent-open-actionable="true"] .recent-open')
                .filter({hasText: operation === 'conversion' ? 'bitonal-faint-pencil.pdf' : 'pending-save.pdf'}).click();
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
