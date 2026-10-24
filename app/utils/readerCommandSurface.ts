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

/** Commands that exist only where the runtime can run them. */
export interface IReaderToolbarCapabilities {
    ocr: boolean;
    scanCleanup: boolean;
}

// The toolbar's commands depend only on what the runtime can do. Document state
// disables commands but never adds or removes them, so the toolbar keeps its
// layout when a tab opens or closes a document.
export function createReaderToolbarSurface(capabilities: IReaderToolbarCapabilities) {
    const commands = {
        ...allCommands,
        ocr: capabilities.ocr,
        'scan-cleanup': capabilities.scanCleanup,
    };

    return createSurface({
        inline: {
            ...commands,
            'open-file': false,
            'optimize-pdf-for-interaction': false,
            'print-current-page': false,
        },
        menu: commands,
    });
}

export const DESKTOP_EDITOR_READER_COMMAND_SURFACE = createReaderToolbarSurface({
    ocr: true,
    scanCleanup: true,
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
