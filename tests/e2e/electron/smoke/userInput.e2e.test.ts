import type * as electronRunLaunchConfig from '@scripts/electron-run/electronRunLaunchConfig';
import {join} from 'node:path';
import {
    mkdtemp, rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {findFreePort} from '@scripts/electron-run/electronRunProcessTree';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    openDocumentSidebarTab, openPdfInApp, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {
    afterAll, describe, expect, it, vi,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';

// This branch defaults Linux E2E to a mapped window on private Xvfb.
// The diagnosis specifically requires an unmapped hidden window.
vi.mock('@scripts/electron-run/electronRunLaunchConfig', async (importOriginal) => {
    const original = await importOriginal<typeof electronRunLaunchConfig>();
    return {
        ...original,
        buildElectronE2EAutomationEnv:(env:NodeJS.ProcessEnv)=>({
            ...original.buildElectronE2EAutomationEnv(env),
            EVB_AUTOMATION_HIDE_WINDOW:'1',
        }),
    };
});

interface IInspectorResult {
    result?: { value?: unknown };
    exceptionDetails?: unknown;
}

interface IInspectorResponse {
    id: number;
    result: IInspectorResult;
    error?: unknown;
}

async function connectMain(port: number) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json() as Array<{ webSocketDebuggerUrl: string }>;
    const target = targets[0];
    if (!response.ok || !target) {
        throw new Error('The task-owned Electron main inspector is unavailable');
    }
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = reject;
    });
    let requestId = 0;
    const pending = new Map<number, {
        resolve: (value: IInspectorResult) => void;
        reject: (error: unknown) => void;
    }>();
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data)) as IInspectorResponse;
        const callback = pending.get(message.id);
        if (!callback) {
            return;
        }
        pending.delete(message.id);
        if (message.error) {
            callback.reject(message.error);
        } else {
            callback.resolve(message.result);
        }
    };
    return {
        async evaluate(expression: string) {
            const id = ++requestId;
            const result = await new Promise<IInspectorResult>((resolve, reject) => {
                pending.set(id, {
                    resolve,
                    reject,
                });
                socket.send(JSON.stringify({
                    id,
                    method: 'Runtime.evaluate',
                    params: {
                        expression,
                        awaitPromise: true,
                        returnByValue: true,
                    },
                }));
            });
            if (result.exceptionDetails) {
                throw new Error(JSON.stringify(result.exceptionDetails));
            }
            return result.result?.value;
        },
        close: () => socket.close(),
    };
}

const inspectorPort = await findFreePort();
const stateDirectory = await mkdtemp(join(tmpdir(), 'select-all-state-'));
afterAll(() => rm(stateDirectory, {
    recursive: true,
    force: true,
}));


// These are pointer fixtures inside the real hidden window. The helper is the
// subject: DOM setup supplies the layout, and only trusted input can record
// the outcome. No application command substitutes for the click or wheel.
async function mountPointerFixture(page: Page, markup: string) {
    await page.evaluate((html) => {
        const fixture = document.createElement('div');
        fixture.id = 'pointer-fixture';
        fixture.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:black';
        fixture.innerHTML = html;
        fixture.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            fixture.dataset.clicked = target.closest('[data-target]')?.getAttribute('data-target') ?? '';
            fixture.dataset.trusted = String(event.isTrusted);
            if (target.closest('[data-target="dismiss"]')) {
                fixture.querySelector('#pointer-cover')?.remove();
            }
        });
        document.body.append(fixture);
    }, markup);
}

async function readPointerOutcome(page: Page) {
    return page.evaluate(() => {
        const fixture = document.querySelector<HTMLElement>('#pointer-fixture');
        const scroller = fixture?.querySelector<HTMLElement>('[data-scroller]');
        return {
            clicked: fixture?.dataset.clicked ?? null,
            trusted: fixture?.dataset.trusted ?? null,
            scrollLeft: scroller?.scrollLeft ?? 0,
            scrollTop: scroller?.scrollTop ?? 0,
        };
    });
}

describe('trusted pointer harness', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-user-input-${Date.now()}`});
    it('clicks a child of a visible target with trusted input', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, '<button data-target="visible" style="margin:40px"><span>Visible target</span></button>');
        await clickAsUser(page, '[data-target="visible"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'visible',
            trusted: 'true',
        });
    });

    it('clicks the visible portion of a target wider and taller than its scroll panel without scrolling it away', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto">
                <button data-target="oversized" style="display:block;width:1000px;height:800px">Large target</button>
            </div>
        `);
        await clickAsUser(page, '[data-target="oversized"]', {timeoutMs: 2000});
        expect(await readPointerOutcome(page)).toEqual({
            clicked: 'oversized',
            trusted: 'true',
            scrollLeft: 0,
            scrollTop: 0,
        });
    });

    it('reveals an offscreen nested scroll panel before wheeling its target', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:260px;height:180px;overflow:auto">
                <div style="height:800px;padding-top:400px">
                    <div style="width:220px;height:140px;overflow:auto">
                        <div style="height:350px"></div>
                        <button data-target="nested">Nested target</button>
                    </div>
                </div>
            </div>
        `);
        await clickAsUser(page, '[data-target="nested"]', {timeoutMs: 3000});
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'nested',
            trusted: 'true',
        });
    });

    it('aims again when hovering the target moves it before the click', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, '<button data-target="hover" style="position:absolute;left:40px;top:40px">Moving target</button>');
        await page.evaluate(() => {
            const target = document.querySelector<HTMLElement>('[data-target="hover"]')!;
            target.addEventListener('pointerenter', () => {target.style.left = '350px';}, {once: true});
        });
        await clickAsUser(page, '[data-target="hover"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'hover',
            trusted: 'true',
        });
    });

    it('wheels the outer panel at a point where a nested panel cannot consume its wheel', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:260px;height:180px;overflow:auto">
                <div style="width:220px;height:140px;overflow:auto"><div style="height:600px"></div></div>
                <div style="height:250px"></div>
                <button data-target="outer">Outer target</button>
            </div>
        `);
        await clickAsUser(page, '[data-target="outer"]', {timeoutMs: 3000});
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'outer',
            trusted: 'true',
        });
    });

    it('refuses a target covered by a dialog and clicks it after the dialog is dismissed', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <button data-target="covered" style="position:absolute;left:50px;top:50px">Covered target</button>
            <div id="pointer-cover" style="position:absolute;inset:0;background:white">
                <button data-target="dismiss" style="margin:200px">Dismiss</button>
            </div>
        `);
        await expect(clickAsUser(page, '[data-target="covered"]', {timeoutMs: 250})).rejects.toThrow('covered by');
        expect((await readPointerOutcome(page)).clicked).toBeNull();
        await clickAsUser(page, '[data-target="dismiss"]');
        await clickAsUser(page, '[data-target="covered"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'covered',
            trusted: 'true',
        });
    });

    it('wheels a target into view and resolves a found target in the page', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto;scroll-behavior:smooth">
                <div style="height:450px"></div>
                <button data-target="found">Find me</button>
            </div>
        `);
        await clickFoundAsUser(page, (label) => Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent === label), 'Find me', {description: 'the found button'});
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'found',
            trusted: 'true',
        });
    });

    it('restores native content size, scale and focus after viewport emulation and a real resize', async () => {
        const session = sessions.getSession();
        await session.command('windowResize', [
            600,
            500,
        ]);
        await session.page.setViewport({
            width: 1200,
            height: 800,
            deviceScaleFactor: 3,
        });
        await session.resetForE2E();
        expect(await session.page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            scale: devicePixelRatio,
            focus: document.hasFocus(),
            visibility: document.visibilityState,
        }))).toEqual({
            width: 900,
            height: 672,
            scale: 1,
            focus: true,
            visibility: 'visible',
        });
    });

    it('preserves native high-DPI rendering through a renderer reset', async () => {
        const session = await sessions.restart({
            hard: true,
            extraEnv: {EVB_AUTOMATION_DEVICE_SCALE_FACTOR: '2'},
        });
        await session.page.setViewport({
            width: 500,
            height: 400,
            deviceScaleFactor: 3,
        });
        await session.resetForE2E();
        expect(await session.page.evaluate(() => devicePixelRatio)).toBe(2);
        const png = Buffer.from(await session.page.screenshot({type: 'png'}));
        expect({
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
        }).toEqual({
            width: 1800,
            height: 1344,
        });
    });
});

describe('Select All input ordering', () => {
    const sessions = createElectronE2ESessionFixture({
        sessionName: () => `e2e-select-all-ordering-${Date.now()}`,
        extraEnv: {
            EVB_APP_STATE_DIR: stateDirectory,
            EVB_AUTOMATION_EXTRA_CHROMIUM_SWITCHES: `--inspect=127.0.0.1:${inspectorPort}`,
        },
    });
    it('keeps typing after a menu Select All in the focused page-label field', async () => {
        const { page } = sessions.getSession();
        await openPdfInApp(page, await createMultiPageTextFixturePdf('select-all-ordering.pdf', 2));
        await waitForViewerInteractive(page);
        await openDocumentSidebarTab(page, 'Pages');
        const scope = '.workspace-host[data-workspace-active="true"]';
        const disclosure = `${scope} .pdf-sidebar-pages-disclosure`;
        if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, disclosure);
        }
        await clickAsUser(page, '#page-label-prefix-input');
        // Seed a collapsed caret, so the actual menu action must select the old value.
        await page.$eval('#page-label-prefix-input', (element) => {
            const input = element as HTMLInputElement;
            input.value = 'Accepted-';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.setSelectionRange(input.value.length, input.value.length);
        });

        if (process.platform === 'darwin') {
            // AppKit translates Control+A to line navigation on macOS. Keep
            // that native edit command available rather than treating it as Cmd+A.
            await page.keyboard.down('Control');
            await page.keyboard.press('a', { commands: ['MoveToBeginningOfLine'] });
            await page.keyboard.up('Control');
            const selection = await page.$eval('#page-label-prefix-input', (element) => {
                const input = element as HTMLInputElement;
                return [
                    input.selectionStart,
                    input.selectionEnd,
                ];
            });
            expect(selection).toEqual([
                0,
                0,
            ]);
            await page.$eval('#page-label-prefix-input', (element) => {
                const input = element as HTMLInputElement;
                input.setSelectionRange(input.value.length, input.value.length);
            });
        }

        const main = await connectMain(inspectorPort);
        try {
            await main.evaluate(`(() => {
                if (process.cwd() !== ${JSON.stringify(process.cwd())}) throw new Error('Wrong Electron inspector');
                const { BrowserWindow, Menu } = process.getBuiltinModule('module')
                    .createRequire(process.cwd() + '/package.json')('electron');
                const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('/electron'));
                if (!window || window.isVisible()) throw new Error('Expected a task-owned hidden app window');
                const find = menu => {
                    for (const item of menu.items) {
                        if (item.accelerator === 'CmdOrCtrl+A') return item;
                        const nested = item.submenu && find(item.submenu);
                        if (nested) return nested;
                    }
                };
                const item = find(Menu.getApplicationMenu());
                if (!item?.enabled || !item.visible) throw new Error('Select All unavailable');
                const contents = window.webContents;
                // One main-process tick. This bypasses only OS routing, and reaches
                // the real menu handler before queueing the following trusted keys.
                item.click({ triggeredByAccelerator: true }, window, contents);
                const send = character => {
                    contents.sendInputEvent({ type: 'keyDown', keyCode: character });
                    contents.sendInputEvent({ type: 'char', keyCode: character });
                    contents.sendInputEvent({ type: 'keyUp', keyCode: character });
                };
                send('L');
                // Queue subsequent keys now, at a fast person's typing pace.
                // The leading key is already in flight while the old focus probe awaits.
                return new Promise(resolve => {
                    for (const [index, character] of [...'ate-'].entries()) {
                        setTimeout(() => {
                            send(character);
                            if (index === 3) resolve(true);
                        }, (index + 1) * 5);
                    }
                });
            })()`);
            await page.waitForFunction(() => (
                (document.querySelector('#page-label-prefix-input') as HTMLInputElement)?.value === 'Late-'
            ), { timeout: 10_000 });
            await clickAsUser(page, `${scope} .pdf-sidebar-pages-primary-button`);
            await expect.poll(async () => (await readToolbarPageIndicator(page)).primaryText).toBe('Late-1');
        } finally {
            main.close();
        }
    });
});
