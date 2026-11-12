import { resolve } from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import { clickAsUser } from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';

// AS1: a provider that never answers its start (as Codex does while a blocked
// network holds its sign-in refresh) must not hold the panel. The panel names
// the cause within the startup budget and the composer stays usable.
describe('Electron E2E - assistant provider that never answers', () => {
    const fixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-assistant-provider-stall-${Date.now()}`,
        timeoutMs: 90_000,
        extraEnv: {
            CODEX_CLI_PATH: resolve(`tests/fixtures/electron/codex-model-picker.${process.platform === 'win32' ? 'cmd' : 'mjs'}`),
            EVB_FAKE_CODEX_HANG: '1',
        },
    });

    it('names the stalled start and keeps the composer usable', async () => {
        const {page} = fixture.getSession();
        await page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({assistantPanelEnabled: true});
        });
        await page.reload();
        await openPdfInApp(page, resolve('tests/fixtures/release/packaged-core-smoke.pdf'));
        await waitForPdfLoaded(page);
        const openedAt = Date.now();
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');

        await page.waitForFunction(
            () => document.querySelector('.agent-assistant-panel')?.textContent?.includes('did not start within 10 seconds') === true,
            {timeout: 20_000},
        );
        expect(Date.now() - openedAt, 'the stalled start is reported within its budget').toBeLessThan(20_000);
        const composer = await page.$eval('.agent-assistant-panel textarea', element => ({
            visible: element.getBoundingClientRect().height > 0,
            disabled: (element as HTMLTextAreaElement).disabled,
        }));
        expect(composer).toEqual({
            visible: true,
            disabled: false,
        });

        const sentAt = Date.now();
        await clickAsUser(page, '.agent-assistant-panel textarea');
        await page.keyboard.type('Hello');
        await page.keyboard.press('Enter');
        await page.waitForFunction(
            () => [...document.querySelectorAll('.agent-assistant-panel .timeline-error')]
                .some(row => row.textContent?.includes('did not start within 10 seconds')),
            {timeout: 30_000},
        );
        expect(Date.now() - sentAt, 'a send to the stalled provider fails within its budget').toBeLessThan(30_000);
        expect(await page.$eval('.agent-assistant-panel', panel => panel.textContent)).toContain('Hello');
        expect(await page.$eval('.agent-assistant-panel textarea', element => (element as HTMLTextAreaElement).disabled)).toBe(false);
    }, 90_000);
});
