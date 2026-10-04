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

// Opening the picker must discover both providers before the first model turn.
describe('Electron E2E - assistant model discovery', () => {
    const fixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-assistant-model-picker-${Date.now()}`,
        timeoutMs: 60_000,
        extraEnv: { CODEX_CLI_PATH: resolve(`tests/fixtures/electron/codex-model-picker.${process.platform === 'win32' ? 'cmd' : 'mjs'}`) },
    });

    it('shows current Sol and versioned Opus first without superseded Sol', async () => {
        const { page } = fixture.getSession();
        await page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({ assistantPanelEnabled: true });
        });
        await page.reload();
        await openPdfInApp(page, resolve('tests/fixtures/release/packaged-core-smoke.pdf'));
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.assistant-switcher-trigger');
        await clickAsUser(page, '.assistant-switcher-trigger');
        await page.waitForFunction(() => {
            const groups = [...document.querySelectorAll('.assistant-model-group')];
            return groups.some(group => /GPT-\d+(?:\.\d+)?-Astra/.test(group.textContent ?? ''));
        });
        const groups = await page.evaluate(() => [...document.querySelectorAll('.assistant-model-group')].map(group => ({
            provider: group.getAttribute('aria-label'),
            labels: [...group.querySelectorAll('.assistant-switcher-option-label')].map(row => row.textContent?.trim() ?? ''),
        })));
        const codex = groups.find(group => group.provider === 'Codex')?.labels ?? [];
        const claude = groups.find(group => group.provider === 'Claude')?.labels ?? [];
        expect(codex[0]).toMatch(/^GPT-\d+(?:\.\d+)?-Sol$/);
        expect(codex).not.toContain('GPT-6-Sol');
        expect(codex.some(label => /-Luna$/.test(label))).toBe(true);
        expect(claude[0]).toMatch(/^Opus \d+(?:\.\d+)?/);
        expect(claude).not.toContain('Opus');
        expect(await page.$('.agent-assistant-message.is-user')).toBeNull();
    }, 60_000);
});
