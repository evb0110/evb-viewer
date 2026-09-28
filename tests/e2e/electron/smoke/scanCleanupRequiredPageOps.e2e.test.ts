import {
    existsSync,
    statSync,
} from 'node:fs';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createLargeScannedFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
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

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-required-page-ops-${Date.now()}`});

async function openCleanup(session: ReturnType<typeof sessionFixture.getSession>) {
    const toasts = await session.page.$$('button[aria-label="Dismiss"]');
    for (const toast of toasts) {
        if (await toast.isVisible()) {
            const rect = await toast.boundingBox();
            if (rect) await session.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        }
    }
    const buttons = await session.page.$$('button[aria-label="Scan cleanup"]');
    const candidates = await Promise.all(buttons.map(async element => ({
        element,
        visible: await element.isVisible(),
        rect: await element.boundingBox(),
    })));
    const target = candidates.find(candidate => candidate.visible && candidate.rect
        && candidate.rect.width > 8 && candidate.rect.height > 8);
    expect(target, 'visible Scan cleanup toolbar button').toBeTruthy();
    const hit = await session.page.evaluate((rect) => {
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const element = document.elementFromPoint(x, y);
        return {
            label: element?.closest('button')?.getAttribute('aria-label') ?? null,
            html: element?.outerHTML ?? null,
            viewport: [
                innerWidth,
                innerHeight,
            ],
        };
    }, target!.rect!);
    console.log('scan-cleanup-open-hit', JSON.stringify({
        rect: target!.rect,
        hit,
    }));
    expect(hit.label).toBe('Scan cleanup');
    await session.page.mouse.click(
        target!.rect!.x + target!.rect!.width / 2,
        target!.rect!.y + target!.rect!.height / 2,
    );
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
                    const rect = await button.boundingBox();
                    if (rect) await session.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
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
        await radio!.evaluate(element => element.scrollIntoView({block: 'center'}));
        const radioRect = await radio!.boundingBox();
        expect(radioRect, `${mode} option rect`).toBeTruthy();
        const radioHit = await session.page.evaluate((rect) => {
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return {
                label: hit?.closest('[role="radio"]')?.getAttribute('aria-label') ?? null,
                html: hit?.outerHTML ?? null,
            };
        }, radioRect!);
        console.log(`scan-cleanup-output-hit-${mode}`, JSON.stringify({
            rect: radioRect,
            ...radioHit,
        }));
        await session.page.mouse.click(
            radioRect!.x + radioRect!.width / 2,
            radioRect!.y + radioRect!.height / 2,
        );
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
                await checkbox!.evaluate(element => element.scrollIntoView({block: 'center'}));
                const rect = await checkbox!.boundingBox();
                expect(rect).toBeTruthy();
                const hit = await session.page.evaluate((point) => {
                    const element = document.elementFromPoint(point.x, point.y);
                    return element?.closest('[role="checkbox"]')?.getAttribute('aria-label') ?? null;
                }, {
                    x: rect!.x + rect!.width / 2,
                    y: rect!.y + rect!.height / 2,
                });
                expect(hit, `${label} hit target`).toBe(label);
                await session.page.mouse.click(
                    rect!.x + rect!.width / 2,
                    rect!.y + rect!.height / 2,
                );
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
        await session.page.mouse.click(
            actionRect!.x + actionRect!.width / 2,
            actionRect!.y + actionRect!.height / 2,
        );

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
