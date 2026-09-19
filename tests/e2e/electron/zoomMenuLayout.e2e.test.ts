import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolve} from 'node:path';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const ZOOM_MENU_TIMEOUT_MS = 45_000;
const ZOOM_MENU_VIEWPORT = {
    deviceScaleFactor: 2,
    height: 668,
    width: 900,
};

interface IZoomMenuLayout {
    buttonRects: Array<{
        bottom: number;
        left: number;
        right: number;
        top: number;
        width: number;
    }>;
    menu: {
        clientHeight: number;
        clientWidth: number;
        scrollHeight: number;
        scrollWidth: number;
    };
    menuRect: {
        bottom: number;
        left: number;
        right: number;
    };
    viewGroup: {
        bottom: number;
        top: number;
    };
}

async function setFrenchLargeInterface(page: Page) {
    await page.evaluate(async () => {
        const target = window as IE2EWindow;
        const saveSettings = target.electronAPI?.settings.save;
        if (!saveSettings) {
            throw new Error('Electron settings save bridge is unavailable');
        }
        await saveSettings({
            locale: 'fr',
            uiScale: 'large',
        });
    });
    await page.reload({waitUntil: 'domcontentloaded'});
}

async function clickVisibleZoomDisplay(page: Page) {
    const point = await page.evaluate(() => {
        const target = Array.from(document.querySelectorAll<HTMLElement>('.zoom-controls-display'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = getComputedStyle(candidate);
                return rect.width > 0
                    && rect.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            });
        if (!target) {
            throw new Error('Visible zoom display was not found');
        }
        const rect = target.getBoundingClientRect();
        return {
            x: rect.left + (rect.width / 2),
            y: rect.top + (rect.height / 2),
        };
    });
    await page.mouse.click(point.x, point.y);
    await page.waitForSelector('.zoom-dropdown', {
        timeout: ZOOM_MENU_TIMEOUT_MS,
        visible: true,
    });
}

async function readZoomMenuLayout(page: Page): Promise<IZoomMenuLayout> {
    return page.evaluate(() => {
        const menu = document.querySelector<HTMLElement>('.zoom-dropdown');
        const viewGroup = Array.from(menu?.querySelectorAll<HTMLElement>('.zoom-toggle-group') ?? [])
            .find(group => group.querySelectorAll('button.zoom-toggle-btn').length === 3);
        if (!menu || !viewGroup) {
            throw new Error('Three-button zoom view-mode group was not found');
        }
        const menuRect = menu.getBoundingClientRect();
        const viewGroupRect = viewGroup.getBoundingClientRect();
        return {
            buttonRects: Array.from(viewGroup.querySelectorAll<HTMLButtonElement>('button.zoom-toggle-btn'))
                .map(button => {
                    const rect = button.getBoundingClientRect();
                    return {
                        bottom: rect.bottom,
                        left: rect.left,
                        right: rect.right,
                        top: rect.top,
                        width: rect.width,
                    };
                }),
            menu: {
                clientHeight: menu.clientHeight,
                clientWidth: menu.clientWidth,
                scrollHeight: menu.scrollHeight,
                scrollWidth: menu.scrollWidth,
            },
            viewGroup: {
                bottom: viewGroupRect.bottom,
                top: viewGroupRect.top,
            },
            menuRect: {
                bottom: menuRect.bottom,
                left: menuRect.left,
                right: menuRect.right,
            },
        } satisfies IZoomMenuLayout;
    });
}

describe('Electron E2E - localized zoom menu layout', () => {
    const sessionFixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-zoom-menu-layout-${Date.now()}`,
        timeoutMs: ZOOM_MENU_TIMEOUT_MS,
    });

    it('keeps all localized view modes on one reachable row', async () => {
        const session: IElectronE2ESession = sessionFixture.getSession();
        await session.page.setViewport(ZOOM_MENU_VIEWPORT);
        await setFrenchLargeInterface(session.page);

        const fixturePath = resolve(process.cwd(), 'tests', 'fixtures', 'electron', 'test-scanned.pdf');
        await openPdfInApp(session.page, fixturePath, ZOOM_MENU_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, ZOOM_MENU_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, ZOOM_MENU_TIMEOUT_MS);
        await clickVisibleZoomDisplay(session.page);

        const layout = await readZoomMenuLayout(session.page);
        expect(layout.buttonRects).toHaveLength(3);
        expect(Math.max(...layout.buttonRects.map(rect => rect.top))
            - Math.min(...layout.buttonRects.map(rect => rect.top))).toBeLessThanOrEqual(1);
        expect(layout.buttonRects.every(rect => rect.width > 0)).toBe(true);
        expect(layout.buttonRects.every(rect => rect.left >= 0)).toBe(true);
        expect(layout.buttonRects.every(rect => rect.left >= layout.menuRect.left - 1)).toBe(true);
        expect(layout.buttonRects.every(rect => rect.right <= layout.menuRect.right + 1)).toBe(true);
        expect(layout.viewGroup.bottom - layout.viewGroup.top).toBeGreaterThan(0);
        expect(layout.menu.scrollWidth).toBeLessThanOrEqual(layout.menu.clientWidth + 1);
    }, ZOOM_MENU_TIMEOUT_MS);
});
