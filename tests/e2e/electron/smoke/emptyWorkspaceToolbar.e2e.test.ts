import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {Page} from 'puppeteer-core';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-empty-workspace-toolbar-${Date.now()}`});

async function readToolbar(page: Page) {
    return page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>('#editor-global-toolbar-host [role="toolbar"]');
        const rect = toolbar?.getBoundingClientRect();
        const controls = Array.from(toolbar?.querySelectorAll<HTMLElement>('button, input') ?? [])
            .filter(element => {
                const r = element.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
            })
            .map(element => ({
                disabled: 'disabled' in element ? (element as HTMLButtonElement).disabled : false,
                label: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '',
                text: element.textContent?.trim() ?? '',
            }));
        const rightControls = Array.from(document.querySelectorAll<HTMLElement>(
            '#editor-global-toolbar-host button[aria-label*="Assistant"], #editor-global-toolbar-host button[aria-label*="Settings"]',
        )).map(element => {
            const r = element.getBoundingClientRect();
            return {
                label: element.getAttribute('aria-label'),
                right: Math.round(r.right),
            };
        });
        return {
            height: rect ? Math.round(rect.height) : 0,
            controls,
            rightControls,
        };
    });
}

describe('empty workspace toolbar contract', () => {
    it('keeps document controls visible and disabled, without shifting the toolbar when a document opens', async () => {
        const session = sessions.getSession();
        await session.page.waitForSelector('#editor-global-toolbar-host [role="toolbar"]', {timeout: 20_000});
        const empty = await readToolbar(session.page);
        const evidence = mkdtempSync(join(tmpdir(), 'evb-e2e-empty-toolbar-'));
        await session.page.screenshot({path: join(evidence, 'empty-workspace.png')});

        const pdfPath = await createMultiPageTextFixturePdf(`empty-toolbar-${Date.now()}.pdf`, 2);
        await openPdfInApp(session.page, pdfPath);
        await waitForPdfLoaded(session.page);
        const documentToolbar = await readToolbar(session.page);
        await session.page.screenshot({path: join(evidence, 'first-document.png')});

        expect(empty.height, 'empty workspace must render the document toolbar row').toBeGreaterThan(0);
        const expectedLabels = [
            'Toggle Sidebar',
            'Save',
            'Print',
            'Undo',
            'Redo',
        ];
        for (const label of expectedLabels) {
            const control = empty.controls.find(item => item.label === label || item.text === label);
            expect(control, `${label} must be visible in the empty workspace`).toBeTruthy();
            expect(control?.disabled, `${label} is disabled without a document`).toBe(true);
        }
        expect(empty.controls.some(item => /page/i.test(`${item.label} ${item.text}`)), 'page navigation is visible').toBe(true);
        expect(empty.controls.some(item => /zoom|fit width|fit height|%/i.test(`${item.label} ${item.text}`)), 'zoom is visible').toBe(true);
        expect(empty.rightControls.length).toBeGreaterThan(0);
        expect(documentToolbar.height).toBe(empty.height);
        expect(documentToolbar.rightControls.map(item => item.label)).toEqual(empty.rightControls.map(item => item.label));
        expect(documentToolbar.rightControls.map(item => item.right)).toEqual(empty.rightControls.map(item => item.right));
    }, 90_000);
});
