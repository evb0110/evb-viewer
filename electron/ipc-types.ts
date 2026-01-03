export interface IIpcChannels {
    'dialog:openPdf': {
        args: [];
        result: string | null;
    };
    'file:read': {
        args: [filePath: string];
        result: Uint8Array;
    };
    'file:write': {
        args: [filePath: string, data: Uint8Array];
        result: boolean;
    };
    'window:setTitle': {
        args: [title: string];
        result: undefined;
    };
}

export type TMenuEventCallback = () => void;
export type TMenuEventUnsubscribe = () => void;

export interface IMenuEvents {
    onMenuOpenPdf: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSave: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomIn: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuZoomOut: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuActualSize: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitWidth: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuFitHeight: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuAbout: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}
