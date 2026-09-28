import {
    copyFileSync, existsSync, mkdirSync,
} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createFreeTextAnnotationWithPointer, readPdfTextAnnotationRecords,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab, openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type {Page} from 'puppeteer-core';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-move-dirty-tab-save-${Date.now()}`});
const stagedFixture = '/home/ubuntu/.devkit/project12-stage/fixtures/interaction-deterministic-12.pdf';

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

async function visibleAnnotationTexts(page: Page) {
    return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]',
    )).map(element => element.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() ?? '').filter(Boolean));
}

describe('dirty tab transfer and annotation save', () => {
    it('transfers the committed annotation and saves a later edit with it', async () => {
        const fixtureDir = resolve('.devkit/project12/877');
        mkdirSync(fixtureDir, {recursive: true});
        const sourcePath = resolve(fixtureDir, `move-dirty-source-${Date.now()}.pdf`);
        copyFileSync(stagedFixture, sourcePath);
        const destinationPath = sourcePath.replace(/\.pdf$/u, '-saved.pdf');
        const session = await sessions.restart({
            clean: true,
            extraEnv: {EVB_E2E_SAVE_DIALOG_PATH: destinationPath},
        });
        await openPdfInApp(session.page, sourcePath);
        await waitForPdfLoaded(session.page);
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
        await createFreeTextAnnotationWithPointer(destination, second, {
            x: 0.28,
            y: 0.58,
        }, 1);
        const saveOptions = await destination.waitForSelector('button[aria-label="Save options"]', {
            visible: true,
            timeout: 10_000,
        });
        await saveOptions!.click();
        const saveAs = await destination.waitForSelector('[role="menuitem"]', {
            visible: true,
            timeout: 10_000,
        });
        const menuItems = await destination.$$('[role="menuitem"]');
        const saveAsItem = (await Promise.all(menuItems.map(async candidate => ({
            candidate,
            text: await candidate.evaluate(element => element.textContent ?? ''),
        })))).find(entry => /Save As/u.test(entry.text))?.candidate;
        if (!saveAsItem || !saveAs) throw new Error('Save As was not available in the visible save menu');
        await saveAsItem.click();
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
