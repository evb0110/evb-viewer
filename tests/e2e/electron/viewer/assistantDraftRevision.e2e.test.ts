import {createHash} from 'node:crypto';
import {electronUserDataPath} from '@scripts/electron-run/electronRunSessionPaths';
import {
    copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import {
    join, resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import {
    afterAll, describe, expect, it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    activateMenuItemAsUser,
    clickAsUser,
} from '@tests/e2e/electron/helpers/userInput';
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
        // Seed the OS clipboard, then use the installed menu's Paste action.
        // CDP keyboard events do not reach the macOS application menu.
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
        await activateMenuItemAsUser(page, {accelerator: 'CmdOrCtrl+V'});
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

    // A10-4: the assistant's own save commits a revision its turn must keep.
    it('lets an assistant turn read its document after the turn saves it', async () => {
        const session = fixture.getSession();
        const {page} = session;
        const directory = join(tmpdir(), session.name);
        fixtureDirectory = directory;
        mkdirSync(directory, {recursive: true});
        const pdfPath = join(directory, 'assistant-own-save.pdf');
        copyFileSync(resolve('tests/fixtures/release/packaged-core-smoke.pdf'), pdfPath);
        await page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({assistantPanelEnabled: true});
        });
        await page.reload();
        await openPdfInApp(page, pdfPath);
        await waitForPdfLoaded(page);
        await openDocumentSidebarTab(page, 'Pages');
        const disclosure = '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-disclosure';
        if (await page.$eval(disclosure, button => button.getAttribute('aria-expanded')) !== 'true') {
            await clickAsUser(page, disclosure);
        }
        await clickAsUser(page, '#page-label-prefix-input');
        await page.keyboard.type('A104-');
        await clickAsUser(page, '.workspace-host[data-workspace-active="true"] .pdf-sidebar-pages-primary-button');
        if (await page.$('.agent-assistant-input') === null) {
            await clickAsUser(page, 'button[aria-label="Toggle EVB Assistant"]');
        }
        await page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        await clickAsUser(page, '.agent-assistant-input');
        await page.keyboard.type('A10-4 own save');
        await page.keyboard.press('Enter');

        const reply = '.agent-assistant-message.is-assistant:last-child';
        await page.waitForFunction(selector => document.querySelector(selector)?.textContent?.includes('save:'), {}, reply);
        await session.command('screenshot', ['a10-4-own-save']);
        expect(await page.$eval(reply, element => element.textContent?.trim())).toContain('save:ok read:ok');
        expect((await readPdfCatalogWithPdfjs(pdfPath)).pageLabels?.[0]).toBe('A104-1');
    });

    // ADR 0004: schema-1 conversation history and provider continuation survive upgrades.
    it('shows the deterministically adopted legacy conversation after opening the panel and relaunching', async () => {
        let session = fixture.getSession();
        const directory = join(tmpdir(), session.name);
        fixtureDirectory = directory;
        mkdirSync(directory, {recursive: true});
        const pdfPath = join(directory, 'legacy-chat.pdf');
        copyFileSync(resolve('tests/fixtures/release/packaged-core-smoke.pdf'), pdfPath);
        const root = join(electronUserDataPath(session.name), 'assistant-chat');
        const sessions = join(root, 'sessions');
        mkdirSync(sessions, {recursive: true});
        const canonicalScopeKey = `document:electron:${pdfPath}`;
        const canonicalKey = `codex:${canonicalScopeKey}`;
        const fileName = (key: string) => `v2-${createHash('sha256').update(key).digest('hex')}.jsonl`;
        const seed = (scopeKey: string, text: string | null, lastAccessedAtMs: number) => {
            const key = `codex:${scopeKey}`;
            const bytes = `${JSON.stringify({
                schemaVersion: 1,
                type: 'session-snapshot',
                key,
                writtenAt: '2026-01-01T00:00:00.000Z',
                session: {
                    provider: 'codex',
                    scope: {
                        kind: 'document',
                        key: scopeKey,
                        title: 'legacy-chat.pdf',
                        tabId: 'old-tab',
                        documentRef: pdfPath,
                        documentBackend: 'electron',
                        documentSessionKey: 'old-opening',
                    },
                    model: 'gpt-5',
                    effort: 'medium',
                    speedMode: 'standard',
                    providerThreadId: text ? `thread-${text}` : null,
                    turnOwner: {
                        phase: 'idle',
                        generation: 0,
                        turnId: null,
                        localTurnId: null,
                    },
                    messages: text ? [{
                        id: scopeKey,
                        role: 'user',
                        text,
                        createdAt: '2026-01-01T00:00:00.000Z',
                    }] : [],
                    lastAccessedAtMs,
                },
            })}\n`;
            writeFileSync(join(sessions, fileName(key)), bytes);
            return bytes;
        };
        const originals = [
            seed('document-session:b', 'Other saved conversation', 20),
            seed(canonicalScopeKey, null, 99),
            seed('document-session:a', 'Saved before the file-key upgrade', 20),
        ];
        await session.page.evaluate(async () => {
            await (window as IE2EWindow).electronAPI?.settings.save({assistantPanelEnabled: true});
        });
        session = await fixture.restart({clean: false});
        const openChat = async () => {
            await openPdfInApp(session.page, pdfPath);
            await waitForPdfLoaded(session.page);
            if (!await session.page.$('.agent-assistant-input')) {
                await clickAsUser(session.page, 'button[aria-label="Toggle EVB Assistant"]');
            }
            await session.page.waitForSelector('.agent-assistant-input:not(:disabled)', {visible: true});
        };
        await openChat();
        await expect.poll(() => session.page.$$eval('.agent-assistant-message.is-user .agent-assistant-message-bubble',
            bubbles => bubbles.map(bubble => bubble.textContent?.trim()))).toEqual(['Saved before the file-key upgrade']);
        await session.command('screenshot', ['a35-legacy-chat-recovered']);
        const canonicalPath = join(sessions, fileName(canonicalKey));
        const readCanonicalSnapshot = () => readFileSync(canonicalPath, 'utf8').trim().split('\n')
            .map(line => JSON.parse(line) as {
                type: string;
                session?: {providerThreadId: string}
            })
            .findLast(record => record.type === 'session-snapshot');
        expect(readCanonicalSnapshot()?.session?.providerThreadId).toBe('thread-Saved before the file-key upgrade');
        const backups = readdirSync(join(root, 'archive')).map(name => readFileSync(join(root, 'archive', name), 'utf8'));
        for (const bytes of originals) expect(backups).toContain(bytes);
        await clickAsUser(session.page, '.agent-assistant-input');
        await session.page.keyboard.type('Continue this saved conversation.');
        await session.page.keyboard.press('Enter');
        await expect.poll(() => session.page.$$eval('.agent-assistant-message.is-assistant .agent-assistant-message-bubble',
            bubbles => bubbles.map(bubble => bubble.textContent?.trim()))).toContain('Image received.');
        session = await fixture.restart({clean: false});
        await openChat();
        await expect.poll(() => session.page.$$eval('.agent-assistant-message.is-user .agent-assistant-message-bubble',
            bubbles => bubbles.map(bubble => bubble.textContent?.trim()))).toEqual([
            'Saved before the file-key upgrade',
            'Continue this saved conversation.',
        ]);
        expect(readCanonicalSnapshot()?.session?.providerThreadId).toBe('thread-Saved before the file-key upgrade');
        await session.command('screenshot', ['a35-legacy-chat-relaunched']);
    });

});
