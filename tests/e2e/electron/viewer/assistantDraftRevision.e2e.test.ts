import {
    copyFileSync, mkdirSync, rmSync,
} from 'node:fs';
import {
    join, resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterAll, describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    openDocumentSidebarTab,
    openPdfInApp,
    saveViaVisibleToolbar,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {readWorkspaceStateValues} from '@tests/e2e/electron/helpers/workspaceExpose';
import {readPdfCatalogWithPdfjs} from '@tests/e2e/electron/helpers/fixtures';
import type {IWorkspaceAutomationStateSnapshot} from '@app/types/workspaceExpose';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';

// AS-03: a new committed byte revision cancels old actions, not composed work.
describe('Electron E2E - assistant draft revision', () => {
    const fixture = createElectronE2ESessionFixture({
        sessionName: () => `e2e-assistant-draft-revision-${Date.now()}`,
        timeoutMs: 60_000,
        extraEnv: {CODEX_CLI_PATH: resolve(`tests/fixtures/electron/codex-model-picker.${process.platform === 'win32' ? 'cmd' : 'mjs'}`)},
    });

    let fixtureDirectory = '';
    afterAll(() => {
        if (fixtureDirectory) {
            rmSync(fixtureDirectory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps composed text and a pasted image after numbering and saving the same PDF', async () => {
        const session = fixture.getSession();
        const {page} = session;
        const directory = join(tmpdir(), session.name);
        fixtureDirectory = directory;
        mkdirSync(directory, {recursive: true});
        const pdfPath = join(directory, 'assistant-draft.pdf');
        copyFileSync(resolve('tests/fixtures/release/packaged-core-smoke.pdf'), pdfPath);
        await page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({assistantPanelEnabled: true});
        });
        await page.reload();
        await openPdfInApp(page, pdfPath);
        await waitForPdfLoaded(page);
        const before = await readWorkspaceStateValues<Pick<IWorkspaceAutomationStateSnapshot, 'documentIdentity'>>(page, ['documentIdentity']);
        await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        await page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        await clickAsUser(page, '.agent-assistant-input');
        await page.keyboard.type('Keep this composed prompt and image after Save.');
        // Seed the OS clipboard, then paste through trusted keyboard input.
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 48;
            canvas.height = 32;
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#d32f2f';
            context.fillRect(0, 0, 24, 32);
            context.fillStyle = '#1976d2';
            context.fillRect(24, 0, 24, 32);
            const png = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), 'image/png'));
            await navigator.clipboard.write([new ClipboardItem({'image/png': png})]);
        });
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await page.keyboard.press('V');
        await page.keyboard.up(modifier);
        await page.waitForFunction(() => (document.querySelector('.agent-assistant-composer-attachment-image') as HTMLImageElement | null)?.naturalWidth === 48);
        const imageBefore = await page.$eval('.agent-assistant-composer-attachment-image', image => (image as HTMLImageElement).src);
        await session.command('screenshot', ['as03-composed']);

        await openDocumentSidebarTab(page, 'Pages');
        const disclosure = '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-disclosure';
        if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, disclosure);
        }
        await clickAsUser(page, '#page-label-prefix-input');
        await page.keyboard.type('AS03-');
        await clickAsUser(page, '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-primary-button');
        expect(await page.$eval('.agent-assistant-input', input => (input as HTMLTextAreaElement).value)).toBe('Keep this composed prompt and image after Save.');
        await saveViaVisibleToolbar(page, 30_000, pdfPath);
        const after = await readWorkspaceStateValues<Pick<IWorkspaceAutomationStateSnapshot, 'documentIdentity'>>(page, ['documentIdentity']);
        expect(before.documentIdentity).toBeTruthy();
        expect(after.documentIdentity).toBeTruthy();
        expect(after.documentIdentity?.token).not.toBe(before.documentIdentity?.token);
        expect(after.documentIdentity?.documentRef).toBe(before.documentIdentity?.documentRef);
        expect((await readPdfCatalogWithPdfjs(pdfPath)).pageLabels?.[0]).toBe('AS03-1');
        await page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        await session.command('screenshot', ['as03-saved']);
        const composed = await page.evaluate(() => ({
            text: document.querySelector<HTMLTextAreaElement>('.agent-assistant-input')?.value,
            images: [...document.querySelectorAll<HTMLImageElement>('.agent-assistant-composer-attachment-image')].map(image => ({
                src: image.src,
                width: image.naturalWidth,
            })),
        }));
        expect(composed).toEqual({
            text: 'Keep this composed prompt and image after Save.',
            images: [{
                src: imageBefore,
                width: 48,
            }],
        });
    }, 60_000);
});
