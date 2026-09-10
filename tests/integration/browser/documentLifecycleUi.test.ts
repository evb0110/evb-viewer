import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
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

async function reservePort() {
    const reservation = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
        reservation.once('error', rejectListen);
        reservation.listen(0, '127.0.0.1', resolveListen);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser lifecycle test could not reserve a port');
    }
    await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
    return address.port;
}

async function waitForServer(url: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (devServer?.exitCode !== null) {
            throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
        }
        try {
            const response = await fetch(url);
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

async function stopServer() {
    const server = devServer;
    devServer = null;
    if (!server || server.exitCode !== null) {
        return;
    }
    server.kill('SIGTERM');
    await Promise.race([
        new Promise<void>(resolveExit => server.once('exit', () => resolveExit())),
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (server.exitCode === null) {
        server.kill('SIGKILL');
    }
}

beforeAll(async () => {
    const port = await reservePort();
    origin = `http://127.0.0.1:${String(port)}`;
    devServer = spawn('pnpm', [
        'exec',
        'nuxi',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
        },
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
    await waitForServer(origin);
}, 120_000);

afterAll(async () => {
    await stopServer();
});

describe('browser document lifecycle UI', () => {
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

            await page.getByTestId('workspace-document-pdf-error').waitFor({
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
    }, 180_000);

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
            expect(await target.getByRole('button', {name: /sticky note/i}).first().isDisabled()).toBe(true);
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
});
