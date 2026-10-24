import {
    mkdirSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    expect, it,
} from 'vitest';
import {devices} from 'playwright';
import type {Page} from 'playwright';
import {
    lifecycle, waitForOpenFileReady, collectConsoleProblems, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

async function readSettingsLayout(page: Page) {
    return page.evaluate(() => ({
        overflow: [...document.querySelectorAll<HTMLElement>('.tool-page-body, .settings-card, .settings-grid, .settings-card [role="radiogroup"]')]
            .filter(element => element.scrollWidth > element.clientWidth + 1)
            .map(element => ({
                className: element.className,
                width: element.clientWidth,
                contentWidth: element.scrollWidth,
                text: element.innerText.slice(0, 200),
            })),
        truncatedNavigation: [...document.querySelectorAll<HTMLElement>('.rail-item > span:not(.iconify, .rail-count)')]
            .filter(element => element.scrollWidth > element.clientWidth + 1)
            .map(element => element.textContent),
        themeIconCounts: [...document.querySelectorAll<HTMLElement>('.settings-card label')]
            .filter(element => element.querySelector('[role="radio"][value="light"], [role="radio"][value="dark"]'))
            .map(element => [...element.querySelectorAll<HTMLElement>('.iconify, svg')]
                .filter(icon => icon.getBoundingClientRect().width > 0).length),
    }));
}

async function readClippedToolbarControls(page: Page) {
    return page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>('[role="toolbar"][aria-label="Document toolbar"]')!;
        const clippingOverflows = new Set([
            'hidden',
            'clip',
            'auto',
            'scroll',
        ]);
        return [...toolbar.querySelectorAll<HTMLButtonElement>('button')].flatMap(button => {
            const rect = button.getBoundingClientRect();
            if (!rect.width || !rect.height || getComputedStyle(button).visibility === 'hidden') return [];
            let ancestor = button.parentElement;
            const bounds = toolbar.getBoundingClientRect();
            let clipped = rect.left < bounds.left - 1 || rect.right > bounds.right + 1
                || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
            while (ancestor) {
                const style = getComputedStyle(ancestor);
                const clip = ancestor.getBoundingClientRect();
                if (clippingOverflows.has(style.overflowX)) {
                    clipped ||= rect.left < clip.left - 1 || rect.right > clip.right + 1;
                }
                if (clippingOverflows.has(style.overflowY)) {
                    clipped ||= rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1;
                }
                ancestor = ancestor.parentElement;
            }
            return clipped ? [{
                label: button.getAttribute('aria-label') ?? button.textContent?.trim(),
                left: rect.left,
                right: rect.right,
            }] : [];
        });
    });
}

// Owner-reported chrome reachability at phone widths, plus the existing desktop
// baseline: painted choices and actual toolbar controls must fit their surfaces.
it('keeps settings and document controls readable and reachable from phone to desktop', async () => {
    const evidenceDir = resolve('.devkit', `responsive-workspace-${process.pid}`);
    mkdirSync(evidenceDir, {recursive: true});
    const page = await lifecycle.browser.newPage({
        viewport: {
            width: 390,
            height: 844,
        },
        recordVideo: {
            dir: evidenceDir,
            size: {
                width: 1280,
                height: 900,
            },
        },
    });
    const problems = collectConsoleProblems(page);
    const observations: unknown[] = [];
    try {
        await page.addInitScript(() => {
            Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
        });
        await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
        await waitForOpenFileReady(page);
        await page.locator('.start-rail').getByRole('button', {
            name: 'Settings',
            exact: true,
        }).click();
        await page.getByRole('textbox', {
            name: 'Author Name',
            exact: true,
        }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        for (const width of [
            290,
            320,
            390,
            768,
            900,
            1280,
        ]) {
            await page.setViewportSize({
                width,
                height: 900,
            });
            const layout = await readSettingsLayout(page);
            observations.push({
                surface: 'settings',
                width,
                ...layout,
            });
            await page.screenshot({path: resolve(evidenceDir, `settings-${width}.png`)});
            expect.soft(layout.themeIconCounts, `one theme icon per choice at ${width}px`).toEqual([
                1,
                1,
            ]);
            expect.soft(layout.overflow, `settings controls fit at ${width}px`).toEqual([]);
            expect.soft(layout.truncatedNavigation, `start navigation is readable at ${width}px`).toEqual([]);
        }
        await page.setViewportSize({
            width: 390,
            height: 844,
        });
        await page.getByText('Dark', {exact: true}).click();
        await expect.poll(() => page.locator('html').getAttribute('class')).toContain('dark');
        await page.getByText('Light', {exact: true}).click();
        await expect.poll(() => page.locator('html').getAttribute('class')).not.toContain('dark');
        await page.getByText('Large', {exact: true}).click();
        await expect.poll(() => page.getByRole('radio', {
            name: 'Large',
            exact: true,
        }).getAttribute('aria-checked')).toBe('true');
        const largeLayout = await readSettingsLayout(page);
        observations.push({
            surface: 'settings-large',
            width: 390,
            ...largeLayout,
        });
        expect.soft(largeLayout.overflow).toEqual([]);
        expect.soft(largeLayout.truncatedNavigation).toEqual([]);
        await page.screenshot({path: resolve(evidenceDir, 'settings-large-390.png')});
        await page.getByText('Auto', {exact: true}).click();
        await page.locator('.start-rail').getByRole('button', {
            name: 'Recent Files',
            exact: true,
        }).click();
        keepFileChooserInterceptionEnabled(page);
        const pdf = await PDFDocument.create();
        for (let index = 1; index <= 60; index += 1) pdf.addPage([
            420,
            600,
        ]).drawText(`Mobile reading page ${index}`, {
            x: 24,
            y: 560,
            size: 18,
        });
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'Mobile reading document.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(await pdf.save()),
        });
        await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 60_000});
        for (const width of [
            290,
            320,
            390,
            768,
            900,
            1280,
        ]) {
            await page.setViewportSize({
                width,
                height: 900,
            });
            await expect.poll(() => page.evaluate(() => {
                const viewport = document.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]')!;
                return viewport.scrollWidth - viewport.clientWidth;
            }), {timeout: 10_000}).toBeLessThanOrEqual(1);
            if (width >= 900) {
                await page.getByRole('button', {name: /^Last Page\b/iu}).click();
                await expect.poll(() => page.locator('.page-controls-current-primary').innerText()).toBe('60');
                await page.getByRole('button', {name: /^First Page\b/iu}).click();
                await expect.poll(() => page.locator('.page-controls-current-primary').innerText()).toBe('1');
            }
            observations.push({
                surface: 'document',
                width,
                clipped: await readClippedToolbarControls(page),
            });
            await page.screenshot({path: resolve(evidenceDir, `document-${width}.png`)});
            await expect.poll(() => readClippedToolbarControls(page)).toEqual([]);
        }
        await page.setViewportSize({
            width: 320,
            height: 844,
        });
        await page.locator('.page-controls-display').click();
        await page.locator('.page-controls-inline-input').fill('3');
        await page.locator('.page-controls-inline-input').press('Enter');
        await expect.poll(() => page.locator('.page-controls-current-primary').innerText()).toBe('3');
        await page.getByRole('button', {name: /^Next page$/iu}).click();
        await expect.poll(() => page.locator('.page-controls-current-primary').innerText()).toBe('4');
        await page.locator('.zoom-controls-display').click();
        await page.getByRole('button', {
            name: '100%',
            exact: true,
        }).click();
        await expect.poll(() => page.locator('.zoom-controls-display-value').innerText()).toBe('100%');
        expect(problems).toEqual([]);
    } finally {
        writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify(observations, null, 2));
        writeFileSync(resolve(evidenceDir, 'console.json'), JSON.stringify(problems, null, 2));
        await page.context().close();
    }
}, 90_000);

async function openStartPage(page: Page) {
    await page.addInitScript(() => {
        Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
        sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
    });
    await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
    await waitForOpenFileReady(page);
    await page.evaluate(() => document.fonts.ready);
}

function readStartReach(page: Page) {
    return page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.empty-state')!.getBoundingClientRect();
        const rail = document.querySelector<HTMLElement>('.start-rail')!.getBoundingClientRect();
        const recent = document.querySelector<HTMLElement>('.start-recent')!.getBoundingClientRect();
        return {
            railTopInset: Math.round(rail.top - pane.top),
            recentHeight: Math.round(recent.height),
            recentBottomOverflow: Math.round(recent.bottom - pane.bottom),
        };
    });
}

// Phone browsers: a touch screen, a page narrower than the sidebar plus a
// readable document, and (in landscape) less height than Start needs.
it('fits Start, menus and the sidebar to a touch phone', async () => {
    const evidenceDir = resolve('.devkit', `responsive-phone-${process.pid}`);
    mkdirSync(evidenceDir, {recursive: true});
    const landscape = await lifecycle.browser.newContext({...devices['iPhone 14 landscape']});
    try {
        const page = await landscape.newPage();
        const problems = collectConsoleProblems(page);
        await openStartPage(page);
        const before = await readStartReach(page);
        await page.screenshot({path: resolve(evidenceDir, 'landscape-start.png')});
        expect.soft(before.railTopInset, 'the Start navigation begins inside its pane').toBeGreaterThanOrEqual(0);
        const pane = (await page.locator('.empty-state').boundingBox())!;
        // Finger swipes up the pane. CDP's synthesized scroll gesture does not
        // scroll a headless touch page, so the touch points are sent directly.
        const cdp = await landscape.newCDPSession(page);
        const x = Math.round(pane.x + pane.width / 2);
        const startY = Math.round(pane.y + pane.height - 8);
        const travel = Math.round(pane.height - 16);
        for (let swipe = 0; swipe < 3; swipe += 1) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{
                    x,
                    y: startY,
                }],
            });
            for (let step = 1; step <= 10; step += 1) {
                await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [{
                        x,
                        y: startY - Math.round(travel * step / 10),
                    }],
                });
            }
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
            });
        }
        await expect.poll(async () => (await readStartReach(page)).recentBottomOverflow, {message: 'scrolling Start reaches the end of the recent list'}).toBeLessThanOrEqual(1);
        const after = await readStartReach(page);
        await page.screenshot({path: resolve(evidenceDir, 'landscape-start-scrolled.png')});
        expect.soft(after.recentHeight, 'the recent list keeps a usable height').toBeGreaterThanOrEqual(200);
        expect(problems).toEqual([]);
    } finally {
        await landscape.close();
    }

    const portrait = await lifecycle.browser.newContext({...devices['iPhone 14']});
    try {
        const page = await portrait.newPage();
        const problems = collectConsoleProblems(page);
        await openStartPage(page);
        const touchSizes = await page.evaluate(() => ({
            tabClose: document.querySelector<HTMLElement>('[aria-label="Close Tab"]')!.getBoundingClientRect().height,
            searchFont: Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>('input[type="search"]')!).fontSize),
        }));
        // iOS Safari zooms the page into a focused field with text under 16px.
        expect.soft(touchSizes.searchFont, 'fields keep iOS from zooming on focus').toBeGreaterThanOrEqual(16);
        expect.soft(touchSizes.tabClose, 'the tab close button is finger sized').toBeGreaterThanOrEqual(32);
        keepFileChooserInterceptionEnabled(page);
        const pdf = await PDFDocument.create();
        for (let index = 1; index <= 8; index += 1) pdf.addPage([
            420,
            600,
        ]).drawText(`Phone page ${index}`, {
            x: 24,
            y: 560,
            size: 18,
        });
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', {
            name: 'Open File',
            exact: true,
        }).first().click();
        await (await chooser).setFiles({
            name: 'Phone document.pdf',
            mimeType: 'application/pdf',
            buffer: Buffer.from(await pdf.save()),
        });
        await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 60_000});
        await page.getByRole('button', {
            name: 'Menu',
            exact: true,
        }).tap();
        const menuText = await page.getByRole('menu').first().innerText();
        expect.soft(menuText, 'a touch screen has no keyboard for shortcut hints').not.toMatch(/⌘|Ctrl\+/u);
        await page.keyboard.press('Escape');
        const readViewer = () => page.evaluate(() => ({
            width: Math.round(document.querySelector<HTMLElement>('[data-document-viewer-chassis-viewport]')!.getBoundingClientRect().width),
            pageBox: (({
                left, top, width, height,
            }) => [
                left,
                top,
                width,
                height,
            ].map(Math.round))(document.querySelector<HTMLElement>('.page_container')!.getBoundingClientRect()),
            zoom: document.querySelector<HTMLElement>('.zoom-controls-display-value')!.innerText,
            sidebarOpen: !document.querySelector<HTMLElement>('.sidebar-wrapper')!.classList.contains('is-closed'),
            sidebarWidth: Math.round(document.querySelector<HTMLElement>('.sidebar-wrapper')!.getBoundingClientRect().width),
        }));
        const closed = await readViewer();
        await page.getByRole('button', {name: 'More tools'}).tap();
        await page.getByRole('menuitem', {name: /Toggle Sidebar/iu}).tap();
        await expect.poll(async () => (await readViewer()).sidebarWidth).toBeGreaterThan(200);
        await page.screenshot({path: resolve(evidenceDir, 'portrait-sidebar.png')});
        const open = await readViewer();
        expect.soft(open.width, 'the open sidebar covers the page instead of narrowing it').toBe(closed.width);
        expect.soft(open.zoom, 'opening the sidebar does not refit the page').toBe(closed.zoom);
        expect.soft(open.pageBox, 'the rendered page keeps its size and position').toEqual(closed.pageBox);
        const viewport = page.viewportSize()!;
        await page.touchscreen.tap(viewport.width - 16, viewport.height / 2);
        await expect.poll(async () => (await readViewer()).sidebarOpen, {message: 'a tap beside the sidebar closes it'}).toBe(false);
        await page.screenshot({path: resolve(evidenceDir, 'portrait-sidebar-closed.png')});
        // Crop mode paints its overlay above ordinary viewer layers; the open
        // sidebar and the tap target beside it must still be on top of it.
        await page.getByRole('button', {name: 'More tools'}).tap();
        await page.getByRole('menuitem', {name: 'Crop Pages'}).tap();
        await page.locator('.crop-overlay.is-active').waitFor();
        await page.getByRole('button', {name: 'More tools'}).tap();
        await page.getByRole('menuitem', {name: /Toggle Sidebar/iu}).tap();
        await expect.poll(async () => (await readViewer()).sidebarWidth).toBeGreaterThan(200);
        expect.soft(await page.evaluate(() => {
            const sidebar = document.querySelector<HTMLElement>('.sidebar-wrapper')!.getBoundingClientRect();
            const center = document.elementFromPoint(sidebar.left + sidebar.width / 2, sidebar.top + sidebar.height / 2);
            const beside = document.elementFromPoint(window.innerWidth - 16, window.innerHeight / 2);
            return {
                sidebar: Boolean(center?.closest('.sidebar-wrapper')),
                beside: beside?.classList.contains('sidebar-scrim') ?? false,
            };
        }), 'the sidebar stays above the crop overlay').toEqual({
            sidebar: true,
            beside: true,
        });
        await page.touchscreen.tap(viewport.width - 16, viewport.height / 2);
        await expect.poll(async () => (await readViewer()).sidebarOpen).toBe(false);
        await page.keyboard.press('Escape');
        // 360 px is the most common Android width: page and zoom controls
        // share one toolbar row there instead of stacking.
        await page.setViewportSize({
            width: 360,
            height: 740,
        });
        await expect.poll(() => page.evaluate(() => {
            const pageTop = document.querySelector<HTMLElement>('.page-controls')!.getBoundingClientRect().top;
            const zoomTop = document.querySelector<HTMLElement>('.zoom-controls')!.getBoundingClientRect().top;
            return Math.abs(pageTop - zoomTop);
        }), {message: 'page and zoom controls share a toolbar row at 360 px'}).toBeLessThanOrEqual(1);
        await page.screenshot({path: resolve(evidenceDir, 'portrait-360.png')});
        expect(problems).toEqual([]);
    } finally {
        await portrait.close();
    }
}, 120_000);

// Owner-reported on Android Chrome at 412x776 with the system font size raised
// (page text about 14% larger): Start scrolled inside its pane and the recent
// list scrolled again inside Start, a one-row sliver with its own scrollbar.
it('scrolls phone Start as one page through every recent file', async () => {
    const evidenceDir = resolve('.devkit', `responsive-phone-start-${process.pid}`);
    mkdirSync(evidenceDir, {recursive: true});
    const phone = await lifecycle.browser.newContext({
        ...devices['Pixel 7'],
        viewport: {
            width: 412,
            height: 776,
        },
    });
    try {
        const page = await phone.newPage();
        const problems = collectConsoleProblems(page);
        await openStartPage(page);
        await page.addStyleTag({content: 'html { font-size: 18.24px !important; }'});
        keepFileChooserInterceptionEnabled(page);
        const pdf = await PDFDocument.create();
        pdf.addPage([
            420,
            600,
        ]);
        // Six recent files at the larger text overflow the phone's height.
        for (let index = 1; index <= 6; index += 1) {
            const nextChooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().tap();
            await (await nextChooser).setFiles({
                name: `Phone recent ${index}.pdf`,
                mimeType: 'application/pdf',
                buffer: Buffer.from(await pdf.save()),
            });
            await page.locator('.page_container--rendered canvas').first().waitFor({timeout: 60_000});
            await page.getByRole('button', {
                name: 'Close Tab',
                exact: true,
            }).first().tap();
            await expect.poll(() => page.locator('.recent-row--data:not(.recent-row--skeleton)').count()).toBe(index);
        }
        const startPane = (await page.locator('.empty-state').boundingBox())!;
        const startCdp = await phone.newCDPSession(page);
        const swipeX = Math.round(startPane.x + startPane.width / 2);
        const swipeStartY = Math.round(startPane.y + startPane.height - 8);
        for (let swipe = 0; swipe < 4; swipe += 1) {
            await startCdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [{
                    x: swipeX,
                    y: swipeStartY,
                }],
            });
            for (let step = 1; step <= 10; step += 1) {
                await startCdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [{
                        x: swipeX,
                        y: swipeStartY - Math.round((startPane.height - 16) * step / 10),
                    }],
                });
            }
            await startCdp.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
            });
        }
        const readLastRecent = () => page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>('.empty-state')!.getBoundingClientRect();
            const rows = document.querySelectorAll<HTMLElement>('.recent-row--data');
            const last = rows[rows.length - 1]!.querySelector<HTMLElement>('.recent-open')!.getBoundingClientRect();
            return {
                visible: last.top >= pane.top - 1 && last.bottom <= pane.bottom + 1,
                tableScrollRange: (({
                    scrollHeight, clientHeight,
                }) => scrollHeight - clientHeight)(document.querySelector<HTMLElement>('.recent-table')!),
            };
        });
        await expect.poll(async () => (await readLastRecent()).visible, {message: 'swiping Start reaches the last recent file'}).toBe(true);
        const start = await page.evaluate(() => ({
            tableHeaderWidth: document.querySelector<HTMLElement>('.recent-row--head')!.getBoundingClientRect().width,
            rootOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
        }));
        await page.screenshot({path: resolve(evidenceDir, 'portrait-start-large-text.png')});
        expect.soft((await readLastRecent()).tableScrollRange, 'the recent list does not scroll inside Start').toBeLessThanOrEqual(1);
        expect.soft(start.tableHeaderWidth, 'a phone lists recent files without a visible table header').toBeLessThanOrEqual(1);
        // The app never scrolls at the page level, so a pull past a pane's top
        // must not reach the browser's pull-to-refresh.
        expect.soft(start.rootOverscroll, 'pulling down does not reload the app').toBe('none');
        expect(problems).toEqual([]);
    } finally {
        await phone.close();
    }
}, 120_000);
