import { resolve } from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    activateMenuItemAsUser,
    clickAsUser,
    revealForPointer,
} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import { waitForAnimationFrames } from '@tests/e2e/electron/helpers/viewerVirtualizationContract';
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
        await page.waitForFunction(() => {
            const groups = [...document.querySelectorAll('.picker-group')];
            return groups.some(group => /GPT-\d+(?:\.\d+)?-Astra/.test(group.textContent ?? ''));
        });
        const groups = await page.evaluate(() => [...document.querySelectorAll('.picker-group')].map(group => ({
            provider: group.querySelector('header')?.textContent?.trim() ?? null,
            labels: [...group.querySelectorAll('.picker-model')].map(row => row.textContent?.trim() ?? ''),
        })));
        const codex = groups.find(group => group.provider === 'Codex')?.labels ?? [];
        expect(codex).toEqual(['GPT-6-Astra', 'GPT-6-Sol', 'GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-5.5']);
        expect(codex).not.toContain('GPT-6.1-Sol');
        const state = await page.evaluate(async () => (window as IE2EWindow).electronAPI!.agent.getAssistantState());
        const setup = state.instances.find(instance => instance.id === 'codex')!;
        expect(setup.models.some(model => model.id === setup.defaultModel)).toBe(true);
        expect(await page.$('.assistant-message.is-user')).toBeNull();
        await clickAsUser(page, '.picker-efforts [role="radio"]');
        await page.keyboard.press('ArrowUp');
        expect.soft(await page.$eval('.picker-efforts [role="radio"]:last-child', row => row.getAttribute('aria-checked')), 'Effort arrow navigation selects and wraps').toBe('true');
        await clickAsUser(page, '.picker-speed-option[aria-checked="true"]');
        await page.keyboard.press('ArrowRight');
        expect.soft(await page.$eval('.picker-speed-option:last-child', row => row.getAttribute('aria-checked')), 'Speed arrow navigation selects Fast').toBe('true');
        expect.soft(await page.$$eval('.picker-speed-option', rows => rows.filter(row => row instanceof HTMLElement && row.tabIndex === 0).length), 'Each radio group has one tab stop').toBe(1);
        await page.keyboard.press('ArrowRight');
        expect.soft(await page.$eval('.picker-speed-option:first-child', row => row.getAttribute('aria-checked')), 'Speed navigation wraps to Standard').toBe('true');
        await fixture.getSession().command('screenshot', ['assistant-keyboard-radio-choices']);
        const pickerLayout = await page.evaluate(() => {
            const measure = (selector: string) => {
                const element = document.querySelector(selector);
                if (!element) throw new Error(`Missing ${selector}`);
                const bounds = element.getBoundingClientRect();
                return {top: bounds.top, bottom: bounds.bottom, height: bounds.height, scrollTop: element.scrollTop};
            };
            return {efforts: measure('.picker-efforts'), speed: measure('.picker-speed'), body: measure('.picker-body'), models: measure('.picker-models'), list: measure('.picker-model-list'), popup: measure('.provider-picker')};
        });
        console.log('Picker geometry', pickerLayout);
        expect(pickerLayout.efforts.bottom, 'Effort choices must remain above the speed footer').toBeLessThanOrEqual(pickerLayout.speed.top);
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

    it('keeps following tied to conversation scrolling instead of nested work scrolling', async () => {
        const page = await openAssistantDocument();
        await page.keyboard.type(`AP-B02 tool activity ${'Document context for the assistant. '.repeat(30)}`);
        await page.waitForSelector('.composer-send:not(:disabled)', {visible: true});
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.querySelector('.assistant-message:not(.is-user):last-of-type')?.textContent?.includes('Local tool fixture finished.'));
        const formatted = '.assistant-message:not(.is-user):has(a)';
        expect.soft(await page.$eval(formatted, element => element.textContent), 'Markdown references decode once outside code').toContain('Character references: A & B © 😀 &copy;. Search and &amp;.');
        expect.soft(await page.$eval(formatted, element => element.textContent), 'Raw inline HTML keeps its references literal').toContain('Literal HTML: <code>&amp;&amp;copy;</code>.');
        expect.soft(await page.$eval(formatted + ' a', link => link.getAttribute('href')), 'Link references preserve query parameters').toBe('https://example.com/?a=1&b=2');
        const timeline = await page.$('.assistant-timeline');
        const bounds = await timeline?.boundingBox();
        if (!bounds) throw new Error('Missing conversation viewport');
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height - 20);
        await page.mouse.wheel({deltaY: -12});
        await page.waitForFunction(() => {
            const viewport = document.querySelector('.assistant-timeline');
            if (!viewport) return false;
            const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
            return gap > 2 && gap < 48;
        });
        expect.soft(await page.$('.scroll-to-end'), 'A short upward scroll must expose the resume-following control').not.toBeNull();
        await fixture.getSession().command('screenshot', ['assistant-short-upward-scroll']);
        await page.mouse.move(bounds.x + 10, bounds.y + bounds.height - 20);
        await page.mouse.wheel({deltaY: 12});
        await page.waitForFunction(() => {
            const viewport = document.querySelector('.assistant-timeline');
            return viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
        });
        await page.waitForSelector('.scroll-to-end', {hidden: true});

        // Restore the conversation to start the nested-scroll case with following enabled.
        await page.reload();
        await waitForPdfLoaded(page);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.work-summary');
        await page.waitForSelector('.provider-banner.is-checking', {hidden: true});
        await page.waitForSelector('.scroll-to-end', {hidden: true});
        // A taller conversation, as when the provider banner collapses, keeps following:
        // the browser pulls scrollTop back to the end, and that is not the reader scrolling.
        const naturalSize = await page.evaluate((): [number, number] => [window.innerWidth, window.innerHeight]);
        const naturalHeight = await page.$eval('.assistant-timeline', viewport => viewport.clientHeight);
        await fixture.getSession().command('windowResize', [naturalSize[0], naturalSize[1] - 100]);
        await page.waitForFunction(height => {
            const viewport = document.querySelector('.assistant-timeline');
            return viewport && viewport.clientHeight < height && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
        }, {}, naturalHeight);
        await fixture.getSession().command('windowResize', naturalSize);
        await page.waitForFunction(height => (document.querySelector('.assistant-timeline')?.clientHeight ?? 0) >= height, {}, naturalHeight);
        await waitForAnimationFrames(page, 2);
        expect.soft(await page.$('.scroll-to-end'), 'A taller conversation keeps following its end').toBeNull();
        const disclosureTop = await page.$eval('.work-summary', summary => summary.getBoundingClientRect().top);
        await clickAsUser(page, '.work-summary');
        await fixture.getSession().command('screenshot', ['assistant-open-work-position']);
        expect.soft(await page.$('.scroll-to-end'), 'Opening work details releases following for the reader').not.toBeNull();
        expect.soft(await page.$eval('.work-summary', summary => summary.getBoundingClientRect().top), 'Opening work preserves its visible position').toBeCloseTo(disclosureTop, 0);
        await clickAsUser(page, '.work-entry summary');
        await page.waitForFunction(() => {
            const entries = document.querySelector('.work-entries');
            return entries && entries.scrollHeight - entries.clientHeight > 24;
        });
        await revealForPointer(page, '.work-entries');
        const resume = await page.$('.scroll-to-end');
        if (resume) await clickAsUser(page, resume);
        await revealForPointer(page, '.work-entries');
        await page.waitForSelector('.scroll-to-end', {hidden: true});
        await page.mouse.wheel({deltaY: 80});
        await page.waitForFunction(() => (document.querySelector('.work-entries')?.scrollTop ?? 0) > 24);
        const outerTop = await page.$eval('.assistant-timeline', viewport => viewport.scrollTop);
        const innerTop = await page.$eval('.work-entries', viewport => viewport.scrollTop);
        await page.mouse.wheel({deltaY: -12});
        await page.waitForFunction(top => (document.querySelector('.work-entries')?.scrollTop ?? top) < top - 2, {}, innerTop);
        expect(await page.$eval('.assistant-timeline', viewport => viewport.scrollTop)).toBe(outerTop);
        expect(await page.$('.scroll-to-end'), 'Scrolling work details must keep conversation following enabled').toBeNull();
        await fixture.getSession().command('windowResize', [900, 572]);
        await page.waitForFunction(() => {
            const viewport = document.querySelector('.assistant-timeline');
            return viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
        });
        await fixture.getSession().command('screenshot', ['assistant-following-after-nested-scroll']);
    }, 60_000);

    it('projects live tool activity and restores its conversation after eviction and restart', async () => {
        let page = await openAssistantDocument();
        await page.keyboard.type('AP-B02 tool activity');
        await page.waitForSelector('.composer-send:not(:disabled)', {visible: true});
        await page.keyboard.press('Enter');
        // Read the live group so a restored earlier turn cannot satisfy this wait.
        await page.waitForFunction(() => {
            const rows = [...document.querySelectorAll('.work-group.is-running .work-entry')].map(row => row.textContent ?? '');
            return rows.some(row => row.includes('read_document')) && rows.some(row => row.includes('search_document'));
        });
        // The group row names the running action in words; raw tool names stay in the expanded rows.
        const summary = await page.$eval('.work-group.is-running summary', element => element.textContent ?? '');
        expect(summary).toContain('Searching the document');
        expect(summary).not.toContain('evb_');
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
