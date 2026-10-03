import type {Page} from 'puppeteer-core';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {waitForTabCount} from '@tests/e2e/electron/helpers/waitForTabCount';
import {
    activateMenuItemAsUser,
    clickAsUser,
    clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';

export async function createNewWorkspaceTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    await clickAsUser(session.page, '.tab-bar .tab-new');
    await waitForTabCount(session.page, nextCount);
}

export async function activateWorkspaceTab(session: IElectronE2ESession, tabIndex: number) {
    await clickFoundAsUser(session.page, (index: number) => (
        document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]')[index]
    ), tabIndex, {description: `workspace tab ${tabIndex}`});
}

const SPLIT_MENU_LABELS = {
    right: 'Split Right',
    down: 'Split Down',
} as const;

/** Split Right or Split Down from the active tab's context menu, with trusted clicks. */
export async function splitActiveTabFromTabMenu(page: Page, direction: 'right' | 'down', timeoutMs = 20_000) {
    const paneCount = await page.$$eval('.editor-pane', panes => panes.length);
    await clickAsUser(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', {button: 'right'});
    const label = SPLIT_MENU_LABELS[direction];
    await clickFoundAsUser(page, (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(candidate => candidate.textContent?.trim() === text && candidate.getBoundingClientRect().width > 0), label, {
        description: label,
        timeoutMs,
    });
    await page.waitForFunction((count: number) => document.querySelectorAll('.editor-pane').length === count + 1, {timeout: timeoutMs}, paneCount);
}

/** View > New Pane Right or Down: the explicit empty-pane split, through its menu item. */
export async function openNewPane(page: Page, direction: 'right' | 'down', timeoutMs = 20_000) {
    const paneCount = await page.$$eval('.editor-pane', panes => panes.length);
    await activateMenuItemAsUser(page, {id: `new-pane-${direction}`});
    await page.waitForFunction((count: number) => document.querySelectorAll('.editor-pane').length === count + 1, {timeout: timeoutMs}, paneCount);
}

/** Activates a pane by clicking its active tab, as a person does. */
export async function activatePaneByTab(page: Page, paneId: string, timeoutMs = 20_000) {
    await clickAsUser(page, `.editor-pane[data-editor-pane-id="${paneId}"] .tab.is-active[data-tab-id]`, {timeoutMs});
    await page.waitForFunction((id: string) => (
        document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId === id
    ), {timeout: timeoutMs}, paneId);
}
