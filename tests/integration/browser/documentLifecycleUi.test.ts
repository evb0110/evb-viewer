import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {
    findFreePort, isProcessAlive, killProcessTree,
} from '@scripts/electron-run/electronRunProcessTree';
import {buildNuxtDevServerEnv} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    PDFDocument,
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
                await page.getByRole('button', {
                    name: 'Settings',
                    exact: true,
                }).filter({visible: true}).first().click();
                await page.getByRole('link', {
                    name: informationPage === 'privacy'
                        ? 'Read the complete privacy notice' : 'Open About and Acknowledgements',
                    exact: true,
                }).filter({visible: true}).click();
                await expect.poll(() => new URL(page.url()).pathname).toBe(`/${informationPage}`);
                await page.locator(`.${informationPage}-document h1`).waitFor();
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}.png`)});
                if (informationPage === 'about') {
                    await page.getByRole('link', {
                        name: 'Back to viewer',
                        exact: true,
                    }).click();
                } else {
                    await page.goBack();
                }
                await expect.poll(() => new URL(page.url()).pathname).toBe('/');
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-returned-shell.png`)});
                await page.locator(`${paneSelector(right)} .tab`).filter({hasText: 'generated-text.pdf'}).click();
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
                expect(await Promise.all(panes.map(pane => readPanePageWidth(page, pane)))).toEqual(widths);
                await page.screenshot({path: resolve(process.cwd(), `.devkit/browser-information-${informationPage}-return.png`)});
            }
        } finally {
            await browser.close();
        }
    }, 90_000);

    // T2/T3: accepted note text must reach durable recovery bytes while Save
    // remains available. The recovery timer runs the real save transaction.
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
            // Observe the persisted detached print artifact before its owner
            // releases it. The separate print-layout /Text appearance refusal
            // occurs after this byte-preparation boundary.
            await page.evaluate((noteText) => {
                const put = IDBObjectStore.prototype.put;
                Reflect.set(window, '__restorePrintArtifactObserver', () => {IDBObjectStore.prototype.put = put;});
                const encoded = [...noteText].map(character => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
                IDBObjectStore.prototype.put = function observePrintArtifact(value, key) {
                    const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
                    if (this.name === 'documents' && value?.kind === 'working'
                        && value?.retention === 'transient' && value?.fileName?.endsWith('.staged-native-save.pdf')) {
                        request.transaction?.addEventListener('complete', () => {
                            Reflect.set(window, '__preparedPrintNote', new TextDecoder().decode(value.data).toLowerCase().includes(encoded));
                        }, {once: true});
                    }
                    return request;
                };
            }, text);
            await page.getByRole('button', {
                name: 'Print',
                exact: true,
            }).click();
            await page.getByRole('button', {
                name: 'Print...',
                exact: true,
            }).click();
            await expect.poll(() => page.evaluate(() => Reflect.get(window, '__preparedPrintNote') ?? false), {timeout: 15_000}).toBe(true);
            await page.evaluate(() => {Reflect.get(window, '__restorePrintArtifactObserver')(); Reflect.deleteProperty(window, '__restorePrintArtifactObserver');});
            await page.getByRole('button', {
                name: 'Cancel',
                exact: true,
            }).click();
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
            // Each view replaces its source, so page 1 is measured only once that
            // view shows the new working copy, reports its first visual ready and
            // paints page 1 again. Canvases of the old source do not count.
            const readCurrentPaintedPageWidth = async (paneId: string) => {
                await clickCenter(page, `${paneSelector(paneId)} .tab.is-active[data-tab-id]`);
                const renderedPage = page.locator(`${paneSelector(paneId)} .page_container--rendered[data-page="1"]`);
                await expect.poll(async () => {
                    const view = await page.evaluate(() => {
                        const api = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi;
                        return {
                            workingCopyPath: api.readActiveWorkspaceStateValues?.<{workingCopyPath?: string | null}>(['workingCopyPath']).workingCopyPath ?? null,
                            initialVisualReady: api.getActiveToolbarSnapshot?.()?.initialVisualReady === true,
                        };
                    });
                    return {
                        ...view,
                        paintedPage: await renderedPage.locator('canvas').first().isVisible(),
                    };
                }, {timeout: 30_000}).toEqual({
                    workingCopyPath: workingCopyAfter,
                    initialVisualReady: true,
                    paintedPage: true,
                });
                return renderedPage.first().evaluate(element => Math.round(element.getBoundingClientRect().width));
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
