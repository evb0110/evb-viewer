import {randomUUID} from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {sessionDir} from '@scripts/electron-run/electronRunSessionPaths';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {waitForRendererReady} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    createLargeScannedFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickAsUser} from '@tests/e2e/electron/helpers/userInput';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    type IWorkspaceExposeProbeWindow,
    readWorkspaceStateValues,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-required-page-ops-${Date.now()}`});

async function openCleanup(session: ReturnType<typeof sessionFixture.getSession>) {
    for (const toast of await session.page.$$('button[aria-label="Dismiss"]')) {
        if (await toast.isVisible()) await clickAsUser(session.page, toast);
    }
    await clickAsUser(session.page, 'button[aria-label="Scan cleanup"]');
    await session.page.waitForSelector('.scan-cleanup-surface', {
        timeout: 20_000,
        visible: true,
    });
}

describe('scan cleanup required page ops', () => {
    it.each([
        'Black and white',
        'Grayscale',
        'Color',
    ])('completes a %s run with preserve quality and match size unchecked', async (mode) => {
        const session = sessionFixture.getSession();
        await session.command('windowResize', [
            1280,
            900,
        ]);
        const sourcePath = await createLargeScannedFixturePdf(
            `scan-cleanup-page-ops-${mode.toLowerCase().replaceAll(' ', '-')}.pdf`,
            1,
            0,
        );
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);
        await openCleanup(session);
        await waitForFunctionInPage(session.page, () => (
            document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') !== 'pending'
                && document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action')?.disabled === false
        ), {timeout: 120_000});
        await waitForFunctionInPage(session.page, () => {
            const action = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action');
            if (!action || action.disabled) return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return (hit === action || action.contains(hit))
                    && !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                        .test(document.body.innerText);
        }, {timeout: 120_000});

        for (const label of [
            'The tools required for scan cleanup are unavailable on this system.',
            'Scan cleanup could not be completed',
        ]) {
            const toast = await session.page.$$('button');
            for (const button of toast) {
                if (await button.isVisible() && await button.evaluate((element, text) => (
                    element.innerText.includes(text)
                ), label)) {
                    await clickAsUser(session.page, button);
                }
            }
        }

        const radios = await session.page.$$('[role="radio"]');
        const radio = (await Promise.all(radios.map(async element => ({
            element,
            visible: await element.isVisible(),
            text: await element.evaluate(node => node.textContent?.trim() ?? ''),
            disabled: await element.evaluate(node => (node as HTMLButtonElement).disabled),
            label: await element.evaluate(node => node.getAttribute('aria-label')),
        })))).find(candidate => candidate.visible && !candidate.disabled
                && (candidate.text === mode || candidate.label === mode))?.element;
        expect(radio, `visible ${mode} option`).toBeTruthy();
        await clickAsUser(session.page, radio!);
        await waitForFunctionInPage(session.page, (label: string) => (
            Array.from(document.querySelectorAll<HTMLElement>('[role="radio"][aria-label]'))
                .some(element => element.getAttribute('aria-label') === label
                        && element.getAttribute('aria-checked') === 'true')
        ), {timeout: 5_000}, mode);

        for (const label of [
            'Preserve original quality (no rasterization)',
            'Match page size with other pages',
        ]) {
            const checkboxes = await session.page.$$(`[role="checkbox"][aria-label="${label}"]`);
            const checkbox = (await Promise.all(checkboxes.map(async element => ({
                element,
                visible: await element.isVisible(),
            })))).find(candidate => candidate.visible)?.element;
            expect(checkbox, `visible ${label} checkbox`).toBeTruthy();
            if (await checkbox!.evaluate(element => element.getAttribute('aria-checked') === 'true')) {
                await clickAsUser(session.page, checkbox!);
            }
        }

        const actionSelector = '.scan-cleanup-toolbar-primary-action';
        await waitForFunctionInPage(session.page, (selector: string) => {
            const action = document.querySelector<HTMLButtonElement>(selector);
            if (!action || action.disabled || action.getAttribute('aria-disabled') === 'true') return false;
            const rect = action.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            const previewRunning = /Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                .test(document.body.innerText);
            return (hit === action || action.contains(hit)) && !previewRunning;
        }, {timeout: 120_000}, actionSelector);
        const action = await session.page.$(actionSelector);
        const actionRect = await action!.boundingBox();
        expect(actionRect).toBeTruthy();
        const actionState = await action!.evaluate((element, rect) => {
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            return {
                disabled: element instanceof HTMLButtonElement && element.disabled,
                ariaDisabled: element.getAttribute('aria-disabled'),
                rect,
                hit: document.elementFromPoint(x, y)?.outerHTML,
                previewRunning: /Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                    .test(document.body.innerText),
            };
        }, actionRect!);
        console.log(`scan-cleanup-run-${mode}`, JSON.stringify(actionState));
        expect(actionState.disabled).toBe(false);
        expect(actionState.ariaDisabled).not.toBe('true');
        expect(actionState.previewRunning).toBe(false);
        await clickAsUser(session.page, action!);

        await waitForFunctionInPage(session.page, (source: string) => {
            const active = (window as IWorkspaceExposeProbeWindow)
                .__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath']);
            return (typeof active?.originalPath === 'string'
                    && active.originalPath !== source
                    && active.originalPath.endsWith('— cleaned.pdf'))
                    || document.body.innerText.includes('evb-pdf-page-ops');
        }, {timeout: 180_000}, sourcePath);
        expect(await session.page.evaluate(() => document.body.innerText))
            .not.toContain('evb-pdf-page-ops');
        const outputState = await readWorkspaceStateValues(session.page, ['originalPath']);
        const outputPath = typeof outputState.originalPath === 'string' ? outputState.originalPath : null;
        expect(outputPath).toBeTruthy();
        expect(existsSync(outputPath!)).toBe(true);
        expect(statSync(outputPath!).size).toBeGreaterThan(0);
        expect(await readPdfPageSnapshots(outputPath!)).toEqual([{
            pageNumber: 1,
            rotation: 0,
            textSnippet: '',
        }]);
    }, 240_000);
});

describe('scan cleanup completed output recovery', () => {
    it('opens a finished output that was never opened once the window reloads', async () => {
        const session = sessionFixture.getSession();
        const outputRoot = join(sessionDir(session.name), 'electron-user-data', 'scan-cleanup', 'output');
        const outputPath = join(outputRoot, randomUUID(), 'recovered — cleaned.pdf');
        mkdirSync(dirname(outputPath), {recursive: true});
        copyFileSync(await createLargeScannedFixturePdf('scan-cleanup-recovered.pdf', 1, 0), outputPath);
        writeFileSync(join(outputRoot, '.evb-scan-cleanup-completed-outputs.json'), JSON.stringify([{
            version: 1,
            outputPdfPath: outputPath,
            completedAtMs: Date.now(),
        }]));

        await session.page.reload({waitUntil: 'domcontentloaded'});
        await waitForRendererReady(session.page);
        await waitForFunctionInPage(session.page, (path: string) => (
            (window as IWorkspaceExposeProbeWindow).__evbTestApi
                ?.readActiveWorkspaceStateValues?.(['originalPath'])
                ?.originalPath === path
        ), {timeout: 60_000}, outputPath);
        await waitForPdfLoaded(session.page, 60_000);
        expect(await session.page.evaluate(() => [...document.querySelectorAll('[role="tab"]')]
            .filter(tab => tab.textContent?.includes('recovered — cleaned.pdf')).length)).toBe(1);
    }, 120_000);
});
