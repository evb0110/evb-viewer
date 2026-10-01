import {
    copyFileSync,
    existsSync,
    mkdtempSync,
    statSync,
} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join, resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {readPdfPageSnapshots} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-copied-spread-${Date.now()}`});

async function clickVisible(session: ReturnType<typeof sessionFixture.getSession>, selector: string) {
    const candidates = await session.page.$$(selector);
    for (const element of candidates) {
        if (!await element.isVisible()) continue;
        await element.evaluate(node => node.scrollIntoView({block: 'center'}));
        const rect = await element.boundingBox();
        if (!rect || rect.width < 2 || rect.height < 2) continue;
        await session.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return;
    }
    throw new Error(`No visible target for ${selector}`);
}

async function clickText(
    session: ReturnType<typeof sessionFixture.getSession>,
    selector: string,
    text: string,
) {
    for (const element of await session.page.$$(selector)) {
        if (!await element.isVisible()) continue;
        if (await element.evaluate((node, expected) => node.textContent?.trim() === expected, text)) {
            await element.evaluate(node => node.scrollIntoView({block: 'center'}));
            const rect = await element.boundingBox();
            expect(rect).toBeTruthy();
            await session.page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
            return;
        }
    }
    throw new Error(`No visible ${selector} with text ${text}`);
}

describe('scan cleanup copied spread evidence', () => {
    it('completes a spread copied to every page with current detection evidence', async () => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourceDirectory = mkdtempSync(join(tmpdir(), 'evb-e2e-cleanup-spread-'));
        onTestFinished(() => rm(sourceDirectory, {
            recursive: true,
            force: true,
        }));
        const sourcePath = join(sourceDirectory, 'e2e-document-ops-cleanup-two.pdf');
        copyFileSync(resolve(process.cwd(), 'tests/fixtures/electron/document-ops-cleanup-two.pdf'), sourcePath);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);

        for (const toast of await session.page.$$('button[aria-label="Dismiss"]')) {
            if (await toast.isVisible()) await toast.click();
        }
        await clickVisible(session, 'button[aria-label="Scan cleanup"]');
        await session.page.waitForSelector('.scan-cleanup-surface', {
            visible: true,
            timeout: 20_000,
        });
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
        ), {timeout: 120_000});

        await clickVisible(session, '[role="radio"][aria-label="This page (p. 1)"]');
        await clickVisible(session, '[role="combobox"][aria-label="Page layout"]');
        await clickText(session, '[role="option"]', 'Two-page spread');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
        ), {timeout: 120_000});
        await clickVisible(session, '[role="combobox"][aria-label="Output mode"]');
        await waitForFunctionInPage(session.page, () => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
                .some(element => element.innerText.trim() === 'Black-and-white text with color pictures')
        ), {timeout: 5_000});
        await clickText(session, '[role="option"]', 'Black-and-white text with color pictures');
        await waitForFunctionInPage(session.page, () => !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i
            .test(document.body.innerText), {timeout: 120_000});

        await clickVisible(session, 'button[aria-label="Edit picture and fill zones"]');
        await clickText(session, '.zone-editor-controls [role="radio"]', 'Picture');
        const zone = await session.page.$('.zone-editor-polygons');
        expect(zone).toBeTruthy();
        const zoneRect = await zone!.boundingBox();
        expect(zoneRect).toBeTruthy();
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.25, zoneRect!.y + zoneRect!.height * 0.75);
        await session.page.mouse.down();
        await session.page.mouse.move(zoneRect!.x + zoneRect!.width * 0.5, zoneRect!.y + zoneRect!.height * 0.7, {steps: 12});
        await session.page.mouse.up();
        await waitForFunctionInPage(session.page, () => (
            document.querySelectorAll('.zone-editor-polygon:not(.is-draft)').length > 0
        ), {timeout: 10_000});

        await clickVisible(session, 'button[aria-label="Edit picture and fill zones"]');
        await clickText(session, 'button', 'Copy this page\'s settings to…');
        await waitForFunctionInPage(session.page, () => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
                .some(element => element.innerText.trim() === 'All pages')
        ), {timeout: 5_000});
        await clickText(session, '[role="menuitem"]', 'All pages');
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText)
        ), {timeout: 120_000});

        await clickVisible(session, '[role="radio"][aria-label="All 2 pages"]');
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                && document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') === 'completed'
                && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText);
        }, {timeout: 120_000});
        const action = await session.page.$('.scan-cleanup-toolbar-primary-action');
        const actionRect = await action!.boundingBox();
        expect(actionRect).toBeTruthy();
        const actionState = await action!.evaluate((element, rect) => ({
            disabled: element instanceof HTMLButtonElement && element.disabled,
            ariaDisabled: element.getAttribute('aria-disabled'),
            rect,
            hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.textContent,
            detectionStatus: document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status'),
            previewRunning: /Building cleanup preview|Preview updating|Updating preview|Reading page images/i.test(document.body.innerText),
        }), actionRect!);
        console.log('scan-cleanup-copied-spread-run', JSON.stringify(actionState));
        expect(actionState.disabled).toBe(false);
        expect(actionState.ariaDisabled).not.toBe('true');
        expect(actionState.detectionStatus).toBe('completed');
        expect(actionState.previewRunning).toBe(false);
        await session.page.mouse.click(actionRect!.x + actionRect!.width / 2, actionRect!.y + actionRect!.height / 2);

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return (typeof active?.originalPath === 'string'
                    && active.originalPath !== source
                    && active.originalPath.endsWith('— cleaned.pdf'))
                || document.body.innerText.includes('layout-mismatch');
        }, {timeout: 180_000}, sourcePath);
        expect(await session.page.evaluate(() => document.body.innerText)).not.toContain('layout-mismatch');
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string' ? outputState.originalPath : null;
        expect(outputPath).toBeTruthy();
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect((await readPdfPageSnapshots(outputPath!)).length).toBeGreaterThan(0);
    }, 240_000);
});
