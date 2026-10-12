import { READER_COMMANDS } from '@contracts/readerCommands';
import type {
    IReaderCommandSurface,
    TReaderCommandId,
    TReaderCommandMap,
} from '@contracts/readerCommands';

export type {
    IReaderCommandSurface,
    TReaderCommandId,
    TReaderCommandMap,
} from '@contracts/readerCommands';

function createCommandMap(overrides: Partial<Record<TReaderCommandId, boolean>>): TReaderCommandMap {
    const commandMap: Partial<Record<TReaderCommandId, boolean>> = {};

    for (const command of READER_COMMANDS) {
        commandMap[command] = overrides[command] ?? false;
    }

    return Object.freeze(commandMap) as TReaderCommandMap;
}

function createSurface(options: {
    inline: Partial<Record<TReaderCommandId, boolean>>;
    menu: Partial<Record<TReaderCommandId, boolean>>;
}) {
    return Object.freeze({
        inline: createCommandMap(options.inline),
        menu: createCommandMap(options.menu),
    }) satisfies IReaderCommandSurface;
}

const allCommands = createCommandMap(Object.fromEntries(READER_COMMANDS.map(command => [
    command,
    true,
])));

const desktopInlineCommands = {
    ...allCommands,
    'open-file': false,
    'optimize-pdf-for-interaction': false,
    'print-current-page': false,
};

export const DESKTOP_EDITOR_READER_COMMAND_SURFACE = createSurface({
    inline: desktopInlineCommands,
    menu: allCommands,
});

// The shell toolbar remains mounted while a tab has no document so its height
// stays stable when the document toolbar takes over. Keep only shell actions
// visible on that surface; document actions belong to the empty-state page.
export const EMPTY_STATE_READER_COMMAND_SURFACE = createSurface({
    inline: {
        'overflow-menu': true,
        settings: true,
    },
    menu: {
        'open-file': true,
        settings: true,
    },
});

export function isReaderCommandInline(
    surface: IReaderCommandSurface | null | undefined,
    command: TReaderCommandId,
) {
    return (surface ?? DESKTOP_EDITOR_READER_COMMAND_SURFACE).inline[command];
}

export function isReaderCommandInMenu(
    surface: IReaderCommandSurface | null | undefined,
    command: TReaderCommandId,
) {
    return (surface ?? DESKTOP_EDITOR_READER_COMMAND_SURFACE).menu[command];
}
