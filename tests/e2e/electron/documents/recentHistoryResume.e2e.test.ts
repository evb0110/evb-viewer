import {basename} from 'node:path';
import {rmSync} from 'node:fs';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    createMultiPageTextFixturePdf,
    readPdfPageSnapshots,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';
import {
    getToolbarCurrentPage,
    goToPageViaToolbar,
    openDocumentSidebarTab,
    openPdfInApp,
    setTabMemoryPolicyForE2E,
    waitForPdfLoaded,
    waitForViewerInteractive,
    waitForToolbarCurrentPage,
} from '@tests/e2e/electron/helpers/viewerCore';

import {
    readViewportPageObservation,
    waitForViewportQuiet,
} from '@tests/e2e/electron/helpers/viewportPageObservation';

type THistoryMutation = 'clear' | 'remove';

interface IResumeSurface {
    renderedPages: number;
    text: string;
    activeTabLabel: string;
}

const sessionFixture = createElectronE2ESessionFixture({
    restartBeforeEach: true,
    sessionName: () => 'e2e-recent-history-resume-' + Date.now(),
});

async function clickAtSelectorCentre(
    page: Awaited<ReturnType<typeof sessionFixture.getSession>>['page'],
    selector: string,
) {
    const point = await page.$eval(selector, (element) => {
        const rect = element.getBoundingClientRect();
        return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        };
    });
    await page.mouse.click(point.x, point.y);
}

async function createWorkspaceTabWithPointer(session: ReturnType<typeof sessionFixture.getSession>) {
    const beforeCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length);
    await clickAtSelectorCentre(session.page, '.tab-bar .tab-new');
    await session.page.waitForFunction((count: number) => (
        document.querySelectorAll('.tab-list .tab[data-tab-id]').length === count + 1
    ), {timeout: 10_000}, beforeCount);
    return session.page.$eval('.tab-list .tab.is-active[data-tab-id]', element => (
        (element as HTMLElement).dataset.tabId ?? ''
    ));
}

async function waitForRecentRow(page: ReturnType<typeof sessionFixture.getSession>['page'], sourcePath: string) {
    await page.waitForFunction((path: string) => (
        Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data:not(.recent-row--skeleton)'))
            .some(row => row.dataset.recentSource === path)
    ), {timeout: 15_000}, sourcePath);
}

async function waitForColdRetainedTab(
    page: ReturnType<typeof sessionFixture.getSession>['page'],
    sourceTabId: string,
    emptyTabId: string,
) {
    await page.waitForFunction((sourceId: string, emptyId: string) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        const sourceTab = tabs.find(tab => tab.dataset.tabId === sourceId);
        const activeTab = tabs.find(tab => tab.classList.contains('is-active'));
        return Boolean(
            sourceTab
            && activeTab?.dataset.tabId === emptyId
            && document.querySelectorAll('.page_container--rendered').length === 0,
        );
    }, {timeout: 20_000}, sourceTabId, emptyTabId);
}

async function mutateRecentHistory(
    page: ReturnType<typeof sessionFixture.getSession>['page'],
    mutation: THistoryMutation,
    sourcePath: string,
) {
    if (mutation === 'clear') {
        await clickAtSelectorCentre(page, '.editor-pane.is-active .recent-clear');
        await page.waitForSelector('[role="dialog"]', {
            visible: true,
            timeout: 5_000,
        });
        const confirmPoint = await page.evaluate(() => {
            const button = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'))
                .find(candidate => candidate.textContent?.trim() === 'Clear History');
            const rect = button?.getBoundingClientRect();
            return rect && rect.width > 0 && rect.height > 0
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        });
        expect(confirmPoint, 'Clear History confirmation is visible').not.toBeNull();
        await page.mouse.click(confirmPoint!.x, confirmPoint!.y);
        await page.waitForSelector('[role="dialog"]', {
            hidden: true,
            timeout: 5_000,
        });
    } else {
        const removePoint = await page.evaluate((path: string) => {
            const row = Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data[data-recent-source]'))
                .find(candidate => candidate.dataset.recentSource === path);
            const button = row?.querySelector<HTMLElement>('.recent-action--remove');
            const rect = button?.getBoundingClientRect();
            return rect && rect.width > 0 && rect.height > 0
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null;
        }, sourcePath);
        expect(removePoint, 'Remove from Recent button is visible for the target row').not.toBeNull();
        await page.mouse.click(removePoint!.x, removePoint!.y);
    }

    await page.waitForFunction((path: string) => (
        !Array.from(document.querySelectorAll<HTMLElement>('.recent-row--data[data-recent-source]'))
            .some(row => row.dataset.recentSource === path)
    ), {timeout: 15_000}, sourcePath);
}

async function activateTabWithPointer(
    page: ReturnType<typeof sessionFixture.getSession>['page'],
    tabId: string,
) {
    const point = await page.evaluate((targetId: string) => {
        const tab = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'))
            .find(candidate => candidate.dataset.tabId === targetId);
        const rect = tab?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    }, tabId);
    expect(point, `Retained tab ${tabId} is visible`).not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await page.waitForFunction((targetId: string) => (
        document.querySelector<HTMLElement>('.tab-list .tab.is-active[data-tab-id]')?.dataset.tabId === targetId
    ), {timeout: 5_000}, tabId);
}

async function readResumeSurface(page: ReturnType<typeof sessionFixture.getSession>['page']) {
    return page.evaluate((): IResumeSurface => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const activeTab = document.querySelector<HTMLElement>('.tab-list .tab.is-active[data-tab-id]');
        return {
            renderedPages: host?.querySelectorAll('.page_container--rendered').length ?? 0,
            text: host?.querySelector('.textLayer, .text-layer')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            activeTabLabel: activeTab?.getAttribute('aria-label') ?? activeTab?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
    });
}

async function runResumeAfterHistoryMutation(mutation: THistoryMutation) {
    const session = sessionFixture.getSession();
    const fixturePath = await createMultiPageTextFixturePdf(
        `recent-${mutation}-resume-${Date.now()}.pdf`,
        12,
    );
    onTestFinished(() => rmSync(fixturePath, {force: true}));

    await setTabMemoryPolicyForE2E(session.page, 'aggressive');
    await openPdfInApp(session.page, fixturePath);
    await waitForPdfLoaded(session.page);
    await waitForViewerInteractive(session.page);
    const sourceTabId = await session.page.$eval('.tab-list .tab.is-active[data-tab-id]', element => (
        (element as HTMLElement).dataset.tabId ?? ''
    ));
    expect(sourceTabId).not.toBe('');
    const initialSurface = await readResumeSurface(session.page);
    expect(initialSurface.renderedPages).toBeGreaterThan(0);
    expect(initialSurface.text).toContain('E2E Multi Page Fixture 1/12');

    const emptyTabId = await createWorkspaceTabWithPointer(session);
    await waitForRecentRow(session.page, fixturePath);
    await waitForColdRetainedTab(session.page, sourceTabId, emptyTabId);
    await mutateRecentHistory(session.page, mutation, fixturePath);
    await activateTabWithPointer(session.page, sourceTabId);

    const resumed = await session.page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>(
            '.editor-pane.is-active .workspace-host[data-workspace-active="true"]',
        ) ?? document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const text = host?.querySelector('.textLayer, .text-layer')?.textContent ?? '';
        const page = host?.querySelector<HTMLElement>('.page_container--rendered');
        const rect = page?.getBoundingClientRect();
        return Boolean(
            page
            && rect && rect.width > 100 && rect.height > 100
            && text.includes('E2E Multi Page Fixture 1/12'),
        );
    }, {timeout: 10_000}).then(() => true).catch(() => false);
    const finalSurface = await readResumeSurface(session.page);
    return {
        mutation,
        rendered: resumed,
        ...finalSurface,
        expectedTabLabel: basename(fixturePath),
    };
}

describe('recent history and retained PDF tabs', () => {
    it('preserves the reading page after Save changes and close', async () => {
        const session = sessionFixture.getSession();
        const path = await createMultiPageTextFixturePdf(`recent-dirty-save-close-${Date.now()}.pdf`, 40);
        onTestFinished(() => rmSync(path, {force: true}));
        await openPdfInApp(session.page, path);
        await waitForPdfLoaded(session.page);
        await waitForViewerInteractive(session.page);
        await openDocumentSidebarTab(session.page, 'Pages');
        await clickAsUser(session.page, '.editor-pane.is-active [data-thumbnail-page="1"]', {button: 'right'});
        await clickFoundAsUser(session.page, () => Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
        ).find(item => item.textContent?.toLowerCase().includes('rotate counterclockwise') && item.checkVisibility()),
        null, {description: 'rotate page 1 counterclockwise'});
        await session.page.waitForSelector('.tab.is-active.is-dirty', {visible: true});
        await waitForPdfLoaded(session.page);
        await goToPageViaToolbar(session.page, 27);
        await waitForToolbarCurrentPage(session.page, 27);
        await waitForViewerInteractive(session.page);
        await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
        await clickFoundAsUser(session.page, () => Array.from(
            document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
        ).find(button => button.textContent?.trim() === 'Save changes'),
        null, {description: 'save changes and close'});
        await session.page.waitForSelector('.recent-row--data .recent-open', {visible: true});
        expect((await readPdfPageSnapshots(path))[0]?.rotation).toBe(270);
        await clickAsUser(session.page, '.recent-row--data .recent-open');
        await waitForPdfLoaded(session.page);
        await waitForViewerInteractive(session.page);
        const observation = {
            currentPage: await getToolbarCurrentPage(session.page),
            renderedPage27: await session.page.$eval('.workspace-host[data-workspace-active="true"]', host => (
                Array.from(host.querySelectorAll('.page_container--rendered')).some(page => (
                    page.getAttribute('data-page') === '27' && page.textContent?.includes('27/40')
                ))
            )),
        };
        expect(observation).toEqual({
            currentPage: 27,
            renderedPage27: true,
        });
    }, 180_000);

    it('preserves the other tab reading position through clean close and Save-and-close', async () => {
        const session = sessionFixture.getSession();
        const activate = async (path: string) => {
            await clickFoundAsUser(session.page, (name: string) => Array.from(
                document.querySelectorAll<HTMLElement>('.tab[data-tab-id]'),
            ).find(tab => tab.textContent?.includes(name)), basename(path), {description: basename(path)});
            await waitForPdfLoaded(session.page);
            await waitForViewerInteractive(session.page);
        };
        for (const dirty of [
            false,
            true,
        ]) {
            const a = await createMultiPageTextFixturePdf(`other-close-a-${dirty}-${Date.now()}.pdf`, 40);
            const b = await createMultiPageTextFixturePdf(`other-close-b-${dirty}-${Date.now()}.pdf`, 40);
            onTestFinished(() => {
                rmSync(a, {force: true});
                rmSync(b, {force: true});
            });
            await openPdfInApp(session.page, a);
            await waitForPdfLoaded(session.page);
            await openPdfInApp(session.page, b);
            await waitForPdfLoaded(session.page);
            await goToPageViaToolbar(session.page, 31);
            await waitForToolbarCurrentPage(session.page, 31);
            await waitForViewportQuiet(session.page);
            await activate(a);
            if (dirty) {
                await openDocumentSidebarTab(session.page, 'Pages');
                await clickAsUser(session.page, '.editor-pane.is-active [data-thumbnail-page="1"]', {button: 'right'});
                await clickFoundAsUser(session.page, () => Array.from(
                    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
                ).find(item => item.textContent?.toLowerCase().includes('rotate counterclockwise') && item.checkVisibility()),
                null, {description: 'rotate page 1 counterclockwise'});
                await session.page.waitForSelector('.tab.is-active.is-dirty', {visible: true});
                await waitForPdfLoaded(session.page);
            }
            await goToPageViaToolbar(session.page, 27);
            await waitForToolbarCurrentPage(session.page, 27);
            await waitForViewportQuiet(session.page);
            await activate(b);
            await waitForToolbarCurrentPage(session.page, 31);
            await waitForViewportQuiet(session.page);
            const before = await readViewportPageObservation(session.page);
            await activate(a);
            await waitForToolbarCurrentPage(session.page, 27);
            await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
            if (dirty) {
                await clickFoundAsUser(session.page, () => Array.from(
                    document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
                ).find(button => button.textContent?.trim() === 'Save changes'),
                null, {description: 'save changes and close'});
            }
            await expect.poll(() => session.page.$$eval('.tab[data-tab-id]', tabs => tabs.map(tab => tab.textContent)))
                .toEqual([basename(b)]);
            await waitForPdfLoaded(session.page);
            await waitForViewerInteractive(session.page);
            await waitForViewportQuiet(session.page);
            const observation = {
                currentPage: await getToolbarCurrentPage(session.page),
                renderedPage31: await session.page.$eval('.workspace-host[data-workspace-active="true"]', host => (
                    Array.from(host.querySelectorAll('.page_container--rendered')).some(page => (
                        page.getAttribute('data-page') === '31' && page.textContent?.includes('31/40')
                    ))
                )),
                rotation: (await readPdfPageSnapshots(a))[0]?.rotation,
            };
            const after = await readViewportPageObservation(session.page);
            console.log('OTHER_TAB_CLOSE', JSON.stringify({
                dirty,
                ...observation,
                before,
                after,
            }));
            expect.soft(observation).toEqual({
                currentPage: 31,
                renderedPage31: true,
                rotation: dirty ? 270 : 0,
            });
            expect.soft(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
            await clickAsUser(session.page, '.editor-pane.is-active .tab.is-active .tab-close');
            await session.page.waitForSelector('.recent-row--data .recent-open', {visible: true});
        }
    }, 240_000);

    it('keeps an Aggressive cold tab resumable after Clear History', async () => {
        const result = await runResumeAfterHistoryMutation('clear');
        expect(result.rendered, JSON.stringify(result)).toBe(true);
        expect(result.renderedPages).toBeGreaterThan(0);
        expect(result.text).toContain('E2E Multi Page Fixture 1/12');
        expect(result.activeTabLabel).toContain(result.expectedTabLabel);
    }, 120_000);

    it('keeps an Aggressive cold tab resumable after removing its Recent row', async () => {
        const result = await runResumeAfterHistoryMutation('remove');
        expect(result.rendered, JSON.stringify(result)).toBe(true);
        expect(result.renderedPages).toBeGreaterThan(0);
        expect(result.text).toContain('E2E Multi Page Fixture 1/12');
        expect(result.activeTabLabel).toContain(result.expectedTabLabel);
    }, 120_000);
});
