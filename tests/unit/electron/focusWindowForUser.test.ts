import {describe, expect, it, vi} from 'vitest';
import {focusWindowForUser} from '@electron/window/focusWindowForUser';

function createHarness(
    options: {
        destroyed?: boolean;
        minimized?: boolean;
        visible?: boolean;
    } = {},
) {
    const calls: string[] = [];
    const application = {focus: vi.fn(() => calls.push('application.focus'))};
    const window = {
        focus: vi.fn(() => calls.push('window.focus')),
        isDestroyed: vi.fn(() => options.destroyed ?? false),
        isMinimized: vi.fn(() => options.minimized ?? false),
        isVisible: vi.fn(() => options.visible ?? true),
        restore: vi.fn(() => calls.push('window.restore')),
        show: vi.fn(() => calls.push('window.show')),
        webContents: {focus: vi.fn(() => calls.push('window.webContents.focus'))},
    };

    return {
        application,
        calls,
        window,
    };
}

describe('focusWindowForUser', () => {
    it('does nothing when automation forbids focus', () => {
        const harness = createHarness({
            minimized: true,
            visible: false,
        });

        focusWindowForUser(harness.window, {
            application: harness.application,
            noFocus: true,
            platform: 'darwin',
        });

        expect(harness.calls).toEqual([]);
        expect(harness.window.isDestroyed).not.toHaveBeenCalled();
    });

    it('does not operate on a destroyed window', () => {
        const harness = createHarness({destroyed: true});

        focusWindowForUser(harness.window, {
            application: harness.application,
            noFocus: false,
            platform: 'darwin',
        });

        expect(harness.calls).toEqual([]);
    });

    it('restores and shows a window before activating it on macOS', () => {
        const harness = createHarness({
            minimized: true,
            visible: false,
        });

        focusWindowForUser(harness.window, {
            application: harness.application,
            noFocus: false,
            platform: 'darwin',
        });

        expect(harness.calls).toEqual(['window.restore', 'window.show', 'application.focus', 'window.focus', 'window.webContents.focus']);
        expect(harness.application.focus).toHaveBeenCalledWith({steal: true});
    });

    it('focuses an ordinary visible window without mutating its geometry', () => {
        const harness = createHarness({visible: true});

        focusWindowForUser(harness.window, {
            application: harness.application,
            noFocus: false,
            platform: 'darwin',
        });

        expect(harness.calls).toEqual(['application.focus', 'window.focus', 'window.webContents.focus']);
        expect(harness.window.restore).not.toHaveBeenCalled();
        expect(harness.window.show).not.toHaveBeenCalled();
    });

    it('does not request application activation outside macOS', () => {
        const harness = createHarness({visible: true});

        focusWindowForUser(harness.window, {
            application: harness.application,
            noFocus: false,
            platform: 'linux',
        });

        expect(harness.calls).toEqual(['window.focus', 'window.webContents.focus']);
        expect(harness.application.focus).not.toHaveBeenCalled();
    });
});
