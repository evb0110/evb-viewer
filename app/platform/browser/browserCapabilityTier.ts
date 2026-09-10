type TBrowserOpenFilePicker = (
    options?: {
        multiple?: boolean;
        excludeAcceptAllOption?: boolean;
        types?: IFilePickerAcceptType[];
    },
) => Promise<FileSystemFileHandle[]>;

type TBrowserSaveFilePicker = (
    options?: {
        suggestedName?: string;
        excludeAcceptAllOption?: boolean;
        types?: IFilePickerAcceptType[];
    },
) => Promise<FileSystemFileHandle>;

interface IWindowWithBrowserFilePickers extends Window {
    showOpenFilePicker?: TBrowserOpenFilePicker;
    showSaveFilePicker?: TBrowserSaveFilePicker;
}

export interface IFilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
}

export type TBrowserFileAccessTier =
    | 'file-system-access'
    | 'open-handle-only'
    | 'save-handle-only'
    | 'download-only';

type TBrowserStorageTier = 'persistent' | 'volatile';
export type TBrowserCapabilityTier = `${TBrowserFileAccessTier}-${TBrowserStorageTier}`;

interface IBrowserCapabilitySupport {
    readonly opensWithHandle: boolean;
    readonly savesToChosenTarget: boolean;
    readonly persistentStorage: boolean;
}

export const BROWSER_CAPABILITY_TIER_SUPPORT = {
    'file-system-access-persistent': {
        opensWithHandle: true,
        savesToChosenTarget: true,
        persistentStorage: true,
    },
    'file-system-access-volatile': {
        opensWithHandle: true,
        savesToChosenTarget: true,
        persistentStorage: false,
    },
    'open-handle-only-persistent': {
        opensWithHandle: true,
        savesToChosenTarget: false,
        persistentStorage: true,
    },
    'open-handle-only-volatile': {
        opensWithHandle: true,
        savesToChosenTarget: false,
        persistentStorage: false,
    },
    'save-handle-only-persistent': {
        opensWithHandle: false,
        savesToChosenTarget: true,
        persistentStorage: true,
    },
    'save-handle-only-volatile': {
        opensWithHandle: false,
        savesToChosenTarget: true,
        persistentStorage: false,
    },
    'download-only-persistent': {
        opensWithHandle: false,
        savesToChosenTarget: false,
        persistentStorage: true,
    },
    'download-only-volatile': {
        opensWithHandle: false,
        savesToChosenTarget: false,
        persistentStorage: false,
    },
} as const satisfies Record<TBrowserCapabilityTier, IBrowserCapabilitySupport>;

export interface IBrowserCapabilityTier {
    readonly tier: TBrowserCapabilityTier;
    readonly support: IBrowserCapabilitySupport;
    readonly openFilePicker: TBrowserOpenFilePicker | null;
    readonly saveFilePicker: TBrowserSaveFilePicker | null;
    readonly indexedDbFactory: IDBFactory | null;
}

/**
 * Browser degradation has three independent axes. Consumers use this product
 * tier as policy; API calls still validate browser failures at their boundary.
 */
export function resolveBrowserCapabilityTier(): IBrowserCapabilityTier {
    const pickerWindow = typeof window === 'undefined'
        ? null
        : (window as IWindowWithBrowserFilePickers);
    const openFilePicker = typeof pickerWindow?.showOpenFilePicker === 'function'
        ? pickerWindow.showOpenFilePicker.bind(pickerWindow)
        : null;
    const saveFilePicker = typeof pickerWindow?.showSaveFilePicker === 'function'
        ? pickerWindow.showSaveFilePicker.bind(pickerWindow)
        : null;
    let indexedDbFactory: IDBFactory | null = null;
    try {
        indexedDbFactory = typeof indexedDB === 'undefined' ? null : indexedDB;
    } catch {
        // Browser policy can deny access while evaluating the global getter.
        // Treat that the same as an unavailable persistence API.
        indexedDbFactory = null;
    }
    const fileAccessTier: TBrowserFileAccessTier = openFilePicker
        ? (saveFilePicker ? 'file-system-access' : 'open-handle-only')
        : (saveFilePicker ? 'save-handle-only' : 'download-only');
    const tier: TBrowserCapabilityTier = `${fileAccessTier}-${indexedDbFactory ? 'persistent' : 'volatile'}`;

    return {
        tier,
        support: BROWSER_CAPABILITY_TIER_SUPPORT[tier],
        openFilePicker,
        saveFilePicker,
        indexedDbFactory,
    };
}
