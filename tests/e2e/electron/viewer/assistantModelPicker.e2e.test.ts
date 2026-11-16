import { resolve } from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    activateMenuItemAsUser,
    clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {createLargeAssistantImage} from '@tests/fixtures/electron/createLargeAssistantImage';

// Opening the picker must discover both providers before the first model turn.
describe('Electron E2E - assistant model discovery', () => {
    const fixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-assistant-model-picker-${Date.now()}`,
        timeoutMs: 60_000,
        extraEnv: { CODEX_CLI_PATH: resolve(`tests/fixtures/electron/codex-model-picker.${process.platform === 'win32' ? 'cmd' : 'mjs'}`) },
    });

    async function openAssistantDocument() {
        const {page} = fixture.getSession();
        await page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({assistantPanelEnabled: true});
        });
        await page.reload();
        await openPdfInApp(page, resolve('tests/fixtures/release/packaged-core-smoke.pdf'));
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.composer-input:not(:disabled)', {visible: true});
        await clickAsUser(page, '.composer-input');
        return page;
    }

    it('shows the installed setup’s reported models and a runnable default without inserting Sol 6.1', async () => {
        const page = await openAssistantDocument();
        const inputInset = await page.$eval('.composer-input', input => {
            const style = getComputedStyle(input);
            return input.clientLeft + Number.parseFloat(style.paddingLeft);
        });
        expect(inputInset, 'Composer text should have a compact inline inset').toBeLessThanOrEqual(12);
        await clickAsUser(page, '.picker-trigger');
        await page.waitForSelector('[data-rail-tab="codex"]:not(:disabled)', {visible: true});
        await clickAsUser(page, '[data-rail-tab="codex"]');
        await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].some(row => /GPT-\d+(?:\.\d+)?-Astra/.test(row.textContent ?? '')));
        const rowLabels = () => page.evaluate(() => [...document.querySelectorAll('[data-model-picker-content] [role="option"]')]
            .map(row => row.querySelector('.row-name')?.firstChild?.textContent ?? row.textContent?.trim() ?? ''));
        // Older releases fold under "Show more", as in T3 Code; the reported current models list first.
        expect(await rowLabels()).toEqual(['GPT-6-Astra', 'GPT-6-Luna', 'Show more']);
        // The reasoning column lists the selected model's levels with its default marked.
        expect(await page.$$eval('[data-model-picker-effort] .effort-label', labels => labels.map(label => label.textContent))).toEqual(['Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra']);
        // Keyboard: the levels and speeds are radio groups, so the arrows select; the star is no part of an option.
        const triggerLabel = () => page.$eval('.picker-trigger', button => button.getAttribute('aria-label') ?? '');
        expect(await triggerLabel()).toBe('Codex · GPT-6-Astra · Medium · Standard');
        expect(await page.$$eval('[data-model-picker-content] [role="option"] button', buttons => buttons.length)).toBe(0);
        await clickAsUser(page, '[data-model-picker-effort] [data-effort-level][aria-checked="true"]');
        await page.keyboard.press('ArrowDown');
        await page.waitForFunction(() => document.querySelector('.picker-trigger')?.getAttribute('aria-label') === 'Codex · GPT-6-Astra · High · Standard');
        expect(await page.$$eval('.speed-segment', segments => segments.map(segment => (segment as HTMLElement).tabIndex))).toEqual([0, -1]);
        await clickAsUser(page, '.speed-segment[aria-checked="true"]');
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('.picker-trigger')?.getAttribute('aria-label') === 'Codex · GPT-6-Astra · High · Fast');
        // Back to the defaults, which the later tests send with.
        await page.keyboard.press('ArrowLeft');
        await clickAsUser(page, '[data-model-picker-effort] [data-effort-id="medium"]');
        await page.waitForFunction(() => document.querySelector('.picker-trigger')?.getAttribute('aria-label') === 'Codex · GPT-6-Astra · Medium · Standard');
        await clickAsUser(page, '[data-model-picker-content] .picker-row.is-more');
        const codex = await rowLabels();
        expect(codex).toEqual(['GPT-6-Astra', 'GPT-6-Luna', 'GPT-6-Sol', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5', 'Show less']);
        expect(codex).not.toContain('GPT-6.1-Sol');
        const state = await page.evaluate(async () => (window as IE2EWindow).electronAPI!.agent.getAssistantState());
        const setup = state.instances.find(instance => instance.id === 'codex')!;
        expect(setup.models.some(model => model.id === setup.defaultModel)).toBe(true);
        expect(await page.$('.assistant-message.is-user')).toBeNull();
    }, 60_000);

    it('keeps the accepted image prompt visible when the local provider answers', async () => {
        const page = await openAssistantDocument();
        const png = createLargeAssistantImage();
        expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
        await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
            await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([bytes], {type: 'image/png'})})]);
        }, png.toString('base64'));
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+V'});
        await page.waitForSelector('.composer-image img');
        await page.keyboard.type('Explain this image.');
        await page.waitForSelector('.composer-send:not(:disabled)', {visible: true});
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.assistant-message:not(.is-user)')?.textContent?.includes('Image received.'));
        expect(await page.$eval('.assistant-timeline', element => element.textContent)).toContain('Explain this image.');
        expect(await page.$eval('.message-images img', image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
        await page.reload();
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.assistant-message.is-user');
        expect(await page.$eval('.assistant-timeline', element => element.textContent)).toContain('Explain this image.');
        await page.waitForFunction(() => (document.querySelector('.message-images img') as HTMLImageElement | null)?.naturalWidth);
        expect(await page.$eval('.message-images img', image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    }, 60_000);

    it('projects live tool activity and restores its conversation after eviction and restart', async () => {
        let page = await openAssistantDocument();
        await page.keyboard.type('AP-B02 tool activity');
        await page.waitForSelector('.composer-send:not(:disabled)', {visible: true});
        await page.keyboard.press('Enter');
        // Both tool calls show as live work rows of the running turn.
        await page.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.work-entry')].map(row => row.textContent ?? '');
            return rows.some(row => row.includes('read_document')) && rows.some(row => row.includes('search_document'));
        });
        expect(await page.$eval('.work-group summary', summary => summary.textContent)).toContain('search_document');
        await page.waitForFunction(() => document.querySelector('.assistant-message:not(.is-user):last-of-type')?.textContent?.includes('Local tool fixture finished.'));

        // Populate the production cache through ordinary state requests. This is
        // setup for returning to the real open document, not a second chat store.
        await page.evaluate(async () => {
            const agent = (window as IE2EWindow).electronAPI!.agent;
            for (let index = 0; index < 65; index += 1) {
                await agent.getAssistantState({scope: {
                    kind: 'document',
                    key: `eviction-setup-${index}`,
                    title: null,
                }});
            }
        });
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.composer-input:not(:disabled)', {visible: true});
        await page.waitForSelector('.assistant-message.is-user');
        expect(await page.$eval('.assistant-timeline', element => element.textContent)).toContain('AP-B02 tool activity');

        ({page} = await fixture.restart({
            hard: true,
            clean: false,
        }));
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.assistant-message.is-user');
        expect(await page.$eval('.assistant-timeline', element => element.textContent)).toContain('AP-B02 tool activity');
    }, 120_000);
    it('preserves every table-like line inside assistant fenced code', async () => {
        const page = await openAssistantDocument();
        await page.keyboard.type('AP-B01 fenced table');
        await page.waitForSelector('.composer-send:not(:disabled)', {visible: true});
        await page.keyboard.press('Enter');
        const message = '.assistant-message:not(.is-user):last-of-type';
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('After'), {}, message);
        expect(await page.$eval(message + ' pre', element => element.textContent)).toBe(
            'const value = 1;\n| a | b |\n| --- | --- |\n| c | d |',
        );
        expect(await page.$(message + ' table')).toBeNull();
        await fixture.getSession().command('screenshot', ['ap-b01-fenced-table']);
    }, 60_000);

});
