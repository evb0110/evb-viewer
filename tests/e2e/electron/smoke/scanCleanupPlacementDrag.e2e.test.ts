import {createHash} from 'node:crypto';
import {createCanvas} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    clickVisibleToolbarButton, dismissScanCleanupFirstRunGuidance, openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';

const fixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-placement-drag-${Date.now()}`});

async function createSpreadFixture() {
    const path = await createMultiPageTextFixturePdf('cleanup-placement-drag.pdf', 1);
    const canvas = createCanvas(1650, 1275);
    const context = canvas.getContext('2d');
    context.fillStyle = '#f5f5f5';
    context.fillRect(0, 0, 1650, 1275);
    context.fillStyle = '#282828';
    // The left leaf's smaller ink block leaves room to move on the canvas
    // matched to the right leaf. A full-size block cannot change placement.
    for (let leaf = 0; leaf < 2; leaf += 1) {
        for (let line = 0; line < (leaf === 0 ? 12 : 24); line += 1) {
            for (let column = 0; column < (leaf === 0 ? 16 : 26); column += 1) {
                context.fillRect(leaf * 825 + 150 + column * 20, 120 + line * 40, 12, 15);
            }
        }
    }
    const doc = await PDFDocument.create();
    const image = await doc.embedPng(canvas.toBuffer('image/png'));
    doc.addPage([
        792,
        612,
    ]).drawImage(image, {
        x: 0,
        y: 0,
        width: 792,
        height: 612,
    });
    writeFileSync(path, await doc.save());
    return path;
}

describe('scan cleanup placement drag', () => {
    it('moves a cleaned spread half when dragged from its content interior', async () => {
        const session = fixture.getSession();
        const {page} = session;
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const source = await createSpreadFixture();
        const sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await dismissScanCleanupFirstRunGuidance(page);
        await clickAsUser(page, '[data-settings-scope="page"]');
        await clickAsUser(page, '[role="combobox"][aria-label="Page layout"]');
        await clickFoundAsUser(page, () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
            .find(option => option.textContent?.trim() === 'Two-page spread'), undefined, {description: 'Two-page spread'});
        for (const text of [
            'Crop each output page to its content',
            'Match page size with other pages',
        ]) {
            const checked = await page.evaluate((labelText: string) => {
                const label = [...document.querySelectorAll('label')].find(candidate => candidate.textContent?.trim() === labelText);
                return document.getElementById(label?.htmlFor ?? '')?.getAttribute('aria-checked') === 'true';
            }, text);
            if (!checked) await clickFoundAsUser(page, (labelText: string) => [...document.querySelectorAll('label')]
                .find(label => label.textContent?.trim() === labelText), text, {description: text});
        }
        await page.waitForFunction(() => {
            const images = [...document.querySelectorAll<HTMLImageElement>('[data-output-half] .cleaned-image.preview-pixel:not(.is-incoming):not(.is-outgoing)')];
            return document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && document.querySelectorAll('.placement-control[role="button"]').length === 2
                && images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0)
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/.test(document.body.innerText);
        }, {timeout: 120_000});
        const readPlacement = () => page.evaluate(async (sha: string) => {
            const api = (window as IE2EWindow).electronAPI?.scanCleanup;
            if (!api?.getSettings) throw new Error('Scan cleanup settings API unavailable');
            const settings = await api.getSettings({sourceSha256: sha});
            return settings.documentOverrides[sha]?.overrides?.['1']?.placementOverrides ?? null;
        }, sourceSha256);
        const before = await readPlacement();
        const start = await page.$eval('.placement-control[aria-label*="left half"]', element => {
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height * 0.42;
            return {
                x,
                y,
                hit: document.elementFromPoint(x, y)?.className,
            };
        });
        // Trusted CDP mouse input must pass through the content-box interior
        // and move placement; dispatchEvent or element.click bypass hit testing.
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + 45, start.y + 45, {steps: 12});
        await page.mouse.up();
        try {
            await expect.poll(readPlacement, {
                timeout: 5_000,
                message: 'Dragging the cleaned page interior must change its persisted placement',
            }).not.toEqual(before);
        } finally {
            if (process.env.SPLITFLAKE_UI_PROOF_DIR) {
                const evidence = resolve(process.env.SPLITFLAKE_UI_PROOF_DIR);
                mkdirSync(evidence, {recursive: true});
                writeFileSync(resolve(evidence, 'source.pdf'), readFileSync(source));
                writeFileSync(resolve(evidence, 'placement.json'), JSON.stringify({
                    before,
                    after: await readPlacement(),
                    start,
                }, null, 2));
                await page.screenshot({path: resolve(evidence, 'placement.png')});
            }
        }
    }, 240_000);
});
