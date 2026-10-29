import {
    mkdirSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    clickVisibleToolbarButton, openPdfInApp,
} from '@tests/e2e/electron/helpers/viewerCore';
import {SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR} from '@contracts/scan-cleanup/toolbarSelectors';

const fixture = createElectronE2ESessionFixture({sessionName: () => `e2e-splitflake-position-${Date.now()}`});
const evidence = resolve(process.env.SPLITFLAKE_UI_PROOF_DIR ?? `.devkit/tmp/scan-cleanup-settings-position-${Date.now()}`);

describe('scan cleanup settings position', () => {
    it('keeps the settings in place when analysis stops and restarts', async () => {
        const {page} = fixture.getSession();
        const source = await createLargeScannedFixturePdf('scan-cleanup-settings-position.pdf', 6, 0);
        await openPdfInApp(page, source);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector(SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR, {visible: true});
        if (await page.$('.scan-cleanup-first-run-guidance')) {
            await clickAsUser(page, '.scan-cleanup-first-run-guidance button');
            await page.waitForSelector('.scan-cleanup-first-run-guidance', {hidden: true});
        }
        mkdirSync(evidence, {recursive: true});
        async function position(name: string) {
            const result = await page.evaluate(() => ({
                surface: document.querySelector('.scan-cleanup-surface')!.getBoundingClientRect().top,
                panel: document.querySelector('.scan-cleanup-settings-scroll')!.getBoundingClientRect().top,
                layout: document.querySelector('[aria-label="Page layout"]')!.getBoundingClientRect().top,
            }));
            writeFileSync(resolve(evidence, `${name}.json`), JSON.stringify(result));
            await page.screenshot({path: resolve(evidence, `${name}.png`)});
            return result;
        }
        const analyzing = await position('analyzing');
        await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR);
        await page.waitForFunction(() => {
            const button = document.querySelector<HTMLButtonElement>('.scan-thumbnail-redetect');
            return button !== null && !button.disabled;
        });
        const stopped = await position('stopped');
        expect(stopped, JSON.stringify({
            analyzing,
            stopped,
        })).toEqual(analyzing);
        await clickAsUser(page, '.scan-thumbnail-redetect');
        await page.waitForSelector(SCAN_CLEANUP_TOOLBAR_CANCEL_DETECTION_SELECTOR, {visible: true});
        expect(await position('restarted')).toEqual(stopped);
    });
});
