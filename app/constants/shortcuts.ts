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
}

const SHORTCUTS = {
    openFile: {
        key: 'O',
        modifiers: ['mod'], 
    },
    save: {
        key: 'S',
        modifiers: ['mod'], 
    },
    saveAs: {
        key: 'S',
        modifiers: [
            'mod',
            'shift',
        ], 
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
    },
    fitHeight: {
        key: '2',
        modifiers: ['mod'], 
    },
    zoomIn: {
        key: '=',
        modifiers: ['mod'], 
    },
    zoomOut: {
        key: '\u2212',
        modifiers: ['mod'], 
    },
    actualSize: {
        key: '0',
        modifiers: ['mod'],
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

function formatShortcutLabel(def: IShortcutDef, isMac: boolean) {
    const activeDef = (!isMac && def.nonMacOverride) ? def.nonMacOverride : def;
    const parts = getOrderedModifiers(activeDef.modifiers, isMac)
        .map(m => resolveModifierLabel(m, isMac));
    parts.push(activeDef.key);

    if (!isMac) {
        return parts.join('+');
    }

    return parts.join('');
}

export function getShortcutLabels(isMac = isMacClientPlatform()) {
    return createShortcutRecord((_, def) => formatShortcutLabel(def, isMac));
}

export const useShortcutLabels = () => {
    const isMac = ref(false);
    onMounted(() => {
        isMac.value = isMacClientPlatform();
    });
    return computed(() => getShortcutLabels(isMac.value));
};
