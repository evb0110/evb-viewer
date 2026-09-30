import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';

const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-scan-cleanup-badge-targets-${Date.now()}`});

interface IScanCleanupBadgeState {
    thickness: string | null;
    badges: Array<{
        text: string;
        badgeRect: {
            x: number;
            y: number;
            width: number;
            height: number
        };
        buttonLabel: string;
        buttonRect: {
            x: number;
            y: number;
            width: number;
            height: number
        };
        hitLabel: string | null;
        hitIsOwnButton: boolean;
    }>;
}

describe('scan cleanup badge targets', () => {
    it('keeps each remove button on its own badge at 1280×900 and 900×700', async () => {
        const session = sessionFixture.getSession();
        const sourcePath = await createLargeScannedFixturePdf('scan-cleanup-badge-targets.pdf', 1, 0);
        await openPdfInApp(session.page, sourcePath, 90_000);
        await waitForPdfLoaded(session.page, 90_000);
        await waitForViewerInteractive(session.page, 90_000);

        const clickVisible = async (selector: string) => {
            await waitForFunctionInPage(session.page, (targetSelector: string) => (
                Array.from(document.querySelectorAll<HTMLElement>(targetSelector)).some((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.width > 1
                        && rect.height > 1
                        && element.checkVisibility()
                        && !(element as HTMLButtonElement).disabled
                        && element.getAttribute('aria-disabled') !== 'true';
                })
            ), {timeout: 20_000}, selector);
            const elements = await session.page.$$(selector);
            const target = (await Promise.all(elements.map(async element => ({
                element,
                rect: await element.boundingBox(),
                visible: await element.isVisible(),
            })))).find(candidate => candidate.visible && candidate.rect && candidate.rect.width > 1 && candidate.rect.height > 1);
            expect(target, `visible target ${selector}`).toBeTruthy();
            await target!.element.evaluate(element => element.scrollIntoView({block: 'center'}));
            const rect = await target!.element.boundingBox();
            expect(rect).toBeTruthy();
            await session.page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
        };
        const clickLabel = async (text: string) => {
            const labels = await session.page.$$('label');
            const target = (await Promise.all(labels.map(async element => ({
                element,
                text: await element.evaluate(node => node.textContent?.trim() ?? ''),
                visible: await element.isVisible(),
            })))).find(candidate => candidate.text === text && candidate.visible);
            expect(target, `label ${text}`).toBeTruthy();
            await target!.element.evaluate(element => element.scrollIntoView({block: 'center'}));
            const rect = await target!.element.boundingBox();
            expect(rect).toBeTruthy();
            await session.page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
        };
        const setThicknessToOne = async () => {
            const selector = '.editor-pane.is-active [role="slider"][aria-label="Text thickness"]';
            await clickVisible(selector);
            await session.page.keyboard.press('ArrowRight');
            await waitForFunctionInPage(session.page, (value: string) => (
                document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [role="slider"][aria-label="Text thickness"]',
                )?.getAttribute('aria-valuenow') === value
            ), {timeout: 5_000}, '1');
        };
        const readBadges = async (): Promise<IScanCleanupBadgeState> => session.page.evaluate(() => {
            const badges = Array.from(document.querySelectorAll<HTMLElement>(
                '#editor-global-toolbar-host .scan-cleanup-settings-badge',
            ));
            return {
                thickness: document.querySelector<HTMLElement>(
                    '.editor-pane.is-active [role="slider"][aria-label="Text thickness"]',
                )?.getAttribute('aria-valuenow') ?? null,
                badges: badges.map((badge) => {
                    const button = badge.querySelector<HTMLButtonElement>('button')!;
                    button.scrollIntoView({
                        block: 'nearest',
                        inline: 'nearest',
                    });
                    const badgeRect = badge.getBoundingClientRect();
                    const buttonRect = button.getBoundingClientRect();
                    const x = buttonRect.x + buttonRect.width / 2;
                    const y = buttonRect.y + buttonRect.height / 2;
                    const hit = document.elementFromPoint(x, y);
                    return {
                        text: badge.innerText.trim(),
                        badgeRect: {
                            x: badgeRect.x,
                            y: badgeRect.y,
                            width: badgeRect.width,
                            height: badgeRect.height,
                        },
                        buttonLabel: button.getAttribute('aria-label') ?? '',
                        buttonRect: {
                            x: buttonRect.x,
                            y: buttonRect.y,
                            width: buttonRect.width,
                            height: buttonRect.height,
                        },
                        hitLabel: hit?.closest('button')?.getAttribute('aria-label') ?? null,
                        hitIsOwnButton: hit === button || button.contains(hit),
                    };
                }),
            };
        });
        const dismissGuide = async () => {
            const guideButton = await session.page.$$('button');
            for (const button of guideButton) {
                if (await button.isVisible() && await button.evaluate(element => element.innerText.trim() === 'Got it')) {
                    const rect = await button.boundingBox();
                    if (rect) await session.page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
                    return;
                }
            }
        };
        const openCleanup = async () => {
            await clickVisible('button[aria-label="Scan cleanup"]');
            await session.page.waitForSelector('.scan-cleanup-surface', {timeout: 20_000});
            await waitForFunctionInPage(session.page, () => (
                document.querySelector('.scan-cleanup-surface')?.getAttribute('data-detection-status') !== 'pending'
                && document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-primary-action')?.disabled === false
            ), {timeout: 120_000});
            await dismissGuide();
        };
        const configureBadges = async () => {
            await clickVisible('[role="radio"][aria-label="Black and white"]');
            await setThicknessToOne();
            await clickLabel('Crop each output page to its content');
            await waitForFunctionInPage(session.page, () => (
                !/preview updating|building cleanup preview|reading page images/i.test(document.body.innerText)
                && !Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label*="Show progress details"]'))
                    .some(button => button.getBoundingClientRect().width > 1)
            ), {timeout: 120_000});
            try {
                await waitForFunctionInPage(session.page, () => (
                    document.querySelectorAll('#editor-global-toolbar-host .scan-cleanup-settings-badge').length === 3
                ), {timeout: 10_000});
            } catch (error) {
                const state = await session.page.evaluate(() => ({
                    badges: Array.from(document.querySelectorAll('#editor-global-toolbar-host .scan-cleanup-settings-badge'))
                        .map(badge => badge.textContent?.trim()),
                    cleanupText: document.querySelector<HTMLElement>('.scan-cleanup-surface')?.innerText,
                }));
                throw new Error(`Expected three configured badges; observed ${JSON.stringify(state)}`, {cause: error});
            }
        };
        const clickRemoveThickness = async () => {
            const badge = await session.page.$('#editor-global-toolbar-host .scan-cleanup-settings-badge');
            const target = await session.page.$('#editor-global-toolbar-host .scan-cleanup-settings-badge button[aria-label^="Remove Text thickness:"]');
            expect(badge).toBeTruthy();
            expect(target).toBeTruthy();
            const rect = await target!.boundingBox();
            expect(rect).toBeTruthy();
            await target!.evaluate(element => element.scrollIntoView({
                block: 'nearest',
                inline: 'nearest',
            }));
            const visibleRect = await target!.boundingBox();
            expect(visibleRect).toBeTruthy();
            const hit = await session.page.evaluate((point) => {
                const element = document.elementFromPoint(point.x, point.y);
                return {
                    label: element?.closest('button')?.getAttribute('aria-label') ?? null,
                    rect: element?.getBoundingClientRect().toJSON() ?? null,
                    targetLabel: document.querySelector<HTMLButtonElement>(
                        '#editor-global-toolbar-host .scan-cleanup-settings-badge button[aria-label^="Remove Text thickness:"]',
                    )?.getAttribute('aria-label') ?? null,
                };
            }, {
                x: visibleRect!.x + visibleRect!.width / 2,
                y: visibleRect!.y + visibleRect!.height / 2,
            });
            console.log('badge-remove-hit', JSON.stringify(hit));
            await session.page.mouse.click(
                visibleRect!.x + visibleRect!.width / 2,
                visibleRect!.y + visibleRect!.height / 2,
            );
        };

        await session.command('windowResize', [
            1280,
            900,
        ]);
        await openCleanup();
        await configureBadges();
        await waitForFunctionInPage(session.page, () => (
            !/Building cleanup preview|Preview updating|Updating preview|Reading page images/i
                .test(document.body.innerText)
        ), {timeout: 120_000});
        const wideBefore = await readBadges();
        console.log('wide-badges-before', JSON.stringify(wideBefore));
        expect(wideBefore.badges).toHaveLength(3);
        expect(wideBefore.badges.every(badge => badge.buttonRect.width >= 24)).toBe(true);
        await clickRemoveThickness();
        await waitForFunctionInPage(session.page, () => (
            !Array.from(document.querySelectorAll('#editor-global-toolbar-host .scan-cleanup-settings-badge'))
                .some(badge => badge.textContent?.includes('Text thickness:'))
        ), {timeout: 5_000});
        const wideAfter = await readBadges();
        expect(wideBefore.badges.find(badge => badge.text.startsWith('Text thickness:'))?.hitIsOwnButton).toBe(true);
        expect(wideAfter.thickness).toBe('0');
        expect(wideAfter.badges).toHaveLength(2);
        expect(wideAfter.badges.map(badge => badge.text).join(' ')).toContain('Output: Black and white');

        await setThicknessToOne();
        await session.command('windowResize', [
            900,
            700,
        ]);
        await waitForFunctionInPage(session.page, () => innerWidth === 900 && innerHeight === 700, {timeout: 5_000});
        const narrowBefore = await readBadges();
        expect(narrowBefore.badges).toHaveLength(3);
        expect(narrowBefore.badges.every(badge => badge.buttonRect.width >= 24)).toBe(true);
        expect(narrowBefore.badges.every(badge => badge.hitIsOwnButton)).toBe(true);
        await clickRemoveThickness();
        await waitForFunctionInPage(session.page, () => (
            document.querySelector<HTMLElement>(
                '.editor-pane.is-active [role="slider"][aria-label="Text thickness"]',
            )?.getAttribute('aria-valuenow') === '0'
        ), {timeout: 5_000});
        const narrowAfter = await readBadges();
        expect(narrowAfter.badges).toHaveLength(2);
        expect(narrowAfter.badges.map(badge => badge.text).join(' ')).toContain('Output: Black and white');
    }, 180_000);
});
