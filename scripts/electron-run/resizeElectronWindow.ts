import type { Page } from 'puppeteer-core';
import type {
    IHostCapability,
    IHostWindowState,
} from '@contracts/hostPlatformFeature';
import { delay } from 'es-toolkit/promise';

// Viewport emulation changes the numbers the renderer reports and leaves the
// native window alone, so it cannot reproduce a layout defect that only a real
// window resize causes. This resize goes through the window's own resize API,
// which Electron routes to the native window in the main process, so the
// window manager, the frame, and the renderer all move together. It works for
// a hidden window because nothing here needs the window on screen.
// A fullscreen or maximized window keeps the size the window manager gives it,
// so the window first leaves those states through its main process.

export interface IElectronWindowSize {
    width: number;
    height: number;
}

interface IElectronWindowMetrics {
    /** Size of the content area: what the document layout actually gets. */
    contentSize: IElectronWindowSize;
    /** Size of the whole window, content area plus the native frame. */
    windowSize: IElectronWindowSize;
    devicePixelRatio: number;
}

export interface IResizeElectronWindowResult {
    requestedContentSize: IElectronWindowSize;
    /** Native state after the window was asked to leave fullscreen and maximized. */
    windowState: IHostWindowState;
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
 * whole window, so it adds the frame the window has at that moment. A session
 * is ready only after its window paints, so that frame already includes a
 * Linux menu bar.
 */
export async function resizeElectronWindowContentArea(
    page: Page,
    contentSize: IElectronWindowSize,
    settleTimeoutMs: number,
): Promise<IResizeElectronWindowResult> {
    const hasContentSize = (metrics: IElectronWindowMetrics) => (
        metrics.contentSize.width === contentSize.width && metrics.contentSize.height === contentSize.height
    );

    const windowState = await page.evaluate(() => (
        (window as Window & {electronAPI: {host: IHostCapability;};}).electronAPI.host.restoreNormalWindow()
    ));
    if (!windowState.supported || windowState.fullScreen || windowState.maximized) {
        throw new Error(
            'The window did not leave its native placement before the resize '
            + `(supported=${String(windowState.supported)}, fullScreen=${String(windowState.fullScreen)}, `
            + `maximized=${String(windowState.maximized)}), so the window manager would keep overriding its size.`,
        );
    }

    const before = await readElectronWindowMetrics(page);
    await page.evaluate((requested: IElectronWindowSize) => {
        window.resizeTo(requested.width, requested.height);
    }, {
        width: contentSize.width + before.windowSize.width - before.contentSize.width,
        height: contentSize.height + before.windowSize.height - before.contentSize.height,
    });

    const deadline = Date.now() + settleTimeoutMs;
    let after = await readElectronWindowMetrics(page);
    while (Date.now() < deadline && !hasContentSize(after)) {
        await delay(SETTLE_POLL_INTERVAL_MS);
        after = await readElectronWindowMetrics(page);
    }

    return {
        requestedContentSize: contentSize,
        windowState,
        before,
        after,
        settled: hasContentSize(after),
    };
}
