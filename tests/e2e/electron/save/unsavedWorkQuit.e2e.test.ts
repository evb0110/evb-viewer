import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync, readFileSync, mkdtempSync, rmSync,
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
import {
    openPdfInApp, waitForPdfLoaded, waitForViewerInteractive, 
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    startHostVisibleElectronE2ESession, type IElectronE2ESession, 
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { createE2ERunScopedSessionName } from '@scripts/electron-run/electronRunRunId';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';

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
        outputDirectory = mkdtempSync(join(tmpdir(), 'evb-quit-unsaved-'));
        const sourcePath = join(outputDirectory, requiresSaveAs ? 'quit-generated-source.pdf' : 'quit-source.pdf');
        copyFileSync(
            resolve(process.cwd(), 'tests/fixtures/electron/test-scanned.pdf'),
            sourcePath,
        );
        const sessionName = createE2ERunScopedSessionName(`e2e-quit-unsaved-${Date.now()}`);
        session = await startHostVisibleElectronE2ESession(sessionName, {
            clean: true,
            initialOpenPaths: requiresSaveAs ? [] : [sourcePath],
        });

        let documentPath = sourcePath;
        if (requiresSaveAs) {
            documentPath = join(outputDirectory, `generated-${randomUUID()}.pdf`);
            copyFileSync(sourcePath, documentPath);
        }
        if (requiresSaveAs) await openPdfInApp(session.page, documentPath, 60_000);
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        const originalBytes = readFileSync(documentPath);
        const originalAnnotationSummary = await readPdfAnnotationSummary(documentPath);
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
        } else {
            const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
            await session.page.keyboard.down(modifier);
            try {
                await session.page.keyboard.press('q');
            } finally {
                await session.page.keyboard.up(modifier);
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
