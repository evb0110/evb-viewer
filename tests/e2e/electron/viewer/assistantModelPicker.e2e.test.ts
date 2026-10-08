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
        await page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        await clickAsUser(page, '.agent-assistant-input');
        return page;
    }

    it('shows the newest model in each family with Sol and Opus first', async () => {
        const page = await openAssistantDocument();
        const inputInset = await page.$eval('.agent-assistant-input', input => {
            const style = getComputedStyle(input);
            return input.clientLeft + Number.parseFloat(style.paddingLeft);
        });
        expect(inputInset, 'Composer text should have a compact inline inset').toBeLessThanOrEqual(12);
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
        for (const family of [
            'Opus',
            'Fable',
        ]) {
            const versions = claude.flatMap(label => new RegExp(`^${family} (\\d+(?:\\.\\d+)?)`).exec(label)?.slice(1) ?? []);
            expect(versions.length).toBeGreaterThan(0);
            expect(new Set(versions).size, `${family} has stale versions: ${versions.join(', ')}`).toBe(1);
        }
        expect(await page.$('.agent-assistant-message.is-user')).toBeNull();
    }, 60_000);

    it('keeps the accepted image prompt visible when the local provider answers', async () => {
        const page = await openAssistantDocument();
        const png = createLargeAssistantImage();
        expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
        await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
            await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([bytes], {type: 'image/png'})})]);
        }, png.toString('base64'));
        await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.keyboard.press('V');
        await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
        await page.waitForSelector('.agent-assistant-composer-attachment-image');
        await page.keyboard.type('Explain this image.');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.agent-assistant-message.is-assistant')?.textContent?.includes('Image received.'));
        expect(await page.$eval('.agent-assistant-messages', element => element.textContent)).toContain('Explain this image.');
        expect(await page.$eval('.agent-assistant-message-image', image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
        await page.reload();
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.agent-assistant-message.is-user');
        expect(await page.$eval('.agent-assistant-messages', element => element.textContent)).toContain('Explain this image.');
        await page.waitForFunction(() => (document.querySelector('.agent-assistant-message-image') as HTMLImageElement | null)?.naturalWidth);
        expect(await page.$eval('.agent-assistant-message-image', image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    }, 60_000);

    it('projects live tool activity and restores its conversation after eviction and restart', async () => {
        let page = await openAssistantDocument();
        await page.keyboard.type('AP-B02 tool activity');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.agent-assistant-turn-progress')?.textContent?.includes('Tool search_document running'));
        expect(await page.$$eval('.agent-assistant-tool-activity', rows => rows.map(row => row.textContent?.trim()).join('\n'))).toBe('read_document — Running\nsearch_document — Running');
        await page.waitForFunction(() => document.querySelector('.agent-assistant-message.is-assistant:last-of-type')?.textContent?.includes('Local tool fixture finished.'));

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
        await page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        await page.waitForSelector('.agent-assistant-message.is-user');
        expect(await page.$eval('.agent-assistant-messages', element => element.textContent)).toContain('AP-B02 tool activity');

        ({page} = await fixture.restart({
            hard: true,
            clean: false,
        }));
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.agent-assistant-message.is-user');
        expect(await page.$eval('.agent-assistant-messages', element => element.textContent)).toContain('AP-B02 tool activity');
    }, 120_000);
    it('preserves every table-like line inside assistant fenced code', async () => {
        const page = await openAssistantDocument();
        await page.keyboard.type('AP-B01 fenced table');
        await page.keyboard.press('Enter');
        const message = '.agent-assistant-message.is-assistant:last-child';
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('After'), {}, message);
        expect(await page.$eval(message + ' pre', element => element.textContent)).toBe(
            'const value = 1;\n| a | b |\n| --- | --- |\n| c | d |',
        );
        expect(await page.$(message + ' table')).toBeNull();
        await fixture.getSession().command('screenshot', ['ap-b01-fenced-table']);
    }, 60_000);

});
