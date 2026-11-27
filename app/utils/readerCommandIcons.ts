import {READER_COMMAND_DESCRIPTORS} from '@contracts/readerCommands';
import type {TReaderCommandIconName, TReaderCommandId} from '@contracts/readerCommands';

export type TReaderCommandMenuIcon = `i-ph-${string}`;

export function getReaderCommandToolbarIcon(command: TReaderCommandId): TReaderCommandIconName {
    return READER_COMMAND_DESCRIPTORS[command].icon;
}

export function getReaderCommandMenuIcon(command: TReaderCommandId): TReaderCommandMenuIcon {
    return toReaderCommandMenuIcon(getReaderCommandToolbarIcon(command));
}

function toReaderCommandMenuIcon(icon: TReaderCommandIconName): TReaderCommandMenuIcon {
    return `i-${icon.replace(':', '-')}` as TReaderCommandMenuIcon;
}
