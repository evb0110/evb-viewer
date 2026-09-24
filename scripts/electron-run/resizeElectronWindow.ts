import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';

// Viewport emulation changes the numbers the renderer reports and leaves the
// native window alone, so it cannot reproduce a layout defect that only a real
// window resize causes. This resize goes through the window's own resize API,
// which Electron routes to the native window in the main process, so the
// window manager, the frame, and the renderer all move together. It works for
// a hidden window because nothing here needs the window on screen.

export interface IElectronWindowSize {
    width: number;
    height: number;
}

export interface IElectronWindowMetrics {
    /** Size of the content area: what the document layout actually gets. */
    contentSize: IElectronWindowSize;
    /** Size of the whole window, content area plus the native frame. */
    windowSize: IElectronWindowSize;
    devicePixelRatio: number;
}

export interface IResizeElectronWindowResult {
    requestedContentSize: IElectronWindowSize;
    before: IElectronWindowMetrics;
    after: IElectronWindowMetrics;
    settled: boolean;
}

const SETTLE_POLL_INTERVAL_MS = 50;

export function readElectronWindowMetrics(page: Page) {
    return page.evaluate(() => ({
        contentSize: {
            width: window.innerWidth,
            height: window.innerHeight,
        },
        windowSize: {
            width: window.outerWidth,
            height: window.outerHeight,
        },
        devicePixelRatio: window.devicePixelRatio,
    })) as Promise<IElectronWindowMetrics>;
}

/**
 * Resizes the real window so its content area becomes `contentSize`, then
 * waits until the renderer reports that size. The resize request names the
 * whole window, so it adds the frame the window has at that moment.
 */
export async function resizeElectronWindowContentArea(
    page: Page,
    contentSize: IElectronWindowSize,
    settleTimeoutMs: number,
): Promise<IResizeElectronWindowResult> {
    const requestContentSize = () => page.evaluate((requested: IElectronWindowSize) => {
        const frameWidth = window.outerWidth - window.innerWidth;
        const frameHeight = window.outerHeight - window.innerHeight;
        window.resizeTo(requested.width + frameWidth, requested.height + frameHeight);
    }, contentSize);
    const hasContentSize = (metrics: IElectronWindowMetrics) => (
        metrics.contentSize.width === contentSize.width && metrics.contentSize.height === contentSize.height
    );

    const before = await readElectronWindowMetrics(page);
    await requestContentSize();

    const deadline = Date.now() + settleTimeoutMs;
    let after = await readElectronWindowMetrics(page);
    while (Date.now() < deadline && !hasContentSize(after)) {
        await delay(SETTLE_POLL_INTERVAL_MS);
        const previous = after;
        after = await readElectronWindowMetrics(page);
        // A frame that changes after it was measured, as the Linux menu bar
        // and decorations can early in a session, leaves the content area
        // short by the difference. Once the window holds still at the wrong
        // size, ask again with the frame it has now.
        if (!hasContentSize(after) && JSON.stringify(after) === JSON.stringify(previous)) {
            await requestContentSize();
        }
    }

    return {
        requestedContentSize: contentSize,
        before,
        after,
        settled: hasContentSize(after),
    };
}
