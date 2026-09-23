import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolve} from 'node:path';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createPasswordProtectedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    openPdfInApp,
    triggerOpenPathInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const DIALOG_TIMEOUT_MS = 45_000;
const DIALOG_VIEWPORT = {
    deviceScaleFactor: 1,
    height: 800,
    width: 1280,
};
const LAYOUT_TOLERANCE_PX = 0.5;

interface IPrintDialogLayout {
    cancelTop: number;
    dialogHeight: number;
    dialogTop: number;
    layoutHeadingTop: number;
    summaryText: string;
}

interface IPoint {
    x: number;
    y: number;
}

interface IDialogFrame {
    height: number | null;
    opacity: number;
    present: boolean;
}

interface IDialogFrameProbeWindow {
    __dialogFrameSampler?: number;
    __dialogFrames?: IDialogFrame[];
}

async function clickPoint(page: Page, point: IPoint | null, what: string) {
    if (!point) {
        throw new Error(`${what} was not found`);
    }
    await page.mouse.click(point.x, point.y);
}

async function waitForDialogSettled(page: Page) {
    // Modals scale and fade in; measure the settled box.
    await page.waitForFunction(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return dialog !== null
            && getComputedStyle(dialog).opacity === '1'
            && dialog.getAnimations({subtree: true}).every(animation => animation.playState !== 'running');
    }, {timeout: DIALOG_TIMEOUT_MS});
}

async function openPrintDialog(page: Page) {
    const point = await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label="Print"]'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
            });
        if (!button) {
            return null;
        }
        const rect = button.getBoundingClientRect();
        return {
            x: rect.left + (rect.width / 2),
            y: rect.top + (rect.height / 2),
        };
    });
    await clickPoint(page, point, 'Visible Print toolbar button');
    await page.waitForSelector('[role="dialog"] [role="radio"][value="range"]', {
        timeout: DIALOG_TIMEOUT_MS,
        visible: true,
    });
    await waitForDialogSettled(page);
}

async function readPrintDialogLayout(page: Page): Promise<IPrintDialogLayout> {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    return page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) {
            throw new Error('Print dialog is not open');
        }
        const paragraphs = Array.from(dialog.querySelectorAll<HTMLElement>('p'));
        const layoutHeading = paragraphs.find(paragraph => paragraph.textContent?.trim() === 'Layout');
        const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
            .find(button => button.textContent?.trim() === 'Cancel');
        const summary = paragraphs.find(paragraph => /^(Printing|Enter a valid)/u.test(paragraph.textContent?.trim() ?? ''));
        if (!layoutHeading || !cancel || !summary) {
            throw new Error('Print dialog lost its layout heading, summary or Cancel button');
        }
        const dialogRect = dialog.getBoundingClientRect();
        return {
            cancelTop: cancel.getBoundingClientRect().top,
            dialogHeight: dialogRect.height,
            dialogTop: dialogRect.top,
            layoutHeadingTop: layoutHeading.getBoundingClientRect().top,
            summaryText: summary.textContent?.trim() ?? '',
        };
    });
}

function expectSameGeometry(actual: IPrintDialogLayout, expected: IPrintDialogLayout) {
    expect(Math.abs(actual.dialogHeight - expected.dialogHeight)).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
    expect(Math.abs(actual.dialogTop - expected.dialogTop)).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
    expect(Math.abs(actual.layoutHeadingTop - expected.layoutHeadingTop)).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
    expect(Math.abs(actual.cancelTop - expected.cancelTop)).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
}

function startDialogFrameSampler(page: Page) {
    return page.evaluate(() => {
        const probe = window as typeof window & IDialogFrameProbeWindow;
        const frames: IDialogFrame[] = [];
        probe.__dialogFrames = frames;
        const sample = () => {
            const dialog = document.querySelector('[role="dialog"]');
            frames.push({
                height: dialog?.getBoundingClientRect().height ?? null,
                opacity: dialog ? Number(getComputedStyle(dialog).opacity) : 0,
                present: dialog !== null,
            });
            probe.__dialogFrameSampler = requestAnimationFrame(sample);
        };
        sample();
    });
}

function stopDialogFrameSampler(page: Page) {
    return page.evaluate(() => {
        const probe = window as typeof window & IDialogFrameProbeWindow;
        if (probe.__dialogFrameSampler !== undefined) {
            cancelAnimationFrame(probe.__dialogFrameSampler);
        }
        return probe.__dialogFrames ?? [];
    });
}

describe('Electron E2E - dialog layout stability', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-dialog-layout-${Date.now()}`,
        timeoutMs: DIALOG_TIMEOUT_MS,
    });

    it('keeps its controls in place when the page range is chosen and rejected', async () => {
        const session: IElectronE2ESession = sessionFixture.getSession();
        const {page} = session;
        await page.setViewport(DIALOG_VIEWPORT);

        const fixturePath = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'generated-text.pdf');
        await openPdfInApp(page, fixturePath, DIALOG_TIMEOUT_MS);
        await waitForPdfLoaded(page, DIALOG_TIMEOUT_MS);
        await waitForViewerInteractive(page, DIALOG_TIMEOUT_MS);
        await openPrintDialog(page);

        const initial = await readPrintDialogLayout(page);
        expect(initial.summaryText).toMatch(/^Printing/u);

        const rangeLabel = await page.evaluate(() => {
            const radio = document.querySelector<HTMLElement>('[role="dialog"] [role="radio"][value="range"]');
            const label = radio ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(radio.id)}"]`) : null;
            if (!label) {
                return null;
            }
            const rect = label.getBoundingClientRect();
            return {
                x: rect.left + Math.min(rect.width / 2, 30),
                y: rect.top + (rect.height / 2),
            };
        });
        await clickPoint(page, rangeLabel, 'Page range label');
        await page.waitForSelector('[role="dialog"] [role="radio"][value="range"][aria-checked="true"]', {timeout: DIALOG_TIMEOUT_MS});
        expectSameGeometry(await readPrintDialogLayout(page), initial);

        const rangeInput = await page.$('[role="dialog"] input[aria-label="Page range"]');
        const inputBox = await rangeInput?.boundingBox();
        await clickPoint(page, inputBox ? {
            x: inputBox.x + 10,
            y: inputBox.y + (inputBox.height / 2),
        } : null, 'Page range input');
        await page.keyboard.type('abc');
        await page.keyboard.press('Tab');
        await page.waitForSelector('[role="dialog"] input[aria-label="Page range"][aria-invalid="true"]', {timeout: DIALOG_TIMEOUT_MS});

        const rejected = await readPrintDialogLayout(page);
        expect(rejected.summaryText).toBe('Enter a valid page range.');
        expectSameGeometry(rejected, initial);
    }, DIALOG_TIMEOUT_MS * 2);

    it('keeps the password prompt on screen at one size after a wrong password', async () => {
        const session: IElectronE2ESession = sessionFixture.getSession();
        const {page} = session;
        await page.setViewport(DIALOG_VIEWPORT);

        const fixturePath = await createPasswordProtectedFixturePdf(`dialog-layout-password-${Date.now()}.pdf`);
        await triggerOpenPathInApp(page, fixturePath, DIALOG_TIMEOUT_MS);
        await page.waitForSelector('[role="dialog"] input[type="password"]', {
            timeout: DIALOG_TIMEOUT_MS,
            visible: true,
        });
        await waitForDialogSettled(page);

        await startDialogFrameSampler(page);
        await page.type('[role="dialog"] input[type="password"]', 'wrong-password');
        await page.keyboard.press('Enter');
        await page.waitForSelector('[role="dialog"] [data-slot="error"]', {timeout: DIALOG_TIMEOUT_MS});
        await waitForDialogSettled(page);
        const frames = await stopDialogFrameSampler(page);

        expect(frames.length).toBeGreaterThan(0);
        expect(frames.filter(frame => !frame.present || frame.opacity < 0.999)).toEqual([]);
        const heights = frames.map(frame => frame.height ?? 0);
        expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(LAYOUT_TOLERANCE_PX);
        expect(await page.evaluate(() => document.activeElement?.getAttribute('type'))).toBe('password');

        await page.keyboard.type('frame-secret');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), {timeout: DIALOG_TIMEOUT_MS});
        await waitForPdfLoaded(page, DIALOG_TIMEOUT_MS);
    }, DIALOG_TIMEOUT_MS * 2);
});
