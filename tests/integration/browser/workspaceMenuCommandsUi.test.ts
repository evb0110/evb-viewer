import {createHash} from 'node:crypto';
import {
    mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFStream, PDFString, PDFHexString,
} from 'pdf-lib';
import {
    describe, expect, it,
} from 'vitest';
import type {
    Page, Locator,
} from 'playwright';
import type {IBrowserLifecycleTestApi} from './documentLifecycleTestHelpers';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled, openPdfFromChooser, settleActiveOpen,
} from './documentLifecycleTestHelpers';

// C11/C12 expectations are deliberately literal: the rendered reference and
// native browser clipboard are the public interfaces, not the shortcut registry.
// Evidence is kept only when a run asks for it.
const parityEvidenceDir = process.env.EVB_C11_C12_EVIDENCE_DIR ? resolve(process.env.EVB_C11_C12_EVIDENCE_DIR) : null;


async function parityScreenshot(page: Page, name: string) {
    if (parityEvidenceDir === null) return;
    mkdirSync(parityEvidenceDir, {recursive: true});
    await page.screenshot({
        path: resolve(parityEvidenceDir, `${name}.png`),
        fullPage: true,
    });
}


async function openParitySettings(page: Page) {
    await page.addInitScript(() => {
        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
    });
    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
    await waitForOpenFileReady(page);
    await page.locator('nav[aria-label="Workspace"]').getByRole('button', {
        name: 'Settings',
        exact: true,
    }).click();
    await page.locator('.settings-grid[aria-busy="false"]').waitFor();
}


function parityMenuItem(page: Page, name: string) {
    return page.getByRole('menuitem').filter({has: page.getByText(name, {exact: true})});
}


async function openParityEditMenu(page: Page, keyboard = false) {
    const trigger = page.getByRole('button', {
        name: 'Menu',
        exact: true,
    });
    if (keyboard) await trigger.press('Enter');
    else await trigger.click();
    await page.getByRole('menu').first().waitFor();
    await parityScreenshot(page, 'c12-edit-menu');
    // The baseline must fail on the omission before testing the new behavior.
    for (const name of [
        'Cut',
        'Copy',
        'Paste',
        'Select All',
    ]) {
        expect(await parityMenuItem(page, name).count(), `C12 Edit must expose ${name}`).toBe(1);
    }
}


async function parityEdit(page: Page, name: string, keyboard = false) {
    await openParityEditMenu(page, keyboard);
    const item = parityMenuItem(page, name);
    expect(await item.getAttribute('aria-disabled'), `${name} is enabled for the captured target`).not.toBe('true');
    if (keyboard) {
        // Traverse the real menu's roving focus, including disabled entries.
        const limit = await page.getByRole('menuitem').count() + 1;
        for (let step = 0; step < limit; step += 1) {
            if (await item.evaluate(element => element.contains(document.activeElement))) break;
            await page.keyboard.press('ArrowDown');
        }
        expect(await item.evaluate(element => element.contains(document.activeElement))).toBe(true);
        expect(await page.locator('[role="menuitem"][data-highlighted]').count()).toBe(1);
        await page.keyboard.press('Enter');
    } else await item.click();
    await page.getByRole('menu').first().waitFor({state: 'hidden'});
}


async function selectParityTail(page: Page, field: Locator, count: number) {
    await field.press('ControlOrMeta+A');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.down('Shift');
    for (let index = 0; index < count; index += 1) await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
}


async function parityPdf() {
    const pdf = await PDFDocument.create();
    pdf.setCreationDate(new Date('2026-01-01T00:00:00Z'));
    pdf.setModificationDate(new Date('2026-01-01T00:00:00Z'));
    for (const text of [
        'C12 selectable PDF text',
        'C12 second page',
    ]) {
        pdf.addPage([
            600,
            800,
        ]).drawText(text, {
            x: 60,
            y: 720,
            size: 18,
        });
    }
    const buffer = Buffer.from(await pdf.save());
    if (parityEvidenceDir !== null) {
        mkdirSync(parityEvidenceDir, {recursive: true});
        writeFileSync(resolve(parityEvidenceDir, 'c12-fixture.pdf'), buffer);
        writeFileSync(resolve(parityEvidenceDir, 'environment.json'), JSON.stringify({
            fixtureSha256: createHash('sha256').update(buffer).digest('hex'),
            browser: await lifecycle.browser.version(),
            platform: process.platform,
            node: process.version,
        }, null, 2));
    }
    return {
        name: 'c12-edit.pdf',
        mimeType: 'application/pdf',
        buffer,
    };
}

describe('browser document lifecycle UI', () => {
    it('C11 hides browser update controls while keeping About reachable', async () => {
        const page = await lifecycle.browser.newPage({viewport: {
            width: 900,
            height: 700,
        }});
        const problems = collectConsoleProblems(page);
        try {
            // Observe insertion as well as the settled UI, so a transient no-op
            // update button cannot pass by disappearing after initialization.
            await page.addInitScript(() => {
                Reflect.set(window, '__c11UpdateCardSeen', false);
                new MutationObserver(() => {
                    if (Array.from(document.querySelectorAll('button, legend')).some(element =>
                        /^(Updates|Check for Updates)$/u.test(element.textContent?.trim() ?? ''))) {
                        Reflect.set(window, '__c11UpdateCardSeen', true);
                    }
                }).observe(document, {
                    childList: true,
                    subtree: true,
                });
            });
            await openParitySettings(page);
            const about = page.getByRole('link', {
                name: 'Open About and Acknowledgements',
                exact: true,
            });
            await about.scrollIntoViewIfNeeded();
            await parityScreenshot(page, 'c11-settings-900');
            expect(await page.getByRole('button', {
                name: 'Check for Updates',
                exact: true,
            }).count()).toBe(0);
            expect(await page.getByText('Updates', {exact: true}).count()).toBe(0);
            expect(await page.evaluate(() => Reflect.get(window, '__c11UpdateCardSeen'))).toBe(false);
            await page.setViewportSize({
                width: 1280,
                height: 900,
            });
            await page.getByText('Large', {exact: true}).click();
            await about.scrollIntoViewIfNeeded();
            await parityScreenshot(page, 'c11-settings-large');
            expect(await page.getByRole('button', {
                name: 'Check for Updates',
                exact: true,
            }).count()).toBe(0);
            await about.click();
            await page.waitForURL('**/about');
            expect(await page.getByRole('heading', {
                name: 'About EVB Viewer',
                exact: true,
            }).isVisible()).toBe(true);
            expect(await page.locator('main').innerText()).toMatch(/\d+\.\d+\.\d+/u);
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
        }
    }, 90_000);

    for (const platform of [
        'mac',
        'linux',
    ] as const) {
        it(`C12 shows complete, unique shortcut help with ${platform} keycaps`, async () => {
            const page = await lifecycle.browser.newPage({viewport: {
                width: 1280,
                height: 900,
            }});
            const problems = collectConsoleProblems(page);
            try {
                // Presentation-only platform fixture; actual editing below uses
                // this host's native keyboard mapping and unmodified navigator.
                await page.addInitScript((mac) => {
                    Object.defineProperties(navigator, {
                        platform: {get: () => mac ? 'MacIntel' : 'Linux x86_64'},
                        userAgent: {get: () => mac ? 'Mozilla/5.0 (Macintosh)' : 'Mozilla/5.0 (X11; Linux x86_64)'},
                        userAgentData: {get: () => ({platform: mac ? 'macOS' : 'Linux'})},
                    });
                }, platform === 'mac');
                await openParitySettings(page);
                await page.getByRole('button', {
                    name: 'Keyboard Shortcuts',
                    exact: true,
                }).click();
                const rows = page.locator('.settings-shortcut-row');
                await rows.first().scrollIntoViewIfNeeded();
                await parityScreenshot(page, `c12-help-${platform}-top`);
                await rows.last().scrollIntoViewIfNeeded();
                await parityScreenshot(page, `c12-help-${platform}-bottom`);
                const mod = platform === 'mac' ? '⌘' : 'Ctrl';
                const saveAs = platform === 'mac' ? [
                    '⇧',
                    '⌘',
                    'S',
                ] : [
                    'Ctrl',
                    'Shift',
                    'S',
                ];
                const expected = [
                    {
                        label: 'Open File',
                        keys: [
                            mod,
                            'O',
                        ],
                    },
                    {
                        label: 'Save',
                        keys: [
                            mod,
                            'S',
                        ],
                    },
                    {
                        label: 'Save As...',
                        keys: saveAs,
                    },
                    {
                        label: 'Search document',
                        keys: [
                            mod,
                            'F',
                        ],
                    },
                    {
                        label: 'Zoom In',
                        keys: [
                            mod,
                            '=',
                        ],
                    },
                    {
                        label: 'Zoom Out',
                        keys: [
                            mod,
                            '−',
                        ],
                    },
                    {
                        label: 'Actual Size',
                        keys: [
                            mod,
                            '0',
                        ],
                    },
                    {
                        label: 'Fit Width',
                        keys: [
                            mod,
                            '1',
                        ],
                    },
                    {
                        label: 'Fit Height',
                        keys: [
                            mod,
                            '2',
                        ],
                    },
                    {
                        label: 'Cut',
                        keys: [
                            mod,
                            'X',
                        ],
                    },
                    {
                        label: 'Copy',
                        keys: [
                            mod,
                            'C',
                        ],
                    },
                    {
                        label: 'Paste',
                        keys: [
                            mod,
                            'V',
                        ],
                    },
                    {
                        label: 'Select All',
                        keys: [
                            mod,
                            'A',
                        ],
                    },
                ];
                expect(await rows.evaluateAll(elements => elements.map(element => ({
                    label: element.querySelector('.settings-shortcut-label')?.textContent?.trim(),
                    keys: Array.from(element.querySelectorAll('kbd')).map(key => key.textContent?.trim()),
                })))).toEqual(expect.arrayContaining(expected));
                expect(await rows.count()).toBe(expected.length);
                expect(problems).toEqual([]);
            } finally {
                await page.context().close();
            }
        }, 90_000);
    }

    it('C12 Edit preserves a real input selection for Copy, Cut, Paste, Select All and native undo', async () => {
        const page = await lifecycle.browser.newPage({permissions: [
            'clipboard-read',
            'clipboard-write',
        ]});
        const problems = collectConsoleProblems(page);
        try {
            await openParitySettings(page);
            const field = page.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            await field.click();
            await page.keyboard.type('Alpha Beta');
            await selectParityTail(page, field, 4);
            await parityEdit(page, 'Copy');
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Beta');
            await expect.poll(() => field.evaluate(element => element === document.activeElement)).toBe(true);
            expect(await field.inputValue()).toBe('Alpha Beta');
            await field.press('ArrowRight');
            await parityEdit(page, 'Paste', true);
            await expect.poll(() => field.inputValue()).toBe('Alpha BetaBeta');
            await field.press('ControlOrMeta+Z');
            expect(await field.inputValue()).toBe('Alpha Beta');
            await selectParityTail(page, field, 4);
            await parityEdit(page, 'Cut', true);
            expect(await field.inputValue()).toBe('Alpha ');
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Beta');
            await parityEdit(page, 'Paste');
            await expect.poll(() => field.inputValue()).toBe('Alpha Beta');
            await parityEdit(page, 'Select All', true);
            await page.keyboard.type('Replacement author');
            expect(await field.inputValue()).toBe('Replacement author');
            await parityScreenshot(page, 'c12-input-edited');
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
        }
    }, 90_000);

    it('C12 Edit denied clipboard paste warns once and leaves the input unchanged', async () => {
        const page = await lifecycle.browser.newPage({permissions: ['clipboard-write']});
        const problems = collectConsoleProblems(page);
        try {
            await openParitySettings(page);
            const field = page.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            await field.click();
            await page.keyboard.type('Keep this');
            await selectParityTail(page, field, 4);
            await page.evaluate(() => navigator.clipboard.writeText('native paste'));
            expect(await page.evaluate(async () => (await navigator.permissions.query({name: 'clipboard-read' as PermissionName})).state)).toBe('denied');
            await parityEdit(page, 'Paste');
            const warning = page.getByRole('region').getByText(/^Paste from the menu is unavailable\./u);
            await warning.waitFor();
            expect(await warning.count()).toBe(1);
            expect(await field.inputValue()).toBe('Keep this');
            await parityScreenshot(page, 'c12-denied-paste');
            await expect.poll(() => field.evaluate(element => element === document.activeElement)).toBe(true);
            await page.keyboard.press('ControlOrMeta+V');
            await expect.poll(() => field.inputValue()).toBe('Keep native paste');
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
        }
    }, 90_000);

    it('C12 Edit refuses a paste when its input target changes during clipboard reading', async () => {
        const page = await lifecycle.browser.newPage({permissions: [
            'clipboard-read',
            'clipboard-write',
        ]});
        const problems = collectConsoleProblems(page);
        try {
            await openParitySettings(page);
            const field = page.getByRole('textbox', {
                name: 'Author Name',
                exact: true,
            });
            await field.click();
            await page.keyboard.type('Keep this');
            await selectParityTail(page, field, 4);
            await page.evaluate(() => navigator.clipboard.writeText('stale clipboard'));
            // Controlled async boundary: read the actual clipboard, holding only
            // its completion. No application command or clipboard result is faked.
            await page.evaluate(() => {
                const clipboard = navigator.clipboard;
                const original = clipboard.readText.bind(clipboard);
                clipboard.readText = async () => {
                    const text = await original();
                    Reflect.set(window, '__c12ClipboardRead', true);
                    await new Promise<void>((release) => {Reflect.set(window, '__c12ReleaseClipboard', release);});
                    return text;
                };
            });
            await parityEdit(page, 'Paste');
            await page.waitForFunction(() => Reflect.get(window, '__c12ClipboardRead') === true);
            await field.press('ControlOrMeta+A');
            await page.keyboard.type('Changed while reading');
            await page.evaluate(() => Reflect.get(window, '__c12ReleaseClipboard')());
            const warning = page.getByRole('region').getByText('The editing target changed. Choose Paste again.', {exact: true});
            await warning.waitFor();
            expect(await warning.count()).toBe(1);
            expect(await field.inputValue()).toBe('Changed while reading');
            await parityScreenshot(page, 'c12-target-changed');
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
        }
    }, 90_000);

    it('C12 Edit keeps a live inline text-box draft through pointer and keyboard menus and Save As', async () => {
        const page = await lifecycle.browser.newPage({
            viewport: {
                width: 1280,
                height: 900,
            },
            permissions: [
                'clipboard-read',
                'clipboard-write',
            ],
        });
        const problems = collectConsoleProblems(page);
        try {
            await openPdfFromChooser(page, await parityPdf());
            await settleActiveOpen(page);
            // Assert the omission before doing any new editing acceptance on base.
            await openParityEditMenu(page);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.getByRole('button', {
                name: 'Toggle Sidebar',
                exact: true,
            }).click();
            await page.getByRole('tab', {
                name: 'Annotations',
                exact: true,
            }).click();
            await page.locator('.tool-button[data-tool="text"]').click();
            await page.locator('.workspace-host[data-workspace-active="true"] .page_container[data-page="1"]').click({position: {
                x: 230,
                y: 240,
            }});
            const editor = page.locator('.pdf-annotation-editor-text-box [contenteditable="true"]');
            await editor.waitFor();
            await page.keyboard.type('Draft Beta');
            await selectParityTail(page, editor, 4);
            await parityEdit(page, 'Copy');
            expect(await editor.isVisible()).toBe(true);
            expect(await editor.innerText()).toBe('Draft Beta');
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Beta');
            await parityEdit(page, 'Cut', true);
            expect(await editor.isVisible()).toBe(true);
            expect(await editor.innerText()).toBe('Draft ');
            await parityEdit(page, 'Paste');
            await expect.poll(() => editor.innerText()).toBe('Draft Beta');
            await parityEdit(page, 'Select All', true);
            await page.keyboard.type('Saved C12 edited text');
            expect(await editor.innerText()).toBe('Saved C12 edited text');
            await parityScreenshot(page, 'c12-inline-draft');
            await editor.press('ControlOrMeta+Enter');
            await editor.waitFor({state: 'hidden'});
            const downloaded = page.waitForEvent('download');
            await page.keyboard.press('ControlOrMeta+Shift+S');
            const savedDirectory = mkdtempSync(resolve(tmpdir(), 'evb-c12-'));
            try {
                const savedPath = resolve(savedDirectory, 'c12-edited.pdf');
                await (await downloaded).saveAs(savedPath);
                const saved = await PDFDocument.load(readFileSync(savedPath));
                expect(saved.getPageCount()).toBe(2);
                const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
                expect(Array.from({length: annots.size()}, (_, index) => annots.lookup(index, PDFDict)
                    .lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString)?.decodeText())).toContain('Saved C12 edited text');
                const reopened = await lifecycle.browser.newPage();
                try {
                    await openPdfFromChooser(reopened, savedPath);
                    await settleActiveOpen(reopened);
                    expect(await reopened.locator('.pdf-annotation-editor-text-box').getAttribute('aria-label')).toBe('Saved C12 edited text');
                } finally {
                    await reopened.context().close();
                }
            } finally {
                rmSync(savedDirectory, {
                    recursive: true,
                    force: true,
                });
            }
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
        }
    }, 120_000);

    it('C12 Edit copies a real PDF text selection', async () => {
        const page = await lifecycle.browser.newPage({
            viewport: {
                width: 1280,
                height: 900,
            },
            permissions: [
                'clipboard-read',
                'clipboard-write',
            ],
        });
        const problems = collectConsoleProblems(page);
        try {
            await openPdfFromChooser(page, await parityPdf());
            await settleActiveOpen(page);
            await openParityEditMenu(page);
            await page.keyboard.press('Escape');
            await page.keyboard.press('Escape');
            await page.getByRole('button', {
                name: 'Text Select',
                exact: true,
            }).click();
            const text = page.locator('.workspace-host[data-workspace-active="true"] .text-layer span').filter({hasText: /^C12 selectable PDF text$/u});
            await text.waitFor();
            const box = await text.boundingBox();
            expect(box).not.toBeNull();
            await page.mouse.move(box!.x + 1, box!.y + box!.height / 2);
            await page.mouse.down();
            await page.mouse.move(box!.x + box!.width - 1, box!.y + box!.height / 2, {steps: 12});
            await page.mouse.up();
            expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('C12 selectable PDF text');
            await parityEdit(page, 'Copy');
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('C12 selectable PDF text');
            expect(problems).toEqual([]);
        } finally {
            await page.context().close();
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
