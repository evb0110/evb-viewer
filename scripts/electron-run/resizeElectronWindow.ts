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
 * waits until the renderer reports that size. The native frame is measured
 * first, because the resize request names the whole window.
 */
export async function resizeElectronWindowContentArea(
    page: Page,
    contentSize: IElectronWindowSize,
    settleTimeoutMs: number,
): Promise<IResizeElectronWindowResult> {
    const before = await readElectronWindowMetrics(page);
    await page.evaluate((requested: IElectronWindowSize) => {
        const frameWidth = window.outerWidth - window.innerWidth;
        const frameHeight = window.outerHeight - window.innerHeight;
        window.resizeTo(requested.width + frameWidth, requested.height + frameHeight);
    }, contentSize);

    const deadline = Date.now() + settleTimeoutMs;
    let after = await readElectronWindowMetrics(page);
    while (
        Date.now() < deadline
        && (after.contentSize.width !== contentSize.width || after.contentSize.height !== contentSize.height)
    ) {
        await delay(SETTLE_POLL_INTERVAL_MS);
        after = await readElectronWindowMetrics(page);
    }

    return {
        requestedContentSize: contentSize,
        before,
        after,
        settled: after.contentSize.width === contentSize.width
            && after.contentSize.height === contentSize.height,
    };
}
