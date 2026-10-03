import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    afterEach, describe, expect, it, 
} from 'vitest';
import { readPdfAnnotationSummary } from '@tests/e2e/electron/helpers/fixtures';
import { createCanonicalTextBoxWithPointer } from '@tests/e2e/electron/helpers/viewerAnnotations';
import { activateMenuItemAsUser } from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp, waitForPdfLoaded, waitForViewerInteractive, 
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    startElectronE2ESession, startHostVisibleElectronE2ESession, type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { createE2ERunScopedSessionName } from '@scripts/electron-run/electronRunRunId';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import { electronUserDataPath } from '@scripts/electron-run/electronRunSessionPaths';

describe('unsaved work on app Quit', () => {
    let session: IElectronE2ESession | null = null;
    let outputDirectory: string | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
        if (outputDirectory) rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
        outputDirectory = null;
    });

    it.each([
        {
            destination: 'a saved PDF',
            requiresSaveAs: false, 
        },
        {
            destination: 'a generated PDF requiring Save As',
            requiresSaveAs: true, 
        },
    ])('asks before quitting $destination and Cancel keeps the unsaved edit and source intact', async ({ requiresSaveAs }) => {
        const fixturePath = resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf');
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-quit-unsaved-'));
        const sourcePath = join(outputDirectory, 'quit-source.pdf');
        copyFileSync(fixturePath, sourcePath);
        const sessionName = createE2ERunScopedSessionName(`e2e-quit-unsaved-${Date.now()}`);
        // Linux reaches the real window through X11 input, so its Xvfb window
        // must be mapped. macOS runs the Quit menu item in a hidden session,
        // so the owner's desktop stays untouched.
        const startSession = process.platform === 'linux' ? startHostVisibleElectronE2ESession : startElectronE2ESession;
        session = await startSession(sessionName, {
            clean: true,
            initialOpenPaths: requiresSaveAs ? [] : [sourcePath],
        });

        let documentPath = sourcePath;
        if (requiresSaveAs) {
            // Scan cleanup output under the profile is what the app treats as
            // generated, so its first save needs a destination.
            const generatedDirectory = join(electronUserDataPath(session.name), 'scan-cleanup', 'output', randomUUID());
            mkdirSync(generatedDirectory, { recursive: true });
            documentPath = join(generatedDirectory, 'quit-generated.pdf');
            copyFileSync(fixturePath, documentPath);
            await openPdfInApp(session.page, documentPath, 60_000);
        }
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const originalBytes = readFileSync(documentPath);
        const originalAnnotationSummary = await readPdfAnnotationSummary(documentPath);
        const electronPid = getSessionInfo(session.name)?.electronPid;
        expect(electronPid).toEqual(expect.any(Number));
        if (process.platform === 'linux') {
            const windowId = execFileSync('xdotool', [
                'search',
                '--onlyvisible',
                '--pid',
                String(electronPid),
            ], { encoding: 'utf8' })
                .trim().split('\n')[0];
            expect(windowId).toMatch(/^\d+$/u);
            if (!windowId) throw new Error('The visible Electron window id was missing');
            execFileSync('xdotool', [
                'windowfocus',
                '--sync',
                windowId,
            ]);
        }
        const marker = `Quit unsaved ${Date.now()}`;
        await createCanonicalTextBoxWithPointer(session.page, marker, {
            x: 0.4,
            y: 0.3,
        });

        if (process.platform === 'linux') {
            execFileSync('xdotool', [
                'key',
                '--clearmodifiers',
                'ctrl+q',
            ]);
        } else if (process.platform === 'darwin') {
            // Renderer key events never reach the menu's Cmd-Q.
            await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+Q'});
        } else {
            await session.page.keyboard.down('Control');
            try {
                await session.page.keyboard.press('q');
            } finally {
                await session.page.keyboard.up('Control');
            }
        }
        const quitOutcome = await Promise.race([
            session.page.waitForFunction(() => Boolean(document.querySelector('[role="dialog"]')), { timeout: 15_000 })
                .then(() => 'prompt' as const, () => 'no-prompt' as const),
            new Promise<'closed'>(resolve => session!.page.once('close', () => resolve('closed'))),
        ]);
        expect.soft(quitOutcome).toBe('prompt');
        expect.soft(readFileSync(documentPath)).toEqual(originalBytes);
        if (quitOutcome !== 'prompt') return;
        const dialogText = await session.page.$eval('[role="dialog"]', element => element.textContent ?? '');
        expect(dialogText).toContain('Save changes');
        expect(dialogText).toContain('Discard changes');
        expect(dialogText).toContain('Cancel');

        const cancel = await session.page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                .find(candidate => candidate.textContent?.trim().includes('Cancel'));
            const bounds = button?.getBoundingClientRect();
            return bounds ? {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
            } : null;
        });
        expect(cancel).not.toBeNull();
        if (!cancel) throw new Error('Quit decision did not offer Cancel');
        await session.page.mouse.click(cancel.x, cancel.y);

        await session.page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        await session.page.waitForFunction((text: string) => Array.from(
            document.querySelectorAll<HTMLElement>('.editor-pane.is-active .pdf-annotation-editor-layer [data-annotation-kind="text-box"]'),
        ).some(entity => entity.textContent?.replace(/[\u200B\uFEFF]/gu, '').trim() === text), { timeout: 10_000 }, marker);
        expect(session.page.isClosed()).toBe(false);
        expect((await readPdfAnnotationSummary(documentPath)).total).toBe(originalAnnotationSummary.total);
        expect(readFileSync(documentPath)).toEqual(originalBytes);

        const windowClosed = new Promise<void>(resolve => session!.page.once('close', () => resolve()));
        await session.page.evaluate(() => window.electronAPI?.windowTabs.closeCurrentWindow());
        await session.page.waitForFunction(() => Boolean(document.querySelector('[role="dialog"]')));
        const discard = await session.page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
                .find(candidate => candidate.textContent?.trim().includes('Discard changes'));
            const bounds = button?.getBoundingClientRect();
            return bounds ? {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
            } : null;
        });
        expect(discard).not.toBeNull();
        if (!discard) throw new Error('Window close decision did not offer Discard changes');
        await session.page.mouse.click(discard.x, discard.y);
        await windowClosed;
    }, 150_000);
});

// Ctrl+W is File > Close Tab. Window > Close must not take it over: on Linux
// and Windows the window's accelerator table keeps the last menu item bound to
// a key, and on macOS Window > Close also has Cmd+W. Linux presses the key
// through X11 input to the session's own display; macOS runs the item the
// accelerator resolves to in a hidden session.
describe.runIf(process.platform === 'linux' || process.platform === 'darwin')('Close Tab shortcut', () => {
    let session: IElectronE2ESession | null = null;
    let outputDirectory: string | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
        if (outputDirectory) rmSync(outputDirectory, {
            recursive: true,
            force: true,
        });
        outputDirectory = null;
    });

    it('closes only the active tab and keeps the window', async () => {
        const fixturePath = resolve(process.cwd(), 'tests/fixtures/electron/generated-text.pdf');
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-close-tab-shortcut-'));
        const firstPath = join(outputDirectory, 'first-tab.pdf');
        const secondPath = join(outputDirectory, 'second-tab.pdf');
        copyFileSync(fixturePath, firstPath);
        copyFileSync(fixturePath, secondPath);
        const startSession = process.platform === 'linux' ? startHostVisibleElectronE2ESession : startElectronE2ESession;
        session = await startSession(createE2ERunScopedSessionName(`e2e-close-tab-shortcut-${Date.now()}`), {
            clean: true,
            initialOpenPaths: [
                firstPath,
                secondPath,
            ],
        });
        const readTabs = () => session!.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.map(tab => ({
            label: tab.querySelector('.tab-label')?.textContent?.trim() ?? '',
            active: tab.classList.contains('is-active'),
        })));
        await session.page.waitForFunction(() => Array.from(document.querySelectorAll('.tab-list .tab[data-tab-id] .tab-label'))
            .map(label => label.textContent?.trim()).join() === 'first-tab.pdf,second-tab.pdf', {timeout: 60_000});
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const before = await readTabs();
        const activeLabel = before.find(tab => tab.active)?.label;
        expect(activeLabel).toBeTruthy();

        const windowClosed = new Promise<'window closed'>(resolveClosed => session!.page.once('close', () => resolveClosed('window closed')));
        if (process.platform === 'linux') {
            const electronPid = getSessionInfo(session.name)?.electronPid;
            expect(electronPid).toEqual(expect.any(Number));
            const windowId = execFileSync('xdotool', [
                'search',
                '--onlyvisible',
                '--pid',
                String(electronPid),
            ], { encoding: 'utf8' })
                .trim().split('\n')[0];
            if (!windowId) throw new Error('The visible Electron window id was missing');
            execFileSync('xdotool', [
                'windowfocus',
                '--sync',
                windowId,
            ]);
            execFileSync('xdotool', [
                'key',
                '--clearmodifiers',
                'ctrl+w',
            ]);
        } else {
            await activateMenuItemAsUser(session.page, {accelerator: 'CmdOrCtrl+W'});
        }

        const outcome = await Promise.race([
            session.page.waitForFunction(() => document.querySelectorAll('.tab-list .tab[data-tab-id]').length === 1, {timeout: 15_000})
                // The wait fails as the renderer goes away, just before the page reports it closed.
                .then(() => 'one tab closed' as const, () => windowClosed),
            windowClosed,
        ]);
        expect(outcome).toBe('one tab closed');
        expect((await readTabs()).map(tab => tab.label)).toEqual(before.map(tab => tab.label).filter(label => label !== activeLabel));
    }, 150_000);
});
