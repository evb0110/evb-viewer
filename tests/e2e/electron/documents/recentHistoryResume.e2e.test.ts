import {basename} from 'node:path';
import {rmSync} from 'node:fs';
import {
    describe,
    expect,
    it,
    onTestFinished,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createMultiPageTextFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    openPdfInApp,
    setTabMemoryPolicyForE2E,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

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
