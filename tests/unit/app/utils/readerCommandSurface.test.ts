import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createReaderToolbarSurface,
    DESKTOP_EDITOR_READER_COMMAND_SURFACE,
    isReaderCommandInMenu,
    isReaderCommandInline,
} from '@app/utils/readerCommandSurface';

describe('readerCommandSurface', () => {
    it('keeps desktop editor tools inline while routing file-only actions through menus', () => {
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'open-file')).toBe(false);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'open-file')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'print-current-page')).toBe(false);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'print-current-page')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'capture-region')).toBe(true);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'crop')).toBe(true);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'capture-region')).toBe(true);
        expect(isReaderCommandInMenu(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'crop')).toBe(true);
    });

    it('offers OCR and scan cleanup only where the runtime can run them', () => {
        const browserSurface = createReaderToolbarSurface({
            ocr: true,
            scanCleanup: false,
        });
        expect(isReaderCommandInline(browserSurface, 'ocr')).toBe(true);
        expect(isReaderCommandInline(browserSurface, 'scan-cleanup')).toBe(false);
        expect(isReaderCommandInMenu(browserSurface, 'scan-cleanup')).toBe(false);
        expect(isReaderCommandInline(DESKTOP_EDITOR_READER_COMMAND_SURFACE, 'scan-cleanup')).toBe(true);
    });
});
