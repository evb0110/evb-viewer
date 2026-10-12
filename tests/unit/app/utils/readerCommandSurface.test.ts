import {
    describe,
    expect,
    it,
} from 'vitest';
import {
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
});
