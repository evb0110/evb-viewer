import {
    mkdirSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {
    expect, it,
} from 'vitest';
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
