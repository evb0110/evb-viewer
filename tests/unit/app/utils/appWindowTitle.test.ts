import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    formatWebTitleTemplate,
    resolveAppWindowTitle,
} from '@app/utils/appWindowTitle';

describe('resolveAppWindowTitle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('names the app, not its website, in the Chrome extension', () => {
        vi.stubGlobal('location', new URL('chrome-extension://abcdefghijklmnopabcdefghijklmnop/index.html#/'));

        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: 'notes.pdf',
            isBrowserRuntime: true,
        })).toBe('notes.pdf - EVB Viewer');
    });

    it('falls back to the desktop app title when no document is open', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: null,
            isBrowserRuntime: false,
        })).toBe('EVB Viewer');
    });

    it('uses the active document name for desktop windows', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: ' notes.pdf ',
            isBrowserRuntime: false,
        })).toBe('notes.pdf');
    });

    it('falls back to the web app title when no document is open in the browser', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: null,
            isBrowserRuntime: true,
        })).toBe('EVB Viewer Web');
    });

    it('includes the active document name in browser window titles', () => {
        expect(resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: 'notes.pdf',
            isBrowserRuntime: true,
        })).toBe('notes.pdf - EVB Viewer Web');
    });

    it('caps an overly long document name in the desktop window title', () => {
        const result = resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: `${'a'.repeat(120)}.pdf`,
            isBrowserRuntime: false,
        });

        expect(result.length).toBe(60);
        expect(result.endsWith('…')).toBe(true);
    });

    it('never cuts a character in half when it caps a document name', () => {
        const result = resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: `${'a'.repeat(58)}😀.pdf`,
            isBrowserRuntime: false,
        });

        expect(result).toBe(`${'a'.repeat(58)}…`);
        expect(result.isWellFormed()).toBe(true);
    });

    it('caps the document name before composing the browser window title', () => {
        const result = resolveAppWindowTitle({
            appTitle: 'EVB Viewer',
            webTitle: 'EVB Viewer Web',
            fileName: `${'a'.repeat(120)}.pdf`,
            isBrowserRuntime: true,
        });

        expect(result.endsWith('… - EVB Viewer Web')).toBe(true);
    });
});

describe('formatWebTitleTemplate', () => {
    it('avoids duplicating the app name when the page title already matches it', () => {
        expect(formatWebTitleTemplate('EVB Viewer Web', 'EVB Viewer Web')).toBe('EVB Viewer Web');
    });

    it('appends the app name for distinct page titles', () => {
        expect(formatWebTitleTemplate('Download', 'EVB Viewer Web')).toBe('Download — EVB Viewer Web');
    });
});
