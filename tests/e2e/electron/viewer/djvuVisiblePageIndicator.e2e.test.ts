import {
    copyFileSync, mkdtempSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe, expect, it, onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openDjvuInApp, waitForDjvuLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readToolbarPageIndicator} from '@tests/e2e/electron/helpers/toolbarPageIndicator';
import {waitForWorkspaceToolbarSnapshot} from '@tests/e2e/electron/helpers/workspaceExpose';
import {waitForViewportQuiet} from '@tests/e2e/electron/helpers/viewportPageObservation';
import {evaluateInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import type {Page} from 'puppeteer-core';

/** Two DjVu pages: a tall page 1 (1200x4000) and a short page 2 (1200x400), each one black rule. */
const TALL_THEN_SHORT_DJVU = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'djvu-fixtures', 'tall-then-short.djvu');

/** Page 1 and 2 as the DjVu page-source renderer lays them out, in the scroll container's coordinates. */
async function readPageGeometry(page: Page) {
    return evaluateInPage(page, () => {
        const first = document.querySelector<HTMLElement>('[data-page-number="1"]');
        const second = document.querySelector<HTMLElement>('[data-page-number="2"]');
        let scroller = first?.parentElement ?? null;
        while (scroller && ![
            'auto',
            'scroll',
        ].includes(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
        }
        if (!first || !second || !scroller) return null;
        const scrollerRect = scroller.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        return {
            scrollTop: scroller.scrollTop,
            viewportHeight: scroller.clientHeight,
            firstTop: firstRect.top - scrollerRect.top + scroller.scrollTop,
            firstHeight: firstRect.height,
            secondTop: secondRect.top - scrollerRect.top + scroller.scrollTop,
            secondHeight: secondRect.height,
            pointerX: scrollerRect.left + scrollerRect.width / 2,
            pointerY: scrollerRect.top + scrollerRect.height / 2,
        };
    });
}

describe('Electron E2E - DjVu visible page indicator', () => {
    const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-djvu-visible-indicator-${Date.now()}`});

    it('names the visible page 1 while the viewport sits inside a tall page whose centre is far away', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-e2e-djvu-visible-indicator-'));
        onTestFinished(() => rm(directory, {
            recursive: true,
            force: true,
        }));
        const djvuPath = join(directory, 'tall-then-short.djvu');
        copyFileSync(TALL_THEN_SHORT_DJVU, djvuPath);
        const {page} = sessions.getSession();
        await openDjvuInApp(page, djvuPath);
        await waitForDjvuLoaded(page);
        // DjVu opens in continuous scroll, the mode the indicator follows.
        await waitForWorkspaceToolbarSnapshot(page, {continuousScroll: true});
        await waitForViewportQuiet(page);

        // Scroll with the wheel until the viewport centre sits in the lower part
        // of page 1, where page 2's centre is nearer than page 1's.
        const target = await readPageGeometry(page);
        expect(target, 'both DjVu pages are mounted').not.toBeNull();
        const desiredCenter = target!.firstTop + target!.firstHeight * 0.83;
        const desiredScrollTop = desiredCenter - target!.viewportHeight / 2;
        expect(desiredCenter + target!.viewportHeight / 2).toBeLessThan(target!.firstTop + target!.firstHeight);
        const viewerPoint = {
            x: target!.pointerX,
            y: target!.pointerY,
        };
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const current = await readPageGeometry(page);
            if (!current || Math.abs(current.scrollTop - desiredScrollTop) < 40) break;
            await page.mouse.move(viewerPoint.x, viewerPoint.y);
            await page.mouse.wheel({deltaY: Math.sign(desiredScrollTop - current.scrollTop) * Math.min(400, Math.abs(desiredScrollTop - current.scrollTop))});
            await waitForViewportQuiet(page, 300);
        }
        await waitForViewportQuiet(page);
        const settled = await readPageGeometry(page);
        expect(settled, 'the viewport is still measurable').not.toBeNull();
        expect(settled!.scrollTop).toBeGreaterThanOrEqual(settled!.firstTop);
        expect(settled!.scrollTop + settled!.viewportHeight).toBeLessThanOrEqual(settled!.firstTop + settled!.firstHeight);
        // The centre the old nearest-centre rule used is nearer page 2's centre than page 1's.
        const viewportCentre = settled!.scrollTop + settled!.viewportHeight / 2;
        const firstCentre = settled!.firstTop + settled!.firstHeight / 2;
        const secondCentre = settled!.secondTop + settled!.secondHeight / 2;
        expect(Math.abs(viewportCentre - secondCentre)).toBeLessThan(Math.abs(viewportCentre - firstCentre));
        const indicator = await readToolbarPageIndicator(page);
        expect(indicator.renderedPage, 'the toolbar names the page the viewport is inside').toBe(1);
    }, 240_000);
});
