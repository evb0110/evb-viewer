import {
    describe,
    expect,
    it,
} from 'vitest';
import { createVisibleWindowElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';

interface IVisibleWindowState {
    availHeight: number;
    availWidth: number;
    outerHeight: number;
    outerWidth: number;
    visibilityState: DocumentVisibilityState;
}

function readVisibleWindowState(): IVisibleWindowState {
    return {
        availHeight: window.screen.availHeight,
        availWidth: window.screen.availWidth,
        outerHeight: window.outerHeight,
        outerWidth: window.outerWidth,
        visibilityState: document.visibilityState,
    };
}

describe('Electron E2E - Visible Window Lifecycle', () => {
    const sessionFixture = createVisibleWindowElectronE2ESessionFixture({
        sessionName: () => `e2e-visible-window-${Date.now()}`,
        timeoutMs: 90_000,
    });

    it('shows and maximizes the real application window after renderer readiness', async () => {
        const session = sessionFixture.getSession();

        await expect.poll(
            () => session.page.evaluate(readVisibleWindowState),
            {timeout: 20_000},
        ).toSatisfy((state: IVisibleWindowState) => state.visibilityState === 'visible'
            && state.availWidth > 0
            && state.availHeight > 0
            && state.outerWidth >= Math.floor(state.availWidth * 0.9)
            && state.outerHeight >= Math.floor(state.availHeight * 0.85));
    });
});
