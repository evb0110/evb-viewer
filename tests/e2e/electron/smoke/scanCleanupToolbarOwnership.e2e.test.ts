import {
    describe, expect, it,
} from 'vitest';
import {
    SCAN_CLEANUP_RUN_METER_SELECTOR,
    SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR,
} from '@contracts/scan-cleanup/toolbarSelectors';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    clickVisibleToolbarButton, dismissScanCleanupFirstRunGuidance, openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {activateWorkspaceTab} from '@tests/e2e/electron/helpers/workspaceTabs';

const fixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-toolbar-ownership-${Date.now()}`});

describe('scan cleanup toolbar ownership', () => {
    it('keeps a running cleanup out of another document\'s toolbar', async () => {
        const {page} = fixture.getSession();
        const running = await createLargeScannedFixturePdf('toolbar-owner-running-300-pages.pdf', 300, 0);
        const other = await createLargeScannedFixturePdf('toolbar-owner-other.pdf', 2, 0);
        await openPdfInApp(page, running);
        await waitForPdfLoaded(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await dismissScanCleanupFirstRunGuidance(page);
        // Start after detection, so the first document has a job running and
        // not only a click waiting for its analysis.
        await waitForFunctionInPage(page, (primaryActionSelector: string) => {
            const action = document.querySelector<HTMLButtonElement>(primaryActionSelector);
            return document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && action?.disabled === false && (action.textContent ?? '').includes('Clean up');
        }, {timeout: 120_000}, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
        await page.waitForSelector(SCAN_CLEANUP_RUN_METER_SELECTOR, {timeout: 30_000});

        await openPdfInApp(page, other);
        await waitForPdfLoaded(page);
        // A narrow window folds the trigger into More tools; read the command
        // the user reaches either way.
        await clickAsUser(page, 'button[aria-label="More tools"]');
        const command = await (await page.waitForFunction(() => {
            const icon = [...document.querySelectorAll<HTMLElement>('.overflow-menu-scan-cleanup-icon')]
                .find(element => element.checkVisibility());
            const item = icon?.closest<HTMLElement>('[role^="menuitem"]');
            if (!icon || !item) return null;
            return {
                label: (item.textContent ?? '').trim(),
                runningDot: icon.querySelector('.overflow-menu-running-dot') !== null,
                runCompleted: [...document.querySelectorAll<HTMLElement>('[data-slot="title"]')]
                    .some(title => (title.textContent ?? '').trim() === 'Scan cleanup complete'),
            };
        }, {timeout: 30_000})).jsonValue();
        await page.keyboard.press('Escape');
        expect(command).toEqual({
            label: 'Scan cleanup',
            runningDot: false,
            runCompleted: false,
        });
        // The first document's run started before that read and is still
        // running after it, so the read saw a toolbar beside a live run.
        await activateWorkspaceTab(fixture.getSession(), 0);
        await page.waitForSelector(SCAN_CLEANUP_RUN_METER_SELECTOR, {timeout: 30_000});
    }, 300_000);
});
