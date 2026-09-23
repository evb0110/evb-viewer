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

export const MOBILE_READER_COMMAND_SURFACE = createSurface({
    inline: {
        'app-menu': true,
        'open-file': true,
        'overflow-menu': true,
        'page-navigation': true,
        zoom: true,
    },
    menu: {
        'capture-region': true,
        'continuous-scroll': true,
        crop: true,
        'drag-mode': true,
        'export-docx': true,
        'fit-height': true,
        'fit-width': true,
        fullscreen: true,
        ocr: true,
        'open-file': true,
        print: true,
        'print-current-page': true,
        'quick-note': true,
        'save-as': true,
        settings: true,
        'text-select': true,
        'toggle-sidebar': true,
        'view-mode': true,
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

export function listReaderCommandsForPlacement(
    surface: IReaderCommandSurface | null | undefined,
    placement: keyof IReaderCommandSurface,
) {
    const resolvedSurface = surface ?? DESKTOP_EDITOR_READER_COMMAND_SURFACE;

    return READER_COMMANDS.filter(command => resolvedSurface[placement][command]);
}
