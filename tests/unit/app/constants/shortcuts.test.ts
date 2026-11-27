import {afterEach, describe, expect, it, vi} from 'vitest';
import {getShortcutLabels, isMacPlatformHint} from '@app/constants/shortcuts';

describe('shortcuts', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('recognizes common macOS platform hints', () => {
        expect(isMacPlatformHint('MacIntel')).toBe(true);
        expect(isMacPlatformHint('"macOS"')).toBe(true);
        expect(isMacPlatformHint('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
        expect(isMacPlatformHint('Win32')).toBe(false);
    });

    it('formats modifier labels for explicit platforms', () => {
        expect(getShortcutLabels(true).openFile).toBe('\u2318O');
        expect(getShortcutLabels(false).openFile).toBe('Ctrl+O');
    });

    it('orders macOS shortcut modifiers like native menus', () => {
        expect(getShortcutLabels(true).saveAs).toBe('\u21E7\u2318S');
        expect(getShortcutLabels(false).saveAs).toBe('Ctrl+Shift+S');
    });

    it('detects macOS from client userAgentData platform hints', () => {
        vi.stubGlobal('navigator', {
            platform: '',
            userAgent: '',
            userAgentData: {platform: 'macOS'},
        });

        expect(getShortcutLabels().openFile).toBe('\u2318O');
    });
});
