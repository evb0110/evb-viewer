import type { Page } from 'puppeteer-core';
import {
    resizeElectronWindowContentArea,
    type IElectronWindowSize,
} from '@scripts/electron-run/resizeElectronWindow';

// What the renderer of every hidden E2E session believes about its window,
// identical on every host. Without this owner the same test ran in a focused
// 900x672 window at scale 1 under Linux Xvfb and in an unfocused 900x668
// window at scale 2 on a Retina Mac, where focus and blur events never fire
// and `:focus` never matches. A person always works in a focused window.
//
// Focus is emulated by the session controller, which owns it for every hidden
// session, agent reproductions included; this owner only checks it.
//
// The content area is the one the product's 900x700 default window gets
// under the required Linux CI frame, so the required lanes keep their
// geometry. The scale is pinned at launch (EVB_AUTOMATION_DEVICE_SCALE_FACTOR);
// a session that needs real high-DPI rendering starts with a native scale
// instead of emulating one.

export const E2E_CONTENT_SIZE: IElectronWindowSize = {
    width: 900,
    height: 672,
};

const RESIZE_SETTLE_TIMEOUT_MS = 10_000;

interface IUserEnvironmentReport {
    hasFocus: boolean;
    visibilityState: DocumentVisibilityState;
    devicePixelRatio: number;
    contentSize: IElectronWindowSize;
}

function readUserEnvironment(page: Page) {
    return page.evaluate(() => ({
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
        devicePixelRatio: window.devicePixelRatio,
        contentSize: {
            width: window.innerWidth,
            height: window.innerHeight,
        },
    })) as Promise<IUserEnvironmentReport>;
}

export function formatUserEnvironment(report: IUserEnvironmentReport) {
    return `focus=${String(report.hasFocus)} visibility=${report.visibilityState} `
        + `scale=${report.devicePixelRatio} content=${report.contentSize.width}x${report.contentSize.height}`;
}

/**
 * Puts the renderer in the canonical state and fails when it cannot get
 * there. It also undoes what a previous test may have left behind: viewport
 * emulation survives a renderer reload, and a real resize stays until undone.
 */
export async function establishUserEnvironment(page: Page, deviceScaleFactor: number) {
    await page.setViewport(null);
    const resize = await resizeElectronWindowContentArea(page, E2E_CONTENT_SIZE, RESIZE_SETTLE_TIMEOUT_MS);
    const report = await readUserEnvironment(page);
    const problems = [
        ...(resize.settled ? [] : ['the window did not reach the canonical content size']),
        ...(report.hasFocus ? [] : ['the document has no focus']),
        ...(report.visibilityState === 'visible' ? [] : ['the document is not visible']),
        ...(report.devicePixelRatio === deviceScaleFactor ? [] : [`the scale is not ${deviceScaleFactor}`]),
    ];
    if (problems.length > 0) {
        throw new Error(`The E2E renderer is not in the state a person's window is in: ${problems.join('; ')} (${formatUserEnvironment(report)})`);
    }
    return report;
}
