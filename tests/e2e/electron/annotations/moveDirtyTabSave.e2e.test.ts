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
    await page.click('.tab-new');
    await page.click('.tab-list [role="tab"]:first-child');
    await page.click('.tab-list [role="tab"].is-active', {button: 'right'});
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
    await menuItem.click();
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
    await textTool!.click();
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
});
