import type { TMenuEventUnsubscribe } from '@contracts/electronApiCommon';
import type {
    IApplicationMenuDocumentState,
    IDocumentsMenuCapability,
} from '@contracts/electronApiDocuments';
import type { IWindowTabsCapability } from '@contracts/windowTabsPlatformFeature';

// The browser's application menu. Desktop's native menu sends its commands to
// the renderer on platform menu events and is drawn from the document state the
// renderer reports; the browser draws that menu in the page, so both ends meet
// here: the page menu dispatches the same events and reads the same state.

// A menu event without a payload is a no-argument callback in the capability
// and an undefined payload in the platform contract; both take this shape.
type TMenuCallbackArgs<TRegister> = TRegister extends (callback: (...args: infer TArgs) => void) => unknown
    ? TArgs extends [] | [undefined] ? [payload?: undefined] : TArgs
    : never;
type TDocumentMenuEventName = Extract<keyof IDocumentsMenuCapability, `onMenu${string}`>;
type TWindowTabsMenuEventName = Extract<keyof IWindowTabsCapability, `onMenu${string}`>;

export type TBrowserMenuEventArgs = {
    [TName in TDocumentMenuEventName]: TMenuCallbackArgs<IDocumentsMenuCapability[TName]>;
} & {
    [TName in TWindowTabsMenuEventName]: TMenuCallbackArgs<IWindowTabsCapability[TName]>;
} & {onMenuSelectAll: []};
// onMenuSelectAll is page-local: desktop's Edit > Select All sends real key input instead.
export type TBrowserMenuEventName = keyof TBrowserMenuEventArgs;
type TBrowserMenuListener<TName extends TBrowserMenuEventName> = (...args: TBrowserMenuEventArgs[TName]) => void;
type TBrowserMenuDocumentStateListener = (state: IApplicationMenuDocumentState | null) => void;

const menuEventListeners = new Map<TBrowserMenuEventName, Set<unknown>>();
const menuDocumentStateListeners = new Set<TBrowserMenuDocumentStateListener>();
let menuDocumentState: IApplicationMenuDocumentState | null = null;

export function subscribeBrowserMenuEvent<TName extends TBrowserMenuEventName>(name: TName) {
    return (callback: TBrowserMenuListener<TName>): TMenuEventUnsubscribe => {
        const listeners = menuEventListeners.get(name) ?? new Set();
        menuEventListeners.set(name, listeners);
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
        };
    };
}

export function dispatchBrowserMenuEvent<TName extends TBrowserMenuEventName>(
    name: TName,
    ...args: TBrowserMenuEventArgs[TName]
) {
    for (const listener of [...menuEventListeners.get(name) ?? []]) {
        (listener as TBrowserMenuListener<TName>)(...args);
    }
}

export function setBrowserMenuDocumentState(state: boolean | IApplicationMenuDocumentState) {
    menuDocumentState = typeof state === 'boolean'
        ? {
            hasDocument: state,
            canSave: state,
        }
        : state;
    for (const listener of [...menuDocumentStateListeners]) {
        listener(menuDocumentState);
    }
}

export function readBrowserMenuDocumentState() {
    return menuDocumentState;
}

export function onBrowserMenuDocumentStateChange(listener: TBrowserMenuDocumentStateListener): TMenuEventUnsubscribe {
    menuDocumentStateListeners.add(listener);
    return () => {
        menuDocumentStateListeners.delete(listener);
    };
}
