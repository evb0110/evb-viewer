import type { IRecentFile } from 'app/types/shared';

export type { IRecentFile } from 'app/types/shared';

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
    'recent-files:get': {
        args: [];
        result: IRecentFile[];
    };
    'recent-files:add': {
        args: [originalPath: string];
        result: undefined;
    };
    'recent-files:remove': {
        args: [originalPath: string];
        result: undefined;
    };
    'recent-files:clear': {
        args: [];
        result: undefined;
    };
}

export interface IMenuEventCallback {(): void;}

export interface IMenuEventUnsubscribe {(): void;}

export interface IMenuEvents {
    onMenuOpenPdf: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSave: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomIn: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuZoomOut: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuActualSize: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitWidth: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuFitHeight: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuAbout: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
}
