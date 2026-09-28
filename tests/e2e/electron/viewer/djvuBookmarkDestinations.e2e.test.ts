import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openDjvuInApp, openPdfInApp, openDocumentSidebarTab, waitForDjvuLoaded, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';

const execFileAsync = promisify(execFile);
const sourcePath = resolve('tests/fixtures/djvu/sources/bookmark-component-ids.djvu');

describe('DjVu converted bookmark destinations', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-bookmark-destinations-${Date.now()}`});

    it('preserves component-ID bookmark targets in the saved PDF and navigates after reopening', async () => {
        const outputPath = resolve('.devkit/project12/875/evidence/converted.pdf');
        await rm(outputPath, {force: true});
        const session = await sessions.restart({
            clean: true,
            sessionName: () => `e2e-djvu-bookmark-destinations-${Date.now()}`,
            extraEnv: {
                EVB_E2E_SAVE_DIALOG_PATH: outputPath,
                EVB_PDF_IMAGE_COMBINE_ENABLE: '1',
            },
        });
        await openDjvuInApp(session.page, sourcePath, 120_000);
        await waitForDjvuLoaded(session.page, 120_000);
        await session.page.click('[data-focus-restore="djvu-convert"]');
        await waitForFunctionInPage(session.page, () => {
            const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                .find(element => element.textContent?.includes('Convert DjVu to PDF'));
            if (!dialog) return false;
            const button = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
                .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled);
            return button !== undefined;
        }, {timeout: 30_000});
        await session.page.click('.convert-advanced-toggle');
        await waitForFunctionInPage(session.page, () => {
            const radio = document.querySelector<HTMLButtonElement>('[role="radio"][value="direct-1"]');
            return Boolean(radio && !radio.disabled);
        }, {timeout: 30_000});
        await session.page.click('[role="radio"][value="direct-1"]');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('[role="radio"][value="direct-1"]')?.getAttribute('aria-checked') === 'true'
        ), {timeout: 5_000});
        await waitForFunctionInPage(session.page, () => {
            const dialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
                .find(element => element.textContent?.includes('Convert DjVu to PDF'));
            const button = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
                .find(candidate => candidate.textContent?.trim() === 'Convert' && !candidate.disabled);
            if (!button) return false;
            button.click();
            return true;
        }, {timeout: 30_000});
        await expect.poll(() => existsSync(outputPath), {timeout: 300_000}).toBe(true);
        const qpdf = getPdfNativeToolPaths().qpdf;
        const {stdout: outlineJson} = await execFileAsync(qpdf, [
            '--json',
            '--json-key=outlines',
            outputPath,
        ]);
        const outline = JSON.parse(outlineJson) as {outlines: Array<{
            action?: unknown;
            dest?: unknown;
            destpageposfrom1?: number;
            kids: unknown[];
            title: string;
        }>;};
        expect(outline.outlines.map(entry => ({
            hasDestination: entry.dest !== undefined || entry.action !== undefined,
            page: entry.destpageposfrom1,
            title: entry.title,
        }))).toEqual([
            {
                hasDestination: true,
                page: 1,
                title: 'Page one',
            },
            {
                hasDestination: true,
                page: 2,
                title: 'Page two component target',
            },
            {
                hasDestination: true,
                page: 3,
                title: 'Page three numeric control',
            },
        ]);

        await session.page.click('.tab-list .tab.is-active .tab-close');
        await openPdfInApp(session.page, outputPath, 120_000);
        await waitForPdfLoaded(session.page, 120_000);
        await session.page.evaluate(() => document.querySelector<HTMLElement>('.document-bookmarks-toolbar__actions button')?.click());
        await openDocumentSidebarTab(session.page, 'Bookmarks');
        for (const [
            title,
            pageNumber,
        ] of [
                [
                    'Page two component target',
                    2,
                ],
                [
                    'Page one',
                    1,
                ],
            ] as const) {
            const rows = await session.page.$$('.document-bookmark-item__row');
            let activated = false;
            for (const candidate of rows) {
                if (await candidate.evaluate((element, expectedTitle) => element.textContent?.trim() === expectedTitle, title)) {
                    await candidate.click();
                    activated = true;
                    break;
                }
            }
            expect(activated, `bookmark row found for ${title}`).toBe(true);
            await expect.poll(async () => (await readToolbarPageIndicator(session.page)).renderedPage, {timeout: 15_000}).toBe(pageNumber);
            expect((await readToolbarPageIndicator(session.page)).renderedPage).toBe(pageNumber);
        }
        await rm(outputPath, {force: true});
    }, 420_000);
});
