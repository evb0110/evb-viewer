import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {describe, expect, it} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {openPdfInApp, waitForPdfLoaded} from '@tests/e2e/electron/helpers/viewerCore';
import type {Page} from 'puppeteer-core';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-empty-workspace-toolbar-${Date.now()}`});

async function readToolbar(page: Page) {
    return page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>('#editor-global-toolbar-host [role="toolbar"]');
        const rect = toolbar?.getBoundingClientRect();
        const controls = Array.from(toolbar?.querySelectorAll<HTMLElement>('button, input') ?? [])
            .filter((element) => {
                const r = element.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden';
            })
            .map((element) => ({
                disabled: 'disabled' in element ? (element as HTMLButtonElement).disabled : false,
                label: element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '',
                text: element.textContent?.trim() ?? '',
                left: Math.round(element.getBoundingClientRect().left),
            }));
        const rightControls = Array.from(
            document.querySelectorAll<HTMLElement>(
                '#editor-global-toolbar-host button[aria-label*="Assistant"], #editor-global-toolbar-host button[aria-label*="Settings"]',
            ),
        ).map((element) => {
            const r = element.getBoundingClientRect();
            return {
                label: element.getAttribute('aria-label'),
                right: Math.round(r.right),
            };
        });
        return {
            height: rect ? Math.round(rect.height) : 0,
            viewportWidth: window.innerWidth,
            controls,
            rightControls,
        };
    });
}

// Resize the real window, then read the toolbar once its collapse tier has
// settled for the new width.
async function readToolbarAtWidth(session: ReturnType<typeof sessions.getSession>, width: number) {
    await session.command('windowResize', [width, 700]);
    await expect.poll(() => session.page.evaluate(() => window.innerWidth)).toBe(width);
    await session.page.evaluate(
        () =>
            new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            }),
    );
    return readToolbar(session.page);
}

describe('empty workspace toolbar contract', () => {
    it('keeps document controls visible and disabled, without shifting the toolbar when a document opens', async () => {
        const session = sessions.getSession();
        await session.page.waitForSelector('#editor-global-toolbar-host [role="toolbar"]', {timeout: 20_000});
        // A wide window shows every inline control; the 900 px baseline collapses some.
        const emptyWide = await readToolbarAtWidth(session, 1600);
        const empty = await readToolbarAtWidth(session, 900);

        const pdfPath = await createMultiPageTextFixturePdf(`empty-toolbar-${Date.now()}.pdf`, 2);
        await openPdfInApp(session.page, pdfPath);
        await waitForPdfLoaded(session.page);
        const documentToolbar = await readToolbar(session.page);
        const documentWide = await readToolbarAtWidth(session, 1600);

        expect(empty.height, 'empty workspace must render the document toolbar row').toBeGreaterThan(0);
        const expectedLabels = ['Toggle Sidebar', 'Save', 'Print', 'Undo', 'Redo'];
        for (const label of expectedLabels) {
            const control = empty.controls.find((item) => item.label === label || item.text === label);
            expect(control, `${label} must be visible in the empty workspace`).toBeTruthy();
            expect(control?.disabled, `${label} is disabled without a document`).toBe(true);
        }
        expect(
            empty.controls.some((item) => /page/i.test(`${item.label} ${item.text}`)),
            'page navigation is visible',
        ).toBe(true);
        expect(
            empty.controls.some((item) => /zoom|fit width|fit height|%/i.test(`${item.label} ${item.text}`)),
            'zoom is visible',
        ).toBe(true);
        expect(empty.rightControls.length).toBeGreaterThan(0);
        expect(empty.viewportWidth, 'measure the supported 900 px window after its native bounds settle').toBe(900);
        expect(documentToolbar.viewportWidth, 'opening a document must keep the same settled window width').toBe(900);
        expect(documentToolbar.height).toBe(empty.height);
        expect(
            documentToolbar.controls.map((item) => item.left),
            'opening a document must not add, remove or move toolbar controls',
        ).toEqual(empty.controls.map((item) => item.left));
        expect(documentWide.viewportWidth).toBe(1600);
        expect(
            documentWide.controls.map((item) => item.left),
            'opening a document must not add, remove or move controls in a wide window',
        ).toEqual(emptyWide.controls.map((item) => item.left));
        expect(documentToolbar.rightControls.map((item) => item.label)).toEqual(empty.rightControls.map((item) => item.label));
        expect(documentToolbar.rightControls.map((item) => item.right)).toEqual(empty.rightControls.map((item) => item.right));
    }, 90_000);
});

// I1, #1608: the real tab menu must acknowledge a rejected clipboard write.
// This is the one real-app regression for the shared clipboard/shell pattern.
it('#1608 shows feedback when Copy path is denied by the clipboard', async () => {
    const session = sessions.getSession();
    const pdfPath = await createMultiPageTextFixturePdf(`clipboard-failure-${Date.now()}.pdf`, 1);
    await openPdfInApp(session.page, pdfPath);
    await waitForPdfLoaded(session.page);
    await session.page.evaluate(() => {
        const clipboard = navigator.clipboard;
        Object.defineProperty(clipboard, '__step1608OriginalWriteText', {
            value: Object.getOwnPropertyDescriptor(clipboard, 'writeText'),
            configurable: true,
        });
        Object.defineProperty(clipboard, 'writeText', {
            configurable: true,
            value: async () => {
                throw new DOMException('Clipboard write denied for #1608', 'NotAllowedError');
            },
        });
    });
    try {
        await clickAsUser(session.page, '.tab.is-active[data-tab-id]', {button: 'right'});
        await clickAsUser(session.page, '[data-tab-command="copy-path"]');
        await expect
            .poll(
                () =>
                    session.page.$$eval('[role="status"], [role="alert"]', (nodes) =>
                        nodes.map((node) => node.textContent ?? '').join(' '),
                    ),
                {timeout: 1_000},
            )
            .toMatch(
                /(?:failed|unable|could not|denied|not allowed).*(?:cop|clipboard)|(?:cop|clipboard).*(?:failed|unable|could not|denied|not allowed)/i,
            );
    } finally {
        await session.page.evaluate(() => {
            const original = Reflect.get(navigator.clipboard, '__step1608OriginalWriteText');
            if (original) {
                Object.defineProperty(navigator.clipboard, 'writeText', original);
            } else {
                Reflect.deleteProperty(navigator.clipboard, 'writeText');
            }
            Reflect.deleteProperty(navigator.clipboard, '__step1608OriginalWriteText');
        });
    }
});
