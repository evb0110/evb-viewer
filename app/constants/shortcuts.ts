import type { TTranslationKey } from '@i18n-app';
import { isMacClientPlatform } from '@app/utils/clientPlatform';

export { isMacPlatformHint } from '@app/utils/clientPlatform';

type TModifier = 'mod' | 'shift';

interface IShortcutDef {
    key: string;
    modifiers: TModifier[];
    nonMacOverride?: {
        key: string;
        modifiers: TModifier[] 
    };
    /** Listed in Settings' shortcut reference under this label. */
    helpLabelKey?: TTranslationKey;
}

const SHORTCUTS = {
    openFile: {
        key: 'O',
        modifiers: ['mod'],
        helpLabelKey: 'toolbar.openPdf',
    },
    save: {
        key: 'S',
        modifiers: ['mod'],
        helpLabelKey: 'toolbar.save',
    },
    saveAs: {
        key: 'S',
        modifiers: [
            'mod',
            'shift',
        ],
        helpLabelKey: 'toolbar.saveAs',
    },
    print: {
        key: 'P',
        modifiers: ['mod'],
    },
    toggleSidebar: {
        key: 'B',
        modifiers: ['mod'], 
    },
    search: {
        key: 'F',
        modifiers: ['mod'],
        helpLabelKey: 'documentSourceSidebar.searchPlaceholder',
    },
    undo: {
        key: 'Z',
        modifiers: ['mod'], 
    },
    redo: {
        key: 'Z',
        modifiers: [
            'mod',
            'shift',
        ],
        nonMacOverride: {
            key: 'Y',
            modifiers: ['mod'], 
        }, 
    },
    exportDocx: {
        key: 'E',
        modifiers: [
            'mod',
            'shift',
        ],
    },
    insertImageFromFile: {
        key: 'I',
        modifiers: [
            'mod',
            'shift',
        ],
    },
    pasteImageFromClipboard: {
        key: 'V',
        modifiers: [
            'mod',
            'shift',
        ],
    },
    fitWidth: {
        key: '1',
        modifiers: ['mod'],
        helpLabelKey: 'zoom.fitWidth',
    },
    fitHeight: {
        key: '2',
        modifiers: ['mod'],
        helpLabelKey: 'zoom.fitHeight',
    },
    zoomIn: {
        key: '=',
        modifiers: ['mod'],
        helpLabelKey: 'zoom.zoomIn',
    },
    zoomOut: {
        key: '\u2212',
        modifiers: ['mod'],
        helpLabelKey: 'zoom.zoomOut',
    },
    actualSize: {
        key: '0',
        modifiers: ['mod'],
        helpLabelKey: 'settings.actualSize',
    },
    newPaneRight: {
        key: '\\',
        modifiers: ['mod'],
    },
} as const satisfies Record<string, IShortcutDef>;

export type TShortcutName = keyof typeof SHORTCUTS;

function createShortcutRecord<TValue>(createValue: (name: TShortcutName, def: IShortcutDef) => TValue) {
    const entries = Object.entries(SHORTCUTS).map(([
        name,
        def,
    ]) => [
        name,
        createValue(name as TShortcutName, def),
    ]);
    return Object.fromEntries(entries) as {[TName in TShortcutName]: TValue};
}

function resolveModifierLabel(m: TModifier, isMac: boolean): string {
    if (m === 'mod') {
        return isMac ? '\u2318' : 'Ctrl';
    }
    return isMac ? '\u21E7' : 'Shift';
}

function getOrderedModifiers(modifiers: TModifier[], isMac: boolean) {
    if (!isMac) {
        return modifiers;
    }

    const macModifierOrder: TModifier[] = [
        'shift',
        'mod',
    ];

    return [...modifiers].sort((a, b) => macModifierOrder.indexOf(a) - macModifierOrder.indexOf(b));
}

function shortcutKeyParts(def: IShortcutDef, isMac: boolean) {
    const activeDef = (!isMac && def.nonMacOverride) ? def.nonMacOverride : def;
    return [
        ...getOrderedModifiers(activeDef.modifiers, isMac).map(m => resolveModifierLabel(m, isMac)),
        activeDef.key,
    ];
}

export function getShortcutLabels(isMac = isMacClientPlatform()) {
    return createShortcutRecord((_, def) => shortcutKeyParts(def, isMac).join(isMac ? '' : '+'));
}

/** The labels Settings' shortcut reference uses, each one without parameters. */
type TShortcutHelpLabelKey = {
    [TName in TShortcutName]: (typeof SHORTCUTS)[TName] extends {helpLabelKey: infer TKey} ? TKey : never
}[TShortcutName];

/** Settings' shortcut reference: the shortcuts with a help label, in registry order. */
export function getShortcutHelpItems(isMac = isMacClientPlatform()) {
    return Object.values<IShortcutDef>(SHORTCUTS).flatMap(def => (def.helpLabelKey === undefined ? [] : [{
        labelKey: def.helpLabelKey as TShortcutHelpLabelKey,
        keys: shortcutKeyParts(def, isMac),
    }]));
}

/** The client platform, known once mounted, so server and first render agree. */
function useMountedIsMac() {
    const isMac = ref(false);
    onMounted(() => {
        isMac.value = isMacClientPlatform();
    });
    return isMac;
}

export const useShortcutHelpItems = () => {
    const isMac = useMountedIsMac();
    return computed(() => getShortcutHelpItems(isMac.value));
};

export const useShortcutLabels = () => {
    const isMac = useMountedIsMac();
    return computed(() => getShortcutLabels(isMac.value));
};
