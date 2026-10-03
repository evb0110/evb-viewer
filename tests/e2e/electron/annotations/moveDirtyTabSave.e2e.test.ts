import {
    copyFileSync, existsSync, mkdtempSync, rmSync,
} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    afterEach, describe, expect, it,
} from 'vitest';
import {
    startElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {readPdfTextAnnotationRecords} from '@tests/e2e/electron/helpers/fixtures';
import {createFreeTextAnnotationWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab, waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {openNewPane} from '@tests/e2e/electron/helpers/workspaceTabs';
import {
    getLatestAutomationEventId,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import type {Page} from 'puppeteer-core';

let outputDirectory: string | null = null;
let session: IElectronE2ESession | null = null;

afterEach(async () => {
    await session?.stop({preserveArtifacts: true});
    session = null;
    if (outputDirectory) rmSync(outputDirectory, {
        recursive: true,
        force: true,
    });
    outputDirectory = null;
});

async function moveTabToNewWindow(page: Page) {
    const browser = page.browser();
    const oldPages = new Set(await browser.pages());
    await clickAsUser(page, '.tab-new');
    await clickAsUser(page, '.tab-list [role="tab"]:first-child');
    await clickAsUser(page, '.tab-list [role="tab"].is-active', {button: 'right'});
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="menuitem"]'))
        .some(item => item.textContent?.includes('Move Tab to New Window')));
    const item = await page.$('[role="menuitem"]');
    const candidates = await page.$$('[role="menuitem"]');
    const transfer = await Promise.all(candidates.map(async candidate => ({
        candidate,
        text: await candidate.evaluate(element => element.textContent ?? ''),
    })));
    const menuItem = transfer.find(candidate => candidate.text.includes('Move Tab to New Window'))?.candidate;
    if (!menuItem || !item) throw new Error('Move Tab to New Window menu item was not rendered');
    await clickAsUser(page, menuItem);
    let destination: Page | undefined;
    const deadline = Date.now() + 30_000;
    while (!destination && Date.now() < deadline) {
        destination = (await browser.pages()).find(candidate => !oldPages.has(candidate));
        if (!destination) await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!destination) throw new Error('Move Tab to New Window did not create a destination window');
    await waitForFunctionInPage(destination, () => document.querySelector('.page_container--rendered') !== null, {timeout: 30_000});
    return destination;
}

async function createDestinationTextAnnotation(page: Page, text: string) {
    await openAnnotationsTab(page);
    const textTool = await page.waitForSelector('.editor-pane.is-active .notes-panel .tool-button[data-tool="text"]', {visible: true});
    await clickAsUser(page, textTool!);
    const selector = '.editor-pane.is-active .page_container[data-page="1"]';
    await page.waitForFunction((pageSelector: string) => {
        const container = document.querySelector<HTMLElement>(pageSelector);
        const layer = container?.querySelector<HTMLElement>('.pdf-annotation-editor-layer');
        const rect = layer?.getBoundingClientRect();
        return Boolean(container?.classList.contains('page_container--rendered')
            && layer?.classList.contains('is-interactive')
            && rect && rect.width > 0 && rect.height > 0);
    }, {timeout: 30_000}, selector);
    const point = await page.$eval(selector, container => {
        const layer = container.querySelector<HTMLElement>('.pdf-annotation-editor-layer')!;
        const rect = layer.getBoundingClientRect();
        return {
            x: rect.left + rect.width * 0.58,
            y: rect.top + rect.height * 0.58,
        };
    });
    await page.mouse.click(point.x, point.y);
    const editorSelector = `${selector} .pdf-annotation-editor-text-box.is-editing [contenteditable="true"]`;
    await page.waitForSelector(editorSelector, {
        visible: true,
        timeout: 30_000,
    });
    await page.waitForFunction((target: string) => document.activeElement === document.querySelector(target), {timeout: 10_000}, editorSelector);
    await page.keyboard.type(text, {delay: 10});
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(modifier);
    try {
        await page.keyboard.press('Enter');
    } finally {
        await page.keyboard.up(modifier);
    }
    await page.waitForFunction((expected: string) => Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
    )).some(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === expected), {timeout: 30_000}, text);
}

async function visibleAnnotationTexts(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
    )).map(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? '').filter(Boolean));
}

async function dragTabToOtherPane(page: Page, sourcePaneId: string, targetPaneId: string) {
    const points = await page.evaluate((payload: {
        source: string;
        target: string;
    }) => {
        const center = (element: Element | null) => {
            const rect = element?.getBoundingClientRect();
            return rect && rect.width > 0 ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            } : null;
        };
        return {
            from: center(document.querySelector(`.editor-pane[data-editor-pane-id="${payload.source}"] .tab.is-active[data-tab-id]`)),
            to: center(document.querySelector(`.editor-pane[data-editor-pane-id="${payload.target}"] .tab-list`)),
        };
    }, {
        source: sourcePaneId,
        target: targetPaneId,
    });
    if (!points.from || !points.to) throw new Error(`Tab drag points are not visible: ${JSON.stringify(points)}`);
    await page.mouse.move(points.from.x, points.from.y);
    await page.mouse.down();
    const steps = 12;
    for (let step = 1; step <= steps; step += 1) {
        await page.mouse.move(
            points.from.x + (points.to.x - points.from.x) * step / steps,
            points.from.y + (points.to.y - points.from.y) * step / steps,
        );
    }
    await page.mouse.up();
}

describe('dirty tab transfer and annotation save', () => {
    it('transfers the committed annotation and saves a later edit with it', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-dirty-tab-save-'));
        const sourcePath = join(outputDirectory, 'move-dirty-source.pdf');
        copyFileSync(resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf'), sourcePath);
        const destinationPath = join(outputDirectory, 'move-dirty-saved.pdf');
        session = await startElectronE2ESession(`e2e-move-dirty-tab-save-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destinationPath},
            initialOpenPaths: [sourcePath],
        });
        await waitForPdfLoaded(session.page);
        await waitForViewerInteractive(session.page);
        const first = `Moved annotation ${Date.now()}`;
        await createFreeTextAnnotationWithPointer(session.page, first, {
            x: 0.28,
            y: 0.32,
        }, 1);
        expect(await visibleAnnotationTexts(session.page)).toContain(first);
        const sourceBytes = await readFile(sourcePath);

        const destination = await moveTabToNewWindow(session.page);
        await openAnnotationsTab(destination);
        expect(await visibleAnnotationTexts(destination)).toContain(first);
        expect(await destination.evaluate(() => document.body.innerText)).toContain(first);

        const second = `Destination edit ${Date.now()}`;
        await createDestinationTextAnnotation(destination, second);
        const saveOptionTargets = await destination.$$eval('button[aria-label="Save options"]', buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
            };
        }).filter(target => target.visible));
        if (saveOptionTargets.length === 0) {
            throw new Error('The destination Save options control is not visible');
        }
        await destination.mouse.click(saveOptionTargets[0]!.x, saveOptionTargets[0]!.y);
        const saveAsItems = await destination.$$('[role="menuitem"]');
        const saveAsItem = (await Promise.all(saveAsItems.map(async candidate => ({
            candidate,
            visible: await candidate.isVisible(),
            text: await candidate.evaluate(element => element.textContent ?? ''),
        })))).find(entry => entry.visible && /Save As/u.test(entry.text))?.candidate;
        if (!saveAsItem) throw new Error('Save As was not available in the visible save menu');
        const saveAsRect = await saveAsItem.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            };
        });
        await destination.mouse.click(saveAsRect.x, saveAsRect.y);
        const saveDeadline = Date.now() + 30_000;
        while (!existsSync(destinationPath) && Date.now() < saveDeadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(existsSync(destinationPath), 'Save As must write the selected output').toBe(true);
        expect(await readFile(sourcePath)).toEqual(sourceBytes);
        expect(await readPdfTextAnnotationRecords(destinationPath)).toEqual(expect.arrayContaining([
            expect.objectContaining({contents: first}),
            expect.objectContaining({contents: second}),
        ]));
    }, 150_000);

    it('keeps a committed annotation dirty and saveable after moving its tab to another pane', async () => {
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-dirty-tab-pane-move-'));
        const sourcePath = join(outputDirectory, 'move-dirty-pane-source.pdf');
        copyFileSync(resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf'), sourcePath);
        session = await startElectronE2ESession(`e2e-move-dirty-tab-pane-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [sourcePath],
        });
        const {page} = session;
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        const annotation = `Pane move annotation ${Date.now()}`;
        await createFreeTextAnnotationWithPointer(page, annotation, {
            x: 0.28,
            y: 0.32,
        }, 1);
        const sourceBytes = await readFile(sourcePath);
        const sourcePaneId = await page.$eval('.editor-pane.is-active', pane => (pane as HTMLElement).dataset.editorPaneId ?? '');

        // An empty pane on the right gives the drag a destination.
        await openNewPane(page, 'right');
        const targetPaneId = await page.$$eval('.editor-pane', (panes, source) => panes
            .map(pane => (pane as HTMLElement).dataset.editorPaneId ?? '')
            .find(id => id !== source) ?? '', sourcePaneId);

        await dragTabToOtherPane(page, sourcePaneId, targetPaneId);
        await page.waitForFunction((target: string, name: string) => Array.from(document.querySelectorAll<HTMLElement>(
            `.editor-pane[data-editor-pane-id="${target}"] .tab[data-tab-id]`,
        )).some(tab => tab.textContent?.includes(name)), {timeout: 30_000}, targetPaneId, 'move-dirty-pane-source.pdf');
        await waitForFunctionInPage(page, (target: string, expected: string) => {
            const pane = document.querySelector<HTMLElement>(`.editor-pane[data-editor-pane-id="${target}"]`);
            const tab = Array.from(pane?.querySelectorAll<HTMLElement>('.tab[data-tab-id]') ?? [])
                .find(candidate => candidate.textContent?.includes('move-dirty-pane-source.pdf'));
            const rendered = Array.from(pane?.querySelectorAll<HTMLElement>('.pdf-annotation-editor-layer [data-annotation-kind="text-box"]') ?? [])
                .some(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === expected);
            return Boolean(tab?.classList.contains('is-active') && tab.classList.contains('is-dirty') && rendered);
        }, {timeout: 30_000}, targetPaneId, annotation);
        expect(await readFile(sourcePath)).toEqual(sourceBytes);

        // Save is offered once the moved view has the document again.
        const saveHandle = await page.waitForFunction(() => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="Save"], button[aria-label^="Save ("]'))
                .find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    return !candidate.disabled && rect.width > 0 && rect.height > 0;
                });
            const rect = button?.getBoundingClientRect();
            return rect
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        }, {timeout: 30_000});
        const saveTarget = await saveHandle.jsonValue();
        await saveHandle.dispose();
        if (!saveTarget) throw new Error('No enabled visible Save control after the pane move');
        const saveBaseline = await getLatestAutomationEventId(page);
        await page.mouse.click(saveTarget.x, saveTarget.y);
        await waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaseline,
            path: sourcePath,
            timeoutMs: 60_000,
        });
        await waitForFunctionInPage(page, (target: string) => Array.from(document.querySelectorAll<HTMLElement>(
            `.editor-pane[data-editor-pane-id="${target}"] .tab.is-active[data-tab-id]`,
        )).every(tab => !tab.classList.contains('is-dirty')), {timeout: 30_000}, targetPaneId);
        expect(await readPdfTextAnnotationRecords(sourcePath)).toEqual(expect.arrayContaining([expect.objectContaining({contents: annotation})]));
    }, 150_000);
});
