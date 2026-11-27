import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {waitForFunctionInPage} from '@tests/e2e/electron/helpers/pageRuntime';
import {clickVisibleToolbarButton, goToPageViaToolbar, waitForToolbarCurrentPage} from '@tests/e2e/electron/helpers/viewerCore';

export interface IDocumentThumbnailParitySnapshot {
    activeTab: string;
    currentPage: number | null;
    currentVisible: boolean;
    frame: {
        background: string;
        border: string;
        borderRadius: string;
        boxShadow: string;
    };
    item: {
        border: string;
        borderRadius: string;
        gap: string;
        padding: string;
    };
    label: {
        color: string;
        fontSize: string;
        lineHeight: string;
    };
    observedCurrentPages: Array<number | null>;
    rail: {
        background: string;
        gutter: string;
        padding: string;
    };
}

interface IDocumentThumbnailParityProbe {
    active: boolean;
    currentPages: Array<number | null>;
}

interface IDocumentThumbnailParityWindow extends Window {
    __documentThumbnailParityProbe?: IDocumentThumbnailParityProbe;
}

async function ensureDocumentSidebarClosed(session: IElectronE2ESession) {
    const visible = await session.page.evaluate(() => {
        const sidebar = document.querySelector<HTMLElement>('.editor-pane.is-active [data-testid="document-sidebar"]');
        const rect = sidebar?.getBoundingClientRect();
        return Boolean(rect && rect.width > 10 && rect.height > 10);
    });
    if (!visible) {
        return;
    }
    await clickVisibleToolbarButton(session.page, 'Toggle Sidebar');
    await waitForFunctionInPage(
        session.page,
        () => {
            const sidebar = document.querySelector<HTMLElement>('.editor-pane.is-active [data-testid="document-sidebar"]');
            const rect = sidebar?.getBoundingClientRect();
            return !rect || rect.width <= 10 || rect.height <= 10;
        },
        {timeout: 10_000},
    );
}

export async function captureDocumentThumbnailParitySnapshot(
    session: IElectronE2ESession,
    currentPage: number,
): Promise<IDocumentThumbnailParitySnapshot> {
    await ensureDocumentSidebarClosed(session);
    await goToPageViaToolbar(session.page, currentPage);
    await waitForToolbarCurrentPage(session.page, currentPage);
    await session.page.evaluate(() => {
        const probe = {
            active: true,
            currentPages: [] as Array<number | null>,
        };
        const sample = () => {
            if (!probe.active) {
                return;
            }
            const rail = document.querySelector<HTMLElement>('.editor-pane.is-active [data-document-thumbnail-rail]');
            const rect = rail?.getBoundingClientRect();
            if (rail && rect && rect.width > 10 && rect.height > 100) {
                const current = rail.querySelector<HTMLElement>('[aria-current="page"]');
                const value = current?.dataset.page ?? current?.dataset.thumbnailPage ?? '';
                probe.currentPages.push(Number.parseInt(value, 10) || null);
            }
            window.requestAnimationFrame(sample);
        };
        (window as IDocumentThumbnailParityWindow).__documentThumbnailParityProbe = probe;
        window.requestAnimationFrame(sample);
    });

    await clickVisibleToolbarButton(session.page, 'Toggle Sidebar');
    await waitForFunctionInPage(
        session.page,
        (targetPage: number) => {
            const rail = document.querySelector<HTMLElement>('.editor-pane.is-active [data-document-thumbnail-rail]');
            const current = rail?.querySelector<HTMLElement>('[aria-current="page"]');
            const value = current?.dataset.page ?? current?.dataset.thumbnailPage ?? '';
            if (!rail || Number.parseInt(value, 10) !== targetPage) {
                return false;
            }
            const railRect = rail.getBoundingClientRect();
            const currentRect = current!.getBoundingClientRect();
            return currentRect.bottom > railRect.top && currentRect.top < railRect.bottom;
        },
        {timeout: 20_000},
        currentPage,
    );
    await session.page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
    });

    return session.page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('.editor-pane.is-active [data-document-thumbnail-rail]');
        const current = rail?.querySelector<HTMLElement>('[aria-current="page"]') ?? null;
        const frame = current?.querySelector<HTMLElement>('[data-document-thumbnail-frame]') ?? null;
        const label = current?.querySelector<HTMLElement>('[data-document-thumbnail-label]') ?? null;
        const activeTab = document.querySelector<HTMLElement>(
            '.editor-pane.is-active [data-testid="document-sidebar"] [role="tab"][aria-selected="true"]',
        );
        if (!rail || !current || !frame || !label) {
            throw new Error('Shared thumbnail parity surface is incomplete');
        }
        const railRect = rail.getBoundingClientRect();
        const currentRect = current.getBoundingClientRect();
        const railStyle = getComputedStyle(rail);
        const itemStyle = getComputedStyle(current);
        const frameStyle = getComputedStyle(frame);
        const labelStyle = getComputedStyle(label);
        const probe = (window as IDocumentThumbnailParityWindow).__documentThumbnailParityProbe;
        if (probe) {
            probe.active = false;
        }
        const value = current.dataset.page ?? current.dataset.thumbnailPage ?? '';
        return {
            activeTab: activeTab?.textContent?.trim() ?? '',
            currentPage: Number.parseInt(value, 10) || null,
            currentVisible: currentRect.bottom > railRect.top && currentRect.top < railRect.bottom,
            frame: {
                background: frameStyle.backgroundColor,
                border: frameStyle.border,
                borderRadius: frameStyle.borderRadius,
                boxShadow: frameStyle.boxShadow,
            },
            item: {
                border: itemStyle.border,
                borderRadius: itemStyle.borderRadius,
                gap: itemStyle.gap,
                padding: itemStyle.padding,
            },
            label: {
                color: labelStyle.color,
                fontSize: labelStyle.fontSize,
                lineHeight: labelStyle.lineHeight,
            },
            observedCurrentPages: probe?.currentPages ?? [],
            rail: {
                background: railStyle.backgroundColor,
                gutter: railStyle.scrollbarGutter,
                padding: railStyle.padding,
            },
        };
    });
}
