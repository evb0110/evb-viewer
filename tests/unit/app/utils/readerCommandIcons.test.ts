import {describe, expect, it} from 'vitest';
import {READER_COMMANDS, READER_COMMAND_DESCRIPTORS} from '@contracts/readerCommands';
import {getReaderCommandMenuIcon, getReaderCommandToolbarIcon} from '@app/utils/readerCommandIcons';

describe('readerCommandIcons', () => {
    it('keeps command descriptors in the toolbar icon namespace', () => {
        for (const command of READER_COMMANDS) {
            expect(READER_COMMAND_DESCRIPTORS[command].icon).toMatch(/^ph:[a-z0-9-]+$/u);
        }
    });

    it('resolves menu icons from the same command metadata as toolbar icons', () => {
        expect(getReaderCommandToolbarIcon('ocr')).toBe('ph:text-aa');
        expect(getReaderCommandMenuIcon('ocr')).toBe('i-ph-text-aa');

        expect(getReaderCommandToolbarIcon('fit-width')).toBe('ph:arrows-out-line-horizontal');
        expect(getReaderCommandMenuIcon('fit-width')).toBe('i-ph-arrows-out-line-horizontal');

        expect(getReaderCommandToolbarIcon('quick-note')).toBe('ph:chat-circle-dots');
        expect(getReaderCommandMenuIcon('quick-note')).toBe('i-ph-chat-circle-dots');
    });
});
