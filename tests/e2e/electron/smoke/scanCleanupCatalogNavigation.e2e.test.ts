import {randomUUID} from 'node:crypto';
import {
    copyFileSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR} from '@contracts/scan-cleanup/toolbarSelectors';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    clickVisibleToolbarButton, goToPageViaToolbar, openDocumentSidebarTab, openPdfInApp,
    waitForPdfLoaded, waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    readWorkspaceStateValues, type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const fixture = createElectronE2ESessionFixture({sessionName: () => `e2e-cleanup-navigation-${Date.now()}`});

describe('compact cleanup catalog navigation', () => {
    it('keeps nested bookmarks, named destinations and labels on raster replacements', async () => {
        const page = fixture.getSession().page;
        const evidence = resolve(process.env.SCANLINKS6_PROOF_DIR ?? `.devkit/tmp/cleanup-navigation-${randomUUID()}`);
        mkdirSync(evidence, {recursive: true});
        const source = resolve(evidence, 'source.pdf');
        writeFileSync(source, Buffer.from(readFileSync(resolve('tests/fixtures/release/scan-cleanup-navigation.pdf.hex'), 'utf8').replace(/\s/gu, ''), 'hex'));
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface');
        await page.waitForFunction(() => document.querySelectorAll('.scan-thumbnail-exclude-toggle').length === 3, {timeout: 90_000});
        const exclusion = await page.$$('.scan-thumbnail-exclude-toggle');
        await clickAsUser(page, exclusion[1]!);
        await clickAsUser(page, '[data-settings-scope="all"]');
        await page.waitForFunction(() => document.querySelector('[data-settings-scope="all"]')?.getAttribute('aria-checked') === 'true');
        await clickAsUser(page, '[aria-label="Page layout"]');
        await page.waitForSelector('[role="option"]');
        const layouts = await page.$$('[role="option"]');
        const single = (await Promise.all(layouts.map(async element => ({
            element,
            matches: await element.evaluate(el => [
                'Force single pages',
                'Single page',
            ].includes(el.textContent?.trim() ?? '')),
        })))).find(candidate => candidate.matches)?.element;
        expect(single).toBeTruthy();
        await clickAsUser(page, single!);
        for (const labelText of [
            'Preserve original quality (no rasterization)',
            'Crop each output page to its content',
            'Skip blank pages',
            'Match page size with other pages',
        ]) {
            const labels = await page.$$('label');
            const label = (await Promise.all(labels.map(async element => ({
                element,
                matches: await element.evaluate((el, text) => el.textContent?.trim() === text, labelText),
            })))).find(candidate => candidate.matches)?.element;
            expect(label, labelText).toBeTruthy();
            const checked = await label!.evaluate(el => {
                const id = el.getAttribute('for');
                const control = id ? document.getElementById(id) : el.parentElement?.querySelector('[role="checkbox"],input[type="checkbox"]');
                return control?.getAttribute('aria-checked') === 'true' || (control instanceof HTMLInputElement && control.checked);
            });
            if (checked) await clickAsUser(page, label!);
        }
        await clickAsUser(page, '[role=radio][aria-label="Auto — recommended per page"]');
        if (await page.$eval('.scan-cleanup-advanced-toggle', el => el.getAttribute('aria-expanded') !== 'true')) await clickAsUser(page, '.scan-cleanup-advanced-toggle');
        for (const label of await page.$$('label')) {
            if (!await label.evaluate(el => el.textContent?.trim() === 'Normalize uneven illumination')) continue;
            const checked = await label.evaluate(el => {
                const id = el.getAttribute('for');
                return (id ? document.getElementById(id) : el.parentElement?.querySelector('[role="checkbox"]'))?.getAttribute('aria-checked') === 'true';
            });
            if (checked) await clickAsUser(page, label);
            break;
        }
        expect(await page.$$eval('.scan-thumbnail-exclude-toggle', els => els.map(el => el.getAttribute('aria-checked')))).toEqual([
            'true',
            'false',
            'true',
        ]);
        await page.waitForFunction(selector => {
            const button = document.querySelector<HTMLButtonElement>(selector);
            return button && !button.disabled && button.textContent?.includes('Clean');
        }, {timeout: 90_000}, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await page.waitForFunction(source => {
            const state = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.readActiveWorkspaceStateValues?.(['originalPath']);
            return typeof state?.originalPath === 'string' && state.originalPath !== source && state.originalPath.endsWith('— cleaned.pdf');
        }, {timeout: 180_000}, source);
        const state = await readWorkspaceStateValues(page, ['originalPath']);
        expect(typeof state.originalPath).toBe('string');
        const output = resolve(evidence, 'compact-output.pdf');
        copyFileSync(String(state.originalPath), output);
        await openPdfInApp(page, output);
        await waitForPdfLoaded(page);
        await waitForViewerInteractive(page);
        const firstLabel = await page.$eval('.page-controls-current-primary', el => el.textContent?.trim());
        await goToPageViaToolbar(page, 2);
        const secondLabel = await page.$eval('.page-controls-current-primary', el => el.textContent?.trim());
        await openDocumentSidebarTab(page, 'Pages');
        await clickAsUser(page, '[data-thumbnail-page="1"]');
        await openDocumentSidebarTab(page, 'Bookmarks');
        await page.waitForSelector('.document-bookmark-item__title');
        for (const toggle of await page.$$('.document-bookmark-item__toggle[aria-expanded="false"]')) await clickAsUser(page, toggle);
        const nesting = await page.$$eval('.document-bookmark-item__title', els => els.map(el => ({
            title: el.textContent?.trim(),
            left: el.getBoundingClientRect().left,
        })));
        await page.screenshot({path: resolve(evidence, 'reopened.png')});
        expect(firstLabel).toBe('i');
        expect(secondLabel).toBe('1');
        expect(nesting.map(item => item.title)).toEqual([
            'first',
            'removed',
            'Third named destination',
            'Body chapter',
        ]);
        expect(nesting[3]!.left).toBeGreaterThan(nesting[2]!.left);
        const titles = await page.$$('.document-bookmark-item__title');
        await clickAsUser(page, titles[3]!);
        await page.waitForFunction(() => document.querySelector('.page-controls-current-primary')?.textContent?.trim() === '1', {timeout: 10_000});
        await page.screenshot({path: resolve(evidence, 'bookmark-target.png')});
        expect(await page.$eval('.page-controls-current-secondary', el => el.textContent?.trim())).toBe('(2)');
    }, 240_000);
});
