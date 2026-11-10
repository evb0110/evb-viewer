import {PDFDocument} from 'pdf-lib';
import type {Page} from 'playwright';
import {expect} from 'vitest';
import {settleActiveOpen} from './documentLifecycleTestHelpers';

// A six-page portrait PDF whose pages read "<label> page <n>".
export async function createReadingBook(label: string, name: string) {
    const pdf = await PDFDocument.create();
    for (let pageNumber = 1; pageNumber <= 6; pageNumber += 1) {
        pdf.addPage([
            400,
            600,
        ]).drawText(`${label} page ${String(pageNumber)}`, {
            x: 40,
            y: 500,
            size: 24,
        });
    }
    return {
        name,
        mimeType: 'application/pdf',
        buffer: Buffer.from(await pdf.save()),
    };
}


// What the reader sees of the active view: the toolbar's page and zoom, and
// the page in the middle of the viewport with its painted orientation.
export function readReadingView(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector('.workspace-host[data-workspace-active="true"]');
        const viewport = host?.querySelector('[data-document-viewer-chassis-viewport]')?.getBoundingClientRect();
        const visible = Array.from(host?.querySelectorAll<HTMLElement>('.page_container--rendered') ?? []).find((container) => {
            if (!viewport) return false;
            const rect = container.getBoundingClientRect();
            const centerX = viewport.left + viewport.width / 2;
            const centerY = viewport.top + viewport.height / 2;
            return rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY;
        });
        const rect = visible?.getBoundingClientRect();
        return {
            indicator: document.querySelector('.page-controls-current-primary')?.textContent?.trim(),
            zoom: document.querySelector('.zoom-controls-display-value')?.textContent?.trim(),
            visibleText: visible?.querySelector('.textLayer')?.textContent?.trim(),
            landscape: rect ? rect.width > rect.height : null,
        };
    });
}


// Opens a reading book through Start's Open File button and the file chooser.
export async function openReadingBook(page: Page, label: string, name: string) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', {
        name: 'Open File',
        exact: true,
    }).first().click();
    await (await chooser).setFiles(await createReadingBook(label, name));
    await expect.poll(async () => (await readReadingView(page)).visibleText, {timeout: 30_000}).toBe(`${label} page 1`);
    await settleActiveOpen(page);
}
