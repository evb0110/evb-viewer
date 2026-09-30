import {expect} from 'vitest';
import type {Page} from 'puppeteer-core';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {waitForTabCount} from '@tests/e2e/electron/helpers/waitForTabCount';

export async function createNewWorkspaceTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    const clicked = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.tab-bar .tab-new');
        button?.click();
        return Boolean(button);
    });
    expect(clicked).toBe(true);
    await waitForTabCount(session.page, nextCount);
}

export async function activateWorkspaceTab(session: IElectronE2ESession, tabIndex: number) {
    await session.page.evaluate((index: number) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        tabs[index]?.click();
    }, tabIndex);
}

export async function splitActiveWorkspaceDocument(session: IElectronE2ESession, direction: 'right' | 'down') {
    const split = await session.page.evaluate(async (targetDirection: 'right' | 'down') => {
        const splitEditor = (window as IE2EWindow & {__splitEditorForE2E?: (direction: 'right' | 'down') => Promise<void> | void;}).__splitEditorForE2E;
        if (typeof splitEditor === 'function') {
            await splitEditor(targetDirection);
            return true;
        }
        return false;
    }, direction);
    expect(split).toBe(true);
    await session.page.waitForFunction(() => document.querySelectorAll('.editor-pane').length >= 2);
}

const SPLIT_MENU_LABELS = {
    right: 'Split Right',
    down: 'Split Down',
} as const;

async function clickPoint(page: Page, point: {
    x: number;
    y: number;
} | null, description: string, button: 'left' | 'right' = 'left') {
    if (!point) {
        throw new Error(`${description} has no visible box`);
    }
    await page.mouse.click(point.x, point.y, {button});
}

function readCenter(selector: string) {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0
        ? {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        }
        : null;
}

/** Split Right or Split Down from the active tab's context menu, with trusted clicks. */
export async function splitActiveTabFromTabMenu(page: Page, direction: 'right' | 'down', timeoutMs = 20_000) {
    const paneCount = await page.$$eval('.editor-pane', panes => panes.length);
    const tabSelector = '.editor-pane.is-active .tab.is-active[data-tab-id]';
    await clickPoint(page, await page.evaluate(readCenter, tabSelector), tabSelector, 'right');
    const label = SPLIT_MENU_LABELS[direction];
    const item = await page.waitForFunction((text: string) => {
        const menuItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
            .find(candidate => candidate.textContent?.trim() === text && candidate.getBoundingClientRect().width > 0);
        const rect = menuItem?.getBoundingClientRect();
        return rect
            ? {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            }
            : null;
    }, {timeout: timeoutMs}, label);
    const point = await item.jsonValue();
    await item.dispose();
    await clickPoint(page, point, label);
    await page.waitForFunction((count: number) => document.querySelectorAll('.editor-pane').length === count + 1, {timeout: timeoutMs}, paneCount);
}

/**
 * New Pane Right or Down: the explicit empty-pane split. The View menu command
 * is a native accelerator that page input cannot reach, so this is setup
 * through the command's automation hook.
 */
export async function openNewPane(page: Page, direction: 'right' | 'down', timeoutMs = 20_000) {
    const paneCount = await page.$$eval('.editor-pane', panes => panes.length);
    const opened = await page.evaluate(async (targetDirection: 'right' | 'down') => {
        const splitEmpty = (window as IE2EWindow & {__splitEditorEmptyForE2E?: (direction: 'right' | 'down') => Promise<void> | void;}).__splitEditorEmptyForE2E;
        if (typeof splitEmpty !== 'function') {
            return false;
        }
        await splitEmpty(targetDirection);
        return true;
    }, direction);
    expect(opened).toBe(true);
    await page.waitForFunction((count: number) => document.querySelectorAll('.editor-pane').length === count + 1, {timeout: timeoutMs}, paneCount);
}

/** Activates a pane by clicking its active tab, as a person does. */
export async function activatePaneByTab(page: Page, paneId: string, timeoutMs = 20_000) {
    const selector = `.editor-pane[data-editor-pane-id="${paneId}"] .tab.is-active[data-tab-id]`;
    await clickPoint(page, await page.evaluate(readCenter, selector), selector);
    await page.waitForFunction((id: string) => (
        document.querySelector<HTMLElement>('.editor-pane.is-active')?.dataset.editorPaneId === id
    ), {timeout: timeoutMs}, paneId);
}
