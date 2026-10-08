import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {
    createCanvas, loadImage,
} from '@napi-rs/canvas';
import {
    findFreePort, isProcessAlive, killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {buildNuxtDevServerEnv} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    PDFDocument, PDFArray, PDFDict, PDFName, PDFString, PDFHexString,
    StandardFonts,
} from 'pdf-lib';
import {chromium} from 'playwright';
import type {Page} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let devServer: ChildProcess | null = null;
let origin = '';
let serverOutput = '';
interface IBrowserLifecycleTestApi {
    waitForActiveDocumentOpenSettled?: () => Promise<boolean>;
    callActiveWorkspaceCommand?: <TResult = unknown>(commandName: string, args?: unknown[]) => Promise<{
        called: boolean;
        value: TResult | null;
    }>;
    callActiveWorkspaceSyncCommand?: <TResult = unknown>(commandName: string, args?: unknown[]) => {
        called: boolean;
        value: TResult | null;
    };
    getActiveToolbarSnapshot?: () => {
        canSave: boolean;
        initialVisualReady: boolean;
        viewerCapabilities: {save: boolean}
    } | null;
    readActiveWorkspaceStateValues?: <TValues extends Record<string, unknown> = Record<string, unknown>>(
        propertyNames: string[],
    ) => TValues;
    listTargetWindows?: () => Promise<Array<{
        windowId: number;
        label: string
    }>>;
    transferActiveTabToWindow?: (windowId: number) => Promise<{
        success: boolean;
        error?: string
    }>;
}

async function waitForServer(url: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (devServer?.exitCode !== null || devServer.signalCode !== null) {
            throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
        }
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
            await response.body?.cancel();
            if (response.ok) {
                return;
            }
        } catch {
            // The development server is still compiling or binding.
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for Nuxt:\n${serverOutput.slice(-8_000)}`);
}

async function waitForOpenFileReady(page: Page) {
    await page.waitForFunction(() => Boolean(Reflect.get(window, '__evbTestApi')), undefined, {timeout: 30_000});
    await page.waitForFunction(() => {
        const api = Reflect.get(window, '__evbTestApi') as {isStartupOpenClaimPending?: () => boolean};
        return !api.isStartupOpenClaimPending?.();
    }, undefined, {timeout: 30_000});
}

// Behavior contract C2: ordinary use of a well-formed document logs no console
// error or warning and throws no page error. Only these named dev-build
// messages are expected; every other problem fails the test.
const EXPECTED_DEV_CONSOLE_PROBLEMS = [{
    pattern: /^warning: \[[^\]]+\] \[perf\] [\w:-]+ was slow \{/u,
    reason: 'app/utils/devPerf.ts frame-budget timing: dev builds only, fires when the host is busy',
}];

function collectConsoleProblems(page: Page) {
    const problems: string[] = [];
    page.on('console', (message) => {
        const problem = `${message.type()}: ${message.text()}`;
        if (
            (message.type() === 'error' || message.type() === 'warning')
            && !EXPECTED_DEV_CONSOLE_PROBLEMS.some(expected => expected.pattern.test(problem))
        ) {
            problems.push(problem);
        }
    });
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    return problems;
}

// One-shot waitForEvent listeners otherwise toggle Playwright's chooser
// interception off and on between opens, and a quick second open can race it.
function keepFileChooserInterceptionEnabled(page: Page) {
    page.on('filechooser', () => {});
}

async function stopServer() {
    const server = devServer;
    devServer = null;
    if (!server?.pid) {
        return;
    }
    await killProcessTree(server.pid);
    if (isProcessAlive(server.pid)) {
        throw new Error('The browser lifecycle Nuxt process did not exit');
    }
}

beforeAll(async () => {
    const port = await findFreePort();
    origin = `http://127.0.0.1:${String(port)}`;
    const sessionName = `browser-lifecycle-${process.pid}`;
    devServer = spawn(process.execPath, [
        resolve(process.cwd(), 'node_modules/nuxt/bin/nuxt.mjs'),
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        // The shared launcher isolates build/output/cache, strips Vitest's
        // child environment and keeps Nitro's macOS socket path short.
        env: buildNuxtDevServerEnv({
            ...process.env,
            SENTRY_BROWSER_DSN: `http://consenttest@127.0.0.1:${String(port)}/1`,
        }, port, sessionName),
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    const captureOutput = (chunk: Buffer) => {
        serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
    };
    devServer.stdout?.on('data', captureOutput);
    devServer.stderr?.on('data', captureOutput);
    await once(devServer, 'spawn');
    await waitForServer(origin);
}, 120_000);

afterAll(async () => {
    await stopServer();
});

async function clickCenter(page: Page, selector: string, button: 'left' | 'right' = 'left') {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) {
        throw new Error(`${selector} has no visible box`);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button});
}

function paneSelector(paneId: string) {
    return `.editor-pane[data-editor-pane-id="${paneId}"]`;
}

/** The rendered width of page 1 in one pane: its zoom as a person sees it. */
function readPanePageWidth(page: Page, paneId: string) {
    return page.locator(`${paneSelector(paneId)} .page_container[data-page="1"]`).first()
        .evaluate(element => Math.round(element.getBoundingClientRect().width));
}

async function zoomActivePane(page: Page, paneId: string, label: 'Zoom In' | 'Zoom Out', steps: number) {
    for (let step = 0; step < steps; step += 1) {
        const before = await readPanePageWidth(page, paneId);
        await page.locator(`#editor-global-toolbar-host button[aria-label^="${label}"]:not([disabled])`).first().click();
        await expect.poll(() => readPanePageWidth(page, paneId), {timeout: 15_000}).not.toBe(before);
    }
}

describe('browser document lifecycle UI', () => {
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
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                recordVideo: {dir: resolve(process.cwd(), `.devkit/browser-annotation-icons-${process.pid}`)},
            });
            const cpu = await page.context().newCDPSession(page);
            await cpu.send('Emulation.setCPUThrottlingRate', {rate: 6});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            }).pressSequentially('Canonical note beside a foreign attachment');
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
                .pressSequentially('Own saved highlight comment');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
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
            // Opening the actual downloaded bytes in a fresh browser page
            // proves this is the saved surface, not the unsaved overlay.
            const reopened = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 800,
                },
                recordVideo: {dir: resolve(process.cwd(), `.devkit/browser-annotation-icons-saved-${process.pid}`)},
            });
            try {
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(origin, {waitUntil: 'domcontentloaded'});
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
                await reopened.mouse.click(100, 200);
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
            } finally {
                await reopened.close();
            }
            console.info('Popup observations', JSON.stringify(popupObservations));
            writeFileSync(resolve(process.cwd(), `.devkit/browser-annotation-popups-${process.pid}.json`), JSON.stringify(popupObservations, null, 2));
            for (const observation of popupObservations) {
                expect(observation.hover, `${observation.label} hover`).toBe(0);
                expect(observation.click, `${observation.label} click`).toBe(0);
            }
            const dimensions = await icon.evaluate((image) => {
                const rect = image.getBoundingClientRect();
                return {
                    naturalWidth: (image as HTMLImageElement).naturalWidth,
                    width: rect.width,
                    height: rect.height,
                    imageStyle: image.getAttribute('style'),
                    containerStyle: image.parentElement?.getAttribute('style'),
                    containerDisplay: image.parentElement && getComputedStyle(image.parentElement).display,
                    scaleFactor: getComputedStyle(image).getPropertyValue('--total-scale-factor'),
                };
            });
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
            expect(new URL(response.url()).pathname).toBe('/pdfjs/images/annotation-paperclip.svg');
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
            await Promise.all(browser.contexts().map(context => context.close()));
            await browser.close();
        }
    }, 90_000);

    it('keeps the performance restart notice through Settings remount until reload', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({recordVideo: {dir: resolve(process.cwd(), '.devkit/lane-b/evidence/op-03-video')}});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 120_000);

    // T4: every accepted note belongs to the document's Save As frontier.
    it.each([
        'single',
        'split',
    ])('writes the accepted note through browser Save As from %s view', async (view) => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1600,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const fixture = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
            await (await chooser).setFiles(fixture);
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30000});
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
            }).pressSequentially(text);
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
                    for (const pdfPage of pdf.getPages()) {
                        const annotations = pdfPage.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
                        for (let i = 0; i < (annotations?.size() ?? 0); i += 1) {
                            const annotation = annotations!.lookup(i, PDFDict);
                            const contents = annotation.lookupMaybe(PDFName.of('Contents'), PDFString, PDFHexString);
                            if (contents) savedContents.push(contents.decodeText());
                        }
                    }
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
            await browser.close();
        }
    }, 120000);
    it('withdraws hosted diagnostics in another open window and allows an explicit regrant', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const context = await browser.newContext({recordVideo: {dir: resolve(process.cwd(), '.devkit/lane-b/evidence/op-02-video')}});
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
            await first.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await second.goto(origin, {waitUntil: 'domcontentloaded'});
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
            const secondLifecycle = await context.newCDPSession(second);
            await secondLifecycle.send('Page.setWebLifecycleState', {state: 'frozen'});
            await consent.uncheck();
            await first.waitForFunction(() => JSON.parse(localStorage.getItem('evb-viewer:browser:settings') ?? '{}').clientDiagnosticsPreference === 'denied');
            await secondLifecycle.send('Page.setWebLifecycleState', {state: 'active'});
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
            await browser.close();
        }
    }, 120_000);

    // T2/T4: reading an information page keeps accepted work and both live views.
    it('preserves an unsaved note and linked view zoom through Privacy and About routes', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({
                viewport: {
                    width: 1_600,
                    height: 900,
                },
                recordVideo: {dir: resolve(process.cwd(), '.devkit/browser-information-video')},
            });
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            }).pressSequentially(text);
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
            await browser.close();
        }
    }, 90_000);

    // T3/C2, issue #1037: foreign FreeText is printable when its viewer supplies
    // the appearance. Explicit /AP remains authoritative (ADR 0003).
    it('prints existing FreeText without AP and preserves explicit appearances', async () => {
        const evidence = resolve(process.cwd(), `.devkit/1037/browser-${process.pid}`);
        mkdirSync(evidence, {recursive: true});
        const browser = await chromium.launch({headless: true});
        const page = await browser.newPage({
            viewport: {
                width: 1_280,
                height: 800,
            },
            recordVideo: {dir: evidence},
        });
        const problems = collectConsoleProblems(page);
        let printStartedAt: number | undefined;
        try {
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                window.print = () => {
                    const canvas = document.querySelector<HTMLCanvasElement>('.browser-print-page canvas');
                    if (!canvas) throw new Error('No printed page');
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
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 90_000);

    // T2/T3, issue #1027: accepted note text reaches recovery bytes, and its
    // icon reaches the printed canvas while the original remains unsaved.
    it('materializes an unsaved note for browser recovery and print without saving the original', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 800,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                // Observe the system-print boundary in every frame without
                // opening a native dialog. The canvas is the printed artifact.
                window.print = () => {
                    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.browser-print-page canvas')];
                    let yellowPixels = 0;
                    for (const canvas of canvases) {
                        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
                        if (!pixels) throw new Error('The print canvas has no pixels');
                        for (let index = 0; index < pixels.length; index += 4) {
                            if (pixels[index]! > 150 && pixels[index + 1]! > 100 && pixels[index + 2]! < 100) {
                                yellowPixels += 1;
                            }
                        }
                    }
                    Reflect.set(window.top!, '__printedNote', {
                        pages: canvases.length,
                        yellowPixels,
                    });
                };
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            // A clean document isolates a newly created /Text note from
            // foreign annotations whose missing appearances have other causes.
            const pdf = await PDFDocument.create();
            const font = await pdf.embedFont(StandardFonts.Helvetica);
            pdf.addPage([
                612,
                792,
            ]).drawText('Browser sticky-note print regression', {
                x: 72,
                y: 720,
                font,
                size: 18,
            });
            await (await chooser).setFiles({
                name: 'browser-note-print.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 30_000});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            const bounds = await page.locator('.page_container[data-page="1"]').first().boundingBox();
            if (!bounds) throw new Error('The first PDF page is not visible');
            await page.mouse.click(bounds.x + 200, bounds.y + 200);
            const text = 'Recovery descriptor regression note';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).pressSequentially(text);
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
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Reflect.get(window, '__printedNote')?.yellowPixels ?? 0), {timeout: 15_000}).toBeGreaterThan(50);
            expect(await page.evaluate(() => Reflect.get(window, '__printedNote').pages)).toBeGreaterThan(0);
            await expect.poll(() => page.evaluate(async (noteText) => {
                const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                    const request = indexedDB.open('evb-viewer-browser-documents');
                    request.onsuccess = () => resolveDb(request.result);
                    request.onerror = () => rejectDb(request.error);
                });
                try {
                    const rows = await new Promise<Array<{
                        data: Uint8Array;
                        fileName: string;
                        kind: string
                    }>>((resolveRows, rejectRows) => {
                        const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
                        request.onsuccess = () => resolveRows(request.result);
                        request.onerror = () => rejectRows(request.error);
                    });
                    const encoded = [...noteText].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
                    return {
                        recovered: rows.some(row => row.fileName.endsWith('.recovery.pdf') && new TextDecoder().decode(row.data).toLowerCase().includes(encoded)),
                        originalChanged: rows.some(row => row.kind === 'source' && new TextDecoder().decode(row.data).toLowerCase().includes(encoded)),
                    };
                } finally {
                    db.close();
                }
            }, text), {timeout: 15_000}).toEqual({
                recovered: true,
                originalChanged: false,
            });
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).isEnabled()).toBe(true);
        } finally {
            await browser.close();
        }
    }, 90_000);

    it('starts and opens a PDF without desktop diagnostics or recovery warnings under an Electron-shaped user agent', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            // Embedded Electron-based browsers report this user agent without
            // installing the EVB preload bridge.
            const page = await browser.newPage({
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
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 120_000);

    it('opens the Start file chooser in the click while the workspace chunk is still loading', async () => {
        const browser = await chromium.launch({headless: true});
        const workspaceModuleRequested = Promise.withResolvers<undefined>();
        const releaseWorkspaceModule = Promise.withResolvers<undefined>();
        try {
            const page = await browser.newPage({viewport: {
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
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 120_000);

    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 90_000);

    it('renders a DjVu open, conversion, and generated PDF reopen in the viewer', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
        } finally {
            await browser.close();
        }
    }, 240_000);

    it('renders an externally replaced PDF and reopens that persisted Recent file', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);

            let openCount = 0;
            const openWithFile = async (filePath: string) => {
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
                await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
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
            ));
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('generated-text.pdf');

            await openWithFile(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ));
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
            await page.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await expect.poll(() => page.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent()).toContain('synthetic-annotation-interoperability.pdf');
            await page.screenshot({
                path: resolve(process.cwd(), '.devkit/browser-pdf-recent-reopen-rendered.png'),
                fullPage: true,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('proves a dirty viewer transfer after source loss before target authority readback', async () => {
        const browser = await chromium.launch({headless: true});
        const context = await browser.newContext();
        const source = await context.newPage();
        const target = await context.newPage();
        try {
            await source.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await target.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                Reflect.set(window, '__evbTransferAuthorityCommittedReadBarrier', () => new Promise<void>(resolveBarrier => {
                    Reflect.set(window, '__evbReleaseTransferAuthorityCommittedReadBarrier', resolveBarrier);
                }));
            });
            await Promise.all([
                source.goto(origin, {waitUntil: 'domcontentloaded'}),
                target.goto(`${origin}?evbWindowId=2`, {waitUntil: 'domcontentloaded'}),
            ]);
            await Promise.all([
                waitForOpenFileReady(source),
                target.waitForFunction(() => Boolean(Reflect.get(window, '__evbTestApi')), undefined, {timeout: 30_000}),
            ]);

            const chooserPromise = source.waitForEvent('filechooser');
            await source.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf',
            ));
            await source.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                state: 'visible',
                timeout: 60_000,
            });
            await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Source PDF did not settle');
            });
            const existingTextBox = source.locator('.pdf-annotation-editor-text-box').filter({hasText: 'Editable interoperability text'}).first();
            await existingTextBox.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await existingTextBox.dblclick();
            const noteEditor = source.locator('.pdf-annotation-editor-text-box__editor').last();
            await noteEditor.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await noteEditor.fill('durable transfer edit');
            await expect.poll(() => noteEditor.textContent()).toBe('durable transfer edit');
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => noteEditor.isVisible()).toBe(true);
            await noteEditor.blur();
            await expect.poll(async () => source.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{dirtyState?: {
                    annotationDirty: boolean;
                    hasAnnotationChanges: boolean;
                };}>(['dirtyState']);
                return state?.dirtyState?.annotationDirty === true
                    && state.dirtyState.hasAnnotationChanges === true;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => source.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).getAttribute('aria-description')).toMatch(/unsaved/i);
            const captured = await source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('captureSplitPayload');
            });
            expect(captured?.called).toBe(true);
            expect(captured?.value).toEqual(expect.objectContaining({kind: 'pdfSnapshot'}));

            await expect.poll(async () => source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return (await api.listTargetWindows?.())?.some(windowInfo => (
                    windowInfo.windowId === 2
                )) ?? false;
            }), {timeout: 30_000}).toBe(true);

            const transferPromise = source.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.transferActiveTabToWindow?.(2);
            });
            await target.waitForFunction(() => typeof Reflect.get(
                window,
                '__evbReleaseTransferAuthorityCommittedReadBarrier',
            ) === 'function', undefined, {timeout: 60_000});
            const provisional = await target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.() ?? null;
            });
            expect(provisional?.canSave).toBe(false);
            // Until the target reads back authority it offers no way to edit:
            // its note tool is disabled, or absent while it has no document.
            expect(await target.getByRole('button', {
                name: /sticky note/i,
                disabled: false,
            }).count()).toBe(0);
            await source.close();
            await target.evaluate(() => {
                const release = Reflect.get(window, '__evbReleaseTransferAuthorityCommittedReadBarrier');
                if (typeof release !== 'function') throw new Error('Target authority read barrier was not installed');
                release();
            });
            const transferResult = await transferPromise;
            expect(transferResult).toMatchObject({
                success: true,
                targetWindowId: 2,
            });

            await expect.poll(() => target.locator(
                '[data-tab-list] [role="tab"][aria-selected="true"]',
            ).textContent(), {timeout: 60_000}).toContain('synthetic-annotation-interoperability.pdf');
            await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Target PDF did not settle after transfer');
            });
            await expect.poll(async () => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                    text?: string;
                    displayText?: string | null;
                    previewText?: string | null;
                }>;}>(['annotationComments']);
                return state?.annotationComments?.some(comment => [
                    comment.text,
                    comment.displayText,
                    comment.previewText,
                ].includes('durable transfer edit')) ?? false;
            }), {timeout: 30_000}).toBe(true);
            await expect.poll(() => target.evaluate(() => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.getActiveToolbarSnapshot?.()?.canSave ?? false;
            }), {timeout: 30_000}).toBe(true);

            const downloadPromise = target.waitForEvent('download');
            const saveResult = await target.evaluate(async () => {
                const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                return api.callActiveWorkspaceCommand?.('handleSaveAs');
            });
            expect(saveResult?.called).toBe(true);
            expect(saveResult?.value).toBe(true);
            const download = await downloadPromise;
            const savedPath = resolve(process.cwd(), '.devkit/browser-transfer-save-reopen/transferred-edited.pdf');
            await download.saveAs(savedPath);

            const reopened = await context.newPage();
            try {
                await reopened.addInitScript(() => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    Reflect.set(window, 'showSaveFilePicker', undefined);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                });
                await reopened.goto(origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(reopened);
                const reopenChooserPromise = reopened.waitForEvent('filechooser');
                await reopened.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await reopenChooserPromise).setFiles(savedPath);
                await reopened.locator('.page_container--rendered .page_canvas canvas').first().waitFor({
                    state: 'visible',
                    timeout: 60_000,
                });
                await reopened.evaluate(async () => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    if (!await api.waitForActiveDocumentOpenSettled?.()) throw new Error('Saved transfer PDF did not settle');
                });
                await expect.poll(async () => reopened.evaluate(() => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const state = api.readActiveWorkspaceStateValues?.<{annotationComments?: Array<{
                        text?: string;
                        displayText?: string | null;
                        previewText?: string | null;
                    }>;}>(['annotationComments']);
                    return state?.annotationComments?.some(comment => [
                        comment.text,
                        comment.displayText,
                        comment.previewText,
                    ].includes('durable transfer edit')) ?? false;
                }), {timeout: 30_000}).toBe(true);
            } finally {
                await reopened.close();
            }
        } finally {
            await browser.close();
        }
    }, 240_000);

    // Sweep #845 item 8: Save As keeps each linked view's zoom.
    it('keeps each linked view zoom through a browser Save As', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_600,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            keepFileChooserInterceptionEnabled(page);
            const chooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            await (await chooserPromise).setFiles(resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Split Right from the tab menu shows the document in a second view.
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count(), {timeout: 20_000}).toBe(2);
            const [
                leftPane,
                rightPane,
            ] = await page.locator('.editor-pane').evaluateAll(panes => panes.map(pane => (pane as HTMLElement).dataset.editorPaneId ?? ''));
            await page.locator(`${paneSelector(rightPane!)} .page_container--rendered canvas`).first().waitFor({
                state: 'visible',
                timeout: 30_000,
            });

            // Each view takes its own custom zoom.
            await clickCenter(page, `${paneSelector(leftPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, leftPane!, 'Zoom In', 2);
            await clickCenter(page, `${paneSelector(rightPane!)} .tab.is-active[data-tab-id]`);
            await zoomActivePane(page, rightPane!, 'Zoom Out', 2);
            const before = {
                left: await readPanePageWidth(page, leftPane!),
                right: await readPanePageWidth(page, rightPane!),
            };
            expect(before.left).not.toBe(before.right);

            // Save As from the right view's Save options menu.
            const readWorkingCopyPath = () => page.evaluate(() => (
                (Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi)
                    .readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath ?? null
            ));
            const workingCopyBefore = await readWorkingCopyPath();
            expect(workingCopyBefore).not.toBeNull();
            const pagesBeforeSaveAs = {
                [leftPane!]: await page.locator(`${paneSelector(leftPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
                [rightPane!]: await page.locator(`${paneSelector(rightPane!)} .page_container--rendered[data-page="1"]`).elementHandle(),
            };
            expect(pagesBeforeSaveAs[leftPane!]).not.toBeNull();
            expect(pagesBeforeSaveAs[rightPane!]).not.toBeNull();
            const downloadPromise = page.waitForEvent('download');
            await page.locator('button[aria-label="Save options"]:not([disabled])').first().click();
            await page.getByRole('menuitem', {name: /^Save As/u}).click();
            await downloadPromise;
            // The Save As has taken effect once the document moved to a new working copy.
            let workingCopyAfter: string | null = null;
            await expect.poll(async () => {
                workingCopyAfter = await readWorkingCopyPath();
                return workingCopyAfter !== null && workingCopyAfter !== workingCopyBefore;
            }, {timeout: 30_000}).toBe(true);
            // Wait for the replacement page, then read its readiness and width
            // in one browser observation. An outgoing page can detach between
            // separate readiness and geometry reads.
            const readCurrentPaintedPageWidth = async (paneId: string) => {
                await clickCenter(page, `${paneSelector(paneId)} .tab.is-active[data-tab-id]`);
                const observation = await page.waitForFunction(({
                    selector, previousPage, workingCopyPath,
                }) => {
                    const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                    const currentPage = document.querySelector<HTMLElement>(selector);
                    const canvas = currentPage?.querySelector('canvas');
                    const canvasRect = canvas?.getBoundingClientRect();
                    const canvasVisible = canvas && getComputedStyle(canvas).visibility === 'visible';
                    if (!currentPage?.isConnected || currentPage === previousPage
                        || !canvasVisible || !canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0
                        || api.getActiveToolbarSnapshot?.()?.initialVisualReady !== true
                        || api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath !== workingCopyPath) {
                        return null;
                    }
                    return {width: Math.round(currentPage.getBoundingClientRect().width)};
                }, {
                    selector: `${paneSelector(paneId)} .page_container--rendered[data-page="1"]`,
                    previousPage: pagesBeforeSaveAs[paneId],
                    workingCopyPath: workingCopyAfter,
                }, {timeout: 30_000});
                const measured = await observation.jsonValue();
                if (!measured) {
                    throw new Error('Replacement page observation is unavailable');
                }
                return measured.width;
            };

            expect({
                right: await readCurrentPaintedPageWidth(rightPane!),
                left: await readCurrentPaintedPageWidth(leftPane!),
            }).toEqual(before);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('finds a regex match while the search worker is still starting', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
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
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
        }
    }, 120_000);

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
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            const consoleProblems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await browser.close();
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
        const browser = await chromium.launch({headless: true});
        const evidenceDir = resolve(process.cwd(), `.devkit/browser-search-cache-mutation-${process.pid}`);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(resolve(evidenceDir, `${fault}-source.pdf`), bytes);
        let page: Page | undefined;
        try {
            page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 900,
                },
                recordVideo: {dir: evidenceDir},
            });
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
                storedBytes = await page!.evaluate(async (ref) => {
                    const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
                        const request = indexedDB.open('evb-viewer-browser-documents');
                        request.onsuccess = () => resolveDb(request.result);
                        request.onerror = () => rejectDb(request.error);
                    });
                    try {
                        return await new Promise<number[]>((resolveBytes, rejectBytes) => {
                            const request = db.transaction('documents', 'readonly').objectStore('documents').get(ref);
                            request.onsuccess = () => resolveBytes(Array.from(request.result?.data ?? []));
                            request.onerror = () => rejectBytes(request.error);
                        });
                    } finally {db.close();}
                }, workingPath);
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
            expect(problems.every(problem => problem.includes('[search] Optional search-cache invalidation failed'))).toBe(true);
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
                const video = page.video();
                await page.close();
                await video?.saveAs(resolve(evidenceDir, `${fault}-proof.webm`));
            }
            await browser.close();
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
        const browser = await chromium.launch({headless: true});
        let page: Page | undefined;
        try {
            page = await browser.newPage({
                viewport: {
                    width: 1280,
                    height: 900,
                },
                recordVideo: {dir: evidenceDir},
            });
            const problems = collectConsoleProblems(page);
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                Reflect.set(window, 'showSaveFilePicker', undefined);
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
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
            await input.pressSequentially('proof');
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
            if (page) {
                await page.screenshot({path: resolve(evidenceDir, 'final.png')}).catch(() => {});
                const video = page.video();
                await page.close();
                await video?.saveAs(resolve(evidenceDir, 'proof.webm'));
            }
            await browser.close();
        }
    }, 120_000);

});
