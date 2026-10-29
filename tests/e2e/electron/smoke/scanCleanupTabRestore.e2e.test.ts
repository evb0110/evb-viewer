import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickVisibleToolbarButton, dismissScanCleanupFirstRunGuidance, openPdfInApp,
    setTabMemoryPolicyForE2E, waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    SCAN_CLEANUP_RUN_METER_SELECTOR,
    SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR,
} from '@contracts/scan-cleanup/toolbarSelectors';
import {
    activateWorkspaceTab, createNewWorkspaceTab,
} from '@tests/e2e/electron/helpers/workspaceTabs';

const fixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-tab-restore-${Date.now()}`});

describe('scan cleanup tab restore', () => {
    it('leaves queued cleanup through Done during analysis without a failure toast', async () => {
        const {page} = fixture.getSession();
        const source = await createLargeScannedFixturePdf('cleanup-done-during-analysis.pdf', 6, 0);
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface[data-detection-status="pending"]', {visible: true});
        await dismissScanCleanupFirstRunGuidance(page);
        // Observe painted toast text throughout the transition, including a
        // failure that could disappear before the workspace is reopened.
        const toasts = await page.evaluateHandle(() => {
            const failures = new Set<string>();
            const observer = new MutationObserver(() => {
                for (const node of document.querySelectorAll<HTMLElement>('[data-slot="title"], [data-slot="description"]')) {
                    const text = node.innerText;
                    if (/Scan cleanup failed|Cleanup requires a completed uniform page analysis/u.test(text)) failures.add(text);
                }
            });
            observer.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
            });
            return {
                failures,
                disconnect: () => observer.disconnect(),
            };
        });
        try {
            await clickAsUser(page, SCAN_CLEANUP_TOOLBAR_PRIMARY_ACTION_SELECTOR);
            await page.waitForSelector(SCAN_CLEANUP_RUN_METER_SELECTOR, {visible: true});
            expect(await page.$eval('.scan-cleanup-surface', surface => surface.getAttribute('data-detection-status')))
                .toBe('pending');
            await clickAsUser(page, '.scan-cleanup-toolbar-done');
            await page.waitForSelector('.scan-cleanup-surface', {hidden: true});
            await waitForViewerInteractive(page);

            await clickVisibleToolbarButton(page, 'Scan cleanup');
            await page.waitForSelector('.scan-cleanup-surface[data-detection-status="completed"]', {timeout: 120_000});
            const failures = await toasts.evaluate(observation => [...observation.failures]);
            console.log('Done during analysis, observed failure toasts:', JSON.stringify(failures));
            expect(failures).toEqual([]);
        } finally {
            await toasts.evaluate(observation => observation.disconnect());
            await toasts.dispose();
        }
    }, 180_000);

    it('keeps page 2 rotation and its customized dot after Done and reopen', async () => {
        const {page} = fixture.getSession();
        const source = await createLargeScannedFixturePdf('cleanup-done-page-overrides.pdf', 2, 0);
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await dismissScanCleanupFirstRunGuidance(page);
        await page.waitForSelector('.scan-cleanup-surface[data-detection-status="completed"]', {timeout: 120_000});
        await clickAsUser(page, '[data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="2"]) .scan-thumbnail-label-band');
        await clickAsUser(page, '[data-settings-scope="page"]');
        const rotation = '[role="radiogroup"][aria-label="Rotation"] [role="radio"][aria-label="90°"]';
        await clickAsUser(page, rotation);
        await page.waitForSelector(`${rotation}[aria-checked="true"]`);
        await page.waitForSelector('[data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="2"]) .scan-thumbnail-customized', {visible: true});
        await clickAsUser(page, '.scan-cleanup-toolbar-done');
        await page.waitForSelector('.scan-cleanup-surface', {hidden: true});
        await waitForViewerInteractive(page);

        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await clickAsUser(page, '[data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="2"]) .scan-thumbnail-label-band');
        await clickAsUser(page, '[data-settings-scope="page"]');
        const restored = await page.evaluate((selector: string) => ({
            rotation: document.querySelector(selector)?.getAttribute('aria-checked'),
            customized: document.querySelector<HTMLElement>('[data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="2"]) .scan-thumbnail-customized')?.checkVisibility() ?? false,
            otherPageCustomized: document.querySelector('[data-document-thumbnail-item]:has(.scan-thumbnail-overlay[data-page-number="1"]) .scan-thumbnail-customized') !== null,
        }), rotation);
        console.log('Page 2 after Done and reopen:', JSON.stringify(restored));
        expect(restored).toEqual({
            rotation: 'true',
            customized: true,
            otherPageCustomized: false,
        });
    }, 180_000);

    it('renders cleanup without an error when returning to an evicted two-page tab', async () => {
        const {page} = fixture.getSession();
        await setTabMemoryPolicyForE2E(page, 'aggressive');
        const source = await createLargeScannedFixturePdf('cleanup-restore-two-pages.pdf', 2, 0);
        await openPdfInApp(page, source);
        await waitForPdfLoaded(page);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {visible: true});
        await dismissScanCleanupFirstRunGuidance(page);
        await page.waitForFunction(() => {
            const surface = document.querySelector('.scan-cleanup-surface');
            const image = surface?.querySelector<HTMLImageElement>('.cleaned-image.preview-pixel:not(.is-incoming):not(.is-outgoing)');
            return surface?.getAttribute('data-detection-status') === 'completed'
                && image?.complete && image.naturalWidth > 0;
        }, {timeout: 120_000});
        const sourceTab = await page.$eval('.tab.is-active[data-tab-id]', tab => tab.getAttribute('data-tab-id'));

        await createNewWorkspaceTab(fixture.getSession());
        // Aggressive memory policy releases the inactive workspace. Wait for
        // its DOM to disappear so this exercises restoration, not a warm tab.
        await page.waitForFunction((id: string | null) => !document.querySelector(
            `.workspace-host[data-workspace-tab-id="${id}"]`,
        ), {}, sourceTab);
        await activateWorkspaceTab(fixture.getSession(), 0);
        // A failed restore is a terminal observation too, so the regression
        // fails on the visible error instead of timing out on a missing image.
        await page.waitForFunction(() => {
            const host = document.querySelector('.workspace-host[data-workspace-active="true"]');
            const image = host?.querySelector<HTMLImageElement>('.scan-cleanup-surface .cleaned-image.preview-pixel:not(.is-incoming):not(.is-outgoing)');
            return host?.querySelector('.workspace-host__loading[role="alert"]')
                || image?.complete && image.naturalWidth > 0
                && host?.querySelectorAll('.scan-thumbnail-overlay[data-page-number]').length === 2
                && host.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !host.querySelector('[role="alert"]');
        }, {timeout: 120_000});
        const restored = await page.evaluate(() => {
            const host = document.querySelector('.workspace-host[data-workspace-active="true"]');
            return {
                cleanupVisible: host?.querySelector<HTMLElement>('.scan-cleanup-surface')?.checkVisibility() ?? false,
                errorText: host?.querySelector<HTMLElement>('[role="alert"]')?.innerText ?? null,
                pages: host?.querySelectorAll('.scan-thumbnail-overlay[data-page-number]').length ?? 0,
            };
        });
        if (process.env.SPLITFLAKE_UI_PROOF_DIR) {
            const evidence = resolve(process.env.SPLITFLAKE_UI_PROOF_DIR);
            mkdirSync(evidence, {recursive: true});
            writeFileSync(resolve(evidence, 'source.pdf'), readFileSync(source));
            writeFileSync(resolve(evidence, 'restored.json'), JSON.stringify(restored, null, 2));
            await page.screenshot({path: resolve(evidence, 'restored.png')});
        }
        expect(restored, 'Returning to a cold Scan cleanup tab must render its cleanup surface without a workspace error').toMatchObject({
            cleanupVisible: true,
            errorText: null,
            pages: 2,
        });
    }, 240_000);
});
